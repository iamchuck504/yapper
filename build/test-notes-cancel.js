// Canceling notes is a data-integrity path, not just a button state: the model
// process/request must stop, the transcript must stay usable, and a canceled
// regeneration must put the last saved notes back on screen and leave them on
// disk byte for byte.
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { mainWindow } = require('./harness');

const ROOT = path.join(app.getPath('temp'), 'yapper-notes-cancel-test');
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, 'Meetings'), { recursive: true });
app.setPath('documents', ROOT);
app.setPath('userData', path.join(ROOT, 'user'));

const folder = path.join(ROOT, 'Meetings', '2026-08-21_0900');
fs.mkdirSync(folder);
fs.writeFileSync(path.join(folder, 'title.txt'), 'Cancellation Review', 'utf8');
fs.writeFileSync(path.join(folder, 'transcript.txt'),
  '[00:00:01] Keep the original notes if a rewrite is canceled.', 'utf8');
const original = '## Summary [00:01]\nThe original saved notes remain authoritative.';
fs.writeFileSync(path.join(folder, 'notes.md'), original, 'utf8');

let modelAborted = false;
const llm = require('../llm');
llm.generate = async (_config, { onDelta, signal }) => new Promise((resolve, reject) => {
  const partial = '## Summary [00:01]\nThis incomplete rewrite must never be saved.';
  const first = setTimeout(() => {
    if (onDelta) onDelta(partial, partial);
  }, 40);
  const late = setTimeout(() => resolve(partial + '\n\n## Decisions [00:02]\nToo late.'), 5000);
  const abort = () => {
    modelAborted = true;
    clearTimeout(first);
    clearTimeout(late);
    reject(new Error('Note generation canceled.'));
  };
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
});

require('../main.js');

let fails = 0;
function check(name, ok, detail) {
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      ${detail}`); }
}

const waitFor = async (read, test, timeout = 4000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await read();
    if (test(value)) return value;
    await new Promise(r => setTimeout(r, 25));
  }
  return read();
};

app.whenReady().then(async () => {
  const win = await mainWindow();
  const $ = js => win.webContents.executeJavaScript(js, true);

  await $('refreshMeetingList()');
  await new Promise(r => setTimeout(r, 200));
  await $(`document.querySelector('#meeting-list .m-item').click()`);

  check('starts with the saved notes',
    (await $(`document.getElementById('notes').textContent`)).includes('original saved notes'),
    await $(`document.getElementById('notes').textContent`));

  await $(`document.getElementById('btn-regen').click()`);
  const partial = await waitFor(
    () => $(`(() => ({
      busy: document.getElementById('notes').getAttribute('aria-busy'),
      label: document.querySelector('#btn-regen .regen-label').textContent,
      notes: document.getElementById('notes').textContent
    }))()`),
    s => s.busy === 'true' && s.label === 'Cancel' && /incomplete rewrite/.test(s.notes));
  check('the in-flight rewrite offers Cancel',
    partial.busy === 'true' && partial.label === 'Cancel', JSON.stringify(partial));
  check('the partial rewrite is visible before completion',
    /incomplete rewrite/.test(partial.notes), partial.notes);

  await $(`document.getElementById('btn-regen').click()`);
  const stopped = await waitFor(
    () => $(`(() => ({
      busy: document.getElementById('notes').getAttribute('aria-busy'),
      label: document.querySelector('#btn-regen .regen-label').textContent,
      notes: document.getElementById('notes').textContent,
      status: document.getElementById('regen-status').textContent
    }))()`),
    s => s.busy === 'false' && /canceled/i.test(s.status));

  check('Cancel reaches the actual model job', modelAborted, 'the model promise kept running');
  check('the UI leaves its busy state', stopped.busy === 'false', JSON.stringify(stopped));
  check('the button becomes Regenerate again', stopped.label === 'Regenerate', stopped.label);
  check('the previous notes return after canceling',
    /original saved notes/.test(stopped.notes) && !/incomplete rewrite/.test(stopped.notes), stopped.notes);
  check('the saved file was never overwritten',
    fs.readFileSync(path.join(folder, 'notes.md'), 'utf8') === original,
    fs.readFileSync(path.join(folder, 'notes.md'), 'utf8'));
  check('the completed job is no longer cancelable',
    await $(`window.yapper.cancelNotes(${JSON.stringify(folder)})`) === false,
    'a stale controller remained registered');

  console.log(fails ? `\n${fails} failures` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(err => {
  console.log('FAIL', err.stack || err.message);
  app.exit(1);
});
