// The index is what every cross-meeting feature reads, so its date handling and
// its "has this changed?" fingerprint have to be right. Both are easy to get
// subtly wrong and hard to notice afterwards: a week that starts on the wrong
// day, or a cache that never notices an edited note.
const fs = require('fs');
const path = require('path');
const os = require('os');
const lib = require('../library');

let fails = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      esperaba ${JSON.stringify(want)}\n      obtuve   ${JSON.stringify(got)}`); }
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'yapper-library-'));
const MEETINGS = path.join(ROOT, 'Meetings');
const INDEX = path.join(ROOT, 'index.json');
fs.mkdirSync(MEETINGS, { recursive: true });

function meeting(name, files) {
  const folder = path.join(MEETINGS, name);
  fs.mkdirSync(folder, { recursive: true });
  for (const [f, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(folder, f), content, 'utf8');
  }
  return folder;
}

// ---------------------------------------------------------------- dates

check('the date comes from the folder name', lib.dateOf('2026-07-30_1415'), '2026-07-30');
check('an odd name yields no date', lib.dateOf('borrador'), '');
check('a name with a suffix too', lib.dateOf('2026-07-30_1415_2'), '2026-07-30');

// Thursday 30 July 2026 — its week runs Monday 27 to Sunday 2 August
const w = lib.weekOf('2026-07-30');
check('the week starts on Monday', w.from, '2026-07-27');
check('and ends on Sunday', w.to, '2026-08-02');
check('a Sunday belongs to the week that is ending', lib.weekOf('2026-08-02').from, '2026-07-27');
check('a Monday starts its own', lib.weekOf('2026-08-03').from, '2026-08-03');
check('the week label is stable',
  lib.weekOf('2026-07-30').label === lib.weekOf('2026-07-27').label, true);
check('and it changes moving into the next one',
  lib.weekOf('2026-08-03').label !== lib.weekOf('2026-07-30').label, true);
check('a week straddling two months is not split',
  [lib.weekOf('2026-07-31').from, lib.weekOf('2026-07-31').to], ['2026-07-27', '2026-08-02']);

// ---------------------------------------------------------------- reading

meeting('2026-07-30_0900', {
  'title.txt': 'Launch Sync',
  'participants.txt': 'Maya, Chuck',
  'transcript.txt': '[00:00:01] We ship on Friday.',
  'notes.md': `## Summary [00:01]
Agreed to launch.

## Decisions [00:05]
- Ship on Friday.

## Action items [00:20]
- Maya: prepare the rollout plan by Friday
- Chuck: review the pricing deck
`
});

let { meetings, changed } = lib.refresh({ meetingsDir: MEETINGS, indexFile: INDEX });
check('finds the meeting', meetings.length, 1);
check('reads it whole', changed.length, 1);
const m = meetings[0];
check('reads the title', m.title, 'Launch Sync');
check('reads the participants', m.participants, ['Maya', 'Chuck']);
check('knows it has notes and a transcript', [m.hasNotes, m.hasTranscript], [true, true]);
check('indexes the sections of the notes',
  m.sections.map(s => s.heading), ['Summary', 'Decisions', 'Action items']);
check('extracts the action items', m.items.length, 2);
check('with their owner', m.items.map(i => i.owner), ['Maya', 'Chuck']);
check('and its source meeting', m.items[0].meeting, 'Launch Sync');

// ---------------------------------------------------------------- the cache

({ meetings, changed } = lib.refresh({ meetingsDir: MEETINGS, indexFile: INDEX }));
check('the second time it is not read again', changed.length, 0);
check('but it is still there', meetings.length, 1);

// editing the notes must invalidate it
fs.writeFileSync(path.join(MEETINGS, '2026-07-30_0900', 'notes.md'),
  '## Action items\n- Maya: prepare the rollout plan\n- Chuck: review the deck\n- Send the contract\n', 'utf8');
({ meetings, changed } = lib.refresh({ meetingsDir: MEETINGS, indexFile: INDEX }));
check('editing the notes makes it read again', changed.length, 1);
check('and the items are updated', meetings[0].items.length, 3);

// a brand new meeting appears
meeting('2026-07-28_1500', { 'title.txt': 'Planning', 'transcript.txt': '[00:00:01] Hello.' });
({ meetings, changed } = lib.refresh({ meetingsDir: MEETINGS, indexFile: INDEX }));
check('a new meeting is added', meetings.length, 2);
check('and only the new one is read', changed.map(c => c.title), ['Planning']);
check('the newest come first', meetings.map(x => x.name),
  ['2026-07-30_0900', '2026-07-28_1500']);

// a deleted meeting disappears
fs.rmSync(path.join(MEETINGS, '2026-07-28_1500'), { recursive: true, force: true });
({ meetings } = lib.refresh({ meetingsDir: MEETINGS, indexFile: INDEX }));
check('a deleted meeting disappears from the index', meetings.length, 1);

// a corrupt index must not be fatal
fs.writeFileSync(INDEX, 'not json at all', 'utf8');
({ meetings, changed } = lib.refresh({ meetingsDir: MEETINGS, indexFile: INDEX }));
check('a corrupt index is rebuilt', meetings.length, 1);
check('by reading everything again', changed.length, 1);

// ---------------------------------------------------------------- selecting

meeting('2026-07-29_1000', { 'title.txt': 'Yesterday', 'transcript.txt': '[00:00:01] x' });
meeting('2026-07-30_1600', { 'title.txt': 'Later today', 'transcript.txt': '[00:00:01] y' });
meeting('2026-07-20_1000', { 'title.txt': 'Last week', 'transcript.txt': '[00:00:01] z' });
meeting('2026-07-30_1100', { 'title.txt': 'Nothing at all' });          // no transcript, no notes
({ meetings } = lib.refresh({ meetingsDir: MEETINGS, indexFile: INDEX }));

check('the ones from a given day', lib.onDay(meetings, '2026-07-30').length, 3);
check('sorted by time, latest first',
  lib.onDay(meetings, '2026-07-30').map(x => x.title), ['Later today', 'Nothing at all', 'Launch Sync']);
check('the ones in a date range',
  lib.inRange(meetings, '2026-07-27', '2026-08-02').map(x => x.title).sort(),
  ['Later today', 'Launch Sync', 'Nothing at all', 'Yesterday']);
check('the one from the previous week is left out',
  lib.inRange(meetings, '2026-07-27', '2026-08-02').some(x => x.title === 'Last week'), false);
check('only the ones with content',
  lib.withContent(lib.onDay(meetings, '2026-07-30')).map(x => x.title),
  ['Later today', 'Launch Sync']);

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(fails ? `\n${fails} failures` : '\nPASS');
process.exit(fails ? 1 : 0);
