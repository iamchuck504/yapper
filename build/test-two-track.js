// The two sides of a call, kept as separate tracks and put back together as a
// labelled transcript. The claim that matters: a word's label comes from which
// stream carried it, so the merge must never invent, drop, or reorder — and a
// call with a silent far side must come out exactly as an unlabelled recording
// always did.
//
// The silence detector is what keeps the far-side track affordable: it is
// digital silence whenever nobody remote speaks, and a silent window skipped
// is an inference (and a hallucinated "Thank you.") avoided.
const engine = require('../engine');

let fails = 0;
function check(name, got, want = true) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      esperaba ${JSON.stringify(want)}\n      obtuve   ${JSON.stringify(got)}`); }
}

// ---------------------------------------------------------------- silence

const silent = Buffer.alloc(32000);                 // one second of zeros
check('digital silence is silent', engine.isSilentPcm(silent), true);

const dither = Buffer.alloc(32000);
for (let i = 0; i < dither.length; i += 2) dither.writeInt16LE((i / 2) % 2 ? 20 : -20, i);
check('dither-level noise still counts as silent', engine.isSilentPcm(dither), true);

const speech = Buffer.from(silent);
speech.writeInt16LE(1200, 16000);                   // one quiet sample mid-way
check('a single audible sample is not silence', engine.isSilentPcm(speech), false);

check('an empty buffer is silent', engine.isSilentPcm(Buffer.alloc(0)), true);

// ---------------------------------------------------------------- merging

const mic = ['[00:00:01] hola', '[00:00:10] sí, de acuerdo'];
const sys = ['[00:00:04] how are you?', '[00:00:07] one more thing'];

check('a silent far side changes nothing — no labels',
  engine.mergeSpeakerTracks(mic, []), mic);

check('a silent microphone still says who was speaking',
  engine.mergeSpeakerTracks([], sys),
  ['[00:00:04] Them: how are you?', '[00:00:07] Them: one more thing']);

check('the sides interleave by time, each line labelled',
  engine.mergeSpeakerTracks(mic, sys), [
    '[00:00:01] Me: hola',
    '[00:00:04] Them: how are you?',
    '[00:00:07] Them: one more thing',
    '[00:00:10] Me: sí, de acuerdo'
  ]);

check('same second: the microphone speaks first',
  engine.mergeSpeakerTracks(['[00:00:05] yo'], ['[00:00:05] ellos']),
  ['[00:00:05] Me: yo', '[00:00:05] Them: ellos']);

check('every word survives the merge',
  engine.mergeSpeakerTracks(mic, sys).length, mic.length + sys.length);

check('a line without a stamp keeps its label anyway',
  engine.mergeSpeakerTracks(['sin marca'], ['[00:00:02] x']),
  ['Me: sin marca', '[00:00:02] Them: x']);

// An hour in: the stamp parser has to read hours, or the merge sorts a late
// meeting into its first minute.
check('stamps past the hour sort where they belong',
  engine.mergeSpeakerTracks(['[01:00:05] tarde'], ['[00:59:59] antes']),
  ['[00:59:59] Them: antes', '[01:00:05] Me: tarde']);

process.exit(fails ? 1 : 0);
