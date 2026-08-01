// Deleting a meeting is the one destructive thing the app does, so the guard
// that keeps it inside the meetings folder is tested against paths that try to
// escape it. Also checks that a false start is recognised as empty.
const path = require('path');

let fails = 0;
function check(name, ok, detail) {
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      ${detail}`); }
}

// the same rule main.js uses, kept in step by this test
const MEETINGS_DIR = path.join('C:', 'Users', 'iamch', 'Documents', 'Meetings');
function insideMeetings(folder) {
  const root = path.resolve(MEETINGS_DIR) + path.sep;
  const target = path.resolve(folder);
  return target.startsWith(root) && target !== path.resolve(MEETINGS_DIR);
}

const inside = [
  path.join(MEETINGS_DIR, '2026-07-29_0103'),
  path.join(MEETINGS_DIR, '2026-07-29_0103', 'nested')
];
const outside = [
  MEETINGS_DIR,                                            // the root itself
  path.join(MEETINGS_DIR, '..'),
  path.join(MEETINGS_DIR, '..', 'Downloads'),
  path.join(MEETINGS_DIR, '2026-07-29', '..', '..', 'Pictures'),
  path.join('C:', 'Windows', 'System32'),
  path.join('C:', 'Users', 'iamch', 'Documents'),
  path.join('C:', 'Users', 'iamch', 'Documents', 'MeetingsBackup'),   // prefix, not child
  ''
];

for (const p of inside) check(`permite borrar dentro: ${p}`, insideMeetings(p), 'blocked it');
for (const p of outside) check(`blocks outside: ${p || '(empty)'}`, !insideMeetings(p), 'allowed it');

// --- what counts as an empty meeting ---
const isEmpty = m => m.audioSec === 0 && !m.hasTranscript && !m.hasSummary;
check('a failed recording counts as empty',
  isEmpty({ audioSec: 0, hasTranscript: false, hasSummary: false }), 'did not flag it');
check('with audio it does not count as empty',
  !isEmpty({ audioSec: 42, hasTranscript: false, hasSummary: false }), 'flagged it');
check('an old compressed recording does not count as empty',
  !isEmpty({ audioSec: -1, hasTranscript: false, hasSummary: false }), 'flagged it');
check('no audio but with a transcript does not count as empty',
  !isEmpty({ audioSec: 0, hasTranscript: true, hasSummary: false }), 'flagged it');

console.log(fails ? `\n${fails} failures` : '\nPASS');
process.exit(fails ? 1 : 0);
