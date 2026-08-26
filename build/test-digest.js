// The digests are the features with the most room to say something that is not
// true: they read across many meetings and present a short conclusion, which is
// exactly where a detail gets attached to the wrong meeting or a date appears
// out of nowhere. So the rules are tested one by one — what a due date is
// allowed to resolve to, what reaches the model, and what is thrown away when it
// comes back uncited.
const digest = require('../digest');

let fails = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      esperaba ${JSON.stringify(want)}\n      obtuve   ${JSON.stringify(got)}`); }
}
function ok(name, cond, detail) {
  if (cond) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      ${detail}`); }
}

function meeting(name, extra = {}) {
  return {
    folder: `C:/M/${name}`, name, date: name.slice(0, 10),
    title: extra.title || name, participants: extra.participants || [],
    hasNotes: extra.sections ? true : !!extra.hasNotes,
    hasTranscript: extra.hasTranscript !== false,
    sections: extra.sections || [], stamp: extra.stamp || 'a:1:1;'
  };
}

// ---------------------------------------------------------------- cache key

console.log('\n-- the cache key --');
const m1 = meeting('2026-07-27_0900');
const m2 = meeting('2026-07-28_1000');
check('the same week yields the same key',
  digest.digestKey([m1, m2]) === digest.digestKey([m1, m2]), true);
check('the order does not change it',
  digest.digestKey([m1, m2]) === digest.digestKey([m2, m1]), true);
check('an edited note does change it',
  digest.digestKey([m1, m2]) === digest.digestKey([m1, { ...m2, stamp: 'a:2:9;' }]), false);
check('a new meeting does too',
  digest.digestKey([m1, m2]) === digest.digestKey([m1, m2, meeting('2026-07-29_1100')]), false);

// ---------------------------------------------------------------- due dates

console.log('\n-- a date only if it is written down --');
check('ISO', digest.dueOn('2026-08-03', '2026-07-29'), '2026-08-03');
check('month and day', digest.dueOn('July 30', '2026-07-29'), '2026-07-30');
check('day and month', digest.dueOn('3 August', '2026-07-29'), '2026-08-03');
check('with an explicit year', digest.dueOn('August 3, 2027', '2026-07-29'), '2027-08-03');
check('barras', digest.dueOn('8/3', '2026-07-29'), '2026-08-03');
check('slashes with a short year', digest.dueOn('8/3/27', '2026-07-29'), '2027-08-03');
for (const vague of ['Friday', 'end of week', 'next week', 'tomorrow', 'soon', 'Q3', '']) {
  check(`"${vague}" does not become a date`, digest.dueOn(vague, '2026-07-29'), '');
}

// ---------------------------------------------------------------- daily

console.log('\n-- the daily digest --');
const TODAY = '2026-07-29';

const standup = meeting('2026-07-29_0900', {
  title: 'Standup', participants: ['Chuck', 'Maya'],
  sections: [
    { heading: 'Summary [00:01]', body: 'A short standup about the rollout.' },
    { heading: 'Decisions [00:20]', body: '- Ship the rollout on Thursday.\n- Keep the old endpoint for a week.' },
    { heading: 'Action items [01:00]', body: '- Maya: update the changelog' }
  ]
});
const review = meeting('2026-07-29_1400', {
  title: 'Design Review', participants: ['Chuck', 'Robert'],
  sections: [
    { heading: 'Decisions', body: 'None' },
    { heading: 'Open questions', body: '- Who owns the migration script?' }
  ]
});
const untouched = meeting('2026-07-29_1600', { title: 'Sync', hasNotes: false, hasTranscript: true });
const lastWeek = meeting('2026-07-21_1000', {
  title: 'Planning',
  sections: [{ heading: 'Decisions', body: '- Pricing stays at twenty nine.' }]
});
const MEETINGS = [standup, review, untouched, lastWeek];

const ITEMS = [
  { text: 'update the changelog', owner: 'Maya', due: '', priority: 'normal', done: false, folder: standup.folder, meeting: 'Standup', sources: [standup.folder] },
  { text: 'fix the login bug', owner: '', due: '', priority: 'high', done: false, folder: review.folder, meeting: 'Design Review', sources: [review.folder] },
  { text: 'send the vendor contract', owner: 'Robert', due: 'July 24', priority: 'normal', done: false, folder: lastWeek.folder, meeting: 'Planning', sources: [lastWeek.folder] },
  { text: 'book the venue', owner: 'Chuck', due: 'August 12', priority: 'normal', done: false, folder: lastWeek.folder, meeting: 'Planning', sources: [lastWeek.folder] },
  { text: 'archive the old repo', owner: 'Chuck', due: 'July 20', priority: 'normal', done: true, folder: lastWeek.folder, meeting: 'Planning', sources: [lastWeek.folder] }
];

const day = digest.dailyDigest({ meetings: MEETINGS, items: ITEMS, day: TODAY });

check('only today meetings', day.meetings.map(m => m.title), ['Standup', 'Design Review', 'Sync']);
check('in the order they happened', day.meetings.map(m => m.time), ['09:00', '14:00', '16:00']);
check('each carries its folder so it can be opened',
  day.meetings.every(m => m.folder.startsWith('C:/M/')), true);
check('decisions come from the decisions section',
  day.decisions.map(d => d.text),
  ['Ship the rollout on Thursday.', 'Keep the old endpoint for a week.']);
check('every decision knows which meeting it came from',
  day.decisions.map(d => d.meeting.title), ['Standup', 'Standup']);
check('"None" does not count as a decision', day.counts.decisions, 2);
ok('the summary does not sneak in as a decision',
  !day.decisions.some(d => /short standup/i.test(d.text)), JSON.stringify(day.decisions));
ok('nor the decision from last week',
  !day.decisions.some(d => /twenty nine/i.test(d.text)), JSON.stringify(day.decisions));

check('today tasks are the ones from today meetings',
  day.created.map(i => i.text).sort(), ['fix the login bug', 'update the changelog']);
ok('a completed task never shows up',
  !JSON.stringify(day).includes('archive the old repo'), 'showed up');

const kinds = day.attention.map(a => a.kind);
ok('flags the transcribed meeting with no notes', kinds.includes('no-notes'), JSON.stringify(day.attention));
check('names it',
  day.attention.filter(a => a.kind === 'no-notes').map(a => a.meeting.title), ['Sync']);
check('overdue means a past date and still open',
  day.attention.filter(a => a.kind === 'overdue').map(a => a.text), ['send the vendor contract']);
ok('a future date is not overdue',
  !day.attention.some(a => /book the venue/.test(a.text)), JSON.stringify(day.attention));
check('urgent items for today surface too',
  day.attention.filter(a => a.kind === 'urgent').map(a => a.text), ['fix the login bug']);
check('the counters add up',
  day.counts, { meetings: 3, decisions: 2, created: 2, openTotal: 4 });

const quiet = digest.dailyDigest({ meetings: MEETINGS, items: [], day: '2026-07-25' });
check('a day with nothing declares itself empty', quiet.empty, true);
check('and it invents no meetings', quiet.meetings.length, 0);

check('an empty day knows whether the whole library is empty', quiet.library, 4);
check('and with an empty library it says so',
  digest.dailyDigest({ meetings: [], items: [], day: TODAY }).library, 0);

const quietButOwing = digest.dailyDigest({ meetings: MEETINGS, items: ITEMS, day: '2026-07-25' });
ok('a day with no meetings but something overdue is not empty',
  quietButOwing.empty === false && quietButOwing.attention.length > 0,
  JSON.stringify(quietButOwing.counts));

// ---------------------------------------------------------------- weekly facts

console.log('\n-- the facts of the week --');
const facts = digest.weeklyFacts({
  meetings: MEETINGS, items: ITEMS, from: '2026-07-27', to: '2026-08-02', today: TODAY
});
check('only the requested week', facts.meetings.map(m => m.title), ['Standup', 'Design Review', 'Sync']);
check('last week is left out',
  facts.meetings.some(m => m.title === 'Planning'), false);
check('counts the decisions of the week', facts.decisionCount, 2);
check('people, by how often they came up',
  facts.people.map(p => `${p.name}:${p.count}`), ['Chuck:2', 'Maya:1', 'Robert:1']);
check('the days with a meeting', facts.days, [{ date: '2026-07-29', count: 3 }]);
check('meetings without notes are flagged',
  facts.missingNotes.map(m => m.title), ['Sync']);
check('overdue items are counted once', facts.overdue, 1);
check('open tasks born during the week', facts.openFromWeek, 2);
check('two meetings with notes is no longer a thin week', facts.thin, false);
check('a single one, yes — no threads to cross',
  digest.weeklyFacts({ meetings: [standup, untouched], from: '2026-07-27', to: '2026-08-02' }).thin, true);
check('a week with no meetings declares itself empty',
  digest.weeklyFacts({ meetings: MEETINGS, from: '2026-06-01', to: '2026-06-07' }).empty, true);

// ---------------------------------------------------------------- weekly input

console.log('\n-- what is sent to the model --');
const input = digest.weeklyInput([standup, review, untouched, lastWeek]);
ok('carries the titles and the dates',
  /=== Standup \| 2026-07-29 \| Chuck, Maya ===/.test(input.text), input.text.slice(0, 200));
ok('carries the decisions', /Ship the rollout on Thursday/.test(input.text), 'faltan');
ok('does NOT carry the tasks section — so it cannot repeat them',
  !/changelog/i.test(input.text), input.text);
ok('a meeting with no notes is not sent', !/=== Sync/.test(input.text), input.text);
check('reports how many it sent', input.meetings, 3);

const long = meeting('2026-07-30_0900', {
  title: 'Marathon',
  sections: [{ heading: 'Summary', body: 'x'.repeat(digest.MAX_MEETING_CHARS + 500) }]
});
const cut = digest.weeklyInput([long]);
ok('a huge note is truncated', cut.text.length < digest.MAX_MEETING_CHARS + 300, `${cut.text.length}`);
check('and the truncation is reported, not hidden', cut.truncated, 1);

// ---------------------------------------------------------------- weekly parse

console.log('\n-- what is accepted back --');
const week = [standup, review, lastWeek];
const good = digest.parseWeekly(`## Threads
- The rollout moved from a plan to a date. [Standup, Planning]
- Pricing was settled and not reopened. [Planning, Standup]

## Shifts
- The old endpoint now survives a week longer than agreed. [Standup]

## Unresolved
- Nobody owns the migration script. [Design Review]
`, week);

check('all three sections, in order', good.sections.map(s => s.title), ['Threads', 'Shifts', 'Unresolved']);
check('the threads are preserved', good.sections[0].items.length, 2);
check('the citation resolves to real meetings',
  good.sections[0].items[0].cites.map(c => c.title), ['Standup', 'Planning']);
check('with their folder, so they can be opened',
  good.sections[0].items[0].cites.every(c => c.folder.startsWith('C:/M/')), true);
check('the bracket is stripped from the text',
  good.sections[0].items[0].text, 'The rollout moved from a plan to a date.');
check('nothing was discarded', good.dropped.length, 0);

const bad = digest.parseWeekly(`## Threads
- The Tokyo office lease was signed on Tuesday. [Tokyo Kickoff]
- Hiring slowed down this week.
- The rollout moved to Thursday. [Standup, Planning]

## Shifts
None

## Unresolved
None
`, week);
check('a citation to a meeting that does not exist is discarded',
  bad.sections[0].items.map(i => i.text), ['The rollout moved to Thursday.']);
check('and so is a claim with no source', bad.dropped.length, 2);
ok('it says why each one was discarded',
  bad.dropped.every(d => d.why), JSON.stringify(bad.dropped));
ok('anything invented survives nowhere',
  !JSON.stringify(bad.sections).includes('Tokyo'), JSON.stringify(bad.sections));
check('"None" is deliberately read as empty',
  bad.sections.slice(1).map(s => s.none), [true, true]);

const missing = digest.parseWeekly('## Threads\n- Something happened. [Standup, Planning]\n', week);
check('a section the model did not write still exists',
  missing.sections.map(s => `${s.title}:${s.items.length}`), ['Threads:1', 'Shifts:0', 'Unresolved:0']);
check('an empty answer declares itself empty',
  digest.parseWeekly('', week).empty, true);
check('and so does a whole answer with no citations',
  digest.parseWeekly('## Threads\n- We talked about many things.\n', week).empty, true);

console.log(fails ? `\n${fails} failures` : '\nPASS');
process.exit(fails ? 1 : 0);
