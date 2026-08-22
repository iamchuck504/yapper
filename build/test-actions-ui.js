// The action items view, driven for real: meeting notes offer tasks, but only
// the ones the user chooses enter the personal list. Chosen duplicates fold
// into one row, their facts come only from the notes, and every control works.
const path = require('path');
const fs = require('fs');
const { app, dialog } = require('electron');
const { sandbox, logger, mainWindow } = require('./harness');

const ROOT = sandbox('actions-ui');
const say = logger(ROOT);

let fails = 0;
function check(name, ok, detail) {
  if (ok) say(`ok    ${name}`);
  else { fails++; say(`FAIL  ${name}\n      ${detail}`); }
}

function meeting(name, title, notes, participants = 'Maya, Chuck') {
  const folder = path.join(ROOT, 'Meetings', name);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'title.txt'), title, 'utf8');
  fs.writeFileSync(path.join(folder, 'participants.txt'), participants, 'utf8');
  fs.writeFileSync(path.join(folder, 'transcript.txt'), '[00:00:01] Something was said.', 'utf8');
  fs.writeFileSync(path.join(folder, 'notes.md'), notes, 'utf8');
  return folder;
}

// Monday: the tasks are created
const planning = meeting('2026-07-27_1000', 'Launch Planning', `## Summary [00:01]
We planned the launch.

## Decisions [00:05]
- Ship on Friday.

## Action items [00:20]
- Maya: prepare the rollout plan by Friday
- Chuck: review the pricing deck
- Send the contract to legal
- URGENT: fix the login bug before Friday
`);

// Wednesday: one of them is restated, one is new
const standup = meeting('2026-07-29_0900', 'Wednesday Standup', `## Summary [00:01]
Quick check-in.

## Action items [00:10]
- Maya: prepare a rollout plan
- Book the launch venue
`);

// and a meeting with nothing to do
meeting('2026-07-28_1400', 'Retro', `## Summary [00:01]
Talked about process.

## Action items [00:09]
- No action items recorded.
`);

dialog.showMessageBox = async () => ({ response: 1 });
require('../main.js');

app.whenReady().then(async () => {
  const win = await mainWindow({ settleMs: 1500 });
  const errs = [];
  win.webContents.on('console-message', (_e, l, m) => { if (l >= 2) errs.push(m); });
  const $ = js => win.webContents.executeJavaScript(js, true);
  const click = async sel => {
    await $(`document.querySelector(${JSON.stringify(sel)}).click()`);
    await new Promise(r => setTimeout(r, 300));
  };

  const chooseItems = async (folder, needles) => {
    await $(`openMeetingByFolder(${JSON.stringify(folder)})`);
    await new Promise(r => setTimeout(r, 300));
    for (const needle of needles) {
      const clicked = await $(`(() => {
        const li = [...document.querySelectorAll('#notes li')]
          .find(x => x.textContent.toLowerCase().includes(${JSON.stringify(needle.toLowerCase())}));
        const btn = li && li.querySelector('.li-add');
        if (!btn) return false;
        btn.click();
        return true;
      })()`);
      check(`can choose "${needle}"`, clicked, 'button was not found');
      await new Promise(r => setTimeout(r, 300));
    }
  };

  await $('window.yapper.refreshLibrary()');
  let list = await $('window.yapper.listActions()');
  check('refreshing notes adds nothing on its own', list.length === 0,
    `${list.length} items appeared without a click`);

  // Choose three tasks from planning, deliberately leave the contract out,
  // then choose the repeated rollout and one new item from the stand-up.
  await chooseItems(planning, ['rollout plan', 'pricing deck', 'login bug']);
  await chooseItems(standup, ['rollout plan', 'launch venue']);
  list = await $('window.yapper.listActions()');
  say(`  items: ${list.map(r => `${r.owner || '—'}/${r.text}`).join(' | ')}\n`);

  // ---- selection and extraction ----
  check('only the chosen action items enter the list', list.length === 4, `${list.length}: see above`);
  check('the item deliberately left unselected stays out',
    !list.some(r => /contract/i.test(r.text)), 'the contract was added');
  check('reads the owners that were actually named',
    list.filter(r => r.owner).map(r => r.owner).sort().join(',') === 'Chuck,Maya',
    list.map(r => r.owner).join(','));
  check('leaves the owner empty when nobody was named',
    list.some(r => /venue/i.test(r.text) && !r.owner), 'made one up');
  check('reads the dates as written', list.some(r => r.due === 'Friday'), 'found none');
  check('flags what is urgent', list.some(r => r.priority === 'high' && /login/i.test(r.text)),
    'did not flag the bug');

  // ---- duplicates ----
  const rollout = list.filter(r => /rollout/i.test(r.text));
  check('an action item repeated across two meetings is ONE row', rollout.length === 1,
    `${rollout.length} filas`);
  check('and remembers both meetings', (rollout[0].mentions || []).length === 2,
    JSON.stringify(rollout[0].sources));
  check('keeping the original owner', rollout[0].owner === 'Maya', rollout[0].owner);
  check('what is new in the standup does get added', list.some(r => /venue/i.test(r.text)), 'falta');

  // ---- the summary on the main screen ----
  const summary = await $(`(() => {
    const el = document.getElementById('action-summary');
    return { text: el.textContent, hidden: el.classList.contains('hidden') };
  })()`);
  say(`  resumen: "${summary.text}"`);
  check('the home screen summarises the action items', !summary.hidden, 'is hidden');
  check('with the count and the urgent ones',
    /4 action items pending/.test(summary.text) && /1 high priority/.test(summary.text),
    summary.text);

  // The theme button is fixed to the window and floats over whatever is under
  // it. On a narrow window the column reaches the edge, and this bar — the
  // first thing in the view — ended up covered by it: the button sat on the
  // text. Measured with the window small, which is where it happens.
  const wasSize = win.getSize();
  win.setSize(1000, 760);
  await new Promise(r => setTimeout(r, 400));
  const clash = await $(`(() => {
    const b = document.getElementById('btn-theme').getBoundingClientRect();
    const a = document.getElementById('action-summary').getBoundingClientRect();
    const over = !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
    return { over, gap: Math.round(b.left - a.right) };
  })()`);
  check('the bar does not end up under the theme button on a narrow window',
    !clash.over, `they overlap by ${-clash.gap}px`);
  win.setSize(wasSize[0], wasSize[1]);
  await new Promise(r => setTimeout(r, 200));

  // ---- the view ----
  await click('#btn-reminders');
  const rows = () => $(`[...document.querySelectorAll('#reminders-list .reminder')].map(li => ({
    text: li.querySelector('.r-text').value,
    owner: (li.querySelector('.r-owner') || {}).textContent || '',
    due: (li.querySelector('.r-due') || {}).textContent || '',
    urgent: li.classList.contains('urgent'),
    meeting: (li.querySelector('.r-open') || {}).textContent || '',
    again: (li.querySelector('.r-again') || {}).textContent || '',
    done: li.classList.contains('done')
  }))`);

  let shown = await rows();
  check('the view lists the chosen action items', shown.length === 4, `${shown.length} filas`);
  check('urgent items come first', shown[0].urgent, JSON.stringify(shown[0]));
  check('shows the owner', shown.some(r => r.owner === 'Maya'), JSON.stringify(shown));
  check('shows the date', shown.some(r => r.due === 'Friday'), JSON.stringify(shown));
  check('shows which meeting it came from',
    shown.some(r => r.meeting === 'Launch Planning'), JSON.stringify(shown.map(r => r.meeting)));
  check('warns when it recurred in another meeting',
    shown.some(r => /also in 1 other meeting/.test(r.again)), JSON.stringify(shown.map(r => r.again)));

  // ---- filters ----
  await click('#action-filter .seg-btn[data-filter="high"]');
  shown = await rows();
  check('the urgent filter leaves only one', shown.length === 1, `${shown.length}`);
  await click('#action-filter .seg-btn[data-filter="mine"]');
  shown = await rows();
  check('the "has owner" filter leaves two', shown.length === 2, `${shown.length}`);
  await click('#action-filter .seg-btn[data-filter="done"]');
  check('with nothing done, the filter says so',
    (await $("!!document.querySelector('#reminders-list .reminders-empty')")), 'no avisa');
  await click('#action-filter .seg-btn[data-filter="open"]');

  // ---- completing, editing, deleting ----
  await click('#reminders-list .reminder .r-check');
  await new Promise(r => setTimeout(r, 300));
  let after = await $('window.yapper.listActions()');
  check('marking as done is saved', after.filter(r => r.done).length === 1,
    `${after.filter(r => r.done).length} hechos`);
  check('and it disappears from "Open"', (await rows()).length === 3, `${(await rows()).length}`);

  await $(`(() => { const i = document.querySelector('#reminders-list .reminder .r-text');
    i.value = 'edited by hand'; i.dispatchEvent(new Event('change')); })()`);
  await new Promise(r => setTimeout(r, 400));
  after = await $('window.yapper.listActions()');
  check('editing by hand is saved', after.some(r => r.text === 'edited by hand'),
    'was not saved');

  // ---- several at once ----
  // Select mode is off by default, so the checkboxes cost nothing until asked for.
  const boxVisible = () => $(`(() => { const b = document.querySelector('#reminders-list .r-select');
    return !!b && getComputedStyle(b).display !== 'none'; })()`);
  check('row checkboxes are hidden until Select is pressed', !(await boxVisible()), 'visible already');
  await click('#btn-select-actions');
  check('Select shows a checkbox per row', await boxVisible(), 'still hidden');
  check('Mark as done is disabled with nothing selected',
    await $("document.getElementById('btn-bulk-done').disabled"), 'enabled');
  await click('#select-all-actions');
  const picked = await $("document.querySelectorAll('#reminders-list .r-select:checked').length");
  const openRows = (await rows()).length;
  check('Select all ticks every row shown', picked === openRows, `${picked} of ${openRows}`);
  check('and the count says so',
    new RegExp(`${openRows} of ${openRows} selected`).test(await $("document.getElementById('bulk-count').textContent")),
    await $("document.getElementById('bulk-count').textContent"));
  await click('#btn-bulk-done');
  await new Promise(r => setTimeout(r, 400));
  after = await $('window.yapper.listActions()');
  check('Mark as done completes every selected item in one go',
    after.every(r => r.done), `${after.filter(r => !r.done).length} still open`);
  check('"Open" is empty afterwards',
    (await $("!!document.querySelector('#reminders-list .reminders-empty')")), 'rows remain');
  check('and select mode switches itself off',
    await $("document.getElementById('bulk-row').classList.contains('hidden')"), 'bar still shown');

  // From "Done" the same button reverses it, so a slip is one click away from undone.
  await click('#action-filter .seg-btn[data-filter="done"]');
  await click('#btn-select-actions');
  check('inside Done the button reads Mark as not done',
    (await $("document.getElementById('btn-bulk-done').textContent")) === 'Mark as not done',
    await $("document.getElementById('btn-bulk-done').textContent"));
  await click('#select-all-actions');
  await click('#btn-bulk-done');
  await new Promise(r => setTimeout(r, 400));
  after = await $('window.yapper.listActions()');
  check('Mark as not done reopens the lot', after.every(r => !r.done),
    `${after.filter(r => r.done).length} still done`);
  await click('#action-filter .seg-btn[data-filter="open"]');
  await click('#reminders-list .reminder .r-check');
  await new Promise(r => setTimeout(r, 300));
  after = await $('window.yapper.listActions()');

  const before = (await rows()).length;
  await click('#reminders-list .reminder .r-del');
  check('deleting removes the row', (await rows()).length === before - 1,
    `${(await rows()).length} of ${before}`);

  // ---- opening the meeting it came from ----
  // Clicked from here and then polled from here: waiting inside the page races
  // with the IPC round trip the click sets off, and that is a flaky test rather
  // than a broken feature.
  await click('#action-filter .seg-btn[data-filter="all"]');
  const found = await $(`(() => {
    const btn = [...document.querySelectorAll('#reminders-list .r-open')]
      .find(b => b.textContent === 'Launch Planning');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  check('there is a button to open the meeting', found, 'could not find it');
  const state = () => $(`({
    meeting: !document.getElementById('view-meeting').classList.contains('hidden'),
    reminders: !document.getElementById('view-reminders').classList.contains('hidden'),
    record: !document.getElementById('view-record').classList.contains('hidden'),
    title: document.getElementById('result-title').textContent
  })`);
  // Held for well past the auto-detect poll: it used to force the record view a
  // few hundred milliseconds later, so the meeting opened and then vanished.
  await new Promise(r => setTimeout(r, 6500));
  const opened = await state();
  check('opens the source meeting',
    opened.meeting && opened.title === 'Launch Planning', JSON.stringify(opened));
  check('and nothing closes it behind your back', !opened.record, JSON.stringify(opened));

  // ---- nothing is invented on a re-index ----
  await $('window.yapper.refreshLibrary()');
  const again = await $('window.yapper.listActions()');
  check('re-indexing duplicates nothing', again.length === after.length - 1,
    `${again.length} ahora, ${after.length - 1} esperados`);

  if (errs.length) say('  renderer errors: ' + errs.slice(0, 4).join(' | '));
  say(fails ? `\n${fails} failures` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(e => { say('FAIL ' + (e.stack || e.message)); app.exit(1); });
