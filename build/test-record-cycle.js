// The whole recording cycle, which nothing had ever exercised end to end: the
// audio graph was rewritten (MediaRecorder out, a PCM tap straight to disk in)
// and only its pieces were covered.
//
// Real speech is fed through the exact IPC the microphone tap uses, then the
// meeting is stopped the way the Stop button stops it, and every artefact it
// should leave behind is checked. What this does NOT cover is the Web Audio
// graph itself — that needs a microphone and a person.
const path = require('path');
const os = require("os");
const fs = require('fs');
const { app, dialog } = require('electron');
const { mainWindow } = require('./harness');

const REAL = path.join(os.homedir(), 'Documents', 'Meetings');
const BASE = path.join(app.getPath('temp'), 'yapper-cycle-test');
let ROOT = BASE;
try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { ROOT = `${BASE}-${process.pid}`; }
fs.mkdirSync(path.join(ROOT, 'Meetings'), { recursive: true });
app.setPath('documents', ROOT);
app.setPath('userData', path.join(ROOT, 'user'));

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

// a minute of a real meeting, as raw samples — the same thing the tap sends
const engine = require('../engine');
function speech() {
  const wav = process.env.WAV || path.join(os.tmpdir(), 'yapper-60s.wav');
  if (fs.existsSync(wav)) return fs.readFileSync(wav).subarray(engine.WAV_HEADER);
  for (const d of fs.readdirSync(REAL)) {
    const p = path.join(REAL, d, 'recording.wav');
    if (fs.existsSync(p) && fs.statSync(p).size > engine.WAV_HEADER + engine.BYTES_PER_SEC * 30) {
      return fs.readFileSync(p).subarray(engine.WAV_HEADER, engine.WAV_HEADER + engine.BYTES_PER_SEC * 60);
    }
  }
  return null;
}

dialog.showMessageBox = async () => ({ response: 0 });
require('../main.js');

app.whenReady().then(async () => {
  const win = await mainWindow();
  const $ = js => win.webContents.executeJavaScript(js);

  const pcm = speech();
  if (!pcm) { say('FAIL  no hay audio real para alimentar la prueba'); return app.exit(1); }
  say(`audio de prueba: ${(pcm.length / engine.BYTES_PER_SEC).toFixed(0)} s\n`);

  // --- start, exactly as the record button does ---
  const folder = await $(`(async () => {
    const p = document.getElementById('participants-rec');
    p.value = 'Maya, Chuck';
    currentFolder = await window.yapper.recordingStart(recParticipants());
    paused = false; recording = true; markers = []; elapsedMs = 0; runStart = Date.now();
    window.yapper.setRecordingState(true);
    return currentFolder;
  })()`);
  check('abrió la carpeta de la reunión', !!folder && fs.existsSync(folder), String(folder));
  check('guardó los participantes',
    fs.existsSync(path.join(folder, 'participants.txt'))
    && fs.readFileSync(path.join(folder, 'participants.txt'), 'utf8').includes('Maya'), 'no está');

  const wav = path.join(folder, 'recording.wav');
  check('creó recording.wav de inmediato', fs.existsSync(wav), 'no existe');
  check('empieza con solo la cabecera', fs.statSync(wav).size === engine.WAV_HEADER,
    `${fs.statSync(wav).size} bytes`);

  // --- feed it in 200 ms blocks, like the tap ---
  const BLOCK = Math.floor(engine.BYTES_PER_SEC / 5) & ~1;
  let sent = 0;
  const half = Math.floor(pcm.length / 2);
  for (let at = 0; at < pcm.length; at += BLOCK) {
    const slice = pcm.subarray(at, Math.min(at + BLOCK, pcm.length));
    await $(`window.yapper.recordingChunk(new Uint8Array([${slice.join(',')}]).buffer)`);
    sent += slice.length;

    // pause halfway: nothing may reach the file while paused
    if (at <= half && at + BLOCK > half) {
      const before = fs.statSync(wav).size;
      await $('setPaused(true)');
      for (let i = 0; i < 3; i++) {
        await $(`(() => { if (!recording || paused) return; window.yapper.recordingChunk(new Uint8Array(3200).buffer); })()`);
      }
      await new Promise(r => setTimeout(r, 150));
      check('en pausa no se escribe nada', fs.statSync(wav).size === before,
        `creció ${fs.statSync(wav).size - before} bytes`);
      await $('setPaused(false); addMarker();');
    }
  }
  await new Promise(r => setTimeout(r, 300));

  const growing = fs.statSync(wav).size;
  check('el audio se escribió según llegaba', growing === engine.WAV_HEADER + sent,
    `esperaba ${engine.WAV_HEADER + sent}, hay ${growing}`);

  // --- a crash right now must still leave something playable ---
  const head = Buffer.alloc(4);
  const fd = fs.openSync(wav, 'r');
  fs.readSync(fd, head, 0, 4, 40);
  fs.closeSync(fd);
  check('mientras graba la cabecera aún no está cerrada', head.readUInt32LE(0) === 0,
    `declara ${head.readUInt32LE(0)} bytes`);

  // --- stop, and check the file the moment it is closed ---
  // The audio is released once there is a transcript, so its header has to be
  // inspected here, in the window where a crash would leave the user with only
  // this file.
  const closed = await $(`(async () => {
    recording = false;
    return window.yapper.recordingFinish('', markers);
  })()`);
  check('la grabación se guardó', closed && closed.bytes === sent,
    `${closed && closed.bytes} bytes de ${sent}`);
  const buf = fs.readFileSync(wav);
  check('la cabecera quedó cerrada con el tamaño real',
    buf.readUInt32LE(40) === buf.length - engine.WAV_HEADER,
    `declara ${buf.readUInt32LE(40)}, hay ${buf.length - engine.WAV_HEADER}`);
  check('el WAV es reproducible en ese momento',
    buf.toString('ascii', 0, 4) === 'RIFF' && buf.readUInt32LE(24) === 16000, 'cabecera inesperada');

  // --- and then the rest of the pipeline the Stop button runs ---
  const t0 = Date.now();
  const result = await $(`(async () => {
    const saved = { folder: ${JSON.stringify(folder)}, bytes: ${sent} };
    const transcript = await window.yapper.transcribe(saved.folder);
    const summary = await window.yapper.summarize(saved.folder, transcript,
      { ...options, participants: 'Maya, Chuck', markers });
    const title = await window.yapper.generateTitle(saved.folder);
    window.yapper.setRecordingState(false);
    return { saved, tLen: transcript.length, sLen: summary.length, title, markers };
  })()`);
  say(`\nel ciclo completo tardó ${((Date.now() - t0) / 1000).toFixed(0)} s`);

  check('quedó una marca del momento señalado',
    result.markers.length === 1 && fs.existsSync(path.join(folder, 'markers.txt')),
    JSON.stringify(result.markers));

  // the transcript is the record now, so the audio should be gone
  check('el audio se liberó al haber transcripción', !fs.existsSync(wav),
    `sigue ocupando ${fs.existsSync(wav) ? (fs.statSync(wav).size / 1024 / 1024).toFixed(0) + ' MB' : ''}`);

  check('dejó transcripción', result.tLen > 100, `${result.tLen} caracteres`);
  check('dejó notas', result.sLen > 200, `${result.sLen} caracteres`);

  // Naming is allowed to come back empty: the prompt tells the model to say so
  // when a recording is too unintelligible to title, and this test clip is a
  // noisy huddle. What matters is that whatever it decides is consistent.
  say(`título: "${result.title}"`);
  if (result.title) {
    check('el título se guardó en disco',
      fs.existsSync(path.join(folder, 'title.txt'))
      && fs.readFileSync(path.join(folder, 'title.txt'), 'utf8').trim() === result.title, 'no coincide');
  } else {
    check('sin título no deja un title.txt vacío',
      !fs.existsSync(path.join(folder, 'title.txt')), 'lo creó igual');
  }

  for (const f of ['transcript.txt', 'notes.md', 'participants.txt', 'markers.txt']) {
    check(`quedó ${f}`, fs.existsSync(path.join(folder, f)), 'falta');
  }

  // --- and the meeting shows up correctly in the sidebar ---
  await $('refreshMeetingList()');
  await new Promise(r => setTimeout(r, 400));
  const rows = await $(`[...document.querySelectorAll('#meeting-list .m-item')].map(li => ({
    title: li.querySelector('.m-title').textContent,
    empty: li.classList.contains('m-void')
  }))`);
  check('aparece en la lista', rows.length === 1, JSON.stringify(rows));
  check('no la marca como vacía', rows[0] && !rows[0].empty, JSON.stringify(rows[0]));
  check('la lista concuerda con el título',
    rows[0] && (result.title ? rows[0].title === result.title : rows[0].title === 'Untitled meeting'),
    `lista "${rows[0] && rows[0].title}" vs "${result.title}"`);
  check('la lista nunca la llama solo "Meeting"', rows[0] && rows[0].title !== 'Meeting',
    'una lista de reuniones llamadas Meeting no dice nada');

  // --- reopening it has to show everything back ---
  const back = await $(`window.yapper.loadMeeting(${JSON.stringify(folder)})`);
  check('al reabrirla trae las notas', back.summary.length > 200, `${back.summary.length} caracteres`);
  check('al reabrirla trae la transcripción', back.transcript.length > 100, `${back.transcript.length} caracteres`);
  check('al reabrirla trae los participantes', back.participants.includes('Maya'), back.participants);
  // no audio any more, and that is correct: the transcript is what it has
  check('sabe que ya no hay grabación', back.hasRecording === false, String(back.hasRecording));

  say(fails ? `\n${fails} fallos` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(e => { say('FAIL ' + (e.stack || e.message)); app.exit(1); });
