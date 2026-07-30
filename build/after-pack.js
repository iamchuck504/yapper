// Gives the macOS build a real dark-appearance icon.
//
// macOS 26 renders legacy .icns files through an automatic appearance pass. On
// a Mac set to dark icons it darkens the tile and keeps the artwork — which for
// Yapper means the near-black mark sits on a near-black tile, and the icon
// lands in the dock as a black slab. The system only leaves an icon alone when
// the app ships the appearance itself, and the only way to ship one is a
// compiled asset catalog: CFBundleIconName pointing at an AppIcon inside
// Assets.car, with the dark images marked as such.
//
// electron-builder has no idea about any of this — it writes icon.icns and
// stops — so the catalog is built here, after packaging and before the dmg and
// zip are cut from the .app.
//
// Compiling a catalog needs actool, which ships with Xcode and not with the
// Command Line Tools. Without it the build still succeeds and still installs;
// the icon is simply the legacy one, dark-slabbed as before. That is a warning,
// not an error: a Windows release must not depend on a 10 GB Xcode install.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

// macOS asks for each size at 1x and 2x; @2x of 512 is the 1024 master.
const SIZES = [[16, '1x', 16], [16, '2x', 32], [32, '1x', 32], [32, '2x', 64],
[128, '1x', 128], [128, '2x', 256], [256, '1x', 256], [256, '2x', 512],
[512, '1x', 512], [512, '2x', 1024]];

const DARK = [{ appearance: 'luminosity', value: 'dark' }];

// /usr/bin/actool exists even with only the Command Line Tools installed — it
// is a shim that fails at runtime with an xcode-select error. Presence proves
// nothing, so each candidate is asked to do something and judged on whether it
// could. Xcode's own copy is tried too: a freshly installed Xcode is not the
// active developer directory until someone runs `sudo xcode-select -s`, and
// this build has no business demanding a password.
function findActool() {
  const candidates = [
    { bin: 'actool', env: process.env },
    ...['/Applications/Xcode.app', '/Applications/Xcode-beta.app']
      .map(app => ({
        bin: path.join(app, 'Contents/Developer/usr/bin/actool'),
        env: { ...process.env, DEVELOPER_DIR: path.join(app, 'Contents/Developer') }
      }))
  ];
  for (const c of candidates) {
    if (c.bin !== 'actool' && !fs.existsSync(c.bin)) continue;
    if (spawnSync(c.bin, ['--version'], { env: c.env, encoding: 'utf8' }).status === 0) return c;
  }
  return null;
}

function scale(src, px, dest) {
  const r = spawnSync('sips', ['-s', 'format', 'png', '-Z', String(px), src, '--out', dest],
    { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`sips failed on ${path.basename(src)}: ${r.stderr}`);
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const app = path.join(context.appOutDir, `${appName}.app`);
  const resources = path.join(app, 'Contents', 'Resources');
  const plist = path.join(app, 'Contents', 'Info.plist');
  const buildDir = __dirname;
  const light = path.join(buildDir, 'yapper-icon.png');
  const dark = path.join(buildDir, 'yapper-icon-dark.png');

  if (!fs.existsSync(dark)) {
    console.log('[icon] no yapper-icon-dark.png — run build/icon-dark.js; keeping the legacy icon');
    return;
  }
  const actool = findActool();
  if (!actool) {
    console.log('[icon] actool unavailable (needs full Xcode, not Command Line Tools).');
    console.log('[icon] shipping the legacy .icns — macOS will draw it dark-slabbed on dark-icon Macs.');
    return;
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'yapper-icon-'));
  try {
    const set = path.join(work, 'Yapper.xcassets', 'AppIcon.appiconset');
    fs.mkdirSync(set, { recursive: true });

    const images = [];
    const done = new Set();
    for (const [size, scaleName, px] of SIZES) {
      for (const [variant, src] of [['light', light], ['dark', dark]]) {
        const file = `${variant}_${px}.png`;
        if (!done.has(file)) { scale(src, px, path.join(set, file)); done.add(file); }
        const entry = { filename: file, idiom: 'mac', scale: scaleName, size: `${size}x${size}` };
        if (variant === 'dark') entry.appearances = DARK;
        images.push(entry);
      }
    }
    fs.writeFileSync(path.join(set, 'Contents.json'),
      JSON.stringify({ images, info: { author: 'yapper', version: 1 } }, null, 2));

    const out = path.join(work, 'out');
    fs.mkdirSync(out);
    const r = spawnSync(actool.bin, [
      '--compile', out,
      '--platform', 'macosx',
      '--minimum-deployment-target', '11.0',
      '--app-icon', 'AppIcon',
      '--output-partial-info-plist', path.join(work, 'partial.plist'),
      path.join(work, 'Yapper.xcassets')
    ], { env: actool.env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`actool failed: ${(r.stderr || r.stdout || '').slice(0, 400)}`);

    const car = path.join(out, 'Assets.car');
    if (!fs.existsSync(car)) throw new Error('actool produced no Assets.car');
    fs.copyFileSync(car, path.join(resources, 'Assets.car'));

    // CFBundleIconFile stays: it is what older macOS reads, and what the
    // Finder falls back to. CFBundleIconName is what points at the catalog.
    const set_ = spawnSync('/usr/libexec/PlistBuddy',
      ['-c', 'Add :CFBundleIconName string AppIcon', plist], { encoding: 'utf8' });
    if (set_.status !== 0) {
      spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleIconName AppIcon', plist]);
    }
    console.log('[icon] Assets.car compiled with light and dark appearances');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
};
