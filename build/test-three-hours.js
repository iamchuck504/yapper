'use strict';

// A controlled long-call simulation. It never opens an input device: macOS
// `say` produces the recorder voice and optional public LibriSpeech fixtures
// provide three real remote voices. The renderer feeds silence through the
// real recording IPC for the requested duration, and controlled WAV fixtures
// then put those voices on separate microphone/system tracks. The real final
// Whisper + FluidAudio path consumes the fixtures, after which the real UI,
// speaker mapping, notes persistence and exports are exercised.
//
//   npx electron build/test-three-hours.js
//   MINUTES=8 LIVE_MINUTES=1 npx electron build/test-three-hours.js  # quick pilot

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');
const { sandbox, logger, mainWindow, within } = require('./harness');

const engine = require('../engine');
const sysaudio = require('../sysaudio');
const llm = require('../llm');

const MINUTES = Math.max(3, Number(process.env.MINUTES || 180));
const LIVE_MINUTES = Math.max(0, Number(process.env.LIVE_MINUTES || 15));
const DURATION_SEC = Math.round(MINUTES * 60);
const BPS = engine.BYTES_PER_SEC;
const HUMAN_CLIPS_PER_SPEAKER = 24;
const RUN_TAG = String(process.env.RUN_TAG || '').replace(/[^a-z0-9-]/gi, '').slice(0, 30);
const ROOT = sandbox(`three-hours${RUN_TAG ? `-${RUN_TAG}` : ''}`);
const say = logger(ROOT);
const REPORT = path.join(ROOT, 'report.json');

let fails = 0;
const results = [];
const metrics = { minutes: MINUTES, liveMinutes: LIVE_MINUTES };
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail || '') });
  if (ok) say(`ok    ${name}`);
  else {
    fails++;
    say(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

const mb = bytes => `${(Number(bytes) / 1024 / 1024).toFixed(1)} MB`;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const rss = () => process.memoryUsage().rss;
async function settledRss() {
  if (global.gc) global.gc();
  await wait(1200);
  return rss();
}

function run(command, args, label) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 90000 });
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`);
  }
}

/** afconvert may put a FLLR chunk before `data`, so a fixed 44-byte slice is
 * not enough. Walk the RIFF chunks and return only 16 kHz mono PCM16. */
function readWavePcm(file) {
  const wav = fs.readFileSync(file);
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${file} is not a WAVE file`);
  }
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
  // afconvert uses classic PCM (1) for AIFF input and WAVE_FORMAT_EXTENSIBLE
  // (0xfffe, with a PCM sub-format GUID) for FLAC input.
  if (!format || ![1, 0xfffe].includes(format.code) || format.channels !== 1
      || format.rate !== 16000 || format.bits !== 16 || !data || !data.length) {
    throw new Error(`${file} is not non-empty 16 kHz mono PCM16`);
  }
  return Buffer.from(data);
}

function filesBelow(dir, suffix) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesBelow(file, suffix));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(suffix)) out.push(file);
  }
  return out.sort();
}

const VOICES = {
  Me: { voice: 'Samantha', name: 'Chuck', phrases: [
    'I will verify the release build and document the remaining risks.',
    'I checked the latest prototype and the main workflow is responding correctly.',
    'I will review the action list before the next project checkpoint.'
  ] },
  Atlas: { voice: 'Daniel', name: 'Alex', phrases: [
    'The launch checklist is current, and the accessibility review is assigned.',
    'The customer feedback confirms that faster meeting notes are the priority.',
    'I will send the updated rollout plan after this meeting.'
  ] },
  Beacon: { voice: 'Moira', name: 'Brooke', phrases: [
    'The performance measurements remain within the expected operating range.',
    'I reviewed the transcription sample and the timestamps stayed in order.',
    'The next test should include a long silence followed by returning voices.'
  ] },
  Cedar: { voice: 'Fred', name: 'Casey', phrases: [
    'The support guide now explains how participants can be matched to their names.',
    'I will confirm the export files and share the final quality report.',
    'The team agreed to keep unknown identities as numbered speaker labels.'
  ] }
};

function buildClips() {
  const fixtureDir = path.join(ROOT, 'synthetic-voices');
  fs.mkdirSync(fixtureDir, { recursive: true });
  const clips = {};
  const makeSynthetic = (speaker, info) => {
    clips[speaker] = info.phrases.map((text, index) => {
      const stem = `${speaker.toLowerCase()}-${index + 1}`;
      const aiff = path.join(fixtureDir, `${stem}.aiff`);
      const wav = path.join(fixtureDir, `${stem}.wav`);
      run('/usr/bin/say', ['-v', info.voice, '-r', '185', '-o', aiff, text], `voice ${info.voice}`);
      run('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav],
        `convert ${info.voice}`);
      const pcm = readWavePcm(wav);
      fs.unlinkSync(aiff);
      fs.unlinkSync(wav);
      if (pcm.length / BPS < 1 || pcm.length / BPS > 15) {
        throw new Error(`${info.voice} produced an implausible ${(pcm.length / BPS).toFixed(1)} s clip`);
      }
      return pcm;
    });
  };

  makeSynthetic('Me', VOICES.Me);
  const humanRoot = process.env.YAPPER_HUMAN_FIXTURES;
  if (humanRoot && fs.existsSync(humanRoot)) {
    const people = fs.readdirSync(humanRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .sort((a, b) => Number(a.name) - Number(b.name));
    if (people.length < 3) throw new Error('YAPPER_HUMAN_FIXTURES needs three speaker directories');
    ['Atlas', 'Beacon', 'Cedar'].forEach((speaker, speakerIndex) => {
      const sources = filesBelow(path.join(humanRoot, people[speakerIndex].name), '.flac');
      clips[speaker] = [];
      for (let index = 0; index < sources.length
        && clips[speaker].length < HUMAN_CLIPS_PER_SPEAKER; index++) {
        const wav = path.join(fixtureDir, `${speaker.toLowerCase()}-${clips[speaker].length + 1}.wav`);
        run('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', sources[index], wav],
          `convert LibriSpeech speaker ${people[speakerIndex].name}`);
        const pcm = readWavePcm(wav);
        fs.unlinkSync(wav);
        const seconds = pcm.length / BPS;
        if (seconds >= 2 && seconds <= 15) clips[speaker].push(pcm);
      }
      if (clips[speaker].length < HUMAN_CLIPS_PER_SPEAKER) {
        throw new Error(`LibriSpeech speaker ${people[speakerIndex].name} has fewer than `
          + `${HUMAN_CLIPS_PER_SPEAKER} usable clips`);
      }
    });
    metrics.voiceFixture = `LibriSpeech speakers ${people.slice(0, 3).map(entry => entry.name).join(', ')}`
      + `, ${HUMAN_CLIPS_PER_SPEAKER} unique clips each`;
  } else {
    for (const speaker of ['Atlas', 'Beacon', 'Cedar']) makeSynthetic(speaker, VOICES[speaker]);
    metrics.voiceFixture = 'macOS synthetic voices';
  }
  return clips;
}

function scheduleCall(clips) {
  const events = [];
  const silentFrom = MINUTES >= 100 ? 88 * 60 : Math.floor(DURATION_SEC * 0.48);
  const silentTo = Math.min(DURATION_SEC - 90, silentFrom + (MINUTES >= 100 ? 4 * 60 : 60));
  const slots = [
    [5, 'Me'], [25, 'Atlas'], [50, 'Beacon'], [75, 'Cedar'], [100, 'Me']
  ];
  let cycle = 0;
  for (let base = 0; base < DURATION_SEC; base += 120, cycle++) {
    for (const [offset, speaker] of slots) {
      const start = base + offset;
      if (start >= DURATION_SEC - 1 || (start >= silentFrom && start < silentTo)) continue;
      const variants = clips[speaker];
      const pcm = variants[(cycle + offset) % variants.length];
      events.push({ start, end: Math.min(DURATION_SEC, start + pcm.length / BPS), speaker, pcm });
    }
    // A controlled cross-talk moment about every forty minutes. The remote
    // system track remains separable; only the mixed track has both voices.
    if (cycle > 0 && cycle % 20 === 0) {
      const start = base + 51;
      if (start < DURATION_SEC - 1 && !(start >= silentFrom && start < silentTo)) {
        const pcm = clips.Me[cycle % clips.Me.length];
        events.push({ start, end: Math.min(DURATION_SEC, start + pcm.length / BPS), speaker: 'Me', pcm });
      }
    }
  }
  events.sort((a, b) => a.start - b.start);
  return { events, silentFrom, silentTo };
}

function openSparseWav(file) {
  const fd = engine.openWav(file);
  fs.ftruncateSync(fd, engine.WAV_HEADER + DURATION_SEC * BPS);
  // engine.openWav deliberately opens write-only because that is all a real
  // recorder needs. This fixture also mixes occasional overlapping turns, so
  // reopen read/write after installing the final header.
  engine.finishWav(fd, DURATION_SEC * BPS);
  return fs.openSync(file, 'r+');
}

function addAt(fd, pcm, start) {
  const max = Math.max(0, DURATION_SEC * BPS - Math.floor(start * BPS));
  const slice = pcm.subarray(0, Math.min(pcm.length, max) & ~1);
  if (!slice.length) return;
  const pos = engine.WAV_HEADER + Math.floor(start * BPS);
  const existing = Buffer.alloc(slice.length);
  fs.readSync(fd, existing, 0, existing.length, pos);
  const mixed = sysaudio.mixPcm(existing, slice);
  fs.writeSync(fd, mixed, 0, mixed.length, pos);
}

function seedTracks(folder, call) {
  const files = {
    mixed: path.join(folder, 'recording.wav'),
    mic: path.join(folder, 'recording.mic.wav'),
    sys: path.join(folder, 'recording.sys.wav')
  };
  for (const file of Object.values(files)) {
    try { fs.unlinkSync(file); } catch { /* first creation */ }
  }
  const fds = {
    mixed: openSparseWav(files.mixed), mic: openSparseWav(files.mic), sys: openSparseWav(files.sys)
  };
  try {
    for (const event of call.events) {
      addAt(fds.mixed, event.pcm, event.start);
      addAt(event.speaker === 'Me' ? fds.mic : fds.sys, event.pcm, event.start);
    }
  } finally {
    for (const fd of Object.values(fds)) engine.finishWav(fd, DURATION_SEC * BPS);
  }
  return files;
}

function stampSeconds(line) {
  const m = String(line).match(/^\[(\d+):(\d\d):(\d\d)\]/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

function overlap(a0, a1, b0, b1) {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

function scoreDiarization(events, segments) {
  const remote = events.filter(event => event.speaker !== 'Me');
  const assignments = [];
  for (const event of remote) {
    const ranked = segments.map(segment => ({
      label: segment.speaker,
      score: overlap(event.start, event.end, segment.start, segment.end)
    })).filter(item => item.score > 0).sort((a, b) => b.score - a.score);
    assignments.push({ truth: event.speaker, at: event.start, predicted: ranked[0]?.label || null });
  }
  const majority = {};
  const stability = {};
  const confusion = {};
  for (const truth of ['Atlas', 'Beacon', 'Cedar']) {
    const rows = assignments.filter(row => row.truth === truth && row.predicted);
    const counts = new Map();
    rows.forEach(row => counts.set(row.predicted, (counts.get(row.predicted) || 0) + 1));
    confusion[truth] = Object.fromEntries([...counts].sort((a, b) => a[0].localeCompare(b[0])));
    const best = [...counts].sort((a, b) => b[1] - a[1])[0] || [null, 0];
    majority[truth] = best[0];
    stability[truth] = rows.length ? best[1] / rows.length : 0;
  }
  const assigned = assignments.filter(row => row.predicted).length;
  const correct = assignments.filter(row => row.predicted && row.predicted === majority[row.truth]).length;
  const late = assignments.filter(row => row.at > DURATION_SEC * 2 / 3 && row.predicted);
  const lateCorrect = late.filter(row => row.predicted === majority[row.truth]).length;
  return {
    total: assignments.length,
    coverage: assignments.length ? assigned / assignments.length : 0,
    stableAccuracy: assigned ? correct / assigned : 0,
    lateAccuracy: late.length ? lateCorrect / late.length : 0,
    majority, stability,
    confusion,
    detectedLabels: new Set(segments.map(segment => segment.speaker)).size,
    distinctMajorities: new Set(Object.values(majority).filter(Boolean)).size
  };
}

function allocatedBytes(file) {
  const stat = fs.statSync(file);
  return Number.isFinite(stat.blocks) ? stat.blocks * 512 : stat.size;
}

// This test must never capture whatever the Mac is currently playing. The
// recorder still receives every synthetic microphone block through its real
// IPC and file handles; only the native input helper is replaced by silence.
sysaudio.create = () => ({
  state: 'unavailable', buffered: 0, droppedBytes: 0,
  start: async () => false, take: () => null, stop: () => {}
});

// Accelerated feeding is not a real-time recording, so a progressive head
// start would race ahead over the temporary silence and then be incorrectly
// reused after the controlled fixture is installed.
engine.canGetAhead = () => false;

let noteInput = '';
let noteSystem = '';
llm.generate = async (_config, { system, input, onDelta, signal }) => {
  noteInput = input;
  noteSystem = system;
  const output = [
    'YAPPER_TITLE: Three Hour Launch Rehearsal',
    '',
    '## Summary [00:05]',
    'Chuck, Alex, Brooke, and Casey reviewed a controlled three-hour release rehearsal.',
    '',
    '## Discussion points [25:00]',
    'Alex reviewed the rollout plan, Brooke tracked transcription performance, and Casey checked exports.',
    '',
    '## Decisions [88:00]',
    'The group retained exact identities and verified recovery after the planned silent interval.',
    '',
    '## Action items [150:25]',
    '- Alex will send the rollout plan.',
    '- Brooke will retain the performance measurements.',
    '- Casey will share the quality report.',
    '',
    `## Next steps [${String(Math.floor((DURATION_SEC - 20) / 60)).padStart(2, '0')}:${String((DURATION_SEC - 20) % 60).padStart(2, '0')}]`,
    'Chuck will review the final build before the next checkpoint.'
  ].join('\n');
  if (signal?.aborted) throw new Error('Note generation canceled.');
  await wait(35);
  if (onDelta) onDelta(output.slice(0, 80), output.slice(0, 80));
  await wait(45);
  if (onDelta) onDelta(output.slice(80), output);
  return output;
};

let exportCount = 0;
dialog.showSaveDialog = async (_win, options) => {
  exportCount++;
  const ext = path.extname(options.defaultPath || '') || '.txt';
  return { canceled: false, filePath: path.join(ROOT, `export-${exportCount}${ext}`) };
};
dialog.showMessageBox = async () => ({ response: 1 });

require('../main.js');

app.whenReady().then(async () => {
  const started = Date.now();
  const hardStop = setTimeout(() => {
    say('FAIL  the three-hour simulation exceeded its 60 minute safety limit');
    app.exit(1);
  }, 60 * 60 * 1000);
  try {
    const win = await mainWindow({ settleMs: 1500 });
    const $ = js => win.webContents.executeJavaScript(js, true);
    const startRss = rss();

    say(`three-hour simulation: ${MINUTES} min accelerated + ${LIVE_MINUTES} min live\n`);
    say('--- 1. controlled voices and ground truth ---');
    const clips = buildClips();
    const call = scheduleCall(clips);
    metrics.events = call.events.length;
    metrics.remoteEvents = call.events.filter(event => event.speaker !== 'Me').length;
    metrics.silence = { from: call.silentFrom, to: call.silentTo };
    check('four controlled identities were generated', Object.keys(clips).length === 4);
    check('every identity speaks in the first and final thirds', Object.keys(clips).every(speaker =>
      call.events.some(event => event.speaker === speaker && event.start < DURATION_SEC / 3)
      && call.events.some(event => event.speaker === speaker && event.start > DURATION_SEC * 2 / 3)));
    say(`  source: ${metrics.voiceFixture}`);
    say(`  ${call.events.length} turns, including ${metrics.remoteEvents} remote turns`);
    say(`  controlled silence ${(call.silentTo - call.silentFrom) / 60} min at minute ${Math.round(call.silentFrom / 60)}`);

    say('\n--- 2. accelerated recording IPC soak ---');
    const recordRss = rss();
    const tRecord = Date.now();
    const folder = await $(`window.yapper.recordingStart('Chuck, Alex, Brooke, Casey')`);
    // One-second chunks preserve the recorder's append-only behavior while the
    // renderer batches one minute per round trip so the simulation stays fast.
    for (let minute = 0; minute < MINUTES; minute++) {
      await $(`(() => {
        const block = new Uint8Array(${BPS});
        for (let second = 0; second < 60; second++) window.yapper.recordingChunk(block.buffer);
        return true;
      })()`);
      if ((minute + 1) % 30 === 0 || minute + 1 === MINUTES) {
        say(`  ${minute + 1}/${MINUTES} simulated minutes written`);
      }
    }
    const finished = await $(`window.yapper.recordingFinish('Synthetic three-hour call', ['00:25:00', '02:30:25'])`);
    await $(`window.yapper.setRecordingState(false)`);
    await wait(800);
    const recording = path.join(folder, 'recording.wav');
    const expectedBytes = DURATION_SEC * BPS;
    const recordSeconds = (Date.now() - tRecord) / 1000;
    metrics.recording = {
      seconds: recordSeconds, logicalBytes: fs.statSync(recording).size,
      rssGrowthBytes: (await settledRss()) - recordRss
    };
    check('the actual recording path accepted the requested duration', finished.bytes === expectedBytes,
      `${finished.bytes} of ${expectedBytes} bytes`);
    check('the accelerated recording has a correct WAV length',
      fs.statSync(recording).size === engine.WAV_HEADER + expectedBytes,
      `${fs.statSync(recording).size} bytes`);
    check('the recording soak did not retain audio-sized memory',
      metrics.recording.rssGrowthBytes < 180 * 1024 * 1024, mb(metrics.recording.rssGrowthBytes));
    say(`  ${recordSeconds.toFixed(1)} s, memory ${mb(metrics.recording.rssGrowthBytes)}`);

    say('\n--- 3. separated three-hour fixture ---');
    const files = seedTracks(folder, call);
    const logical = Object.values(files).reduce((sum, file) => sum + fs.statSync(file).size, 0);
    const allocated = Object.values(files).reduce((sum, file) => sum + allocatedBytes(file), 0);
    metrics.audio = { logicalBytes: logical, allocatedBytes: allocated };
    check('all three synchronized tracks have the requested duration', Object.values(files).every(file =>
      fs.statSync(file).size === engine.WAV_HEADER + expectedBytes));
    check('temporary audio stays within the planned disk budget',
      allocated <= logical * 1.05 && allocated < (MINUTES / 180) * 1.5 * 1024 * 1024 * 1024,
      `${mb(allocated)} allocated for ${mb(logical)} logical`);
    say(`  ${mb(logical)} logical, ${mb(allocated)} actually allocated`);
    const livePattern = Buffer.alloc(60 * BPS);
    const liveFd = fs.openSync(files.mixed, 'r');
    fs.readSync(liveFd, livePattern, 0, livePattern.length, engine.WAV_HEADER);
    fs.closeSync(liveFd);

    say('\n--- 4. real Whisper + FluidAudio final pass ---');
    const finalRss = rss();
    const tFinal = Date.now();
    const ticker = setInterval(() => say(`  final pass still running (${Math.round((Date.now() - tFinal) / 1000)} s)`), 30_000);
    const transcript = await within(
      $(`window.yapper.transcribe(${JSON.stringify(folder)})`),
      'three-hour final transcription and speaker detection', 40 * 60 * 1000
    ).finally(() => clearInterval(ticker));
    const finalSeconds = (Date.now() - tFinal) / 1000;
    const finalGrowth = (await settledRss()) - finalRss;
    metrics.finalPass = { seconds: finalSeconds, rssGrowthBytes: finalGrowth, chars: transcript.length };
    say(`  ${finalSeconds.toFixed(1)} s (${(DURATION_SEC / finalSeconds).toFixed(1)}x realtime), ${transcript.length} characters`);
    check('the full transcript was produced', transcript.length > Math.max(500, MINUTES * 30),
      `${transcript.length} characters`);
    check('final processing did not retain audio-sized memory', finalGrowth < 350 * 1024 * 1024, mb(finalGrowth));
    const raw = fs.readFileSync(path.join(folder, 'transcript.raw.txt'), 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const stamps = lines.map(stampSeconds).filter(value => value !== null);
    check('timestamps never go backwards', stamps.every((value, index) => !index || value >= stamps[index - 1]));
    check('timestamps reach the final two minutes', Math.max(...stamps) > DURATION_SEC - 120,
      `last timestamp ${Math.max(...stamps)} of ${DURATION_SEC}`);
    check('the planned silent interval stays silent', !stamps.some(value =>
      value > call.silentFrom + 15 && value < call.silentTo - 15),
    `timestamps found inside ${call.silentFrom}-${call.silentTo}`);
    check('recorder and remote tracks both survived the merge',
      lines.some(line => / Me: /.test(line)) && lines.some(line => / Speaker \d+: /.test(line)));
    check('successful speaker detection avoids the fallback Them label', !lines.some(line => / Them: /.test(line)));

    const segmentFile = path.join(folder, 'speaker-segments.json');
    const segments = fs.existsSync(segmentFile)
      ? JSON.parse(fs.readFileSync(segmentFile, 'utf8')).segments || [] : [];
    const diarization = scoreDiarization(call.events, segments);
    metrics.diarization = diarization;
    say(`  speakers ${diarization.detectedLabels}; coverage ${(diarization.coverage * 100).toFixed(1)}%; `
      + `stable ${(diarization.stableAccuracy * 100).toFixed(1)}%; final hour ${(diarization.lateAccuracy * 100).toFixed(1)}%`);
    check('FluidAudio found exactly three remote identities',
      diarization.distinctMajorities === 3 && diarization.detectedLabels === 3,
      JSON.stringify(diarization.confusion));
    check('speaker detection covers at least 85% of remote turns', diarization.coverage >= 0.85,
      `${(diarization.coverage * 100).toFixed(1)}%`);
    check('identities stay at least 80% stable across the call', diarization.stableAccuracy >= 0.80,
      `${(diarization.stableAccuracy * 100).toFixed(1)}%`);
    check('returning voices stay at least 80% stable in the final hour', diarization.lateAccuracy >= 0.80,
      `${(diarization.lateAccuracy * 100).toFixed(1)}%`);
    check('audio is released only after transcript artifacts exist',
      fs.existsSync(path.join(folder, 'transcript.txt'))
      && fs.existsSync(path.join(folder, 'transcript.raw.txt'))
      && !fs.readdirSync(folder).some(file => /^recording\./i.test(file)),
    fs.readdirSync(folder).join(', '));

    say('\n--- 5. real speaker naming IPC and notes path ---');
    const speakerMap = { Me: VOICES.Me.name };
    for (const truth of ['Atlas', 'Beacon', 'Cedar']) {
      const label = diarization.majority[truth];
      if (label && !speakerMap[label]) speakerMap[label] = VOICES[truth].name;
    }
    const mapped = await $(`window.yapper.setSpeakerMap(${JSON.stringify(folder)}, ${JSON.stringify(speakerMap)})`);
    const mappedTranscript = mapped.transcript || '';
    check('all four assigned names are persisted', ['Chuck', 'Alex', 'Brooke', 'Casey'].every(name =>
      mappedTranscript.includes(`${name}:`)), Object.keys(speakerMap).join(', '));
    const tNotes = Date.now();
    const draft = await $(`window.yapper.generateNotes(${JSON.stringify(folder)}, {
      style: 'general', detail: 'concise', custom: '',
      participants: 'Chuck, Alex, Brooke, Casey', markers: ['00:25:00', '02:30:25']
    }, true)`);
    metrics.notes = { wallMs: Date.now() - tNotes, ...draft.metrics };
    check('notes begin streaming quickly', draft.metrics.firstTextMs !== null && draft.metrics.firstTextMs < 250,
      `${draft.metrics.firstTextMs} ms`);
    check('notes and title are saved through the real app path',
      fs.existsSync(path.join(folder, 'notes.md'))
      && fs.readFileSync(path.join(folder, 'title.txt'), 'utf8').trim() === 'Three Hour Launch Rehearsal');
    const noteStamps = noteInput.split(/\r?\n/).map(stampSeconds).filter(value => value !== null);
    check('the notes prompt received the complete late transcript',
      noteInput.includes('Chuck:') && Math.max(...noteStamps) > DURATION_SEC - 120,
      `${noteInput.length} characters, last stamp ${Math.max(...noteStamps)}`);
    check('the notes instruction forbids vague speaker references', /instead of vague phrases such as "the speaker"/i.test(noteSystem));
    check('generated notes use names and never “the speaker”',
      ['Alex', 'Brooke', 'Casey'].every(name => draft.summary.includes(name))
      && !/the speaker/i.test(draft.summary));

    say('\n--- 6. reopen UI and exports ---');
    const reopened = await $(`window.yapper.loadMeeting(${JSON.stringify(folder)})`);
    check('speaker names survive reopening', Object.entries(speakerMap).every(([label, name]) =>
      reopened.speakers.some(row => row.label === label && row.name === name)), JSON.stringify(reopened.speakers));
    await $(`openMeetingByFolder(${JSON.stringify(folder)})`);
    await wait(500);
    check('the complete long transcript renders in the meeting view',
      (await $(`document.getElementById('transcript').textContent.length`)) > Math.max(500, MINUTES * 30));
    for (const kind of ['md', 'txt', 'transcript-md', 'both']) {
      const out = await within($(`runExport(${JSON.stringify(kind)})`), `export ${kind}`, 120000);
      check(`export ${kind} succeeds`, !!out && fs.existsSync(out) && fs.statSync(out).size > 100);
    }
    const pdf = await within($(`runExport('pdf')`), 'export pdf', 180000);
    check('PDF export succeeds', !!pdf && fs.existsSync(pdf) && fs.statSync(pdf).size > 2000);

    say(`\n--- 7. live preview, ${LIVE_MINUTES} real minutes ---`);
    if (LIVE_MINUTES > 0) {
      const liveRss = rss();
      const b64 = livePattern.toString('base64');
      await $(`(() => {
        const raw = atob(${JSON.stringify(b64)});
        window.__soakPcm = Uint8Array.from(raw, c => c.charCodeAt(0));
        window.__soakLive = [];
        window.__soakFed = 0;
        window.yapper.onLiveTranscript(line => {
          try { window.__soakLive.push({ ...JSON.parse(line), fed: window.__soakFed }); }
          catch { window.__soakLive.push({ error: 'invalid live payload' }); }
        });
      })()`);
      const liveStarted = await $(`window.yapper.liveStart('Chuck, Alex, Brooke, Casey')`);
      check('live preview starts', liveStarted === true, String(liveStarted));
      if (liveStarted) {
        const blockBytes = BPS / 5;
        const blocks = LIVE_MINUTES * 60 * 5;
        const wallStart = Date.now();
        for (let index = 0; index < blocks; index++) {
          const offset = (index * blockBytes) % livePattern.length;
          await $(`(() => {
            const a = ${offset}; const n = ${blockBytes};
            const src = window.__soakPcm;
            let chunk;
            if (a + n <= src.length) chunk = src.slice(a, a + n);
            else {
              chunk = new Uint8Array(n);
              chunk.set(src.slice(a)); chunk.set(src.slice(0, n - (src.length - a)), src.length - a);
            }
            window.__soakFed = ${(index + 1) / 5};
            window.yapper.recordingChunk(chunk.buffer);
          })()`);
          const delay = wallStart + (index + 1) * 200 - Date.now();
          if (delay > 0) await wait(delay);
          if ((index + 1) % 300 === 0) {
            const snap = await $(`({ count: window.__soakLive.length,
              words: window.__soakLive.reduce((n, x) => n + String(x.commit || '').split(/\\s+/).filter(Boolean).length, 0),
              errors: window.__soakLive.filter(x => x.error).length })`);
            say(`  live minute ${(index + 1) / 300}/${LIVE_MINUTES}: ${snap.words} confirmed words, ${snap.errors} errors`);
          }
        }
        await wait(4000);
        await $(`window.yapper.liveStop()`);
        const liveEvents = await $(`window.__soakLive`);
        const commits = liveEvents.filter(event => event.commit);
        const lags = commits.map(event => event.fed - event.end).filter(Number.isFinite).sort((a, b) => a - b);
        const words = commits.reduce((count, event) => count
          + String(event.commit).split(/\s+/).filter(Boolean).length, 0);
        const errors = liveEvents.filter(event => event.error).length;
        const liveGrowth = (await settledRss()) - liveRss;
        const median = lags.length ? lags[Math.floor(lags.length / 2)] : Infinity;
        const worst = lags.length ? lags[lags.length - 1] : Infinity;
        metrics.live = { words, errors, medianLagSec: median, worstLagSec: worst, rssGrowthBytes: liveGrowth };
        say(`  median lag ${median.toFixed(1)} s, worst ${worst.toFixed(1)} s, memory ${mb(liveGrowth)}`);
        check('live preview produces confirmed text', words > LIVE_MINUTES * 5, `${words} words`);
        check('live preview reports no engine errors', errors === 0, `${errors} errors`);
        check('live median lag stays under six seconds', median < 6, `${median.toFixed(1)} s`);
        check('live worst lag stays under twelve seconds', worst < 12, `${worst.toFixed(1)} s`);
        check('live preview does not leak memory', liveGrowth < 160 * 1024 * 1024, mb(liveGrowth));
      }
    } else {
      say('  skipped by LIVE_MINUTES=0');
    }

    metrics.totalSeconds = (Date.now() - started) / 1000;
    metrics.finalRssGrowthBytes = (await settledRss()) - startRss;
    check('the complete run stays within its memory budget', metrics.finalRssGrowthBytes < 600 * 1024 * 1024,
      mb(metrics.finalRssGrowthBytes));
  } catch (err) {
    fails++;
    results.push({ name: 'uncaught simulation error', ok: false, detail: err.stack || err.message });
    say(`FAIL  ${err.stack || err.message}`);
  } finally {
    clearTimeout(hardStop);
    try {
      fs.writeFileSync(REPORT, JSON.stringify({
        generatedAt: new Date().toISOString(), pass: fails === 0, failures: fails,
        metrics, checks: results
      }, null, 2), 'utf8');
      say(`\nreport: ${REPORT}`);
    } catch (err) {
      say(`could not write report: ${err.message}`);
    }
    say(fails ? `\n${fails} failures` : '\nPASS');
    app.exit(fails ? 1 : 0);
  }
}).catch(err => {
  say(`FAIL  ${err.stack || err.message}`);
  app.exit(1);
});
