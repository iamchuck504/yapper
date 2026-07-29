// The collapsed bubble must be wide enough for its own controls: the Stop
// button was being clipped by a hardcoded width. Opens the real bubble window
// and checks that nothing overflows the card, in every state that changes how
// wide the row wants to be.
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

let fails = 0;
function check(name, ok, detail) {
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      ${detail}`); }
}

app.whenReady().then(async () => {
  let size = null;
  ipcMain.on('bubble-resize', (_e, s) => { size = s; });
  // the bubble talks to the main window for these; swallow them
  for (const ch of ['bubble-stop', 'bubble-pause', 'bubble-focus-main']) ipcMain.on(ch, () => {});

  const w = new BrowserWindow({
    width: 470, height: 280, show: false, frame: false, transparent: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true, nodeIntegration: false
    }
  });
  await w.loadFile(path.join(__dirname, '..', 'renderer', 'bubble.html'));

  // start collapsed, whatever the saved preference is
  await w.webContents.executeJavaScript(
    "localStorage.setItem('yapper-bubble-collapsed','yes'); location.reload();");
  await new Promise(r => w.webContents.once('did-finish-load', r));
  await w.webContents.executeJavaScript('document.fonts.ready');
  await new Promise(r => setTimeout(r, 250));

  // measure with the window actually set to the size the renderer asked for
  const probe = async label => {
    if (size) w.setBounds({ x: 100, y: 100, width: size.w, height: size.h });
    await new Promise(r => setTimeout(r, 120));
    const m = await w.webContents.executeJavaScript(`(() => {
      const card = document.getElementById('card');
      const header = document.querySelector('header');
      const stop = document.getElementById('btn-stop');
      const c = card.getBoundingClientRect(), s = stop.getBoundingClientRect();
      return {
        winW: window.innerWidth, winH: window.innerHeight,
        cardRight: c.right, stopRight: s.right, stopW: s.width,
        headerScroll: header.scrollWidth, headerClient: header.clientWidth,
        timer: document.getElementById('timer').textContent,
        pause: document.getElementById('btn-pause').textContent
      };
    })()`);
    console.log(`\n[${label}] ventana ${size.w}x${size.h}  timer "${m.timer}"  boton "${m.pause}"`);
    check(`${label}: la fila cabe en el header`,
      m.headerScroll <= m.headerClient,
      `contenido ${m.headerScroll}px en ${m.headerClient}px disponibles`);
    check(`${label}: Stop entero dentro de la tarjeta`,
      m.stopRight <= m.cardRight + 0.5,
      `Stop termina en ${m.stopRight.toFixed(1)}px, la tarjeta en ${m.cardRight.toFixed(1)}px`);
    check(`${label}: Stop conserva su ancho`, m.stopW > 40, `mide ${m.stopW.toFixed(1)}px`);
  };

  await probe('normal');

  // "Resume" is wider than "Pause" — driven through the real IPC path, not by
  // poking the DOM, so the refit has to happen the way it does in the app
  w.webContents.send('bubble-state', { paused: true });
  await new Promise(r => setTimeout(r, 200));
  await probe('pausado');

  // a meeting past the hour mark grows the timer
  w.webContents.send('bubble-state', { timer: '01:23:45' });
  await new Promise(r => setTimeout(r, 200));
  await probe('mas de una hora');

  console.log(fails ? `\n${fails} fallos` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(e => { console.log('FAIL', e.message); app.exit(1); });
