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

  // The provider rows live inside Meeting options, which start folded.
  // Measuring "is it actually on screen" with the fold closed reports 0×0,
  // so unfold the real record view before checking their geometry.
  await $(`showView('record'); setOptionsOpen(true)`);
  await new Promise(r => setTimeout(r, 300));

  check('the provider selector exists and has options',
    (await $("document.getElementById('llm-provider').options.length")) >= 4,
    'did not fill');

  check('starts on Claude Code',
    (await $("document.getElementById('llm-provider').value")) === 'claude-cli',
    await $("document.getElementById('llm-provider').value"));

  check('with Claude Code it asks for no key',
    await $("document.getElementById('llm-key-row').classList.contains('hidden')"),
    'the key row is visible');

  // --- the free option someone without a Claude subscription can actually use ---
  const providers = await $('window.yapper.getLlmSettings().then(s => s.providers)');
  const free = providers.filter(p => p.free);
  check('offers at least one free option', free.length >= 1,
    providers.map(p => p.id).join(', '));
  check('the free option says where to get the key',
    free.every(p => p.keyUrl), free.map(p => `${p.id}:${p.keyUrl}`).join(', '));
  check('the free option warns about privacy',
    free.every(p => p.privacy), free.map(p => `${p.id}:${p.privacy}`).join(', '));
  check('there is a local option with no key and no cost',
    providers.some(p => p.id === 'ollama' && !p.needsKey),
    providers.map(p => `${p.id}${p.needsKey ? '(key)' : ''}`).join(', '));

  await $(`(() => {
    const s = document.getElementById('llm-provider');
    s.value = 'gemini';
    s.dispatchEvent(new Event('change'));
  })()`);
  await new Promise(r => setTimeout(r, 400));
  check('picking the free one reveals the link to get the key',
    !(await $("document.getElementById('llm-key-link').classList.contains('hidden')")),
    'the link does not appear');
  // Checking the row is not enough: the text inside it kept its own hidden
  // class, so the row opened and the warning was never actually on screen.
  const privacy = await $(`(() => {
    const el = document.getElementById('llm-privacy');
    const r = el.getBoundingClientRect();
    return { text: el.textContent, visible: r.width > 0 && r.height > 0,
      hidden: el.classList.contains('hidden'),
      rowHidden: document.getElementById('llm-privacy-row').classList.contains('hidden') };
  })()`);
  check('the privacy notice row is revealed', !privacy.rowHidden, 'is still hidden');
  check('the privacy notice is genuinely visible on screen',
    privacy.visible && !privacy.hidden && privacy.text.length > 20, JSON.stringify(privacy));
  check('and it says the free plan uses your data',
    /train|improve its models/i.test(privacy.text), privacy.text);
  check('the link points at an allowed URL',
    (await $("document.getElementById('llm-key-link').dataset.url")).startsWith('https://'),
    await $("document.getElementById('llm-key-link').dataset.url"));
  check('suggests a default model',
    !!(await $("document.getElementById('llm-model').placeholder")), 'no suggestion');

  // Picking a provider is not being set up. Saying nothing here means finding
  // out at the end of the first meeting, after the recording.
  const nokey = await $(`(() => {
    const el = document.getElementById('llm-status');
    const r = el.getBoundingClientRect();
    return { text: el.textContent, kind: el.dataset.kind, bad: el.classList.contains('bad'),
      visible: r.width > 0 && r.height > 0 };
  })()`);
  check('warns immediately that the key is missing',
    nokey.visible && nokey.kind === 'needs-key' && /Paste a key/.test(nokey.text),
    JSON.stringify(nokey));
  check('and marks it as action needed, not informational', nokey.bad, JSON.stringify(nokey));

  // That warning lives inside the options, and the options fold away. Folded,
  // it is off screen and the whole thing falls back into the same trap: finding
  // out at the end of the first meeting. The fold's own line carries it.
  const folded = await $(`(() => {
    setOptionsOpen(false);
    const f = document.getElementById('opts-flag');
    const r = f && f.getBoundingClientRect();
    return { text: f ? f.textContent : '', visible: !!r && r.width > 0 && r.height > 0 };
  })()`);
  check('folded, the pending-key warning is still in sight',
    folded.visible && /key/i.test(folded.text), JSON.stringify(folded));
  await $('setOptionsOpen(true)');
  check('the main process rejects URLs the app does not offer',
    (await $("window.yapper.openExternal('https://example.com/evil')")) === false,
    'opened it');

  // switch to OpenRouter and type a key, exactly as a user would
  await $(`(() => {
    const s = document.getElementById('llm-provider');
    s.value = 'openrouter';
    s.dispatchEvent(new Event('change'));
  })()`);
  await new Promise(r => setTimeout(r, 400));

  check('picking OpenRouter reveals the key row',
    !(await $("document.getElementById('llm-key-row').classList.contains('hidden')")),
    'is still hidden');
  check('suggests the provider default model',
    !!(await $("document.getElementById('llm-model').placeholder")),
    'no placeholder');

  await $(`(() => {
    const k = document.getElementById('llm-key');
    k.value = ${JSON.stringify(KEY)};
    k.dispatchEvent(new Event('change'));
  })()`);
  await new Promise(r => setTimeout(r, 600));

  const after = await $('window.yapper.getLlmSettings()');
  check('the provider was saved', after.provider === 'openrouter', after.provider);
  check('says there is a key stored', after.hasKey === true, JSON.stringify(after));
  check('does NOT return the key to the renderer',
    !JSON.stringify(after).includes(KEY), JSON.stringify(after).slice(0, 120));
  check('the key field is cleared after saving',
    (await $("document.getElementById('llm-key').value")) === '', 'text was left on screen');

  check('the "key missing" warning goes away once it is saved',
    (await $("document.getElementById('llm-status').dataset.kind")) !== 'needs-key',
    await $("document.getElementById('llm-status').textContent"));
  check('and with it the mark on the fold',
    (await $(`(() => {
      setOptionsOpen(false);
      const r = document.getElementById('opts-flag').getBoundingClientRect();
      return r.width === 0 && r.height === 0;
    })()`)),
    'the pending-key mark stayed');

  const raw = fs.readFileSync(path.join(USER_DATA, 'settings.json'), 'utf8');
  check('the key is NOT readable in settings.json', !raw.includes(KEY), raw.slice(0, 200));
  check('was marked as encrypted', /"enc":\s*true/.test(raw), raw.slice(0, 200));

  // the preflight has to notice that notes are now possible
  const env = await $('window.yapper.checkEnvironment()');
  check('the startup check sees that notes can now be generated',
    env.notes && env.notes.ok === true, JSON.stringify(env.notes));

  console.log(fails ? `\n${fails} failures` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(e => { console.log('FAIL', e.stack || e.message); app.exit(1); });
