// What a coworker actually sees when they open Yapper for the first time with no
// Claude Code and no key, and what the settings row looks like as they fill it in.
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { sandbox, mainWindow } = require('./harness');

const ROOT = sandbox('byok-shot');
const OUT = path.join(app.getPath('temp'), 'yapper-byok');
fs.mkdirSync(OUT, { recursive: true });

// pretend Claude Code is not installed, which is the coworker's situation:
// off PATH, and off the fixed places main.js checks on disk (the first of
// those lives under the home directory, so point that at the sandbox)
process.env.PATH = '';
app.setPath('home', ROOT);
require('../main.js');

app.whenReady().then(async () => {
  const win = await mainWindow({ settleMs: 2500 });
  const $ = js => win.webContents.executeJavaScript(js);

  const shot = async name => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
    console.log(`${name}.png`);
  };

  // 1. first launch: what does it say about notes? The app opens on Today, so
  // the banner there is what the friend actually sees; the record view's
  // status line is the older report of the same check.
  const banner = async () => $(`(() => { const b = document.getElementById('home-setup');
    return { shown: !b.classList.contains('hidden'),
      reason: document.getElementById('home-setup-reason').textContent.trim() }; })()`);
  const first = await banner();
  console.log(`\nToday banner on first launch: ${first.shown ? 'SHOWN' : 'MISSING'}\n  "${first.reason}"`);
  if (!first.shown) throw new Error('the Today banner did not appear on a fresh install without a provider');
  const warning = await $(`document.getElementById('status').textContent`);
  console.log(`startup warning (record view):\n  "${warning.trim()}"\n`);
  await shot('1-primer-arranque');

  // 2. the friend opens the "Notes by" dropdown and picks the free one
  const options = await $(`[...document.getElementById('llm-provider').options]
    .map(o => o.value + ' — ' + o.textContent)`);
  console.log('dropdown options:');
  options.forEach(o => console.log(`  ${o}`));

  await $(`(() => { const s = document.getElementById('llm-provider');
    s.value = 'gemini'; s.dispatchEvent(new Event('change')); })()`);
  await new Promise(r => setTimeout(r, 600));
  await shot('2-eligio-gemini');

  const shown = await $(`({
    hint: document.getElementById('llm-hint').textContent,
    privacy: document.getElementById('llm-privacy').textContent,
    link: document.getElementById('llm-key-link').textContent,
    url: document.getElementById('llm-key-link').dataset.url,
    keyPlaceholder: document.getElementById('llm-key').placeholder,
    modelPlaceholder: document.getElementById('llm-model').placeholder
  })`);
  console.log('\nwhat appears when you pick it:');
  for (const [k, v] of Object.entries(shown)) console.log(`  ${k.padEnd(17)} ${v}`);

  // 3. they paste a key
  await $(`(() => { const k = document.getElementById('llm-key');
    k.value = 'AIzaSyExampleKeyNotReal0123456789'; k.dispatchEvent(new Event('change')); })()`);
  await new Promise(r => setTimeout(r, 800));
  await shot('3-key-pegada');

  const after = await $(`(async () => ({
    hasKey: (await window.yapper.getLlmSettings()).hasKey,
    field: document.getElementById('llm-key').value,
    placeholder: document.getElementById('llm-key').placeholder,
    notes: (await window.yapper.checkEnvironment()).notes
  }))()`);
  console.log('\nafter pasting it:');
  for (const [k, v] of Object.entries(after)) console.log(`  ${k.padEnd(12)} ${JSON.stringify(v)}`);
  const afterKey = await banner();
  console.log(`  banner       ${afterKey.shown ? 'still shown' : 'gone'}`);
  if (afterKey.shown) throw new Error('the Today banner stayed after the key was saved');

  // 4. Test connection, with a key that is not real: the error has to be useful
  await $(`document.getElementById('btn-llm-test').click()`);
  await new Promise(r => setTimeout(r, 8000));
  const status = await $(`document.getElementById('llm-status').textContent`);
  console.log(`\nTest connection with a fake key:\n  "${status}"`);
  await shot('4-test-connection');

  console.log(`\ncapturas en ${OUT}`);
  app.exit(0);
}).catch(e => { console.log('FAIL', e.message); app.exit(1); });
