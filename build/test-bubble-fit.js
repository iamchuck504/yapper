// The bubble, in its three states: the resting capsule, the hover-open card,
// and pinned. The capsule must fit its own contents (a hardcoded width once
// clipped the Stop button), hover must open and leave must close it, the pin
// must survive a reload, and the bars must move with the level they are sent.
//
// Hover here is the same message the app's cursor watcher sends — the page has
// no DOM hover of its own, because Electron delivers no mouse events over a
// drag region on Windows.
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

  // a clean slate, whatever this machine's saved preference is
  await w.webContents.executeJavaScript(
    "localStorage.removeItem('yapper-bubble-pinned');"
    + "localStorage.removeItem('yapper-bubble-collapsed'); location.reload();");
  await new Promise(r => w.webContents.once('did-finish-load', r));
  await w.webContents.executeJavaScript('document.fonts.ready');
  await new Promise(r => setTimeout(r, 250));

  const state = () => w.webContents.executeJavaScript(`(() => {
    const card = document.getElementById('card');
    const header = document.querySelector('header');
    const stop = document.getElementById('btn-stop');
    const c = card.getBoundingClientRect(), s = stop.getBoundingClientRect();
    return {
      pill: document.body.classList.contains('pill'),
      cardRight: c.right, stopRight: s.right, stopW: s.width,
      stopShown: getComputedStyle(stop).display !== 'none',
      headerScroll: header.scrollWidth, headerClient: header.clientWidth,
      timer: document.getElementById('timer').textContent,
      pause: document.getElementById('btn-pause').textContent,
      pinOn: document.getElementById('btn-pin').classList.contains('on'),
      radius: getComputedStyle(card).borderRadius,
      bars: [...document.querySelectorAll('.eq i')].map(b => b.style.transform)
    };
  })()`);
  const applySize = async () => {
    if (size) w.setBounds({ x: 100, y: 100, width: size.w, height: size.h });
    await new Promise(r => setTimeout(r, 120));
  };
  const hover = async on => {
    w.webContents.send('bubble-state', { hover: on });
    await new Promise(r => setTimeout(r, on ? 150 : 450));   // leave has a grace period
    await applySize();
  };

  // ---- resting: the capsule ----
  await applySize();
  let m = await state();
  console.log(`\n[capsula] ventana ${size.w}x${size.h}  timer "${m.timer}"`);
  check('descansando es una cápsula', m.pill && m.radius === '999px', JSON.stringify({ pill: m.pill, radius: m.radius }));
  check('chiquita de verdad', size.w < 200 && size.h < 60, `${size.w}x${size.h}`);
  check('sin botones a la vista', !m.stopShown, 'Stop visible en la cápsula');
  check('y aun así nada se desborda', m.headerScroll <= m.headerClient,
    `contenido ${m.headerScroll}px en ${m.headerClient}px`);

  // ---- the level moves the bars, in order ----
  for (const lv of [0.9, 0.5, 0.1]) {
    w.webContents.send('bubble-state', { level: lv });
    await new Promise(r => setTimeout(r, 30));
  }
  m = await state();
  console.log(`  barras: ${m.bars.join('  ')}`);
  check('las barras siguen al nivel, la más nueva primero',
    /0\.28/.test(m.bars[0]) && /0\.6/.test(m.bars[1]) && /0\.92/.test(m.bars[2]),
    JSON.stringify(m.bars));

  // ---- hover opens; the timer keeps fitting while it grows ----
  await hover(true);
  m = await state();
  console.log(`[hover] ventana ${size.w}x${size.h}  boton "${m.pause}"`);
  check('el hover abre la tarjeta', !m.pill && size.w === 470 && size.h === 280,
    JSON.stringify({ pill: m.pill, size }));
  check('con el transcript a la vista', await w.webContents.executeJavaScript(
    "getComputedStyle(document.getElementById('text')).display !== 'none'"), 'sigue oculto');
  check('la fila cabe en el header', m.headerScroll <= m.headerClient,
    `contenido ${m.headerScroll}px en ${m.headerClient}px`);
  check('Stop entero dentro de la tarjeta', m.stopShown && m.stopRight <= m.cardRight + 0.5,
    `Stop termina en ${m.stopRight.toFixed(1)}px, la tarjeta en ${m.cardRight.toFixed(1)}px`);
  check('Stop conserva su ancho', m.stopW > 40, `mide ${m.stopW.toFixed(1)}px`);

  // pausing while open: "Resume" is wider than "Pause"
  w.webContents.send('bubble-state', { paused: true });
  await new Promise(r => setTimeout(r, 150));
  m = await state();
  check('pausado sigue cabiendo', m.pause === 'Resume' && m.headerScroll <= m.headerClient,
    JSON.stringify({ pause: m.pause, scroll: m.headerScroll, client: m.headerClient }));
  w.webContents.send('bubble-state', { paused: false });

  // ---- leaving closes it again ----
  await hover(false);
  m = await state();
  check('salir del hover la vuelve cápsula', m.pill && size.w < 200, JSON.stringify({ pill: m.pill, size }));

  // a meeting past the hour mark grows the timer while resting
  w.webContents.send('bubble-state', { timer: '01:23:45' });
  await new Promise(r => setTimeout(r, 200));
  await applySize();
  m = await state();
  console.log(`[cápsula, +1h] ventana ${size.w}x${size.h}  timer "${m.timer}"`);
  check('una reunión de horas sigue cabiendo en la cápsula',
    m.headerScroll <= m.headerClient, `contenido ${m.headerScroll}px en ${m.headerClient}px`);

  // ---- the pin holds it open, and survives a restart ----
  await hover(true);
  await w.webContents.executeJavaScript("document.getElementById('btn-pin').click()");
  await new Promise(r => setTimeout(r, 120));
  m = await state();
  check('el pin se marca', m.pinOn, 'no se marcó');
  await hover(false);
  m = await state();
  check('con pin, salir del hover no la cierra', !m.pill && size.w === 470,
    JSON.stringify({ pill: m.pill, size }));

  await w.webContents.executeJavaScript('location.reload()');
  await new Promise(r => w.webContents.once('did-finish-load', r));
  await new Promise(r => setTimeout(r, 300));
  await applySize();
  m = await state();
  check('el pin sobrevive un reinicio', !m.pill && m.pinOn, JSON.stringify({ pill: m.pill, pinOn: m.pinOn }));

  // unpin: back to a capsule once the cursor leaves
  await w.webContents.executeJavaScript("document.getElementById('btn-pin').click()");
  await hover(false);
  m = await state();
  check('sin pin vuelve a ser cápsula', m.pill, JSON.stringify({ pill: m.pill, size }));

  // ---- the old preference maps onto the pin ----
  await w.webContents.executeJavaScript(
    "localStorage.removeItem('yapper-bubble-pinned');"
    + "localStorage.setItem('yapper-bubble-collapsed','no'); location.reload();");
  await new Promise(r => w.webContents.once('did-finish-load', r));
  await new Promise(r => setTimeout(r, 300));
  m = await state();
  check('quien la tenía siempre abierta la conserva abierta (pin migrado)',
    !m.pill && m.pinOn, JSON.stringify({ pill: m.pill, pinOn: m.pinOn }));

  console.log(fails ? `\n${fails} fallos` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(e => { console.log('FAIL', e.message); app.exit(1); });
