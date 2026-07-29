// The splash draws the icon from a file now, and its page has a strict CSP —
// a blocked image would leave a silent empty box that nobody notices until a
// coworker opens the app. So load the real splash and check the mark actually
// rendered, by capturing it and looking at the pixels.
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, nativeImage } = require('electron');

const SHOT = path.join(app.getPath('temp'), 'yapper-splash-shot.png');

let fails = 0;
function check(name, ok, detail) {
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      ${detail}`); }
}

app.whenReady().then(async () => {
  const blocked = [];
  const win = new BrowserWindow({
    width: 320, height: 300, show: false, frame: false, transparent: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true }
  });
  // a CSP violation shows up here, not as an exception
  win.webContents.on('console-message', (_e, _lvl, message) => {
    if (/Content Security Policy|Refused to load/i.test(message)) blocked.push(message);
  });

  await win.loadFile(path.join(__dirname, '..', 'renderer', 'splash.html'));
  await new Promise(r => setTimeout(r, 900));

  check('la política de seguridad no bloqueó nada', blocked.length === 0, blocked.join('\n      '));

  const loaded = await win.webContents.executeJavaScript(`(() => {
    const m = document.querySelector('img.mark');
    if (!m) return { found: false };
    return { found: true, complete: m.complete, w: m.naturalWidth, h: m.naturalHeight };
  })()`);
  check('el splash tiene la marca', loaded.found, 'no hay <img class="mark">');
  check('la imagen cargó de verdad',
    loaded.complete && loaded.naturalWidth !== 0 && loaded.w > 0,
    `complete=${loaded.complete} natural=${loaded.w}×${loaded.h}`);

  const shot = await win.webContents.capturePage();
  fs.writeFileSync(SHOT, shot.toPNG());
  const { width: w, height: h } = shot.getSize();
  const px = shot.toBitmap();

  // the mark is the only orange thing up there; if it painted, those pixels exist
  let orange = 0;
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    const b = px[i], g = px[i + 1], r = px[i + 2];
    if (r > 180 && g > 110 && g < 200 && b < 120) orange++;
  }
  check('se ve el naranja de la marca', orange > 300, `${orange} píxeles naranjas en ${w}×${h}`);
  console.log(`\ncaptura: ${SHOT}`);

  win.destroy();
  console.log(fails ? `\n${fails} fallos` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(e => { console.log('FAIL', e.stack || e.message); app.exit(1); });
