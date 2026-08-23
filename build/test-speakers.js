'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const speakers = require('../speaker-diarizer');
const engine = require('../engine');

let fails = 0;
function check(name, got, want = true) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`ok    ${name}`);
  else {
    fails++;
    console.log(`FAIL  ${name}\n      expected ${JSON.stringify(want)}\n      got      ${JSON.stringify(got)}`);
  }
}

const rawSegments = [
  { speakerId: 'cluster-9', startTimeSeconds: 0.4, endTimeSeconds: 3.5 },
  { speakerId: 'cluster-2', startTimeSeconds: 3.5, endTimeSeconds: 7.8 },
  { speakerId: 'cluster-9', startTimeSeconds: 7.8, endTimeSeconds: 12.0 }
];
const remote = [
  '[00:00:01] First voice begins.',
  '[00:00:04] A different voice answers.',
  '[00:00:08] The first voice returns.'
];

const labelled = speakers.labelRemoteLines(remote, rawSegments);
check('speaker numbers follow first appearance, not opaque cluster IDs', labelled.lines, [
  '[00:00:01] Speaker 1: First voice begins.',
  '[00:00:04] Speaker 2: A different voice answers.',
  '[00:00:08] Speaker 1: The first voice returns.'
]);
check('speaker identity stays stable when a voice returns', labelled.speakers, ['Speaker 1', 'Speaker 2']);

check('a line in a tiny segmentation gap uses the nearby voice',
  speakers.labelRemoteLines(['[00:00:12] Near the boundary.'], [
    { speaker: 'a', start: 12.2, end: 14 }
  ]).lines,
  ['[00:00:12] Speaker 1: Near the boundary.']);

check('no diarization data preserves the original remote lines',
  speakers.labelRemoteLines(remote, []).lines, remote);

const merged = engine.mergeSpeakerTracks(
  ['[00:00:02] My response.'], labelled.lines
);
check('two-track merge preserves numbered labels', merged, [
  '[00:00:01] Speaker 1: First voice begins.',
  '[00:00:02] Me: My response.',
  '[00:00:04] Speaker 2: A different voice answers.',
  '[00:00:08] Speaker 1: The first voice returns.'
]);

const rawTranscript = merged.join('\n');
const named = speakers.applySpeakerMap(rawTranscript, {
  Me: 'Chuck',
  'Speaker 1': 'Maya',
  'Speaker 2': 'Carlos'
});
check('speaker names replace labels only at line prefixes', named.split('\n'), [
  '[00:00:01] Maya: First voice begins.',
  '[00:00:02] Chuck: My response.',
  '[00:00:04] Carlos: A different voice answers.',
  '[00:00:08] Maya: The first voice returns.'
]);
check('remapping always works from the immutable raw transcript',
  speakers.applySpeakerMap(rawTranscript, { 'Speaker 1': 'Ana' }).includes('Ana: First voice'), true);
check('speaker-like words inside speech are untouched',
  speakers.applySpeakerMap('[00:00:01] Speaker 1: I said Speaker 2: as an example.', {
    'Speaker 1': 'Ana', 'Speaker 2': 'Luis'
  }), '[00:00:01] Ana: I said Speaker 2: as an example.');
check('unsafe map keys and multiline names are rejected or cleaned',
  speakers.normalizeSpeakerMap({ '__proto__': 'bad', 'Speaker 1': ' Ana:\nAdmin ' }),
  { 'Speaker 1': 'Ana Admin' });
check('load state lists recorder first, then numbered voices',
  speakers.speakerState(rawTranscript, { 'Speaker 2': 'Carlos' }), [
    { label: 'Me', name: '' },
    { label: 'Speaker 1', name: '' },
    { label: 'Speaker 2', name: 'Carlos' }
  ]);

check('malformed helper output is harmless', speakers.parseHelperOutput('{not json'), []);
check('valid helper output is bounded and normalized',
  speakers.parseHelperOutput(JSON.stringify({ segments: rawSegments })).length, 3);
check('a delayed Whisper timestamp still uses its nearby detected voice',
  speakers.labelRemoteLines(['[00:00:20] A timestamped phrase.'], [
    { speaker: 'voice-a', start: 12, end: 15 }
  ]).lines,
  ['[00:00:20] Speaker 1: A timestamped phrase.']);
check('a transcript line far from every detected voice remains unchanged',
  speakers.labelRemoteLines(['[00:00:30] Unmatched audio.'], [
    { speaker: 'voice-a', start: 12, end: 15 }
  ]).lines,
  ['[00:00:30] Unmatched audio.']);

const helper = path.join(__dirname, 'speaker-diarize');
if (process.platform === 'darwin' && fs.existsSync(helper)) {
  const run = spawnSync(helper, ['--self-test'], { encoding: 'utf8', timeout: 10000 });
  check('native helper self-test exits cleanly', run.status, 0);
  check('native helper self-test emits valid JSON', speakers.parseHelperOutput(run.stdout), []);
} else {
  console.log('skip  native helper self-test (not built on this platform)');
}

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
check('the notes prompt preserves unknown numbered identities',
  /write the exact label[\s\S]{0,160}instead of vague phrases such as "the speaker"/i.test(mainSource), true);

// A run can be cancelled once the far side turns out to have said nothing:
// the helper stops, the promise resolves at once, and the result says why.
(async () => {
  const os = require('os');
  const { diarizeFile } = require('../speaker-diarizer');
  const none = diarizeFile(null, null);
  check('an unavailable run still carries cancel()', typeof none.cancel === 'function', true);
  none.cancel();
  if (process.platform === 'darwin') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yapper-diarize-cancel-'));
    const wav = path.join(dir, 'sys.wav');
    const helper = path.join(dir, 'slow-helper.sh');
    fs.writeFileSync(wav, Buffer.alloc(64));
    fs.writeFileSync(helper, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
    const t0 = Date.now();
    const run = diarizeFile(helper, wav, { timeoutMs: 20000 });
    setTimeout(() => run.cancel(), 50);
    const result = await run;
    fs.rmSync(dir, { recursive: true, force: true });
    check('cancel() resolves the run without waiting for the helper',
      Date.now() - t0 < 5000 && result.reason === 'not needed' && result.segments.length === 0, true);
  }
  console.log(fails ? `\n${fails} failures` : '\nPASS');
  process.exit(fails ? 1 : 0);
})();
