// The small things that make the app pleasant to live in, driven for real:
// renaming a meeting from its heading, copying one card, choosing the notes'
// language, and retrying the notes when the provider fails — without
// re-transcribing. No model is needed: the provider is pointed at a closed port.
const path = require('path');
const fs = require('fs');
const { app, Menu } = require('electron');
const { sandbox, logger, mainWindow, watchdog } = require('./harness');

const ROOT = sandbox('qol-ui');
const say = logger(ROOT);

let fails = 0;
function check(name, ok, detail) {
  if (ok) say(`ok    ${name}`);
  else { fails++; say(`FAIL  ${name}\n      ${detail || ''}`); }
}
const pause = ms => new Promise(r => setTimeout(r, ms));

const folder = path.join(ROOT, 'Meetings', '2026-08-21_1500');
fs.mkdirSync(folder, { recursive: true });
fs.writeFileSync(path.join(folder, 'title.txt'), 'Pricing Review', 'utf8');
fs.writeFileSync(path.join(folder, 'transcript.txt'),
  '[00:00:01] We went through the pricing deck.\n[00:00:09] Maya will send the contract to legal on Friday.', 'utf8');
fs.writeFileSync(path.join(folder, 'notes.md'), `## Summary [00:01]
The pricing deck was reviewed.

## Decisions [00:05]
- Keep the enterprise tier.

## Action items [00:09]
- Maya: send the contract to legal by Friday
`, 'utf8');

// a second meeting with a transcript and no notes: the retry path
const bare = path.join(ROOT, 'Meetings', '2026-08-21_1600');
fs.mkdirSync(bare, { recursive: true });
fs.writeFileSync(path.join(bare, 'transcript.txt'), '[00:00:01] Something worth noting was said.', 'utf8');

require('../main.js');

app.whenReady().then(async () => {
  const timer = watchdog(say, 200000);
  try {
    const win = await mainWindow({ settleMs: 1500 });
    const errs = [];
    win.webContents.on('console-message', (_e, l, m) => { if (l >= 2) errs.push(m); });
    const $ = js => win.webContents.executeJavaScript(js, true);
    const key = (sel, key) => $(`document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }))`);

    // Nothing reaches a provider in this test: the notes go to a closed port.
    await $(`window.yapper.setLlmSettings({ provider: 'compatible', baseUrl: 'http://127.0.0.1:9', model: 'none', apiKey: 'x' })`);

    // ---- rename ----
    await $(`openMeetingByFolder(${JSON.stringify(folder)})`);
    await pause(400);
    check('the meeting opens with its title',
      (await $("document.getElementById('result-title').textContent")) === 'Pricing Review');
    await $(`document.getElementById('result-title').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await pause(100);
    check('double-clicking the title makes it editable',
      await $("document.getElementById('result-title').isContentEditable"));
    await $(`document.getElementById('result-title').textContent = 'Pricing Review — Q3'`);
    await key('#result-title', 'Enter');
    await pause(500);
    check('Enter saves the new title on screen',
      (await $("document.getElementById('result-title').textContent")) === 'Pricing Review — Q3',
      await $("document.getElementById('result-title').textContent"));
    check('and on disk', fs.readFileSync(path.join(folder, 'title.txt'), 'utf8') === 'Pricing Review — Q3',
      fs.readFileSync(path.join(folder, 'title.txt'), 'utf8'));
    check('and in the sidebar',
      await $("[...document.querySelectorAll('#meeting-list .m-title')].some(t => t.textContent === 'Pricing Review — Q3')"));
    check('and leaves the field', !(await $("document.getElementById('result-title').isContentEditable")));

    await $(`document.getElementById('btn-rename').click()`);
    await pause(100);
    check('the pencil also opens the field', await $("document.getElementById('result-title').isContentEditable"));
    await $(`document.getElementById('result-title').textContent = 'typo'`);
    await key('#result-title', 'Escape');
    await pause(300);
    check('Escape keeps the old title',
      (await $("document.getElementById('result-title').textContent")) === 'Pricing Review — Q3');
    check('and does not write', fs.readFileSync(path.join(folder, 'title.txt'), 'utf8') === 'Pricing Review — Q3');

    await $(`document.getElementById('btn-rename').click()`);
    await $(`document.getElementById('result-title').textContent = '   '`);
    await key('#result-title', 'Enter');
    await pause(300);
    check('an empty title is not saved',
      (await $("document.getElementById('result-title').textContent")) === 'Pricing Review — Q3'
      && fs.readFileSync(path.join(folder, 'title.txt'), 'utf8') === 'Pricing Review — Q3');

    // the menu's accelerator reaches the same field
    const menu = Menu.getApplicationMenu();
    const edit = menu.items.find(i => i.label === 'Edit');
    edit.submenu.items.find(i => i.label === 'Rename meeting').click();
    await pause(300);
    check('Edit › Rename meeting opens the field too', await $("document.getElementById('result-title').isContentEditable"));
    await key('#result-title', 'Escape');

    // ---- copy one card ----
    await $(`window.__copied = []; navigator.clipboard.writeText = t => { window.__copied.push(t); return Promise.resolve(); }; true`);
    const cards = await $("document.querySelectorAll('#notes .note-sec .sec-copy').length");
    check('every card carries its own Copy', cards === 3, `${cards}`);
    await $(`[...document.querySelectorAll('#notes .note-sec')].find(s => /Action items/.test(s.textContent)).querySelector('.sec-copy').click()`);
    await pause(200);
    const copied = await $('window.__copied');
    check('copying the Action items card copies that card only',
      copied.length === 1 && /^## Action items \[00:09\]\n\n- Maya: send the contract to legal by Friday\n$/.test(copied[0]),
      JSON.stringify(copied));
    check('and says so on the button',
      (await $("[...document.querySelectorAll('#notes .sec-copy')].some(b => b.textContent === 'Copied')")));
    const spoken = await $('spokenNotesText()');
    check('Read aloud does not read the buttons', !/Copy|my list/.test(spoken) && /contract to legal/.test(spoken), spoken);
    const exported = await $(`(() => { const c = document.getElementById('notes').cloneNode(true);
      c.querySelectorAll('.li-add, button').forEach(el => el.remove()); return c.textContent; })()`);
    check('the copy buttons never reach an export', !/Copy/.test(exported));

    // ---- the notes' language ----
    check('the options offer the language', (await $("document.querySelectorAll('#lang-seg .seg-btn').length")) === 3);
    check('English is the default',
      (await $("document.querySelector('#lang-seg .seg-btn.active').dataset.lang")) === 'en'
      && (await $("document.getElementById('regen-lang').value")) === 'en');
    await $(`document.querySelector('#lang-seg .seg-btn[data-lang="es"]').click()`);
    await pause(100);
    check('choosing Español is remembered',
      /"lang":"es"/.test(await $("localStorage.getItem('yapper-options')")),
      await $("localStorage.getItem('yapper-options')"));
    check('and the dropdown beside Regenerate follows',
      (await $("document.getElementById('regen-lang').value")) === 'es');
    check('and the folded summary says so',
      /Español/.test(await $("document.getElementById('opts-sum').textContent")),
      await $("document.getElementById('opts-sum').textContent"));
    await $(`document.getElementById('regen-lang').value = 'en'; document.getElementById('regen-lang').dispatchEvent(new Event('change'))`);
    await pause(100);
    check('changing it beside Regenerate updates the options',
      (await $("document.querySelector('#lang-seg .seg-btn.active').dataset.lang")) === 'en'
      && !/English/.test(await $("document.getElementById('opts-sum').textContent")));
    // the prompt: headings stay English whatever the body's language
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    check('the prompt pins the headings to English when the notes are not',
      /keep every "## " heading exactly as written above, in English/.test(main)
      && /Write the notes in \$\{NOTE_LANGUAGES\[lang\]/.test(main));
    check('the action-item parser reads the Spanish "nothing here" sentences',
      require('../actions').parseActionItems('## Action items\n- No hay acciones pendientes.\n- Ninguna.\n').length === 0);

    // ---- retry without re-transcribing ----
    await $(`openMeetingByFolder(${JSON.stringify(bare)})`);
    await pause(400);
    await $(`document.getElementById('btn-regen').click()`);
    // connection refused is quick, but give the stream machinery time to settle
    let retry = false;
    for (let i = 0; i < 60 && !retry; i++) {
      await pause(250);
      retry = await $("!!document.getElementById('btn-retry-notes')");
    }
    check('when the provider fails, the error carries a Retry button', retry,
      await $("document.getElementById('regen-status').textContent"));
    check('and the meeting keeps the transcript on screen',
      /Something worth noting/.test(await $("document.getElementById('transcript').textContent")));
    check('the title did not get stuck on the placeholder',
      (await $("document.getElementById('result-title').textContent")) !== 'Writing notes…',
      await $("document.getElementById('result-title').textContent"));
    const transcriptMtime = fs.statSync(path.join(bare, 'transcript.txt')).mtimeMs;
    await $(`document.getElementById('btn-retry-notes').click()`);
    await pause(300);
    check('Retry starts writing again',
      /again/.test(await $("document.getElementById('regen-status').textContent"))
      || await $("!!document.getElementById('btn-retry-notes')"),
      await $("document.getElementById('regen-status').textContent"));
    retry = false;
    for (let i = 0; i < 60 && !retry; i++) {
      await pause(250);
      retry = await $("!!document.getElementById('btn-retry-notes')");
    }
    check('a second failure offers it again', retry);
    check('nothing was re-transcribed', fs.statSync(path.join(bare, 'transcript.txt')).mtimeMs === transcriptMtime);
    check('no recording was touched', !fs.existsSync(path.join(bare, 'recording.wav')));

    // ---- settings view ----
    // One card, two homes: it lives folded in the record view and is hosted,
    // unfolded, by the settings view while that is open.
    await $(`document.getElementById('btn-settings').click()`);
    await pause(300);
    check('Settings opens its own view',
      await $("!document.getElementById('view-settings').classList.contains('hidden')"));
    check('hosting the options card, unfolded',
      await $("document.getElementById('options-card').parentElement.id === 'settings-host' && !document.getElementById('options-card').classList.contains('collapsed')"));
    check('with every group on it',
      (await $("document.querySelectorAll('#settings-host .opt-group-title').length")) === 4);
    await $(`document.querySelector('#lang-seg .seg-btn[data-lang="es"]').click()`);
    await pause(100);
    check('a change made there is saved like any other',
      /"lang":"es"/.test(await $("localStorage.getItem('yapper-options')")));
    await $(`document.getElementById('btn-new').click()`);
    await pause(300);
    check('leaving puts the card back in the record view, folded',
      await $("document.getElementById('options-card').parentElement.id === 'view-record' && document.getElementById('options-card').classList.contains('collapsed')"));
    check('right under its toggle',
      await $("document.getElementById('opts-toggle').nextElementSibling.id === 'options-card'"));
    check('and the folded line reflects the change',
      /Español/.test(await $("document.getElementById('opts-sum').textContent")),
      await $("document.getElementById('opts-sum').textContent"));
    await $(`document.getElementById('opts-toggle').click()`);
    check('the fold still opens in place',
      await $("!document.getElementById('options-card').classList.contains('collapsed') && document.getElementById('options-card').parentElement.id === 'view-record'"));
    await $(`document.querySelector('#lang-seg .seg-btn[data-lang="en"]').click()`);
    const menuSettings = (Menu.getApplicationMenu().items.find(i => i.label === (process.platform === 'darwin' ? 'Yapper' : 'File')) || {}).submenu;
    const settingsItem = menuSettings && menuSettings.items.find(i => i.label === 'Settings…');
    check('the menu carries Settings… on Cmd+,', !!settingsItem && settingsItem.accelerator === 'CmdOrCtrl+,');
    settingsItem.click();
    await pause(300);
    check('and it opens the view', await $("!document.getElementById('view-settings').classList.contains('hidden')"));
    await $(`openMeetingByFolder(${JSON.stringify(folder)})`);
    await pause(300);

    // ---- Escape ----
    await $(`openMeetingByFolder(${JSON.stringify(folder)})`);
    await pause(300);
    await $(`document.getElementById('btn-export').click()`);
    check('the export menu opens', !(await $("document.getElementById('export-menu').classList.contains('hidden')")));
    await key('body', 'Escape');
    check('Escape closes it', await $("document.getElementById('export-menu').classList.contains('hidden')"));

    if (errs.length) say('  renderer errors: ' + errs.slice(0, 4).join(' | '));
    check('no renderer errors', errs.length === 0, errs.join(' | '));
  } catch (err) {
    fails++;
    say('FAIL  ' + (err.stack || err.message));
  }
  clearTimeout(timer);
  say(fails ? `\n${fails} failures` : '\nPASS');
  app.exit(fails ? 1 : 0);
});
