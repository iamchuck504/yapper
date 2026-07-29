// Drives the real Settings row: pick a provider, save a key, read it back.
// The point is that the key round-trips through the main process and comes back
// as "there is one" rather than as itself.
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const USER_DATA = path.join(app.getPath('temp'), 'yapper-llm-ui-test');
app.setPath('userData', USER_DATA);
fs.rmSync(USER_DATA, { recursive: true, force: true });

let fails = 0;
function check(name, ok, detail) {
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      ${detail}`); }
}

// booting main.js registers every handler and opens the real window
require('../main.js');

const KEY = 'sk-or-test-abcdef0123456789';

app.whenReady().then(async () => {
  const win = await new Promise(resolve => {
    const tick = setInterval(() => {
      const w = require('electron').BrowserWindow.getAllWindows()
        .find(x => x.webContents.getURL().includes('index.html'));
      if (w) { clearInterval(tick); resolve(w); }
    }, 200);
  });
  await new Promise(r => win.webContents.once('did-finish-load', r));
  await new Promise(r => setTimeout(r, 1500));   // let the settings load

  const $ = js => win.webContents.executeJavaScript(js);

  check('el selector de proveedor existe y tiene opciones',
    (await $("document.getElementById('llm-provider').options.length")) >= 4,
    'no se llenó');

  check('arranca en Claude Code',
    (await $("document.getElementById('llm-provider').value")) === 'claude-cli',
    await $("document.getElementById('llm-provider').value"));

  check('con Claude Code no pide key',
    await $("document.getElementById('llm-key-row').classList.contains('hidden')"),
    'la fila de key está visible');

  // switch to OpenRouter and type a key, exactly as a user would
  await $(`(() => {
    const s = document.getElementById('llm-provider');
    s.value = 'openrouter';
    s.dispatchEvent(new Event('change'));
  })()`);
  await new Promise(r => setTimeout(r, 400));

  check('al elegir OpenRouter aparece la fila de key',
    !(await $("document.getElementById('llm-key-row').classList.contains('hidden')")),
    'sigue oculta');
  check('sugiere el modelo por defecto del proveedor',
    !!(await $("document.getElementById('llm-model').placeholder")),
    'sin placeholder');

  await $(`(() => {
    const k = document.getElementById('llm-key');
    k.value = ${JSON.stringify(KEY)};
    k.dispatchEvent(new Event('change'));
  })()`);
  await new Promise(r => setTimeout(r, 600));

  const after = await $('window.yapper.getLlmSettings()');
  check('el proveedor quedó guardado', after.provider === 'openrouter', after.provider);
  check('dice que hay una key guardada', after.hasKey === true, JSON.stringify(after));
  check('NO devuelve la key al renderer',
    !JSON.stringify(after).includes(KEY), JSON.stringify(after).slice(0, 120));
  check('el campo de key se vacía tras guardar',
    (await $("document.getElementById('llm-key').value")) === '', 'quedó texto en pantalla');

  const raw = fs.readFileSync(path.join(USER_DATA, 'settings.json'), 'utf8');
  check('la key NO está legible en settings.json', !raw.includes(KEY), raw.slice(0, 200));
  check('quedó marcada como cifrada', /"enc":\s*true/.test(raw), raw.slice(0, 200));

  // the preflight has to notice that notes are now possible
  const env = await $('window.yapper.checkEnvironment()');
  check('el chequeo de arranque ve que ya se pueden generar notas',
    env.notes && env.notes.ok === true, JSON.stringify(env.notes));

  console.log(fails ? `\n${fails} fallos` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(e => { console.log('FAIL', e.stack || e.message); app.exit(1); });
