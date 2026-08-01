// Permissions asked at launch, not in the middle of a meeting.
//
// macOS asks the first time something is used, which for a meeting recorder is
// the worst possible moment: the call has started, someone is talking, and the
// app is putting dialogs on screen. The system-audio one is worse than a
// yes/no — it needs the app reopened before it applies — so answering it
// mid-meeting still leaves that meeting recorded one-sided.
//
// The microphone has an API to ask with. System audio does not: the permission
// is triggered by *creating* a tap, so the helper is run for a moment. What
// this pins is that the moment ends — a helper left running holds a tap on
// everything the machine plays — and that it happens once rather than on every
// launch.
const { app } = require('electron');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { sandbox, logger, mainWindow, watchdog } = require('./harness');

if (process.platform !== 'darwin') {
  console.log('skip  estos permisos son de macOS');
  process.exit(0);
}

const ROOT = sandbox('permissions-early');
const say = logger(ROOT);

let fails = 0;
function check(name, ok, detail) {
  if (ok) say(`ok    ${name}`);
  else { fails++; say(`FAIL  ${name}\n      ${detail || ''}`); }
}

const pause = ms => new Promise(r => setTimeout(r, ms));
const HELPER = path.join(__dirname, 'system-audio');
const running = () => Number(execSync(`pgrep -f ${HELPER} | wc -l`).toString().trim());
const settings = () => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'user', 'settings.json'), 'utf8')); }
  catch { return {}; }
};

app.whenReady().then(async () => {
  const timer = watchdog(say, 200000);
  try {
    require('../main.js');

    // Muestreado desde antes de que la ventana esté lista. Con el permiso ya
    // concedido el sondeo termina en cuanto el helper dice "capturing" —
    // cientos de milisegundos — y el harness tarda más que eso en devolver la
    // ventana, así que cualquier lectura posterior llegaría tarde siempre.
    let seen = false;
    const watching = setInterval(() => { if (running() >= 1) seen = true; }, 40);

    const win = await mainWindow();
    await pause(3500);
    clearInterval(watching);

    check('sondea el permiso de audio al arrancar', seen, 'nunca apareció un helper');
    // Suelta el tap: un helper que sigue vivo captura todo lo que suena en la
    // máquina, sin ventana y sin forma de notarlo.
    check('y lo suelta, sin dejar un tap abierto', running() === 0, `quedan ${running()}`);

    // Sin bandera de "ya preguntado": macOS tira estos permisos cuando cambia
    // la identidad de código de la app, que con firma ad-hoc es cada build. Una
    // bandera por versión decía que ya se había preguntado mientras el permiso
    // llevaba seis reinstalaciones borrado, y la app volvía a preguntar a media
    // reunión — justo lo que esto existe para evitar.
    check('no se apoya en una bandera que la identidad de código invalida',
      settings().permissionsAskedBy === undefined,
      JSON.stringify(settings().permissionsAskedBy));

    // Priming must not have broken the thing it exists to smooth.
    const $ = js => win.webContents.executeJavaScript(js, true);
    await $('startRecording()');
    await pause(2500);
    check('grabar sigue funcionando después', await $('recording'));
    check('y la grabación tiene su propio helper', running() >= 1, `helpers: ${running()}`);
    await $('stopAndProcess()').catch(() => { });
  } catch (err) {
    fails++;
    say('FAIL  ' + (err.stack || err.message));
  }
  clearTimeout(timer);
  say(fails ? `\n${fails} fallos` : '\nPASS');
  app.exit(fails ? 1 : 0);
});
