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

if (process.platform !== 'darwin') {
  console.log('skip  the menu bar item is macOS-only');
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

app.whenReady().then(async () => {
  const timer = watchdog(say);
  try {
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

    // The rest is the app: the tray follows the renderer's recording state, so
    // a real recording is what moves it.
    require('../main.js');
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
