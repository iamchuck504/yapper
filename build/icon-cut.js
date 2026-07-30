// Cuts the black corners off the app icon and writes the .ico Windows uses.
//
// The corners are not removed by "delete black pixels": the mark itself is the
// same near-black, so that would hollow out the artwork. Instead the black is
// flood-filled inwards from the four corners, which follows whatever curve the
// artwork actually has — circular, squircle, anything — and cannot reach the
// mark, because the mark does not touch the edge.
//
// The tricky part is the anti-aliased seam. Those pixels are a blend of black
// and the body colour, so simply making them transparent leaves a dark halo
// one pixel wide, which is exactly what a cut-out icon must not have. Each seam
// pixel is un-blended instead: how much body colour it holds becomes its alpha,
// and its colour becomes the body colour.
//
//   node_modules\electron\dist\electron.exe build\icon-cut.js [source.png]

const path = require('path');
const fs = require('fs');
const { app, nativeImage } = require('electron');

const SRC = process.argv[2] || path.join(__dirname, 'icon-source.png');
const OUT_PNG = path.join(__dirname, 'yapper-icon.png');
const OUT_ICO = path.join(__dirname, 'yapper-icon.ico');
// The splash used to draw its own approximation of the logo in SVG, which goes
// stale the moment the real icon changes. It loads this instead, so there is
// one mark and it is the one that ships. 216 px covers a 108 px slot at 2x.
const OUT_MARK = path.join(__dirname, '..', 'renderer', 'app-mark.png');

// Windows shows the small sizes constantly (taskbar, alt-tab, explorer) and
// they are not just a scaled 256 — each is resampled from the full-size art.
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

const DARK = 70;        // luma below this counts as the black surround
const SEAM = 3;         // how far the anti-aliased seam can reach, in pixels

function luma(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

app.whenReady().then(() => {
  if (!fs.existsSync(SRC)) {
    console.log(`FAIL  no encuentro ${SRC}`);
    return app.exit(1);
  }

  const img = nativeImage.createFromPath(SRC);
  const { width: w, height: h } = img.getSize();
  const src = img.toBitmap();          // BGRA
  const px = new Uint8ClampedArray(src);
  const idx = (x, y) => (y * w + x) * 4;

  // The body colour, taken from the middle of the top edge — a point that is
  // always inside the shape whatever its corner radius.
  const c = idx(w >> 1, 0);
  const body = { b: px[c], g: px[c + 1], r: px[c + 2] };
  const bodyLuma = luma(body.r, body.g, body.b);

  // ---- 1. flood the surround inwards from the corners ----
  const outside = new Uint8Array(w * h);
  const stack = [];
  for (const [sx, sy] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]]) {
    stack.push(sx, sy);
  }
  let filled = 0;
  while (stack.length) {
    const y = stack.pop();
    const x = stack.pop();
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const p = y * w + x;
    if (outside[p]) continue;
    const i = p * 4;
    if (luma(px[i + 2], px[i + 1], px[i]) >= DARK) continue;
    outside[p] = 1;
    filled++;
    stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
  }

  // ---- 2. the seam: pixels near the surround that are a partial blend ----
  // Grown from the surround rather than measured geometrically, so it hugs the
  // real edge even where the source was resized or re-encoded.
  const seam = new Uint8Array(w * h);
  let frontier = [];
  for (let p = 0; p < outside.length; p++) if (outside[p]) frontier.push(p);
  for (let step = 0; step < SEAM; step++) {
    const next = [];
    for (const p of frontier) {
      const x = p % w, y = (p / w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (outside[q] || seam[q]) continue;
        seam[q] = 1;
        next.push(q);
      }
    }
    frontier = next;
  }

  // ---- 3. write the alpha ----
  let cleared = 0, feathered = 0;
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    if (outside[p]) {
      px[i] = 0; px[i + 1] = 0; px[i + 2] = 0; px[i + 3] = 0;   // premultiplied: fully clear
      cleared++;
      continue;
    }
    if (!seam[p]) continue;
    // A seam pixel is body colour scaled by how much of it the pixel holds, so
    // its brightness relative to the body is its coverage.
    const cover = Math.min(1, luma(px[i + 2], px[i + 1], px[i]) / bodyLuma);
    if (cover > 0.985) continue;                 // already fully inside
    // These bitmaps are premultiplied: Skia requires each channel to be no
    // greater than the alpha and silently clamps it otherwise, which turns a
    // half-transparent orange into a half-transparent grey — the very halo this
    // is meant to remove.
    px[i] = Math.round(body.b * cover);
    px[i + 1] = Math.round(body.g * cover);
    px[i + 2] = Math.round(body.r * cover);
    px[i + 3] = Math.round(cover * 255);
    feathered++;
  }

  const cut = nativeImage.createFromBitmap(px, { width: w, height: h });
  fs.writeFileSync(OUT_PNG, cut.toPNG());
  fs.writeFileSync(OUT_MARK,
    cut.resize({ width: 216, height: 216, quality: 'best' }).toPNG());

  // ---- 4. the .ico ----
  // Chromium reads PNG-compressed icon entries happily, but the Windows shell —
  // the thing that actually draws the desktop and the taskbar — is older and
  // fussier. Everything up to 128 goes in as a classic DIB, which every version
  // of Windows has always understood; only 256 is PNG, where it is required.
  const entries = ICO_SIZES.map(size => {
    const img = cut.resize({ width: size, height: size, quality: 'best' });
    return size >= 256
      ? { size, data: img.toPNG(), png: true }
      : { size, data: dib(img.toBitmap(), size), png: false };
  });
  fs.writeFileSync(OUT_ICO, buildIco(entries));

  console.log(`origen        : ${path.basename(SRC)}  ${w}×${h}`);
  console.log(`color cuerpo  : rgb(${body.r}, ${body.g}, ${body.b})`);
  console.log(`trimmed       : ${cleared} px (${(cleared / (w * h) * 100).toFixed(1)}% of the canvas)`);
  console.log(`borde suavizado: ${feathered} px`);
  console.log(`\n${path.basename(OUT_PNG)}  ${(fs.statSync(OUT_PNG).size / 1024).toFixed(0)} KB`);
  console.log(`${path.basename(OUT_ICO)}  ${(fs.statSync(OUT_ICO).size / 1024).toFixed(0)} KB  (${ICO_SIZES.join(', ')})`);

  app.exit(0);
});

function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);              // reserved
  header.writeUInt16LE(1, 2);              // 1 = icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;

  entries.forEach((e, n) => {
    const at = n * 16;
    dir[at] = e.size >= 256 ? 0 : e.size;       // 0 means 256
    dir[at + 1] = e.size >= 256 ? 0 : e.size;
    dir[at + 2] = 0;                            // palette entries
    dir[at + 3] = 0;                            // reserved
    dir.writeUInt16LE(1, at + 4);               // colour planes
    dir.writeUInt16LE(32, at + 6);              // bits per pixel
    dir.writeUInt32LE(e.data.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += e.data.length;
  });

  return Buffer.concat([header, dir, ...entries.map(e => e.data)]);
}

/**
 * A 32-bit icon image the classic way: a BITMAPINFOHEADER whose height is
 * doubled (colour rows plus a mask), bottom-up BGRA rows, then the 1-bit AND
 * mask. The mask is redundant with the alpha channel on anything modern, but
 * it is part of the format and some shell paths still read it.
 */
function dib(bitmap, size) {
  const HEADER = 40;
  const stride = size * 4;
  const maskStride = Math.ceil(size / 32) * 4;   // rows padded to 4 bytes
  const out = Buffer.alloc(HEADER + stride * size + maskStride * size);

  out.writeUInt32LE(HEADER, 0);
  out.writeInt32LE(size, 4);
  out.writeInt32LE(size * 2, 8);                 // colour height + mask height
  out.writeUInt16LE(1, 12);                      // planes
  out.writeUInt16LE(32, 14);                     // bits per pixel
  out.writeUInt32LE(0, 16);                      // BI_RGB, uncompressed
  out.writeUInt32LE(stride * size, 20);

  for (let y = 0; y < size; y++) {
    const src = y * stride;
    const dst = HEADER + (size - 1 - y) * stride;          // bottom-up
    for (let x = 0; x < size; x++) {
      const a = bitmap[src + x * 4 + 3];
      // the bitmap is premultiplied; icons want straight colour
      const f = a === 0 ? 0 : 255 / a;
      out[dst + x * 4] = Math.min(255, Math.round(bitmap[src + x * 4] * f));
      out[dst + x * 4 + 1] = Math.min(255, Math.round(bitmap[src + x * 4 + 1] * f));
      out[dst + x * 4 + 2] = Math.min(255, Math.round(bitmap[src + x * 4 + 2] * f));
      out[dst + x * 4 + 3] = a;

      if (a < 128) {   // transparent in the AND mask
        const mrow = HEADER + stride * size + (size - 1 - y) * maskStride;
        out[mrow + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }
  return out;
}
