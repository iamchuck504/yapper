// Writes the menu bar icon: the mark alone, as a template image.
//
// A macOS status item is not a small copy of the app icon. The system expects
// a *template* — pure black artwork carried entirely by its alpha channel —
// and paints it itself, so it comes out dark on a light menu bar, light on a
// dark one, and inverted while the menu is open. Handing it the amber tile
// would put a coloured square up there that goes muddy in half the states the
// menu bar has.
//
// So the tile is thrown away and only the mark survives. That is the same
// measurement `icon-dark.js` makes: every pixel of the seam between mark and
// tile is a blend, so each one is read for how far along the amber→ink ramp it
// sits. There it decides a colour; here it decides an alpha. The anti-aliasing
// survives either way, which is what keeps the edge from stair-stepping at
// 16 pixels — the size this is actually seen at.
//
//   node_modules/electron/dist/Electron.app/Contents/MacOS/Electron build/icon-tray.js

const path = require('path');
const fs = require('fs');
const { app, nativeImage } = require('electron');

const SRC = path.join(__dirname, 'yapper-icon.png');
const OUT = path.join(__dirname, 'yapper-tray-Template.png');
const OUT2X = path.join(__dirname, 'yapper-tray-Template@2x.png');

const AMBER = [224, 164, 88];   // the tile: becomes transparent
const INK = [12, 13, 16];       // the mark: becomes opaque black

const img = nativeImage.createFromPath(SRC);
if (img.isEmpty()) throw new Error(`could not read ${SRC}`);
const { width, height } = img.getSize();
const px = img.toBitmap();      // BGRA, straight from Skia

// Red separates the two colours the most (224 vs 12), so it carries the ramp
// with the least rounding error.
const SPAN = AMBER[0] - INK[0];

for (let i = 0; i < px.length; i += 4) {
  if (px[i + 3] === 0) continue;                 // the cut-out corners stay cut out
  // 0 = pure tile, 1 = pure mark
  let t = (AMBER[0] - px[i + 2]) / SPAN;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  px[i] = 0; px[i + 1] = 0; px[i + 2] = 0;       // template artwork is black
  px[i + 3] = Math.round(255 * t);               // and lives in the alpha
}

const mark = nativeImage.createFromBitmap(px, { width, height });

// The menu bar wants ~18pt of height; @2x is what a Retina display draws from.
// Written as two files with the "Template" suffix macOS looks for, so
// nativeImage picks the right one per display without being told.
fs.writeFileSync(OUT, mark.resize({ width: 18, height: 18, quality: 'best' }).toPNG());
fs.writeFileSync(OUT2X, mark.resize({ width: 36, height: 36, quality: 'best' }).toPNG());
console.log(`[icon] ${path.basename(OUT)} — 18x18 and 36x36, from ${width}x${height}`);
app.quit();
