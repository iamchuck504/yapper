// The transcript is the record, so the cleanup that runs over it has to remove
// the stutters and nothing else. Real speech repeats; decoders repeat
// differently, and the line between them is what these cases pin down.
const engine = require('../engine');

let fails = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      esperaba ${JSON.stringify(want)}\n      obtuve   ${JSON.stringify(got)}`); }
}

const s = engine.undoStutter;

// --- what must be removed ---
check('a repeated three-word phrase',
  s('I want to be clear I want to be clear about this'), 'I want to be clear about this');
check('repetition at the end of the line',
  s('we ship on Friday we ship on Friday'), 'we ship on Friday');
check('ignores punctuation when comparing',
  s('That is it. That is it'), 'That is it.');
check('ignores case',
  s('Moving on to the budget moving on to the budget now'), 'Moving on to the budget now');
check('a triple repetition collapses to one',
  s('let me be clear let me be clear let me be clear'), 'let me be clear');
check('repetition in the middle of the sentence',
  s('so the plan is the plan is to ship it'), 'so the plan is to ship it');

// --- what must survive ---
check('does not touch single-word repetitions', s('no no no'), 'no no no');
check('does not touch two-word repetitions', s('very good very good'), 'very good very good');
check('leaves a normal sentence alone',
  s('We agreed to ship the beta on Friday.'), 'We agreed to ship the beta on Friday.');
check('does not merge words that merely look alike',
  s('I want to be clear I want to be honest'), 'I want to be clear I want to be honest');
check('empty text', s(''), '');
check('a single word', s('hello'), 'hello');

// --- whole transcripts ---
check('drops a line that repeats the previous one',
  engine.deduplicate([
    '[00:00:01] I am not asking you to do it.',
    '[00:00:05] I am not asking you to do it.',
    '[00:00:09] Anyway, moving on.'
  ]),
  ['[00:00:01] I am not asking you to do it.', '[00:00:09] Anyway, moving on.']);

check('keeps the first timestamp, not the second',
  engine.deduplicate([
    '[00:00:01] we ship on Friday',
    '[00:00:04] we ship on Friday'
  ]),
  ['[00:00:01] we ship on Friday']);

// Seconds apart, this is the window seam: the same words re-emitted with more
// after them. Stripping the repeat leaves the sentence readable across the two
// lines, which is what it actually was.
check('seconds apart, it treats it as a seam',
  engine.deduplicate([
    '[00:00:01] we ship on Friday',
    '[00:00:05] we ship on Friday if the tests pass'
  ]),
  ['[00:00:01] we ship on Friday', '[00:00:05] if the tests pass']);

// Half a minute later it is a person restating it, and that belongs in the record.
check('half a minute later it is left intact',
  engine.deduplicate([
    '[00:00:01] we ship on Friday',
    '[00:00:40] we ship on Friday if the tests pass'
  ]),
  ['[00:00:01] we ship on Friday', '[00:00:40] we ship on Friday if the tests pass']);

check('an identical line much later is also kept',
  engine.deduplicate([
    '[00:00:01] I am not asking you to do it.',
    '[00:05:00] I am not asking you to do it.'
  ]),
  ['[00:00:01] I am not asking you to do it.', '[00:05:00] I am not asking you to do it.']);

check('cleans within each line too',
  engine.deduplicate(['[00:00:01] I want to be clear I want to be clear about this']),
  ['[00:00:01] I want to be clear about this']);

check('discards a line that ends up empty',
  engine.deduplicate(['[00:00:01]   ', '[00:00:05] real content here']),
  ['[00:00:05] real content here']);

check('a clean transcript is unchanged',
  engine.deduplicate(['[00:00:01] First thing.', '[00:00:05] Second thing.']),
  ['[00:00:01] First thing.', '[00:00:05] Second thing.']);

// --- the seam: the real case, from 2026-07-12_2058 ---
check('removes the repetition at the seam between two lines',
  engine.deduplicate([
    "[00:00:14] duplicate and we're trying to do that because he's like",
    "[00:00:18] he's like making like $10 million a year doing it"
  ]),
  ["[00:00:14] duplicate and we're trying to do that because he's like",
    '[00:00:18] making like $10 million a year doing it']);

check('the seam does not swallow the whole line',
  engine.deduplicate([
    '[00:00:01] so there is a',
    '[00:00:02] there is a phase one right'
  ]),
  ['[00:00:01] so there is a', '[00:00:02] phase one right']);

check('a single shared word is not a seam',
  engine.deduplicate([
    '[00:00:01] we talked about the plan',
    '[00:00:05] plan for next quarter'
  ]),
  ['[00:00:01] we talked about the plan', '[00:00:05] plan for next quarter']);

check('does not empty a line that is entirely the repetition',
  engine.deduplicate([
    '[00:00:01] we ship on Friday',
    '[00:00:05] on Friday'
  ]),
  ['[00:00:01] we ship on Friday', '[00:00:05] on Friday']);

// the six-times-in-a-row case that started all of this
check('the real case: the same sentence six times',
  engine.deduplicate(Array.from({ length: 6 }, (_, i) =>
    `[00:00:${String(i * 5).padStart(2, '0')}] I'm not asking you to do it. I actually very much`)),
  ["[00:00:00] I'm not asking you to do it. I actually very much"]);

console.log(fails ? `\n${fails} fallos` : '\nPASS');
process.exit(fails ? 1 : 0);
