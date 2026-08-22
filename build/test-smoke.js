// Clicks through the whole app watching for errors nobody would otherwise see.
// A thrown exception in the renderer does not crash anything — the button just
// stops working — so this listens for them while opening every view, toggling
// every control and running every export.
const path = require('path');
const fs = require('fs');
const { app, dialog } = require('electron');
const { mainWindow } = require('./harness');

const BASE = path.join(app.getPath('temp'), 'yapper-smoke-test');
let ROOT = BASE;
try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { ROOT = `${BASE}-${process.pid}`; }
fs.mkdirSync(path.join(ROOT, 'Meetings'), { recursive: true });
app.setPath('documents', ROOT);
app.setPath('userData', path.join(ROOT, 'user'));

// one finished meeting to click around in
const folder = path.join(ROOT, 'Meetings', '2026-07-29_1600');
fs.mkdirSync(folder);
fs.writeFileSync(path.join(folder, 'title.txt'), 'Launch Sync', 'utf8');
fs.writeFileSync(path.join(folder, 'transcript.txt'),
  '[00:00:01] We ship on Friday.\n[00:00:20] Maya owns the rollout.\n[00:02:40] Anything else?', 'utf8');
fs.writeFileSync(path.join(folder, 'notes.md'), `## Summary [00:01]
The team agreed on a Friday launch.

## Action items [00:20]
- Maya: prepare the rollout plan

## Open questions [02:40]
- Nothing outstanding.
`, 'utf8');
fs.writeFileSync(path.join(folder, 'recording.wav'), Buffer.alloc(44 + 32000 * 10));

let fails = 0;
const problems = [];
function check(name, ok, detail) {
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      ${detail}`); }
}

const saved = path.join(ROOT, 'out');
dialog.showSaveDialog = async (_w, o) => ({ canceled: false, filePath: saved + path.extname(o.defaultPath || '.txt') });
dialog.showMessageBox = async () => ({ response: 1 });   // never actually delete

require('../main.js');

app.whenReady().then(async () => {
  // settle straight away, so the listeners below are attached before anything
  // interesting happens on the page
  const win = await mainWindow({ settleMs: 0 });

  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) problems.push(`${message}  (${path.basename(source || '')}:${line})`);
  });
  win.webContents.on('render-process-gone', (_e, d) => problems.push(`the renderer died: ${d.reason}`));
  win.webContents.on('preload-error', (_e, p, err) => problems.push(`preload: ${err.message}`));

  await new Promise(r => setTimeout(r, 1200));

  const $ = js => win.webContents.executeJavaScript(js, true);
  const click = async sel => {
    await $(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) throw new Error('no existe ' + ${JSON.stringify(sel)}); el.click(); })()`);
    await new Promise(r => setTimeout(r, 250));
  };

  // ---- it opens on the day, and the detected-meeting card floats above it ----
  check('opens on Today',
    !(await $("document.getElementById('view-home').classList.contains('hidden')")), 'did not open there');

  win.webContents.send('meeting-detected', { app: 'Zoom' });
  await new Promise(r => setTimeout(r, 400));
  // offsetParent is always null on a fixed element, so visibility is measured
  // from the box it actually occupies inside the window.
  const prompt = await $(`(() => { const el = document.getElementById('meeting-prompt');
    const r = el.getBoundingClientRect();
    const css = getComputedStyle(el);
    return { hidden: el.classList.contains('hidden'), inRecordView: !!el.closest('#view-record'),
      w: Math.round(r.width), h: Math.round(r.height),
      onScreen: r.width > 0 && r.height > 0 && r.top >= 0 && r.left >= 0
        && r.bottom <= innerHeight && r.right <= innerWidth,
      shown: css.display !== 'none' && css.visibility !== 'hidden' && +css.opacity > 0,
      text: el.textContent }; })()`);
  check('the detected-meeting prompt shows while on Today',
    !prompt.hidden && prompt.shown && prompt.onScreen && !prompt.inRecordView, JSON.stringify(prompt));
  check('and it says what triggered it', /Zoom/.test(prompt.text), prompt.text);
  await click('#mp-dismiss');
  check('can be dismissed',
    await $("document.getElementById('meeting-prompt').classList.contains('hidden')"), 'is still there');

  // ---- every view opens ----
  await click('#btn-reminders');
  check('the reminders view opens',
    !(await $("document.getElementById('view-reminders').classList.contains('hidden')")), 'is still hidden');
  await click('#btn-new');
  check('goes back to the record view',
    !(await $("document.getElementById('view-record').classList.contains('hidden')")), 'is still hidden');

  // ---- open the meeting ----
  await $('refreshMeetingList()');
  await new Promise(r => setTimeout(r, 400));
  await click('#meeting-list .m-item');
  check('the meeting opens',
    !(await $("document.getElementById('view-meeting').classList.contains('hidden')")), 'is still hidden');
  check('renders the notes by section',
    (await $("document.querySelectorAll('#notes .note-sec').length")) >= 3,
    await $("document.querySelectorAll('#notes .note-sec').length"));
  check('colours the action items section',
    (await $("document.querySelectorAll('#notes .sec-action').length")) >= 1, 'none');

  // ---- action items enter the personal list only when chosen ----
  check('opening or indexing notes adds no action item automatically',
    (await $('window.yapper.listActions()')).length === 0, 'one appeared without a click');
  const addBtn = await $("document.querySelectorAll('#notes .li-add').length");
  check('action items offer to be added to reminders', addBtn >= 1, `${addBtn} botones`);
  if (addBtn >= 1) {
    await click('#notes .li-add');
    check('the button confirms it was added',
      (await $("document.querySelector('#notes .li-add').textContent")).includes('added'),
      await $("document.querySelector('#notes .li-add').textContent"));
    check('the chosen item cannot be stacked twice from the same button',
      await $("document.querySelector('#notes .li-add').disabled"), 'button is still enabled');
    await click('#btn-reminders');
    const n = await $("document.querySelectorAll('#reminders-list .reminder').length");
    check('the reminder is saved', n >= 1, `${n} in the list`);
    check('the menu counter reflects it',
      !(await $("document.getElementById('reminders-count').classList.contains('hidden')")), 'is still hidden');
    await click('#meeting-list .m-item');
  }

  // ---- editing notes by hand ----
  await click('#btn-edit');
  check('edit mode turns on',
    await $("document.getElementById('notes-editor') && !document.getElementById('notes-editor').classList.contains('hidden')"),
    'the editor never appeared');
  await $(`(() => { const t = document.getElementById('notes-textarea');
    t.value = currentNotesMd + '\\n\\n## Next steps [03:00]\\n- Ship it.'; })()`);
  await click('#btn-save-notes');
  await new Promise(r => setTimeout(r, 400));
  check('the edit is saved to disk',
    fs.readFileSync(path.join(folder, 'notes.md'), 'utf8').includes('Ship it'), 'was not saved');

  // ---- every export ----
  for (const kind of ['md', 'txt', 'transcript-md', 'both']) {
    const out = await $(`runExport(${JSON.stringify(kind)})`);
    check(`export ${kind}`, !!out && fs.existsSync(out), String(out));
  }
  const pdf = await $(`runExport('pdf')`);
  check('export pdf', !!pdf && fs.existsSync(pdf) && fs.statSync(pdf).size > 1000,
    `${pdf} (${pdf && fs.existsSync(pdf) ? fs.statSync(pdf).size : 0} bytes)`);

  // ---- copy, speak, and the option toggles ----
  await click('#btn-copy');
  check('copying does not blow up', true, '');
  await click('#btn-speak');
  await new Promise(r => setTimeout(r, 300));
  await click('#btn-speak');            // and stop again
  // The theme in detail lives in build/test-theme.js; here, only that the
  // corner shortcut still takes you there and back.
  await click('#btn-theme');
  check('the light theme applies', await $("document.body.classList.contains('light')"), 'did not change');
  await click('#btn-theme');

  await click('#btn-new');
  for (const sel of ['#style-pills .seg-btn:nth-child(3)', '#detail-seg .seg-btn:nth-child(2)',
    '#noise-seg .seg-btn:nth-child(3)']) {
    await click(sel);
  }
  check('the options stay checked',
    (await $("document.querySelectorAll('#style-pills .seg-btn.active, #detail-seg .seg-btn.active, #noise-seg .seg-btn.active').length")) === 3,
    'one of them was not flagged');

  // ---- the search box ----
  await $(`(() => { const s = document.getElementById('search'); s.value = 'launch';
    s.dispatchEvent(new Event('input')); })()`);
  await new Promise(r => setTimeout(r, 200));
  check('search finds the meeting',
    (await $("document.querySelectorAll('#meeting-list .m-item').length")) === 1, 'did not find it');
  await $(`(() => { const s = document.getElementById('search'); s.value = 'zzzz';
    s.dispatchEvent(new Event('input')); })()`);
  await new Promise(r => setTimeout(r, 200));
  check('with no results it shows the notice',
    (await $("!!document.querySelector('#meeting-list .m-empty')")), 'no avisa');
  await $(`(() => { const s = document.getElementById('search'); s.value = '';
    s.dispatchEvent(new Event('input')); })()`);

  // ---- the error path: a meeting whose folder vanished ----
  const gone = path.join(ROOT, 'Meetings', 'no-existe');
  const err = await $(`window.yapper.transcribe(${JSON.stringify(gone)}).then(() => null, e => e.message)`);
  check('a nonexistent folder gives a readable error',
    typeof err === 'string' && err.length > 10 && !/undefined/.test(err), String(err));

  check('nothing threw errors along the way', problems.length === 0,
    problems.slice(0, 6).join('\n      '));

  console.log(fails ? `\n${fails} failures` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(e => { console.log('FAIL', e.stack || e.message); app.exit(1); });
