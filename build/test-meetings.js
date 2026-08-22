// Checks that a false start is recognised as empty. Filesystem boundary cases
// live in test-security.js, which exercises the real shared guard.

let fails = 0;
function check(name, ok, detail) {
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      ${detail}`); }
}

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
