// Drives the real Settings row: pick a provider, save a key, read it back.
// The point is that the key round-trips through the main process and comes back
// as "there is one" rather than as itself.
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { mainWindow } = require('./harness');

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
  const win = await mainWindow();   // let the settings load

  const $ = js => win.webContents.executeJavaScript(js);

  // The provider rows live inside the record view, and the app opens on Today.
  // Measuring them while their own section is display:none reports 0×0 for
  // everything, so "is it actually on screen" could never pass — it was
  // measuring the closed view, not the notice.
  await $(`showView('record')`);
  await new Promise(r => setTimeout(r, 300));

  check('el selector de proveedor existe y tiene opciones',
    (await $("document.getElementById('llm-provider').options.length")) >= 4,
    'no se llenó');

  check('arranca en Claude Code',
    (await $("document.getElementById('llm-provider').value")) === 'claude-cli',
    await $("document.getElementById('llm-provider').value"));

  check('con Claude Code no pide key',
    await $("document.getElementById('llm-key-row').classList.contains('hidden')"),
    'la fila de key está visible');

  // --- the free option someone without a Claude subscription can actually use ---
  const providers = await $('window.yapper.getLlmSettings().then(s => s.providers)');
  const free = providers.filter(p => p.free);
  check('ofrece al menos una opción gratis', free.length >= 1,
    providers.map(p => p.id).join(', '));
  check('la opción gratis dice dónde sacar la key',
    free.every(p => p.keyUrl), free.map(p => `${p.id}:${p.keyUrl}`).join(', '));
  check('la opción gratis advierte sobre privacidad',
    free.every(p => p.privacy), free.map(p => `${p.id}:${p.privacy}`).join(', '));
  check('hay una opción local sin key ni costo',
    providers.some(p => p.id === 'ollama' && !p.needsKey),
    providers.map(p => `${p.id}${p.needsKey ? '(key)' : ''}`).join(', '));

  await $(`(() => {
    const s = document.getElementById('llm-provider');
    s.value = 'gemini';
    s.dispatchEvent(new Event('change'));
  })()`);
  await new Promise(r => setTimeout(r, 400));
  check('al elegir la gratis aparece el enlace para sacar la key',
    !(await $("document.getElementById('llm-key-link').classList.contains('hidden')")),
    'el enlace no aparece');
  // Checking the row is not enough: the text inside it kept its own hidden
  // class, so the row opened and the warning was never actually on screen.
  const privacy = await $(`(() => {
    const el = document.getElementById('llm-privacy');
    const r = el.getBoundingClientRect();
    return { text: el.textContent, visible: r.width > 0 && r.height > 0,
      hidden: el.classList.contains('hidden'),
      rowHidden: document.getElementById('llm-privacy-row').classList.contains('hidden') };
  })()`);
  check('la fila del aviso de privacidad se destapa', !privacy.rowHidden, 'sigue oculta');
  check('el aviso de privacidad se ve de verdad en pantalla',
    privacy.visible && !privacy.hidden && privacy.text.length > 20, JSON.stringify(privacy));
  check('y dice que el plan gratis usa tus datos',
    /train|improve its models/i.test(privacy.text), privacy.text);
  check('el enlace apunta a una URL permitida',
    (await $("document.getElementById('llm-key-link').dataset.url")).startsWith('https://'),
    await $("document.getElementById('llm-key-link').dataset.url"));
  check('sugiere un modelo por defecto',
    !!(await $("document.getElementById('llm-model').placeholder")), 'sin sugerencia');

  // Picking a provider is not being set up. Saying nothing here means finding
  // out at the end of the first meeting, after the recording.
  const nokey = await $(`(() => {
    const el = document.getElementById('llm-status');
    const r = el.getBoundingClientRect();
    return { text: el.textContent, kind: el.dataset.kind, bad: el.classList.contains('bad'),
      visible: r.width > 0 && r.height > 0 };
  })()`);
  check('avisa en el momento que falta la key',
    nokey.visible && nokey.kind === 'needs-key' && /Paste a key/.test(nokey.text),
    JSON.stringify(nokey));
  check('y lo marca como pendiente, no como informativo', nokey.bad, JSON.stringify(nokey));
  check('el proceso principal rechaza URLs que no ofrece la app',
    (await $("window.yapper.openExternal('https://example.com/evil')")) === false,
    'la abrió');

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

  check('el aviso de "falta la key" desaparece al guardarla',
    (await $("document.getElementById('llm-status').dataset.kind")) !== 'needs-key',
    await $("document.getElementById('llm-status').textContent"));

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
