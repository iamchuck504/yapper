// Importing a voice note goes through Chromium's decoders now, and that path
// had never been run against a real file. Feeds it an actual m4a and a real
// webm and checks the WAV that comes out is playable, the right length, and
// that the transcript is not empty.
const path = require('path');
const os = require("os");
const fs = require('fs');
const { app, dialog } = require('electron');
const { mainWindow } = require('./harness');

const REAL = path.join(os.homedir(), 'Documents', 'Meetings');
const ROOT = path.join(app.getPath('temp'), 'yapper-import-test');
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, 'Meetings'), { recursive: true });
app.setPath('documents', ROOT);
app.setPath('userData', path.join(ROOT, 'user'));

let fails = 0;
function check(name, ok, detail) {
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      ${detail}`); }
}

function findAudio(ext) {
  for (const d of fs.readdirSync(REAL)) {
    const p = path.join(REAL, d, `recording.${ext}`);
    if (fs.existsSync(p) && fs.statSync(p).size > 100 * 1024) return p;
  }
  return null;
}

let picked = null;
dialog.showOpenDialog = async () => (picked
  ? { canceled: false, filePaths: [picked] }
  : { canceled: true, filePaths: [] });

const engine = require('../engine');
require('../main.js');

app.whenReady().then(async () => {
  const win = await mainWindow();
  const $ = js => win.webContents.executeJavaScript(js);

  for (const ext of ['m4a', 'webm']) {
    picked = findAudio(ext);
    if (!picked) { console.log(`\n(sin ningún .${ext} de prueba en Meetings)`); continue; }
    const sizeMb = (fs.statSync(picked).size / 1024 / 1024).toFixed(1);
    console.log(`\n=== .${ext} — ${path.basename(path.dirname(picked))} (${sizeMb} MB) ===`);

    const before = fs.readdirSync(path.join(ROOT, 'Meetings'));
    const t0 = Date.now();

    // Keep a copy of the decoded WAV the moment it is finished, since the app
    // releases it as soon as the transcript lands. Watching for it is how the
    // conversion itself stays testable.
    const watch = setInterval(() => {
      for (const d of fs.readdirSync(path.join(ROOT, 'Meetings'))) {
        if (before.includes(d)) continue;
        const w = path.join(ROOT, 'Meetings', d, 'recording.wav');
        const copy = path.join(ROOT, 'Meetings', d, 'decoded-copy.wav');
        try {
          if (fs.existsSync(w) && !fs.existsSync(copy)
            && fs.statSync(w).size > engine.WAV_HEADER
            && fs.readFileSync(w).readUInt32LE(40) > 0) {     // header already closed
            fs.copyFileSync(w, copy);
          }
        } catch { /* mid-write; try again next tick */ }
      }
    }, 150);

    await $(`document.getElementById('btn-import').click()`);

    // wait for the pipeline to finish, or for it to give up
    const done = await new Promise(resolve => {
      const started = Date.now();
      const tick = setInterval(async () => {
        const state = await $(`(() => ({
          err: document.getElementById('status').classList.contains('error')
            && document.getElementById('status').textContent,
          view: !document.getElementById('view-meeting').classList.contains('hidden')
        }))()`);
        if (state.view || state.err || Date.now() - started > 300000) {
          clearInterval(tick); resolve(state);
        }
      }, 1000);
    });
    clearInterval(watch);
    console.log(`tardó ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    check(`.${ext}: no falló`, !done.err, done.err || '');
    if (done.err) continue;

    const folders = fs.readdirSync(path.join(ROOT, 'Meetings')).filter(f => !before.includes(f));
    check(`.${ext}: creó la reunión`, folders.length === 1, folders.join(', '));
    if (!folders.length) continue;
    const folder = path.join(ROOT, 'Meetings', folders[0]);

    // The converted WAV is released once there is a transcript, so what it
    // looked like is checked from the copy the test kept before that happened.
    const wav = path.join(folder, 'recording.wav');
    check(`.${ext}: liberó el WAV convertido al haber transcripción`, !fs.existsSync(wav),
      'sigue ocupando espacio');
    const kept = path.join(folder, 'decoded-copy.wav');
    check(`.${ext}: se pudo inspeccionar la conversión`, fs.existsSync(kept), 'no se copió');
    if (!fs.existsSync(kept)) continue;

    const buf = fs.readFileSync(kept);
    const secs = (buf.length - engine.WAV_HEADER) / engine.BYTES_PER_SEC;
    check(`.${ext}: WAV con cabecera válida`,
      buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE',
      buf.toString('ascii', 0, 12));
    check(`.${ext}: 16 kHz mono 16-bit`,
      buf.readUInt16LE(22) === 1 && buf.readUInt32LE(24) === 16000 && buf.readUInt16LE(34) === 16,
      `canales ${buf.readUInt16LE(22)}, rate ${buf.readUInt32LE(24)}, bits ${buf.readUInt16LE(34)}`);
    check(`.${ext}: la cabecera declara el tamaño real`,
      buf.readUInt32LE(40) === buf.length - engine.WAV_HEADER,
      `declara ${buf.readUInt32LE(40)}, hay ${buf.length - engine.WAV_HEADER}`);
    check(`.${ext}: tiene audio de verdad`, secs > 5, `${secs.toFixed(1)} s`);
    console.log(`      duración decodificada: ${(secs / 60).toFixed(1)} min`);

    // and it has to be audible content, not silence
    let peak = 0;
    for (let i = engine.WAV_HEADER; i + 1 < buf.length; i += 200) {
      peak = Math.max(peak, Math.abs(buf.readInt16LE(i)));
    }
    check(`.${ext}: el audio no salió en silencio`, peak > 500, `pico ${peak}`);

    const tr = path.join(folder, 'transcript.txt');
    check(`.${ext}: dejó transcripción`, fs.existsSync(tr), 'no está');
    if (fs.existsSync(tr)) {
      const text = fs.readFileSync(tr, 'utf8');
      check(`.${ext}: la transcripción tiene contenido`, text.trim().length > 40, `${text.length} caracteres`);
      console.log(`      "${text.slice(0, 120).replace(/\n/g, ' ')}"`);
    }

    // The file is called "recording", which names nothing, so the meeting must
    // NOT be called that — it gets a title from what was said, or falls back to
    // its date.
    const title = await $(`document.getElementById('result-title').textContent`);
    check(`.${ext}: no se queda con el nombre genérico del archivo`,
      title !== 'recording' && title.trim().length > 3, `título: "${title}"`);
    console.log(`      título: "${title}"`);

    // the file the user picked is theirs and must not be touched
    check(`.${ext}: el archivo original sigue intacto`,
      fs.existsSync(picked) && fs.statSync(picked).size > 100 * 1024, picked);

    await $(`document.getElementById('btn-new').click()`);
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(fails ? `\n${fails} fallos` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(e => { console.log('FAIL', e.stack || e.message); app.exit(1); });
