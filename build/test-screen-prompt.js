// The Screen Recording dead end, driven in the real window.
//
// Worth a test precisely because the old version *looked* fine: it told the
// user to allow the permission "then record again", which macOS does not
// honour for a process that was already running. Following the instruction
// exactly produced a second one-sided recording and no explanation. What is
// pinned here is that the two things the user cannot do from inside the app
// are on screen and reachable, and that a helper dying mid-meeting — a
// different problem with a different answer — does not raise this prompt.
//
// Not covered: the guard that holds the reopen button back while a meeting is
// in the air. Reaching it needs a real recording, so it needs a microphone;
// `stopAndProcess` re-enables the button and both live in `app.js`.
const { app } = require('electron');
const { sandbox, logger, mainWindow, watchdog, within } = require('./harness');

const ROOT = sandbox('screen-prompt');
const say = logger(ROOT);

let fails = 0;
function check(name, ok, detail) {
  if (ok) say(`ok    ${name}`);
  else { fails++; say(`FAIL  ${name}\n      ${JSON.stringify(detail)}`); }
}

const state = win => win.webContents.executeJavaScript(`(() => {
  const p = document.getElementById('screen-prompt');
  return {
    hidden: p.classList.contains('hidden'),
    text: p.innerText.replace(/\\s+/g, ' ').trim(),
    buttons: [...p.querySelectorAll('button')].map(b => b.id).join(',')
  };
})()`);

const pause = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  const timer = watchdog(say);
  try {
    require('../main.js');
    const win = await within(mainWindow(), 'la ventana principal');

    check('el aviso empieza oculto', (await state(win)).hidden, await state(win));

    // Exactamente por donde llega en producción: el helper nativo vive fuera
    // de este proceso, así que su veredicto entra por el canal, no por la UI.
    win.webContents.send('system-audio-status', { ok: false, reason: 'permission' });
    await pause(400);

    const shown = await state(win);
    check('un permiso denegado levanta el aviso', shown.hidden === false, shown);
    check('con los tres botones', shown.buttons, 'sp-settings,sp-relaunch,sp-dismiss');
    check('y dice que hay que reabrir, no "grabar otra vez"',
      /reopen/i.test(shown.text) && !/record again/i.test(shown.text), shown.text);

    await win.webContents.executeJavaScript(
      `document.getElementById('sp-dismiss').click(), true`);
    await pause(250);
    check('descartar lo cierra', (await state(win)).hidden, await state(win));

    // Una caída a mitad de reunión no se arregla con permisos ni reabriendo,
    // así que tiene su propio mensaje y no debe levantar este aviso.
    win.webContents.send('system-audio-status', { ok: false, reason: 'stopped' });
    await pause(400);
    check('una caída a media reunión no levanta el aviso del permiso',
      (await state(win)).hidden, await state(win));

    // El helper ausente sí, porque la salida es la misma: concederlo y reabrir.
    win.webContents.send('system-audio-status', { ok: false, reason: 'helper' });
    await pause(400);
    check('un helper ausente sí lo levanta',
      (await state(win)).hidden === false, await state(win));
  } catch (err) {
    fails++;
    say('FAIL  ' + (err.stack || err.message));
  }
  clearTimeout(timer);
  say(fails ? `\n${fails} fallos` : '\nPASS');
  app.exit(fails ? 1 : 0);
});
