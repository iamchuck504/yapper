// The transcript is the record now, and the audio goes once it exists. That is
// deleting the user's recording, so the conditions have to be exact: only after
// a real transcript is on disk, never when transcription failed, never when they
// asked to keep it, and never before the transcript is written.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, dialog } = require('electron');
const { sandbox, logger, mainWindow, within } = require('./harness');

const ROOT = sandbox('audio-release');
const say = logger(ROOT);
const engine = require('../engine');

let fails = 0;
function check(name, ok, detail) {
  if (ok) say(`ok    ${name}`);
  else { fails++; say(`FAIL  ${name}\n      ${detail}`); }
}

/**
 * Enough speech to transcribe. It used to insist on a 60 s wav left in %TEMP%
 * by another script — a Windows-only path, and a fixture that may simply not be
 * there — so it now falls back to looping the calibration sample that ships
 * with the app, which every checkout has on every platform.
 */
function sourcePcm(seconds) {
  const named = process.env.WAV || path.join(os.tmpdir(), 'yapper-60s.wav');
  const src = fs.existsSync(named) ? named : path.join(__dirname, 'calibration.wav');
  const pcm = fs.readFileSync(src).subarray(engine.WAV_HEADER);
  const want = engine.BYTES_PER_SEC * seconds;
  if (pcm.length >= want) return pcm.subarray(0, want);
  const copies = Math.ceil(want / pcm.length);
  return Buffer.concat(Array.from({ length: copies }, () => pcm)).subarray(0, want);
}

function seed(name, seconds = 20) {
  const folder = path.join(ROOT, 'Meetings', name);
  fs.mkdirSync(folder, { recursive: true });
  const pcm = sourcePcm(seconds);
  fs.writeFileSync(path.join(folder, 'recording.wav'), engine.wavFromPcm(pcm));
  return folder;
}
const has = (folder, f) => fs.existsSync(path.join(folder, f));

let confirm = 0;
dialog.showMessageBox = async () => ({ response: confirm });
require('../main.js');

app.whenReady().then(async () => {
  const win = await mainWindow({ settleMs: 1500 });
  const $ = js => win.webContents.executeJavaScript(js);

  // ---- 1. a successful transcription releases the audio ----
  say('--- 1. successful transcription ---');
  const a = seed('2026-07-29_2000');
  const before = fs.statSync(path.join(a, 'recording.wav')).size;
  const len = await within(
    $(`window.yapper.transcribe(${JSON.stringify(a)}).then(t => t.length, e => 'err:' + e.message)`),
    'transcribir', 120000);
  check('transcribe', typeof len === 'number' && len > 50, String(len));
  check('the transcript is left on disk', has(a, 'transcript.txt'), 'is missing');
  check(`releases the audio (${(before / 1024 / 1024).toFixed(1)} MB)`, !has(a, 'recording.wav'),
    'the WAV is still there');
  check('the transcript genuinely has content',
    fs.readFileSync(path.join(a, 'transcript.txt'), 'utf8').trim().length > 50, 'is nearly empty');

  // and the meeting still reads correctly with no audio
  const loaded = await $(`window.yapper.loadMeeting(${JSON.stringify(a)})`);
  check('the meeting still opens without audio', loaded.transcript.length > 50, 'no transcript');
  check('and knows the recording is gone', loaded.hasRecording === false, String(loaded.hasRecording));
  await $('refreshMeetingList()');
  await new Promise(r => setTimeout(r, 400));
  const row = await $(`(() => {
    const li = [...document.querySelectorAll('#meeting-list .m-item')]
      .find(x => x.querySelector('.m-date').textContent.includes('20:00'));
    return li ? { empty: li.classList.contains('m-void'), title: li.querySelector('.m-title').textContent } : null;
  })()`);
  check('does NOT flag it as an empty recording', row && !row.empty, JSON.stringify(row));

  // ---- 2. a failed transcription keeps the audio ----
  say('\n--- 2. failed transcription ---');
  const b = seed('2026-07-29_2001');
  const model = engine.modelPath('small');
  const hidden = model + '.hidden';
  fs.renameSync(model, hidden);
  await engine.stop();
  const err = await within(
    $(`window.yapper.transcribe(${JSON.stringify(b)}).then(() => 'ok', e => 'err:' + e.message)`),
    'transcribe with no model', 60000);
  fs.renameSync(hidden, model);
  say(`  ${String(err).slice(0, 90)}`);
  check('fails as it should', String(err).startsWith('err:'), String(err));
  check('keeps the audio when it fails', has(b, 'recording.wav'), 'deleted it anyway');
  check('and leaves no half-written transcript', !has(b, 'transcript.txt'), 'wrote one');

  // it can be retried afterwards, which is the whole point of keeping it
  const retry = await within(
    $(`window.yapper.transcribe(${JSON.stringify(b)}).then(t => t.length, e => 'err:' + e.message)`),
    'reintentar', 120000);
  check('can be retried, and then it does release',
    typeof retry === 'number' && !has(b, 'recording.wav'), String(retry));

  // ---- 3. an empty transcript keeps the audio ----
  say('\n--- 3. audio with no speech ---');
  const c = path.join(ROOT, 'Meetings', '2026-07-29_2002');
  fs.mkdirSync(c, { recursive: true });
  fs.writeFileSync(path.join(c, 'recording.wav'),
    engine.wavFromPcm(Buffer.alloc(engine.BYTES_PER_SEC * 6)));   // six seconds of silence
  const silent = await within(
    $(`window.yapper.transcribe(${JSON.stringify(c)}).then(() => 'ok', e => 'err:' + e.message)`),
    'transcribir silencio', 60000);
  const tPath = path.join(c, 'transcript.txt');
  const tSize = fs.existsSync(tPath) ? fs.statSync(tPath).size : 0;
  say(`  ${String(silent).slice(0, 60)} — transcript ${tSize} bytes, audio ${has(c, 'recording.wav') ? 'conservado' : 'liberado'}`);
  // Either it produced a real transcript and released, or it produced nothing
  // worth keeping and held on. What must never happen is losing the audio to a
  // transcript too thin to be the record.
  check('never trades the audio for a two-word transcript',
    has(c, 'recording.wav') ? true : tSize >= 40,
    `${tSize}-byte transcript and the audio is gone`);

  // ---- 4. "Keep this meeting's audio": one meeting, then off again ----
  say("\n--- 4. \"Keep this meeting's audio\" ---");
  check('starts switched off', (await $('window.yapper.getKeepAudio()')) === false, 'came in switched on');
  check('and so does the on-screen toggle',
    (await $("document.getElementById('opt-keep-audio').checked")) === false, 'came in checked');

  await $(`(() => { const t = document.getElementById('opt-keep-audio');
    t.checked = true; t.dispatchEvent(new Event('change')); })()`);
  await new Promise(r => setTimeout(r, 300));

  const d = seed('2026-07-29_2003');
  await within($(`window.yapper.transcribe(${JSON.stringify(d)})`), 'transcribing with keepAudio', 120000);
  check('when on, keeps the audio for THAT meeting', has(d, 'recording.wav'), 'deleted it anyway');
  check('and still leaves the transcript', has(d, 'transcript.txt'), 'did not leave it');

  // and it must have turned itself off again
  await new Promise(r => setTimeout(r, 300));
  check('switches itself off once it has been honoured',
    (await $('window.yapper.getKeepAudio()')) === false, 'is still on');
  check('the on-screen toggle unchecks itself',
    (await $("document.getElementById('opt-keep-audio').checked")) === false, 'is still checked');

  // so the very next meeting releases again, without touching anything
  const d2 = seed('2026-07-29_2006');
  await within($(`window.yapper.transcribe(${JSON.stringify(d2)})`), 'the next meeting', 120000);
  check('the next meeting releases its audio again', !has(d2, 'recording.wav'), 'kept it');
  check('and the previous one still keeps its own', has(d, 'recording.wav'), 'took it away afterwards');

  // nothing about it may be written to settings, or it would survive a restart
  const settings = JSON.parse(fs.readFileSync(path.join(ROOT, 'user', 'settings.json'), 'utf8'));
  check('is not left saved in settings', settings.keepAudio === undefined,
    JSON.stringify(settings));

  // ---- 4b. an old compressed recording ----
  // Re-transcribing a meeting from before the app wrote WAV converts it first,
  // so the folder briefly holds both files. Both are that meeting's audio, and
  // the policy is the same for both — but the .webm is the user's only copy, so
  // it is worth being explicit that this is intended and not a slip.
  say('\n--- 4b. an old compressed recording ---');
  const legacyFolder = path.join(ROOT, 'Meetings', '2026-07-29_2007');
  fs.mkdirSync(legacyFolder, { recursive: true });
  fs.writeFileSync(path.join(legacyFolder, 'recording.webm'), Buffer.alloc(300 * 1024, 7));
  fs.writeFileSync(path.join(legacyFolder, 'recording.wav'),
    fs.readFileSync(path.join(seed('2026-07-29_2008', 20), 'recording.wav')));
  await within($(`window.yapper.transcribe(${JSON.stringify(legacyFolder)})`),
    'transcribing the old one', 120000);
  check('releases the converted WAV', !has(legacyFolder, 'recording.wav'), 'is still there');
  check('and so is the compressed original', !has(legacyFolder, 'recording.webm'),
    'the .webm survived — the policy says it goes too');
  check('keeping the transcript', has(legacyFolder, 'transcript.txt'), 'is missing');

  // ---- 5. reclaiming what older meetings still hold ----
  say('\n--- 5. releasing what was already stored ---');
  const e1 = seed('2026-07-29_2004', 30);
  fs.writeFileSync(path.join(e1, 'transcript.txt'), '[00:00:01] Already transcribed long ago.', 'utf8');
  const e2 = seed('2026-07-29_2005', 30);          // no transcript: must be left alone
  const held = await $('window.yapper.heldAudio()');
  say(`  held: ${(held.bytes / 1024 / 1024).toFixed(1)} MB across ${held.count} files`);
  check('counts only the already-transcribed meetings', held.count >= 1, JSON.stringify(held));

  confirm = 1;                                     // cancel
  const cancelled = await $('window.yapper.releaseHeldAudio()');
  check('cancelling deletes nothing',
    cancelled.released === 0 && has(e1, 'recording.wav'), JSON.stringify(cancelled));

  confirm = 0;                                     // confirm
  const freed = await $('window.yapper.releaseHeldAudio()');
  say(`  freed: ${(freed.bytes / 1024 / 1024).toFixed(1)} MB from ${freed.released} files`);
  check('confirming frees the transcribed one', !has(e1, 'recording.wav'), 'is still there');
  check('and does NOT touch the one with no transcript', has(e2, 'recording.wav'), 'deleted the untranscribed one');
  check('keeps the transcript of the freed one', has(e1, 'transcript.txt'), 'took the transcript with it');
  const after = await $('window.yapper.heldAudio()');
  check('nothing is held any more', after.count === 0, JSON.stringify(after));

  say(fails ? `\n${fails} failures` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(e => { say('FAIL ' + (e.stack || e.message)); app.exit(1); });
