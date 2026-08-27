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
  'Speaker 2': 'Robert'
});
check('speaker names replace labels only at line prefixes', named.split('\n'), [
  '[00:00:01] Maya: First voice begins.',
  '[00:00:02] Chuck: My response.',
  '[00:00:04] Robert: A different voice answers.',
  '[00:00:08] Maya: The first voice returns.'
]);
check('remapping always works from the immutable raw transcript',
  speakers.applySpeakerMap(rawTranscript, { 'Speaker 1': 'Maya' }).includes('Maya: First voice'), true);
check('speaker-like words inside speech are untouched',
  speakers.applySpeakerMap('[00:00:01] Speaker 1: I said Speaker 2: as an example.', {
    'Speaker 1': 'Maya', 'Speaker 2': 'Robert'
  }), '[00:00:01] Maya: I said Speaker 2: as an example.');
check('unsafe map keys and multiline names are rejected or cleaned',
  speakers.normalizeSpeakerMap({ '__proto__': 'bad', 'Speaker 1': ' Maya:\nRobert ' }),
  { 'Speaker 1': 'Maya Robert' });
check('load state lists recorder first, then numbered voices',
  speakers.speakerState(rawTranscript, { 'Speaker 2': 'Robert' }), [
    { label: 'Me', name: '' },
    { label: 'Speaker 1', name: '' },
    { label: 'Speaker 2', name: 'Robert' }
  ]);

check('notes generalize numbered voices without merging a disagreement',
  speakers.generalizeNoteSpeakers('- Speaker 1 proposed Friday; Speaker 2 preferred Monday.\n- Speaker 1 clarified scope.', 'en'),
  '- One participant proposed Friday; another participant preferred Monday.\n- One participant clarified scope.');
check('the notes fallback speaks natural Spanish too',
  speakers.generalizeNoteSpeakers('- Speaker 1 propuso el viernes; Speaker 2 prefirió el lunes.', 'es'),
  '- Una persona propuso el viernes; otra persona prefirió el lunes.');
check('automatic note language does not leak numbered labels',
  speakers.generalizeNoteSpeakers('## Resumen\nSpeaker 1 explicó que la entrega fue aprobada para el viernes.', 'auto'),
  '## Resumen\nUna persona explicó que la entrega fue aprobada para el viernes.');

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

// Normalised: git checks main.js out with CRLF on Windows, and the bounded
// gaps below count those extra characters.
const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
check('the notes prompt uses identities as evidence but never prints numbered labels',
  /Use these labels only as structural evidence[\s\S]*Never write technical labels such as "Speaker 1"[\s\S]*one participant[\s\S]*another participant/i.test(mainSource), true);
check('the notes prompt requires every explicitly named action owner',
  /EVERY action item with an explicitly named owner[\s\S]{0,180}"Name: task"[\s\S]{0,180}Never generalize a known owner/i.test(mainSource), true);
check('direct address is evidence for a named action owner',
  /A direct request such as "Maya, can you review this\?" is evidence that Maya owns/i.test(mainSource), true);

// A run can be cancelled once the far side turns out to have said nothing:
// the helper stops, the promise resolves at once, and the result says why.
(async () => {
  const os = require('os');
  const { diarizeFile } = require('../speaker-diarizer');
  const none = diarizeFile(null, null);
  check('an unavailable run still carries cancel()', typeof none.cancel === 'function', true);
  none.cancel();

  const workerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yapper-diarize-worker-'));
  const wav = path.join(workerDir, 'sys.wav');
  const assets = path.join(workerDir, 'assets');
  const worker = path.join(workerDir, 'mock-worker.js');
  fs.mkdirSync(assets);
  fs.writeFileSync(wav, Buffer.alloc(64));
  fs.writeFileSync(worker, [
    "const { parentPort } = require('worker_threads');",
    "parentPort.postMessage({ type: 'progress', done: 1, total: 2 });",
    "parentPort.postMessage({ type: 'result', segments: [",
    "  { speaker: 'voice-a', start: 0, end: 2 },",
    "  { speaker: 'voice-b', start: 2, end: 4 }",
    "] });"
  ].join('\n'));
  let progress = false;
  const portable = await diarizeFile(path.join(workerDir, 'speaker-diarize'), wav, {
    platform: 'win32', windowsAssets: assets, workerFile: worker,
    onProgress: () => { progress = true; }
  });
  check('the Windows worker returns normalized local speaker segments',
    portable.available && portable.segments.length === 2 && progress, true);

  fs.writeFileSync(worker, "setInterval(() => {}, 1000);\n");
  const t1 = Date.now();
  const portableCancel = diarizeFile(path.join(workerDir, 'speaker-diarize'), wav, {
    platform: 'win32', windowsAssets: assets, workerFile: worker, timeoutMs: 20000
  });
  setTimeout(() => portableCancel.cancel(), 50);
  const portableCancelled = await portableCancel;
  check('the Windows worker can be cancelled without waiting for inference',
    Date.now() - t1 < 5000 && portableCancelled.reason === 'not needed', true);
  fs.rmSync(workerDir, { recursive: true, force: true });

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
