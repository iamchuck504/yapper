// What happens when starting a recording fails, which on someone else's PC it
// will: no microphone, screen capture denied, a driver that says no.
//
// The dangerous shape is a failure *after* the recording flag is set. The
// button comes back, so the app looks fine, but its own guard now thinks a
// recording is running and refuses to start another — the app silently never
// records again. That is what this pins down.
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { mainWindow } = require('./harness');

const BASE = path.join(app.getPath('temp'), 'yapper-recovery-test');
let ROOT = BASE;
try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { ROOT = `${BASE}-${process.pid}`; }
fs.mkdirSync(path.join(ROOT, 'Meetings'), { recursive: true });
app.setPath('documents', ROOT);
app.setPath('userData', path.join(ROOT, 'user'));

// Electron on Windows holds stdout until it exits, so a run that stalls prints
// nothing at all. Progress goes to a file as it happens.
const LOG = path.join(ROOT, 'progress.log');
function say(line) {
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch { /* nothing to do */ }
}
console.log(`live progress: ${LOG}`);

let fails = 0;
function check(name, ok, detail) {
  if (ok) say(`ok    ${name}`);
  else { fails++; say(`FAIL  ${name}\n      ${detail}`); }
}
function step(label) { say(`  · ${label}`); }

// A recording that fails to start can also fail to *finish* failing — an await
// that never settles. Without this the run just hangs, which is indistinguishable
// from being slow, so the whole thing is on a clock.
const watchdog = setTimeout(() => {
  say('FAIL  the test hung: something never finished resolving');
  app.exit(1);
}, 120000);

/** Never wait forever on one step; say which one stalled. */
function within(promise, label, ms = 25000) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`"${label}" did not answer in ${ms / 1000} s`)), ms))
  ]);
}

require('../main.js');

app.whenReady().then(async () => {
  const win = await mainWindow();
  const $ = js => win.webContents.executeJavaScript(js, true);

  const state = () => $(`({
    recording, paused,
    recordBtnHidden: document.getElementById('btn-record').classList.contains('hidden'),
    recordBtnDisabled: document.getElementById('btn-record').disabled,
    liveShown: !document.getElementById('live-wrap').classList.contains('hidden'),
    error: document.getElementById('status').classList.contains('error')
      && document.getElementById('status').textContent,
    onHome: !document.getElementById('view-home').classList.contains('hidden'),
    onRecord: !document.getElementById('view-record').classList.contains('hidden')
  })`);

  const before = await state();
  check('starts without recording', before.recording === false, JSON.stringify(before));
  check('starts on Today, not on the record view',
    before.onHome && !before.onRecord, JSON.stringify(before));

  // --- 1. screen capture refused ---
  // The two platforms owe the user opposite things here. Windows takes system
  // audio from getDisplayMedia, so a refusal is a real failure and must land
  // softly. macOS never asks — the loopback does not exist there — so the same
  // refusal must not cost anything at all: the microphone alone still records.
  // That is the guarantee, and it is worth pinning down, because the app used
  // to ask anyway and lose the whole recording when the answer was no.
  const MAC = process.platform === 'darwin';
  await $(`(() => {
    window.__realGDM = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getDisplayMedia = () => Promise.reject(new Error('Permission denied by the system'));
  })()`);
  await within($('startRecording()'), 'start with the permission denied');
  await new Promise(r => setTimeout(r, MAC ? 1200 : 600));

  let s = await state();
  if (MAC) {
    check('on macOS a denied screen does not stop recording', s.recording === true, JSON.stringify(s));
    check('and does not complain about a permission it does not need',
      !/Permission denied/.test(s.error || ''), String(s.error));
    // leave the app idle again for the cases below
    await within($('stopAndProcess()'), 'stop the macOS recording').catch(() => { });
    await new Promise(r => setTimeout(r, 1500));
    try { fs.rmSync(path.join(ROOT, 'Meetings'), { recursive: true, force: true }); } catch { }
    fs.mkdirSync(path.join(ROOT, 'Meetings'), { recursive: true });
    s = await state();
    check('and afterwards it is ready again', s.recording === false, JSON.stringify(s));
  } else {
    check('a denied permission does not leave the app recording', s.recording === false, JSON.stringify(s));
    // Recording can start from three places; the view has to be the record one
    // whoever called, or the error shows on a screen nobody is looking at.
    check('starting a recording brings the view with it',
      s.onRecord && !s.onHome, JSON.stringify(s));
    check('it explains it on screen', /Permission denied/.test(s.error || ''), String(s.error));
    check('the record button is still available',
      !s.recordBtnHidden && !s.recordBtnDisabled, JSON.stringify(s));
    check('left no orphaned meeting folder',
      fs.readdirSync(path.join(ROOT, 'Meetings')).length === 0,
      fs.readdirSync(path.join(ROOT, 'Meetings')).join(', '));
  }

  // --- 2. the dangerous one: it fails after the flag is already set ---
  // getDisplayMedia works, the folder is opened, and then the audio tap throws.
  await $(`(() => {
    navigator.mediaDevices.getDisplayMedia = async () => new MediaStream();
    window.__realTap = startPcmTap;
    startPcmTap = () => { throw new Error('the audio device disappeared'); };
  })()`);
  await within($('startRecording()'), 'a start that fails halfway');
  // abortRecording sets the flag first and explains itself last, after closing
  // the file — which can take a moment. Waiting a fixed 800 ms reads the state
  // in between and calls a slow message a missing one, so wait for the message.
  s = await state();
  for (let i = 0; i < 40 && !s.error; i++) {
    await new Promise(r => setTimeout(r, 250));
    s = await state();
  }
  check('a failure halfway through starting leaves it not recording either',
    s.recording === false, JSON.stringify(s));
  check('y lo explica', /audio device disappeared/.test(s.error || ''), String(s.error));
  check('the recording indicator is not left switched on', !s.recordBtnHidden, JSON.stringify(s));

  // the folder was opened before the failure: it must be closed, not left half written
  const folders = fs.readdirSync(path.join(ROOT, 'Meetings'));
  check('the half meeting was closed', folders.length === 1, folders.join(', '));
  if (folders.length === 1) {
    const wav = path.join(ROOT, 'Meetings', folders[0], 'recording.wav');
    check('its WAV exists and has a valid header',
      fs.existsSync(wav) && fs.readFileSync(wav).toString('ascii', 0, 4) === 'RIFF',
      fs.existsSync(wav) ? 'cabecera rara' : 'no existe');
    check('it reads as an empty recording, not a good meeting',
      fs.statSync(wav).size <= 44, `${fs.statSync(wav).size} bytes`);
  }

  // --- 3. and the whole point: it can still record afterwards ---
  await $(`(() => { startPcmTap = window.__realTap;
    navigator.mediaDevices.getDisplayMedia = window.__realGDM; })()`);
  const canStart = await $(`(() => {
    // the guard is what would silently block a retry
    if (recording) return 'the app still believes it is recording';
    return 'ok';
  })()`);
  check('recording can start again', canStart === 'ok', String(canStart));

  clearTimeout(watchdog);
  say(fails ? `\n${fails} failures` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(e => { console.log('FAIL', e.message); app.exit(1); });
