// Did the cut actually work? Checks the corners are gone, the artwork is not,
// and — the failure that is easy to miss — that no dark halo was left along the
// curve. Also renders a preview strip over light, dark and a checkerboard,
// because a one-pixel fringe is something you see before you measure it.
const path = require('path');
const fs = require('fs');
const { app, nativeImage } = require('electron');

const CUT = path.join(__dirname, 'yapper-icon.png');
const ICO = path.join(__dirname, 'yapper-icon.ico');
const PREVIEW = path.join(__dirname, 'icon-preview.png');

let fails = 0;
function check(name, ok, detail) {
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      ${detail}`); }
}

const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

app.whenReady().then(() => {
  const img = nativeImage.createFromPath(CUT);
  const { width: w, height: h } = img.getSize();
  const px = img.toBitmap();
  const at = (x, y) => {
    const i = (y * w + x) * 4;
    return { b: px[i], g: px[i + 1], r: px[i + 2], a: px[i + 3] };
  };

  check('el PNG se lee', w > 0 && h > 0, `${w}×${h}`);

  // --- the corners must be gone ---
  for (const [name, x, y] of [
    ['sup-izq', 4, 4], ['sup-der', w - 5, 4], ['inf-izq', 4, h - 5], ['inf-der', w - 5, h - 5]
  ]) {
    const p = at(x, y);
    check(`esquina ${name} transparente`, p.a === 0, `alpha ${p.a}`);
  }

  // --- and the artwork must not be ---
  const mid = at(w >> 1, h >> 1);
  check('el centro sigue opaco', mid.a === 255, `alpha ${mid.a}`);
  check('la marca sigue oscura', luma(mid.r, mid.g, mid.b) < 60, `luma ${luma(mid.r, mid.g, mid.b).toFixed(0)}`);
  for (const [name, x, y] of [['borde sup', w >> 1, 2], ['borde izq', 2, h >> 1]]) {
    const p = at(x, y);
    check(`${name} conserva el cuerpo`, p.a === 255 && p.r > 200, `rgb ${p.r},${p.g},${p.b} a${p.a}`);
  }

  let opaque = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] === 255) opaque++;
  const kept = opaque / (w * h);
  check('conserva casi todo el lienzo', kept > 0.95 && kept < 0.99, `${(kept * 100).toFixed(1)}% opaco`);

  // --- no dark halo: every partially transparent pixel must be body-coloured,
  // not a leftover blend with the black that was cut away ---
  let fringe = 0, partial = 0;
  for (let p = 0; p < w * h; p++) {
    const a = px[p * 4 + 3];
    if (a === 0 || a === 255) continue;
    partial++;
    // These bitmaps are premultiplied, so the stored colour is already scaled
    // by the alpha; undo that before asking what colour the pixel really is.
    const f = a / 255;
    if (luma(px[p * 4 + 2] / f, px[p * 4 + 1] / f, px[p * 4] / f) < 120) fringe++;
  }
  check('el borde no dejó halo oscuro', fringe === 0, `${fringe} de ${partial} píxeles del borde son oscuros`);
  check('el borde quedó suavizado', partial > 200, `solo ${partial} píxeles intermedios (¿borde duro?)`);

  // --- the .ico really holds every size ---
  const ico = fs.readFileSync(ICO);
  check('el .ico es un icono', ico.readUInt16LE(0) === 0 && ico.readUInt16LE(2) === 1, 'cabecera inesperada');
  const count = ico.readUInt16LE(4);
  const sizes = [];
  let ok256 = false;
  for (let n = 0; n < count; n++) {
    const at2 = 6 + n * 16;
    const s = ico[at2] === 0 ? 256 : ico[at2];
    sizes.push(s);
    const off = ico.readUInt32LE(at2 + 12);
    const len = ico.readUInt32LE(at2 + 8);
    const isPng = ico.slice(off, off + 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (!isPng) { fails++; console.log(`FAIL  la entrada de ${s}px no es un PNG válido`); }
    if (off + len > ico.length) { fails++; console.log(`FAIL  la entrada de ${s}px apunta fuera del archivo`); }
    if (s === 256) ok256 = true;
  }
  check('trae los tamaños que Windows usa',
    [16, 24, 32, 48, 64, 128].every(s => sizes.includes(s)) && ok256, sizes.join(', '));

  // --- a preview a human can judge ---
  const P = 256, GAP = 16, N = 3;
  const pw = P * N + GAP * (N + 1), ph = P + GAP * 2;
  const out = Buffer.alloc(pw * ph * 4);
  const small = nativeImage.createFromPath(CUT).resize({ width: P, height: P, quality: 'best' }).toBitmap();

  const backdrops = [
    (x, y) => ({ r: 251, g: 250, b: 248 }),                                   // light theme
    (x, y) => ({ r: 12, g: 13, b: 16 }),                                      // dark theme
    (x, y) => (((x >> 4) + (y >> 4)) % 2 ? { r: 205, g: 205, b: 205 } : { r: 245, g: 245, b: 245 })
  ];

  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const o = (y * pw + x) * 4;
      const slot = Math.floor((x - GAP) / (P + GAP));
      const bg = backdrops[Math.max(0, Math.min(N - 1, slot))](x, y);
      let { r, g, b } = bg;
      const lx = x - (GAP + slot * (P + GAP));
      const ly = y - GAP;
      if (slot >= 0 && slot < N && lx >= 0 && lx < P && ly >= 0 && ly < P) {
        // source is premultiplied, so it is added rather than scaled again
        const i = (ly * P + lx) * 4;
        const a = small[i + 3] / 255;
        b = Math.min(255, Math.round(small[i] + b * (1 - a)));
        g = Math.min(255, Math.round(small[i + 1] + g * (1 - a)));
        r = Math.min(255, Math.round(small[i + 2] + r * (1 - a)));
      }
      out[o] = b; out[o + 1] = g; out[o + 2] = r; out[o + 3] = 255;
    }
  }
  fs.writeFileSync(PREVIEW, nativeImage.createFromBitmap(out, { width: pw, height: ph }).toPNG());
  console.log(`\nvista previa: ${PREVIEW}`);

  console.log(fails ? `\n${fails} fallos` : '\nPASS');
  app.exit(fails ? 1 : 0);
});
