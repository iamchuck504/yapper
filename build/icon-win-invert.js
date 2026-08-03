// Windows takes the macOS icon: ink tile, amber mark.
//
// The inverted artwork was made for the Mac out of necessity (macOS 26's
// appearance pass ate the near-black mark on the amber tile) and then turned
// out to be the version the owner prefers everywhere. yapper-icon-dark.png is
// already corner-cut and seam-feathered by icon-dark.js, so nothing here cuts
// anything: this packs that PNG into the multi-size .ico Windows loads, and
// derives the two tray images from it — resting, and recording, which carries
// an amber dot because a Windows tray icon has no setTitle to say it with.
//
//   node_modules\electron\dist\electron.exe build\icon-win-invert.js

const path = require('path');
const fs = require('fs');
const { app, nativeImage } = require('electron');
const { buildIco, dib, ICO_SIZES } = require('./ico-lib');

const SRC = path.join(__dirname, 'yapper-icon-dark.png');
const OUT_ICO = path.join(__dirname, 'yapper-icon.ico');
const OUT_TRAY = path.join(__dirname, 'yapper-tray-win.png');
const OUT_TRAY_REC = path.join(__dirname, 'yapper-tray-win-rec.png');

// The dot matches the app's accent — the same amber the mark carries.
const AMBER = { r: 224, g: 164, b: 88 };
const TRAY = 32;

app.whenReady().then(() => {
  if (!fs.existsSync(SRC)) {
    console.log(`FAIL  no ${path.basename(SRC)} — run build/icon-dark.js first`);
    return app.exit(1);
  }
  const img = nativeImage.createFromPath(SRC);

  const entries = ICO_SIZES.map(size => {
    const r = img.resize({ width: size, height: size, quality: 'best' });
    return size >= 256
      ? { size, data: r.toPNG(), png: true }
      : { size, data: dib(r.toBitmap(), size), png: false };
  });
  fs.writeFileSync(OUT_ICO, buildIco(entries));

  const tray = img.resize({ width: TRAY, height: TRAY, quality: 'best' });
  fs.writeFileSync(OUT_TRAY, tray.toPNG());

  // The recording variant: the same image with a filled amber dot in the
  // bottom-right, sized to survive the shell scaling this down to 16 px.
  const px = new Uint8ClampedArray(tray.toBitmap());       // premultiplied BGRA
  const R = 7;
  const cx = TRAY - R - 1;
  const cy = TRAY - R - 1;
  for (let y = 0; y < TRAY; y++) {
    for (let x = 0; x < TRAY; x++) {
      const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (d > R + 0.5) continue;
      const cover = Math.min(1, R + 0.5 - d);              // soft edge, 1 px
      const i = (y * TRAY + x) * 4;
      // opaque dot over whatever was there: premultiplied blend at full alpha
      px[i] = Math.round(AMBER.b * cover + px[i] * (1 - cover));
      px[i + 1] = Math.round(AMBER.g * cover + px[i + 1] * (1 - cover));
      px[i + 2] = Math.round(AMBER.r * cover + px[i + 2] * (1 - cover));
      px[i + 3] = Math.max(px[i + 3], Math.round(cover * 255));
    }
  }
  fs.writeFileSync(OUT_TRAY_REC,
    nativeImage.createFromBitmap(px, { width: TRAY, height: TRAY }).toPNG());

  console.log(`source : ${path.basename(SRC)}  ${img.getSize().width}×${img.getSize().height}`);
  console.log(`${path.basename(OUT_ICO)}  ${(fs.statSync(OUT_ICO).size / 1024).toFixed(0)} KB  (${ICO_SIZES.join(', ')})`);
  console.log(`${path.basename(OUT_TRAY)} + ${path.basename(OUT_TRAY_REC)}  ${TRAY}px`);
  app.exit(0);
});
