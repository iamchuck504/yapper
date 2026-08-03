// The .ico container, shared by every script that writes one.
//
// Chromium reads PNG-compressed icon entries happily, but the Windows shell —
// the thing that actually draws the desktop and the taskbar — is older and
// fussier. Everything up to 128 goes in as a classic DIB, which every version
// of Windows has always understood; only 256 is PNG, where it is required.

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
 * it is part of the format and some shell paths still read it. Input rows are
 * premultiplied (what nativeImage.toBitmap produces); icons want straight
 * colour, so each pixel is un-premultiplied on the way in.
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

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

module.exports = { buildIco, dib, ICO_SIZES };
