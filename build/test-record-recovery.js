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
console.log(`progreso en vivo: ${LOG}`);

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
  say('FAIL  la prueba se colgó: algo no terminó de resolverse');
  app.exit(1);
}, 120000);

/** Never wait forever on one step; say which one stalled. */
function within(promise, label, ms = 25000) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`"${label}" no respondió en ${ms / 1000} s`)), ms))
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
  check('arranca sin grabar', before.recording === false, JSON.stringify(before));
  check('arranca en Today, no en la vista de grabar',
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
  await within($('startRecording()'), 'arranque con permiso denegado');
  await new Promise(r => setTimeout(r, MAC ? 1200 : 600));

  let s = await state();
  if (MAC) {
    check('en macOS la pantalla denegada no impide grabar', s.recording === true, JSON.stringify(s));
    check('y no se queja de un permiso que no necesita',
      !/Permission denied/.test(s.error || ''), String(s.error));
    // leave the app idle again for the cases below
    await within($('stopAndProcess()'), 'parar la grabación de macOS').catch(() => { });
    await new Promise(r => setTimeout(r, 1500));
    try { fs.rmSync(path.join(ROOT, 'Meetings'), { recursive: true, force: true }); } catch { }
    fs.mkdirSync(path.join(ROOT, 'Meetings'), { recursive: true });
    s = await state();
    check('y después vuelve a estar lista', s.recording === false, JSON.stringify(s));
  } else {
    check('un permiso denegado no deja la app grabando', s.recording === false, JSON.stringify(s));
    // Grabar puede empezar desde tres lados; la vista tiene que ser la de grabar
    // sin depender de quién llamó, o el error se muestra en una pantalla que no se ve.
    check('arrancar una grabación se lleva la vista consigo',
      s.onRecord && !s.onHome, JSON.stringify(s));
    check('lo explica en pantalla', /Permission denied/.test(s.error || ''), String(s.error));
    check('el botón de grabar sigue disponible',
      !s.recordBtnHidden && !s.recordBtnDisabled, JSON.stringify(s));
    check('no dejó carpeta de reunión huérfana',
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
  await within($('startRecording()'), 'arranque que falla a mitad');
  // abortRecording sets the flag first and explains itself last, after closing
  // the file — which can take a moment. Waiting a fixed 800 ms reads the state
  // in between and calls a slow message a missing one, so wait for the message.
  s = await state();
  for (let i = 0; i < 40 && !s.error; i++) {
    await new Promise(r => setTimeout(r, 250));
    s = await state();
  }
  check('un fallo a mitad de arranque tampoco deja la app grabando',
    s.recording === false, JSON.stringify(s));
  check('y lo explica', /audio device disappeared/.test(s.error || ''), String(s.error));
  check('el indicador de grabación no se queda encendido', !s.recordBtnHidden, JSON.stringify(s));

  // the folder was opened before the failure: it must be closed, not left half written
  const folders = fs.readdirSync(path.join(ROOT, 'Meetings'));
  check('la reunión a medias quedó cerrada', folders.length === 1, folders.join(', '));
  if (folders.length === 1) {
    const wav = path.join(ROOT, 'Meetings', folders[0], 'recording.wav');
    check('su WAV existe y tiene cabecera válida',
      fs.existsSync(wav) && fs.readFileSync(wav).toString('ascii', 0, 4) === 'RIFF',
      fs.existsSync(wav) ? 'cabecera rara' : 'no existe');
    check('se ve como grabación vacía, no como reunión buena',
      fs.statSync(wav).size <= 44, `${fs.statSync(wav).size} bytes`);
  }

  // --- 3. and the whole point: it can still record afterwards ---
  await $(`(() => { startPcmTap = window.__realTap;
    navigator.mediaDevices.getDisplayMedia = window.__realGDM; })()`);
  const canStart = await $(`(() => {
    // the guard is what would silently block a retry
    if (recording) return 'la app sigue creyendo que graba';
    return 'ok';
  })()`);
  check('se puede volver a grabar', canStart === 'ok', String(canStart));

  clearTimeout(watchdog);
  say(fails ? `\n${fails} fallos` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(e => { console.log('FAIL', e.message); app.exit(1); });
