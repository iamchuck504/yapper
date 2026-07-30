// The day and the week, driven in the real window.
//
// Three things are worth more than the rest here: every line has to offer the
// meeting it came from, the weekly review must not turn into a second copy of
// the day's task list, and a week the notes cannot support has to say so instead
// of being filled in.
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { sandbox, logger, mainWindow, within } = require('./harness');

const ROOT = sandbox('home-ui');
const say = logger(ROOT);

let fails = 0;
function check(name, ok, detail) {
  if (ok) say(`ok    ${name}`);
  else { fails++; say(`FAIL  ${name}\n      ${detail}`); }
}

const p = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
const now = new Date();
const TODAY = iso(now);
const shift = days => iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days));
const monday = iso(new Date(now.getFullYear(), now.getMonth(),
  now.getDate() - ((now.getDay() + 6) % 7)));
const OVERDUE = shift(-10);

function meeting(name, files) {
  const folder = path.join(ROOT, 'Meetings', name);
  fs.mkdirSync(folder, { recursive: true });
  for (const [f, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(folder, f), content, 'utf8');
  }
}

// Today: a meeting with real notes …
meeting(`${TODAY}_0900`, {
  'title.txt': 'Standup',
  'participants.txt': 'Chuck, Maya',
  'transcript.txt': '[00:00:01] The rollout is ready for Thursday.',
  'notes.md': `## Summary [00:01]
A short standup about the rollout.

## Decisions [00:20]
- Ship the rollout on Thursday.
- Keep the old endpoint alive for one more week.

## Action items [01:00]
- Maya: update the changelog before the rollout
`
});

// … one that was transcribed and never written up …
meeting(`${TODAY}_1600`, {
  'title.txt': 'Vendor Sync',
  'participants.txt': 'Chuck, Carlos',
  'transcript.txt': '[00:00:03] Carlos said the contract is still unsigned.'
});

// … a second meeting this week, so the week has a thread to find …
meeting(`${monday}_1000`, {
  'title.txt': 'Rollout Planning',
  'participants.txt': 'Chuck, Maya, Carlos',
  'transcript.txt': '[00:00:02] We planned the rollout for next Tuesday.',
  'notes.md': `## Summary [00:02]
Planning for the rollout.

## Decisions [00:30]
- The rollout targets Tuesday.

## Open questions [01:00]
- Nobody owns the rollback script.

## Action items [01:20]
- Carlos: send the vendor contract by ${OVERDUE}
`
});

// … and one long before, which must stay out of both panels.
meeting('2026-01-05_1100', {
  'title.txt': 'Kickoff',
  'transcript.txt': '[00:00:01] Kicking the year off.',
  'notes.md': '## Decisions\n- Nothing was decided in January.\n'
});

require('../main.js');

app.whenReady().then(async () => {
  const win = await mainWindow({ settleMs: 1500 });
  const $ = js => win.webContents.executeJavaScript(js, true);

  await $('window.yapper.refreshLibrary()');
  await $(`document.getElementById('btn-home').click()`);
  await new Promise(r => setTimeout(r, 900));

  const rows = id => $(`[...document.querySelectorAll('#${id} .digest-item')].map(li => ({
    text: li.textContent,
    sources: [...li.querySelectorAll('.digest-source')].map(b => b.textContent),
    live: [...li.querySelectorAll('.digest-source:not(:disabled)')].length
  }))`);
  const visible = id => $(`!document.getElementById('${id}').classList.contains('hidden')`);
  const text = id => $(`document.getElementById('${id}').textContent`);

  // ---------------- the day ----------------
  say('\n  --- today ---');
  check('the view opens on the day', await visible('view-home') && await visible('home-day'), 'did not open');
  check('the title says Today', (await text('home-title')).trim() === 'Today', await text('home-title'));

  const meetings = await rows('day-meetings');
  say(`  meetings: ${meetings.map(m => m.text.trim()).join(' | ')}`);
  check('only today ones, in order',
    meetings.length === 2 && /09:00/.test(meetings[0].text) && /Standup/.test(meetings[0].text)
      && /16:00/.test(meetings[1].text) && /Vendor Sync/.test(meetings[1].text),
    JSON.stringify(meetings.map(m => m.text)));
  check('the January one does not show up',
    !meetings.some(m => /Kickoff/.test(m.text)), JSON.stringify(meetings.map(m => m.text)));

  const decisions = await rows('day-decisions');
  say(`  decisiones: ${decisions.map(d => d.text.trim()).join(' | ')}`);
  check('today decisions, and only today ones',
    decisions.length === 2 && decisions.every(d => /Standup/.test(d.sources.join())),
    JSON.stringify(decisions));
  check('the summary does not sneak in as a decision',
    !decisions.some(d => /short standup/i.test(d.text)), JSON.stringify(decisions.map(d => d.text)));
  check('the Monday decision is not in the day view',
    !decisions.some(d => /targets Tuesday/i.test(d.text)), JSON.stringify(decisions.map(d => d.text)));
  check('every decision offers to open its meeting',
    decisions.every(d => d.live === 1), JSON.stringify(decisions));

  const created = await rows('day-actions');
  check('new tasks carry owner and origin',
    created.length === 1 && /changelog/.test(created[0].text) && /Maya/.test(created[0].text)
      && created[0].live === 1,
    JSON.stringify(created));

  const attention = await rows('day-attention');
  say(`  attention: ${attention.map(a => a.text.trim()).join(' | ')}`);
  check('the meeting with no notes is flagged, by name',
    attention.some(a => /no notes/i.test(a.text) && /Vendor Sync/.test(a.sources.join())),
    JSON.stringify(attention));
  check('the overdue task is flagged as overdue',
    attention.some(a => /overdue/i.test(a.text) && /vendor contract/i.test(a.text)),
    JSON.stringify(attention));
  check('the sidebar counter agrees',
    (await text('home-count')) === String(attention.length),
    `${await text('home-count')} vs ${attention.length}`);

  await $(`document.querySelector('#day-decisions .digest-source').click()`);
  await new Promise(r => setTimeout(r, 1000));
  check('the source opens the meeting, and it is the right one',
    await visible('view-meeting') && /Standup/.test(await text('result-title')),
    `visible=${await visible('view-meeting')} title="${await text('result-title')}"`);

  // ---------------- an empty day ----------------
  say('\n  --- a day with nothing ---');
  await $(`document.getElementById('btn-home').click()`);
  await new Promise(r => setTimeout(r, 700));
  const emptyDay = await $(`(async () => {
    const d = await window.yapper.dailyDigest('2026-03-11');
    return { empty: d.empty, previous: d.previous, meetings: d.meetings.length };
  })()`);
  say(`  ${JSON.stringify(emptyDay)}`);
  check('an empty day declares itself empty and invents nothing',
    emptyDay.empty === true && emptyDay.meetings === 0, JSON.stringify(emptyDay));
  check('and offers the previous day that did have something',
    emptyDay.previous === '2026-01-05', emptyDay.previous);

  // ---------------- the week ----------------
  say('\n  --- the week ---');
  await $(`document.querySelector('#home-scope .seg-btn[data-scope="week"]').click()`);
  const t0 = Date.now();
  await within($(`(async () => {
    for (let i = 0; i < 240; i++) {
      const foot = document.getElementById('week-foot');
      if (!foot.classList.contains('hidden')) return true;
      await new Promise(r => setTimeout(r, 500));
    }
    return false;
  })()`), 'la semana', 3 * 60 * 1000);
  say(`  escrita en ${((Date.now() - t0) / 1000).toFixed(0)} s`);

  const stats = await $(`[...document.querySelectorAll('.week-stat')].map(s => s.textContent)`);
  say(`  hechos: ${stats.join(' | ')}`);
  check('the facts of the week are shown',
    stats.some(s => /^3meetings|^3 ?meetings/.test(s.replace(/\s+/g, ''))) || stats.length === 6,
    JSON.stringify(stats));
  check('the no-notes warning names the meeting',
    /Vendor Sync/.test(await text('week-facts')), await text('week-facts'));

  const sections = await $(`[...document.querySelectorAll('#week-sections .week-section')].map(s => ({
    title: s.querySelector('.digest-h').textContent,
    none: !!s.querySelector('.week-none'),
    items: [...s.querySelectorAll('.digest-item')].map(li => ({
      text: li.querySelector('.digest-text').textContent,
      sources: [...li.querySelectorAll('.digest-source')].map(b => b.textContent)
    }))
  }))`);
  say('  ' + JSON.stringify(sections, null, 1).replace(/\n\s*/g, ' ').slice(0, 700));

  check('all three sections are present',
    JSON.stringify(sections.map(s => s.title)) === '["Threads","Shifts","Unresolved"]',
    JSON.stringify(sections.map(s => s.title)));
  const items = sections.flatMap(s => s.items);
  check('everything shown cites a real meeting',
    items.length > 0 && items.every(i => i.sources.length >= 1), JSON.stringify(items));
  check('the citations are from this week, not from January',
    !items.some(i => i.sources.join().includes('Kickoff')), JSON.stringify(items.map(i => i.sources)));

  const weekText = await text('week-sections');
  check('the week does NOT repeat the task list',
    !/changelog/i.test(weekText), weekText.slice(0, 400));
  check('nor does it turn into a list of meetings',
    !/^\s*(Standup|Rollout Planning)\s*$/m.test(weekText), weekText.slice(0, 400));
  check('the footer says how many meetings it came from',
    /\d meeting/.test(await text('week-note')), await text('week-note'));

  const cites = await $(`(() => { const b = document.querySelector('#week-sections .digest-source');
    return b ? b.textContent : ''; })()`);
  if (cites) {
    await $(`document.querySelector('#week-sections .digest-source').click()`);
    await new Promise(r => setTimeout(r, 1000));
    check('a citation from the week opens its meeting', await visible('view-meeting'), 'did not open');
    await $(`document.getElementById('btn-home').click()`);
    await new Promise(r => setTimeout(r, 600));
  }

  // ---------------- cached, and a week that cannot be written ----------------
  const second = await within($(`window.yapper.weeklySummary({})`), 'segunda lectura', 60 * 1000);
  check('the second time, what was already written is reused', second.cached === true,
    JSON.stringify({ cached: second.cached, reason: second.reason }));

  const thin = await within($(`window.yapper.weeklySummary({ week: '2026-01-07' })`), 'thin week', 60 * 1000);
  say(`  January week -> ${JSON.stringify({ reason: thin.reason, sections: !!thin.sections })}`);
  check('a week with a single note is not written: it is explained',
    thin.reason === 'thin' && !thin.sections, JSON.stringify(thin).slice(0, 200));
  check('and it still carries the facts',
    thin.facts && thin.facts.meetings.length === 1, JSON.stringify(thin.facts || {}).slice(0, 200));

  const nothing = await within($(`window.yapper.weeklySummary({ week: '2025-02-05' })`), 'empty week', 60 * 1000);
  check('a week with no meetings is not written either',
    nothing.reason === 'no-meetings' && !nothing.sections, JSON.stringify(nothing).slice(0, 160));
  check('and it does not offer to go back to nothing', nothing.previous === '', String(nothing.previous));

  // An empty week on screen: no wall of zeroes, no buttons that do nothing.
  await $(`(() => { homeWeekOf = '2025-02-05'; loadWeek(); })()`);
  await new Promise(r => setTimeout(r, 1800));
  const bare = await $(`({
    facts: !document.getElementById('week-facts').classList.contains('hidden'),
    zeros: [...document.querySelectorAll('.week-stat')].length,
    refresh: !document.getElementById('btn-week-refresh').classList.contains('hidden'),
    back: !!document.querySelector('#week-sections .btn-ghost'),
    status: document.getElementById('week-status').textContent
  })`);
  say(`  empty week on screen -> ${JSON.stringify(bare)}`);
  check('an empty week does not show the wall of zeroes',
    !bare.facts && bare.zeros === 0, JSON.stringify(bare));
  check('nor offers to rewrite what was never written', !bare.refresh, JSON.stringify(bare));
  check('nor to go back when there is nothing behind', !bare.back, JSON.stringify(bare));
  check('what it does do is say so', /No meetings this week/i.test(bare.status), bare.status);

  // With meetings before it, there is a way out — and it leads to a week that had something.
  const janWeek = await within($(`window.yapper.weeklySummary({ week: '2026-02-04' })`), 'february', 60 * 1000);
  check('from a later empty week, the way out points at something real',
    janWeek.previous === '2026-01-05', String(janWeek.previous));

  say(fails ? `\n${fails} fallos` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(e => { say('FAIL ' + (e.stack || e.message)); app.exit(1); });
