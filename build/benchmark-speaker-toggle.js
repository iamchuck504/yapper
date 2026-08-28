'use strict';

// Controlled 30-minute A/B benchmark for the optional speaker pass. Four
// meeting folders hard-link the exact same WAVs and run in a counterbalanced
// order: off, on, on, off. Only window.yapper.transcribe() is timed.
//
//   npx electron build/benchmark-speaker-toggle.js

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { performance } = require('perf_hooks');
const { app } = require('electron');
const { sandbox, logger, mainWindow, within } = require('./harness');
const engine = require('../engine');
const sysaudio = require('../sysaudio');
const speakerDiarizer = require('../speaker-diarizer');

const MINUTES = 30;
const DURATION_SEC = MINUTES * 60;
const BPS = engine.BYTES_PER_SEC;
const ROOT = sandbox('speaker-toggle-benchmark');
const MEETINGS = path.join(ROOT, 'Meetings');
const SOURCE = path.join(ROOT, 'source-audio');
const REPORT = path.join(ROOT, 'speaker-toggle-report.json');
const say = logger(ROOT);

let diarizerCalls = 0;
const diarizerRuns = [];
const realDiarizeFile = speakerDiarizer.diarizeFile;
speakerDiarizer.diarizeFile = (...args) => {
  diarizerCalls++;
  const record = { startedAt: performance.now(), seconds: null, segments: 0, reason: '' };
  diarizerRuns.push(record);
  const run = realDiarizeFile(...args);
  const observed = run.then(result => {
    record.seconds = (performance.now() - record.startedAt) / 1000;
    record.segments = result.segments.length;
    record.reason = result.reason || '';
    return result;
  });
  observed.cancel = () => run.cancel();
  return observed;
};

function run(command, args, label) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 90000 });
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`);
  }
}

function readWavePcm(file) {
  const wav = fs.readFileSync(file);
  let at = 12;
  let format = null;
  let data = null;
  while (at + 8 <= wav.length) {
    const id = wav.toString('ascii', at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    const body = at + 8;
    if (body + size > wav.length) break;
    if (id === 'fmt ' && size >= 16) {
      format = {
        code: wav.readUInt16LE(body), channels: wav.readUInt16LE(body + 2),
        rate: wav.readUInt32LE(body + 4), bits: wav.readUInt16LE(body + 14)
      };
    }
    if (id === 'data') data = wav.subarray(body, body + size);
    at = body + size + (size & 1);
  }
  if (!format || format.code !== 1 || format.channels !== 1
      || format.rate !== 16000 || format.bits !== 16 || !data) {
    throw new Error(`${file} is not PCM16 mono at 16 kHz`);
  }
  return Buffer.from(data);
}

function voiceClip(name, voice, text) {
  const aiff = path.join(SOURCE, `${name}.aiff`);
  const wav = path.join(SOURCE, `${name}.wav`);
  run('/usr/bin/say', ['-v', voice, '-r', '185', '-o', aiff, text], `voice ${voice}`);
  run('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav],
    `convert ${voice}`);
  const pcm = readWavePcm(wav);
  fs.unlinkSync(aiff);
  fs.unlinkSync(wav);
  return pcm;
}

function openSparseWav(file) {
  const fd = engine.openWav(file);
  fs.ftruncateSync(fd, engine.WAV_HEADER + DURATION_SEC * BPS);
  engine.finishWav(fd, DURATION_SEC * BPS);
  return fs.openSync(file, 'r+');
}

function addAt(fd, pcm, start) {
  const max = DURATION_SEC * BPS - Math.floor(start * BPS);
  const slice = pcm.subarray(0, Math.min(pcm.length, max) & ~1);
  if (!slice.length) return;
  const position = engine.WAV_HEADER + Math.floor(start * BPS);
  const existing = Buffer.alloc(slice.length);
  fs.readSync(fd, existing, 0, existing.length, position);
  const mixed = sysaudio.mixPcm(existing, slice);
  fs.writeSync(fd, mixed, 0, mixed.length, position);
}

function buildSourceAudio() {
  fs.mkdirSync(SOURCE, { recursive: true });
  const clips = {
    me: voiceClip('me', 'Samantha',
      'I will verify the release build and document the remaining risks.'),
    atlas: voiceClip('atlas', 'Daniel',
      'The launch checklist is current and the accessibility review is assigned.'),
    beacon: voiceClip('beacon', 'Moira',
      'The performance measurements remain within the expected operating range.'),
    cedar: voiceClip('cedar', 'Fred',
      'I will confirm the export files and share the final quality report.')
  };
  const files = {
    mixed: path.join(SOURCE, 'recording.wav'),
    mic: path.join(SOURCE, 'recording.mic.wav'),
    sys: path.join(SOURCE, 'recording.sys.wav')
  };
  const fds = {
    mixed: openSparseWav(files.mixed),
    mic: openSparseWav(files.mic),
    sys: openSparseWav(files.sys)
  };
  const remote = ['atlas', 'beacon', 'cedar'];
  try {
    for (let base = 0, turn = 0; base < DURATION_SEC; base += 30, turn++) {
      const meAt = base + 2;
      const remoteAt = base + 16;
      addAt(fds.mixed, clips.me, meAt);
      addAt(fds.mic, clips.me, meAt);
      const remoteClip = clips[remote[turn % remote.length]];
      addAt(fds.mixed, remoteClip, remoteAt);
      addAt(fds.sys, remoteClip, remoteAt);
    }
  } finally {
    for (const fd of Object.values(fds)) engine.finishWav(fd, DURATION_SEC * BPS);
  }
  return files;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function linkMeeting(name, sourceFiles) {
  const folder = path.join(MEETINGS, name);
  fs.mkdirSync(folder, { recursive: true });
  for (const [kind, source] of Object.entries(sourceFiles)) {
    const filename = kind === 'mixed' ? 'recording.wav' : `recording.${kind}.wav`;
    fs.linkSync(source, path.join(folder, filename));
  }
  return folder;
}

function contentOnly(transcript) {
  return transcript.replace(/^(\[[\d:]+\])\s+(?:Me|Them|Speaker [1-9]\d*):\s+/gm, '$1 ');
}

function words(text) {
  return text.toLowerCase().match(/[a-z0-9]+/g) || [];
}

function similarity(a, b) {
  const left = new Map();
  const right = new Map();
  words(a).forEach(word => left.set(word, (left.get(word) || 0) + 1));
  words(b).forEach(word => right.set(word, (right.get(word) || 0) + 1));
  const keys = new Set([...left.keys(), ...right.keys()]);
  let common = 0;
  let total = 0;
  for (const key of keys) {
    common += Math.min(left.get(key) || 0, right.get(key) || 0);
    total += Math.max(left.get(key) || 0, right.get(key) || 0);
  }
  return total ? common / total : 1;
}

// The benchmark seeds files directly and must not touch real capture devices.
sysaudio.create = () => ({
  state: 'unavailable', buffered: 0, droppedBytes: 0,
  start: async () => false, take: () => null, stop: () => {}
});
engine.canGetAhead = () => false;

require('../main.js');

app.whenReady().then(async () => {
  const hardStop = setTimeout(() => {
    say('FAIL  benchmark exceeded 20 minutes');
    app.exit(1);
  }, 20 * 60 * 1000);
  let failed = false;
  try {
    const win = await mainWindow({ settleMs: 1500 });
    const $ = js => win.webContents.executeJavaScript(js, true);
    say(`\nBuilding one controlled ${MINUTES}-minute, four-voice call…`);
    const sourceFiles = buildSourceAudio();
    const audioHashes = Object.fromEntries(Object.entries(sourceFiles)
      .map(([kind, file]) => [kind, sha256(file)]));
    say(`audio SHA-256: ${JSON.stringify(audioHashes)}`);

    const order = [
      { name: 'off-1', enabled: false },
      { name: 'on-1', enabled: true },
      { name: 'on-2', enabled: true },
      { name: 'off-2', enabled: false }
    ];
    const runs = [];
    for (const item of order) {
      const folder = linkMeeting(`2099-01-01_${item.name}`, sourceFiles);
      const beforeCalls = diarizerCalls;
      say(`\n${item.name}: Identify speakers ${item.enabled ? 'ON' : 'OFF'}…`);
      const started = performance.now();
      const transcript = await within(
        $(`window.yapper.transcribe(${JSON.stringify(folder)}, ${item.enabled})`),
        item.name, 15 * 60 * 1000);
      const seconds = (performance.now() - started) / 1000;
      const raw = fs.readFileSync(path.join(folder, 'transcript.raw.txt'), 'utf8');
      const segmentFile = path.join(folder, 'speaker-segments.json');
      const run = {
        ...item,
        seconds,
        realtimeMultiple: DURATION_SEC / seconds,
        diarizerCalls: diarizerCalls - beforeCalls,
        lines: raw.split(/\r?\n/).filter(Boolean).length,
        characters: transcript.length,
        content: contentOnly(raw),
        speakerSegments: fs.existsSync(segmentFile)
          ? JSON.parse(fs.readFileSync(segmentFile, 'utf8')).segments.length : 0
      };
      runs.push(run);
      say(`${item.name}: ${seconds.toFixed(2)} s, ${run.realtimeMultiple.toFixed(1)}x realtime, `
        + `${run.lines} lines, diarizer calls ${run.diarizerCalls}, segments ${run.speakerSegments}`);
    }

    const off = runs.filter(run => !run.enabled);
    const on = runs.filter(run => run.enabled);
    const average = list => list.reduce((sum, run) => sum + run.seconds, 0) / list.length;
    const offAverage = average(off);
    const onAverage = average(on);
    const delta = onAverage - offAverage;
    const percent = delta / offAverage * 100;
    const pairSimilarities = [similarity(off[0].content, on[0].content),
      similarity(off[1].content, on[1].content)];
    const sourceHashesAfter = Object.fromEntries(Object.entries(sourceFiles)
      .map(([kind, file]) => [kind, sha256(file)]));
    const audioUnchanged = JSON.stringify(sourceHashesAfter) === JSON.stringify(audioHashes);
    const gatesCorrect = off.every(run => run.diarizerCalls === 0)
      && on.every(run => run.diarizerCalls === 1);
    const comparison = {
      offAverageSeconds: offAverage,
      onAverageSeconds: onAverage,
      extraSeconds: delta,
      extraPercent: percent,
      pairContentSimilarity: pairSimilarities,
      audioUnchanged,
      gatesCorrect
    };
    const serializableRuns = runs.map(({ content, ...run }) => run);
    fs.writeFileSync(REPORT, JSON.stringify({
      generatedAt: new Date().toISOString(), minutes: MINUTES, audioHashes,
      order: order.map(item => item.name), runs: serializableRuns,
      diarizerRuns, comparison
    }, null, 2), 'utf8');

    say('\n=== RESULT ===');
    say(`OFF average: ${offAverage.toFixed(2)} s`);
    say(`ON average:  ${onAverage.toFixed(2)} s`);
    say(`ON cost:     ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} s (${percent >= 0 ? '+' : ''}${percent.toFixed(1)}%)`);
    say(`content similarity: ${pairSimilarities.map(value => `${(value * 100).toFixed(2)}%`).join(', ')}`);
    say(`same source audio remained intact: ${audioUnchanged}`);
    say(`toggle gated diarizer correctly: ${gatesCorrect}`);
    say(`report: ${REPORT}`);
    failed = !audioUnchanged || !gatesCorrect || pairSimilarities.some(value => value < 0.98);
  } catch (err) {
    failed = true;
    say(`FAIL  ${err.stack || err.message}`);
  } finally {
    clearTimeout(hardStop);
    app.exit(failed ? 1 : 0);
  }
}).catch(err => {
  say(`FAIL  ${err.stack || err.message}`);
  app.exit(1);
});
