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
  say('FAIL  the test hung: something never resolved');
  app.exit(1);
}, 120000);

/** Never wait forever on one step; say which one stalled. */
function within(promise, label, ms = 25000) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`"${label}" did not respond in ${ms / 1000} s`)), ms))
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

  // --- 1. the early failure: capture is refused before anything is set up ---
  await $(`(() => {
    window.__realGDM = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getDisplayMedia = () => Promise.reject(new Error('Permission denied by the system'));
  })()`);
  await within($('startRecording()'), 'startup with permission denied');
  await new Promise(r => setTimeout(r, 600));

  let s = await state();
  check('a denied permission does not leave the app recording', s.recording === false, JSON.stringify(s));
  // Recording can start from three places; the view has to be the record view
  // regardless of the caller, or the error shows on a screen nobody is looking at.
  check('starting a recording takes the view with it',
    s.onRecord && !s.onHome, JSON.stringify(s));
  check('it explains it on screen', /Permission denied/.test(s.error || ''), String(s.error));
  check('the record button is still available',
    !s.recordBtnHidden && !s.recordBtnDisabled, JSON.stringify(s));
  check('left no orphan meeting folder',
    fs.readdirSync(path.join(ROOT, 'Meetings')).length === 0,
    fs.readdirSync(path.join(ROOT, 'Meetings')).join(', '));

  // --- 2. the dangerous one: it fails after the flag is already set ---
  // getDisplayMedia works, the folder is opened, and then the audio tap throws.
  await $(`(() => {
    navigator.mediaDevices.getDisplayMedia = async () => new MediaStream();
    window.__realTap = startPcmTap;
    startPcmTap = () => { throw new Error('the audio device disappeared'); };
  })()`);
  await within($('startRecording()'), 'arranque que falla a mitad');
  await new Promise(r => setTimeout(r, 800));

  s = await state();
  check('a mid-startup failure does not leave the app recording either',
    s.recording === false, JSON.stringify(s));
  check('and it explains it', /audio device disappeared/.test(s.error || ''), String(s.error));
  check('the recording indicator does not stay lit', !s.recordBtnHidden, JSON.stringify(s));

  // the folder was opened before the failure: it must be closed, not left half written
  const folders = fs.readdirSync(path.join(ROOT, 'Meetings'));
  check('the half-finished meeting was closed', folders.length === 1, folders.join(', '));
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
    if (recording) return 'the app still thinks it is recording';
    return 'ok';
  })()`);
  check('recording can start again', canStart === 'ok', String(canStart));

  clearTimeout(watchdog);
  say(fails ? `\n${fails} fallos` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(e => { console.log('FAIL', e.message); app.exit(1); });
