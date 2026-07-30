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
  console.log(`\n[capsule] window ${size.w}x${size.h}  timer "${m.timer}"`);
  check('at rest it is a capsule', m.pill && m.radius === '999px', JSON.stringify({ pill: m.pill, radius: m.radius }));
  check('genuinely tiny', size.w < 200 && size.h < 60, `${size.w}x${size.h}`);
  check('no buttons in sight', !m.stopShown, 'Stop is visible on the capsule');
  check('and still nothing overflows', m.headerScroll <= m.headerClient,
    `content ${m.headerScroll}px in ${m.headerClient}px`);

  // ---- the level moves the bars, in order ----
  for (const lv of [0.9, 0.5, 0.1]) {
    w.webContents.send('bubble-state', { level: lv });
    await new Promise(r => setTimeout(r, 30));
  }
  m = await state();
  console.log(`  barras: ${m.bars.join('  ')}`);
  check('the bars follow the level, newest first',
    /0\.28/.test(m.bars[0]) && /0\.6/.test(m.bars[1]) && /0\.92/.test(m.bars[2]),
    JSON.stringify(m.bars));

  // ---- hover opens; the timer keeps fitting while it grows ----
  await hover(true);
  m = await state();
  console.log(`[hover] window ${size.w}x${size.h}  button "${m.pause}"`);
  check('hovering opens the card', !m.pill && size.w === 470 && size.h === 280,
    JSON.stringify({ pill: m.pill, size }));
  check('with the transcript in view', await w.webContents.executeJavaScript(
    "getComputedStyle(document.getElementById('text')).display !== 'none'"), 'is still hidden');
  check('the row fits in the header', m.headerScroll <= m.headerClient,
    `content ${m.headerScroll}px in ${m.headerClient}px`);
  check('Stop fits entirely inside the card', m.stopShown && m.stopRight <= m.cardRight + 0.5,
    `Stop ends at ${m.stopRight.toFixed(1)}px, the card at ${m.cardRight.toFixed(1)}px`);
  check('Stop keeps its width', m.stopW > 40, `mide ${m.stopW.toFixed(1)}px`);

  // pausing while open: "Resume" is wider than "Pause"
  w.webContents.send('bubble-state', { paused: true });
  await new Promise(r => setTimeout(r, 150));
  m = await state();
  check('paused, it still fits', m.pause === 'Resume' && m.headerScroll <= m.headerClient,
    JSON.stringify({ pause: m.pause, scroll: m.headerScroll, client: m.headerClient }));
  w.webContents.send('bubble-state', { paused: false });

  // ---- leaving closes it again ----
  await hover(false);
  m = await state();
  check('leaving hover collapses it back to a capsule', m.pill && size.w < 200, JSON.stringify({ pill: m.pill, size }));

  // a meeting past the hour mark grows the timer while resting
  w.webContents.send('bubble-state', { timer: '01:23:45' });
  await new Promise(r => setTimeout(r, 200));
  await applySize();
  m = await state();
  console.log(`[capsule, +1h] window ${size.w}x${size.h}  timer "${m.timer}"`);
  check('a meeting of several hours still fits in the capsule',
    m.headerScroll <= m.headerClient, `content ${m.headerScroll}px in ${m.headerClient}px`);

  // ---- the pin holds it open, and survives a restart ----
  await hover(true);
  await w.webContents.executeJavaScript("document.getElementById('btn-pin').click()");
  await new Promise(r => setTimeout(r, 120));
  m = await state();
  check('the pin is set', m.pinOn, 'was not set');
  await hover(false);
  m = await state();
  check('with the pin set, leaving hover does not close it', !m.pill && size.w === 470,
    JSON.stringify({ pill: m.pill, size }));

  await w.webContents.executeJavaScript('location.reload()');
  await new Promise(r => w.webContents.once('did-finish-load', r));
  await new Promise(r => setTimeout(r, 300));
  await applySize();
  m = await state();
  check('the pin survives a restart', !m.pill && m.pinOn, JSON.stringify({ pill: m.pill, pinOn: m.pinOn }));

  // unpin: back to a capsule once the cursor leaves
  await w.webContents.executeJavaScript("document.getElementById('btn-pin').click()");
  await hover(false);
  m = await state();
  check('without the pin it goes back to a capsule', m.pill, JSON.stringify({ pill: m.pill, size }));

  // ---- the old preference maps onto the pin ----
  await w.webContents.executeJavaScript(
    "localStorage.removeItem('yapper-bubble-pinned');"
    + "localStorage.setItem('yapper-bubble-collapsed','no'); location.reload();");
  await new Promise(r => w.webContents.once('did-finish-load', r));
  await new Promise(r => setTimeout(r, 300));
  m = await state();
  check('anyone who had it always open keeps it open (pin migrated)',
    !m.pill && m.pinOn, JSON.stringify({ pill: m.pill, pinOn: m.pinOn }));

  console.log(fails ? `\n${fails} fallos` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(e => { console.log('FAIL', e.message); app.exit(1); });
