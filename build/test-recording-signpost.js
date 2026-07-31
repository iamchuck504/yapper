// Can you find your way back to a recording you walked away from?
//
// Found in a real meeting, which is the only place it could have been found:
// open Action items mid-recording and the record view — with the stop button,
// the timer and every toggle — has no visible route back. "New meeting" is the
// route, and it works, but a button offering to start something is the last
// place anyone looks for the thing already running. Nothing else on screen
// said a recording was in progress either.
//
// One control answers both, so this checks both: the sidebar button becomes
// the indicator while recording, and it is still the way back.
const { app } = require('electron');
const { sandbox, logger, mainWindow, watchdog } = require('./harness');

const ROOT = sandbox('signpost');
const say = logger(ROOT);

let fails = 0;
function check(name, got, want = true) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) say(`ok    ${name}`);
  else { fails++; say(`FAIL  ${name}\n      esperaba ${JSON.stringify(want)}\n      obtuve   ${JSON.stringify(got)}`); }
}

const pause = ms => new Promise(r => setTimeout(r, ms));

const sidebar = win => win.webContents.executeJavaScript(`(() => {
  const b = document.getElementById('btn-new');
  const pip = b.querySelector('.rec-pip');
  return {
    label: document.getElementById('btn-new-label').textContent,
    recording: b.classList.contains('recording'),
    pipShown: getComputedStyle(pip).display !== 'none',
    plusShown: getComputedStyle(b.querySelector('.new-plus')).display !== 'none',
    title: b.title
  };
})()`);

const view = win => win.webContents.executeJavaScript(
  `document.getElementById('view-record').classList.contains('hidden') ? 'otra' : 'record'`);

app.whenReady().then(async () => {
  const timer = watchdog(say);
  try {
    require('../main.js');
    const win = await mainWindow();
    const $ = js => win.webContents.executeJavaScript(js, true);

    const idle = await sidebar(win);
    check('en reposo ofrece empezar', idle.label, 'New meeting');
    check('sin punto de grabación', idle.pipShown, false);
    check('con el signo de más', idle.plusShown);

    await $('startRecording()');
    await pause(2500);

    const live = await sidebar(win);
    check('grabando, el botón lo dice', live.recording);
    check('y lleva el reloj, no "New meeting"', /^Recording — \d\d:\d\d/.test(live.label));
    check('el punto sustituye al más', [live.pipShown, live.plusShown], [true, false]);
    check('y el tooltip dice para qué sirve ahora',
      /back to the controls/i.test(live.title));

    // El caso exacto que lo destapó: irse a Action items y tener que volver.
    await $(`document.getElementById('btn-reminders').click()`);
    await pause(700);
    check('me fui a otra vista', await view(win), 'otra');
    check('y el aviso sigue visible desde ahí', (await sidebar(win)).recording);

    await $(`document.getElementById('btn-new').click()`);
    await pause(700);
    check('el mismo botón me regresa a los controles', await view(win), 'record');
    check('sin arrancar una segunda grabación', await $('recording'));

    await $('stopAndProcess()').catch(() => { });
    await pause(2000);
    const after = await sidebar(win);
    check('al parar vuelve a ofrecer empezar', after.label, 'New meeting');
    check('y el punto se va', [after.recording, after.pipShown], [false, false]);
  } catch (err) {
    fails++;
    say('FAIL  ' + (err.stack || err.message));
  }
  clearTimeout(timer);
  say(fails ? `\n${fails} fallos` : '\nPASS');
  app.exit(fails ? 1 : 0);
});
