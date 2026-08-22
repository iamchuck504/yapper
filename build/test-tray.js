// The menu bar item, driven in the real app.
//
// It exists because the app spends a meeting behind the call it is recording,
// and the one thing needed then is to stop it without finding the window
// first.
//
// The failure worth catching is the quiet one. createTray() skips itself when
// the icon will not load — deliberately, since nothing it offers is unreachable
// from the window — so a missing or malformed template would take the whole
// feature away with no error anywhere. That is what most of this checks.
//
// Not covered: the menu's labels. They live on a Tray instance main.js keeps to
// itself, and the only ways to read them from here are a test-only global or a
// screenshot of the menu bar. The decision behind them is one ternary on
// `rendererRecording`, which the recording drive below at least exercises.
const { app, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { sandbox, logger, mainWindow, watchdog } = require('./harness');

if (process.platform !== 'darwin' && process.platform !== 'win32') {
  console.log('skip  no tray on this platform');
  process.exit(0);
}

const ROOT = sandbox('tray');
const say = logger(ROOT);

let fails = 0;
function check(name, got, want = true) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) say(`ok    ${name}`);
  else { fails++; say(`FAIL  ${name}\n      esperaba ${JSON.stringify(want)}\n      obtuve   ${JSON.stringify(got)}`); }
}

const pause = ms => new Promise(r => setTimeout(r, ms));

// main.js registers its app:// scheme as privileged at module level, which
// Electron only allows before the app is ready — so it is loaded up front.
require('../main.js');

app.whenReady().then(async () => {
  const timer = watchdog(say);
  try {
    if (process.platform === 'darwin') {
      const icon1x = path.join(__dirname, 'yapper-tray-Template.png');
      const icon2x = path.join(__dirname, 'yapper-tray-Template@2x.png');

      check('the template icon exists', fs.existsSync(icon1x));
      check('and the @2x that Retina screens draw', fs.existsSync(icon2x));

      const img = nativeImage.createFromPath(icon1x);
      check('the icon loads as an image', !img.isEmpty());
      check('at the height the menu bar asks for', img.getSize(), { width: 18, height: 18 });

      // A template is carried entirely by its alpha: black artwork, transparent
      // tile. If the amber ever survived into it, the menu bar would show a
      // coloured square instead of a mark.
      const px = img.toBitmap();
      let coloured = 0, opaque = 0;
      for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3] > 8) {
          opaque++;
          if (px[i] > 24 || px[i + 1] > 24 || px[i + 2] > 24) coloured++;
        }
      }
      check('it has a visible mark', opaque > 30);
      check('and not one coloured pixel: it is black artwork on alpha', coloured, 0);
    } else {
      // Windows is the opposite of a template: the tray wears the app icon in
      // colour, and the recording state is a second image with an amber dot,
      // because there is no setTitle off macOS to say it any other way.
      const resting = nativeImage.createFromPath(path.join(__dirname, 'yapper-tray-win.png'));
      const recording = nativeImage.createFromPath(path.join(__dirname, 'yapper-tray-win-rec.png'));
      check('the resting icon loads', !resting.isEmpty());
      check('the recording icon loads', !recording.isEmpty());
      check('at tray size', resting.getSize(), { width: 32, height: 32 });

      const amberish = img => {
        const px = img.toBitmap();
        let n = 0;
        for (let i = 0; i < px.length; i += 4) {
          // BGRA: the amber mark is red-heavy and green-warm, never blue-heavy
          if (px[i + 3] > 128 && px[i + 2] > 120 && px[i + 2] > px[i] + 40) n++;
        }
        return n;
      };
      const warm = amberish(resting);
      say(`  · amber pixels in the mark: ${warm}`);
      check('the mark carries its amber', warm > 40);

      // The dot has to be a visible difference, or the state reads as nothing.
      const a = resting.toBitmap(); const b = recording.toBitmap();
      let differing = 0;
      for (let i = 0; i < a.length; i += 4) {
        if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 30) differing++;
      }
      say(`  · pixels the dot changes: ${differing}`);
      check('the recording variant is visibly different (the dot)', differing > 80);
    }

    // The rest is the app: the tray follows the renderer's recording state, so
    // a real recording is what moves it.
    const win = await mainWindow();
    await pause(600);

    await win.webContents.executeJavaScript('startRecording()', true);
    await pause(2500);
    check('genuinely recording', await win.webContents.executeJavaScript('recording', true));

    await win.webContents.executeJavaScript('stopAndProcess()', true).catch(() => { });
    await pause(2000);
    check('and the state returns on stopping',
      await win.webContents.executeJavaScript('recording', true), false);
  } catch (err) {
    fails++;
    say('FAIL  ' + (err.stack || err.message));
  }
  clearTimeout(timer);
  say(fails ? `\n${fails} failures` : '\nPASS');
  app.exit(fails ? 1 : 0);
});
