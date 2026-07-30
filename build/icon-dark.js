// Writes the dark-appearance twin of the app icon.
//
// macOS 26 stopped showing legacy .icns files as drawn: with the icon
// appearance set to dark, the system darkens the tile and keeps the artwork.
// Yapper's mark is near-black on amber, so that treatment eats it — the icon
// arrives in the dock as a black slab. The fix is to ship the dark variant
// ourselves (see mac/icon-appearances.sh), which is this file: the same mark
// with the two colours swapped, amber on ink.
//
// The swap is not "replace this colour with that one". Every pixel of the seam
// between mark and tile is a blend of the two, so each one is measured — how
// far along the amber→ink ramp it sits — and re-mixed in the new order, which
// keeps the anti-aliasing intact instead of leaving a stair-stepped edge.
//
//   node_modules/electron/dist/Electron.app/Contents/MacOS/Electron build/icon-dark.js

const path = require('path');
const fs = require('fs');
const { app, nativeImage } = require('electron');

const SRC = path.join(__dirname, 'yapper-icon.png');
const OUT = path.join(__dirname, 'yapper-icon-dark.png');

const AMBER = [224, 164, 88];   // the tile, and the mark in the dark variant
const INK = [12, 13, 16];       // the mark, and the tile in the dark variant

const img = nativeImage.createFromPath(SRC);
if (img.isEmpty()) throw new Error(`could not read ${SRC}`);
const { width, height } = img.getSize();
const px = img.toBitmap();      // BGRA, straight from Skia

// Red separates the two colours the most (224 vs 12), so it carries the ramp
// with the least rounding error.
const SPAN = AMBER[0] - INK[0];

for (let i = 0; i < px.length; i += 4) {
  if (px[i + 3] === 0) continue;                 // the cut-out corners stay cut out
  // 0 = pure tile, 1 = pure mark, anything between is seam
  let t = (AMBER[0] - px[i + 2]) / SPAN;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  px[i + 2] = Math.round(INK[0] + (AMBER[0] - INK[0]) * t);   // R
  px[i + 1] = Math.round(INK[1] + (AMBER[1] - INK[1]) * t);   // G
  px[i] = Math.round(INK[2] + (AMBER[2] - INK[2]) * t);       // B
}

fs.writeFileSync(OUT, nativeImage.createFromBitmap(px, { width, height }).toPNG());
console.log(`[icon] ${path.basename(OUT)} — ${width}x${height}`);
app.quit();
