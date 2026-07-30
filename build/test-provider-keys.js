// A key belongs to the provider it was issued for.
//
// There used to be one key slot shared by all of them, so saving a Gemini key
// and switching to OpenRouter left the UI saying "saved" and would have sent
// Google's key to OpenRouter's servers. This pins down that each provider keeps
// its own key, model and endpoint, and that switching between them neither
// leaks nor loses anything.
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { sandbox, mainWindow } = require('./harness');

const ROOT = sandbox('provider-keys-test');
const SETTINGS = path.join(ROOT, 'user', 'settings.json');

let fails = 0;
function check(name, ok, detail) {
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      ${detail}`); }
}

const GEMINI = 'AIza-gemini-key-0001';
const ROUTER = 'sk-or-router-key-0002';

require('../main.js');

app.whenReady().then(async () => {
  const win = await mainWindow({ settleMs: 1800 });
  const $ = js => win.webContents.executeJavaScript(js);

  const pick = async id => {
    await $(`(() => { const s = document.getElementById('llm-provider');
      s.value = ${JSON.stringify(id)}; s.dispatchEvent(new Event('change')); })()`);
    await new Promise(r => setTimeout(r, 700));
  };
  const type = async key => {
    await $(`(() => { const k = document.getElementById('llm-key');
      k.value = ${JSON.stringify(key)}; k.dispatchEvent(new Event('change')); })()`);
    await new Promise(r => setTimeout(r, 700));
  };
  const row = () => $(`(() => ({
    provider: document.getElementById('llm-provider').value,
    keyPlaceholder: document.getElementById('llm-key').placeholder,
    model: document.getElementById('llm-model').value,
    status: document.getElementById('llm-status').textContent,
    kind: document.getElementById('llm-status').dataset.kind
  }))()`);
  const stored = () => JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));

  // --- set up Gemini ---
  await pick('gemini');
  await type(GEMINI);
  await $(`(() => { const m = document.getElementById('llm-model');
    m.value = 'gemini-3.5-flash'; m.dispatchEvent(new Event('change')); })()`);
  await new Promise(r => setTimeout(r, 700));

  let s = stored();
  check('stores the key under its provider',
    !!(s.llmByProvider && s.llmByProvider.gemini && s.llmByProvider.gemini.key),
    JSON.stringify(Object.keys(s.llmByProvider || {})));
  check('no shared key field is left',
    s.llmKey === undefined, 'there is still an llmKey at the root');
  check('the key is still unreadable', !JSON.stringify(s).includes(GEMINI), 'appears in cleartext');
  check('stores its model too',
    s.llmByProvider.gemini.model === 'gemini-3.5-flash', s.llmByProvider.gemini.model);

  // --- switch to OpenRouter: nothing of Gemini's may follow ---
  await pick('openrouter');
  let r = await row();
  check('on switching, OpenRouter does not inherit the key',
    /sk-or/.test(r.keyPlaceholder) && !/saved/.test(r.keyPlaceholder), r.keyPlaceholder);
  check('and warns that its own is missing', r.kind === 'needs-key', JSON.stringify(r));
  check('it does not inherit the model either', r.model === '', `modelo "${r.model}"`);

  const cfg = await $('window.yapper.getLlmSettings()');
  check('the main process does not think it has a key either', cfg.hasKey === false, JSON.stringify(cfg));

  // what the app would actually send: no key at all, so it refuses rather than
  // handing Google's key to someone else
  const err = await $(`window.yapper.testLlm({ provider: 'openrouter' }).then(r => r.error || 'ok')`);
  check('does not try to use another provider key',
    /needs an API key/.test(err), String(err));

  // --- set up OpenRouter too, then go back ---
  await type(ROUTER);
  s = stored();
  check('there are now two keys stored, one per provider',
    !!s.llmByProvider.gemini.key && !!s.llmByProvider.openrouter.key,
    JSON.stringify(Object.keys(s.llmByProvider)));
  check('neither of them is readable',
    !JSON.stringify(s).includes(GEMINI) && !JSON.stringify(s).includes(ROUTER), 'one of them appears in cleartext');

  await pick('gemini');
  r = await row();
  check('switching back to Gemini, its key is still there',
    /saved/.test(r.keyPlaceholder), r.keyPlaceholder);
  check('and so is its model', r.model === 'gemini-3.5-flash', `modelo "${r.model}"`);
  check('no pending warnings', r.kind !== 'needs-key', JSON.stringify(r));

  const back = await $('window.yapper.getLlmSettings()');
  check('the main process uses the Gemini one', back.hasKey === true, JSON.stringify(back));
  check('knows which providers are ready',
    Array.isArray(back.configured) && back.configured.includes('gemini')
    && back.configured.includes('openrouter'), JSON.stringify(back.configured));

  // --- an old profile with the single slot has to keep working ---
  const legacy = { llmProvider: 'anthropic', llmKey: { enc: false, v: 'sk-ant-old' }, llmModel: 'claude-sonnet-5' };
  fs.writeFileSync(SETTINGS, JSON.stringify(legacy), 'utf8');
  const migrated = await $('window.yapper.getLlmSettings()');
  check('an old profile migrates to the new shape',
    migrated.provider === 'anthropic' && migrated.hasKey === true
    && migrated.model === 'claude-sonnet-5', JSON.stringify(migrated));
  const after = stored();
  check('and the migration is written to disk',
    after.llmKey === undefined && !!after.llmByProvider.anthropic.key,
    JSON.stringify(after));

  console.log(fails ? `\n${fails} fallos` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(e => { console.log('FAIL', e.message); app.exit(1); });
