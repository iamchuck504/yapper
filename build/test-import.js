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
  const generated = path.join(ROOT, `recording.${ext}`);
  if (fs.existsSync(generated)) return generated;
  if (!fs.existsSync(REAL)) return null;
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
const llm = require('../llm');
llm.generate = async (_config, { system, onDelta }) => {
  if (system.includes('short title')) return 'Import Fixture';
  const out = `${system.includes('YAPPER_TITLE:') ? 'YAPPER_TITLE: Import Fixture\n\n' : ''}`
    + '# Summary\n- Deterministic imported-audio test.\n\n# Key points\n- Chromium decoded the selected voice note.';
  if (onDelta) {
    const cut = out.indexOf('# Key points');
    onDelta(out.slice(0, cut), out.slice(0, cut));
    await new Promise(r => setTimeout(r, 450));
    onDelta(out.slice(cut), out);
  }
  return out;
};
require('../main.js');

app.whenReady().then(async () => {
  const win = await mainWindow();
  const $ = js => win.webContents.executeJavaScript(js);

  const calibration = path.join(__dirname, 'calibration.wav');
  const wavBase64 = fs.readFileSync(calibration).toString('base64');
  const encoded = await $(`(async () => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(wavBase64)}), c => c.charCodeAt(0));
    const audio = new AudioContext();
    const decoded = await audio.decodeAudioData(bytes.buffer);
    const record = candidates => {
      const mimeType = candidates.find(t => MediaRecorder.isTypeSupported(t));
      if (!mimeType) return Promise.resolve({ unsupported: candidates.join(', ') });
      const output = audio.createMediaStreamDestination();
      const source = audio.createBufferSource();
      source.buffer = decoded;
      source.connect(output);
      const chunks = [];
      const recorder = new MediaRecorder(output.stream, { mimeType });
      const done = new Promise((resolve, reject) => {
        recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
        recorder.onerror = e => reject(e.error || new Error('MediaRecorder failed'));
        recorder.onstop = () => {
          const blob = new Blob(chunks, { type: mimeType });
          const reader = new FileReader();
          reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
          reader.onload = () => resolve({ mimeType, data: String(reader.result).split(',')[1] });
          reader.readAsDataURL(blob);
        };
      });
      source.onended = () => recorder.stop();
      recorder.start();
      source.start();
      return done;
    };
    const [m4a, webm] = await Promise.all([
      record(['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/x-m4a']),
      record(['audio/webm;codecs=opus', 'audio/webm'])
    ]);
    await audio.close();
    return { m4a, webm };
  })()`);
  for (const ext of ['m4a', 'webm']) {
    if (!encoded[ext].data) {
      check(`Chromium can encode the .${ext} fixture`, false, encoded[ext].unsupported);
      continue;
    }
    fs.writeFileSync(path.join(ROOT, `recording.${ext}`), Buffer.from(encoded[ext].data, 'base64'));
  }
  const m4a = path.join(ROOT, 'recording.m4a');
  check('made a deterministic m4a fixture', fs.existsSync(m4a) && fs.statSync(m4a).size > 20 * 1024,
    fs.existsSync(m4a) ? `${fs.statSync(m4a).size} bytes` : 'missing');
  const webm = path.join(ROOT, 'recording.webm');
  check('made a deterministic webm fixture', fs.statSync(webm).size > 20 * 1024,
    `${fs.statSync(webm).size} bytes`);

  for (const ext of ['m4a', 'webm']) {
    picked = findAudio(ext);
    if (!picked) { fails++; console.log(`\nFAIL  could not make or find a .${ext} fixture`); continue; }
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
    let sawProgressiveNotes = false;
    const done = await new Promise(resolve => {
      const started = Date.now();
      const tick = setInterval(async () => {
        const state = await $(`(() => ({
          err: (document.getElementById('status').classList.contains('error')
              && document.getElementById('status').textContent)
            || (document.getElementById('regen-status').classList.contains('error')
              && document.getElementById('regen-status').textContent),
          view: !document.getElementById('view-meeting').classList.contains('hidden'),
          busy: document.getElementById('notes').getAttribute('aria-busy') === 'true',
          importBusy: document.getElementById('btn-import').disabled,
          notes: document.getElementById('notes').textContent
        }))()`);
        if (state.view && state.busy && /Deterministic imported-audio/.test(state.notes)) {
          sawProgressiveNotes = true;
        }
        if (state.err || (state.view && !state.busy && !state.importBusy)
            || Date.now() - started > 300000) {
          clearInterval(tick); resolve(state);
        }
      }, 50);
    });
    clearInterval(watch);
    console.log(`took ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    check(`.${ext}: did not fail`, !done.err, done.err || '');
    if (done.err) continue;
    check(`.${ext}: showed notes before the provider finished`, sawProgressiveNotes,
      'no partial note appeared while the request was still running');

    const folders = fs.readdirSync(path.join(ROOT, 'Meetings')).filter(f => !before.includes(f));
    check(`.${ext}: created the meeting`, folders.length === 1, folders.join(', '));
    if (!folders.length) continue;
    const folder = path.join(ROOT, 'Meetings', folders[0]);

    // The converted WAV is released once there is a transcript, so what it
    // looked like is checked from the copy the test kept before that happened.
    const wav = path.join(folder, 'recording.wav');
    check(`.${ext}: released the converted WAV once transcribed`, !fs.existsSync(wav),
      'is still taking up space');
    const kept = path.join(folder, 'decoded-copy.wav');
    check(`.${ext}: the conversion could be inspected`, fs.existsSync(kept), 'was not copied');
    if (!fs.existsSync(kept)) continue;

    const buf = fs.readFileSync(kept);
    const secs = (buf.length - engine.WAV_HEADER) / engine.BYTES_PER_SEC;
    check(`.${ext}: WAV with a valid header`,
      buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE',
      buf.toString('ascii', 0, 12));
    check(`.${ext}: 16 kHz mono 16-bit`,
      buf.readUInt16LE(22) === 1 && buf.readUInt32LE(24) === 16000 && buf.readUInt16LE(34) === 16,
      `canales ${buf.readUInt16LE(22)}, rate ${buf.readUInt32LE(24)}, bits ${buf.readUInt16LE(34)}`);
    check(`.${ext}: the header declares the real size`,
      buf.readUInt32LE(40) === buf.length - engine.WAV_HEADER,
      `declares ${buf.readUInt32LE(40)}, actual ${buf.length - engine.WAV_HEADER}`);
    check(`.${ext}: genuinely has audio`, secs > 5, `${secs.toFixed(1)} s`);
    console.log(`      decoded duration: ${(secs / 60).toFixed(1)} min`);

    // and it has to be audible content, not silence
    let peak = 0;
    for (let i = engine.WAV_HEADER; i + 1 < buf.length; i += 200) {
      peak = Math.max(peak, Math.abs(buf.readInt16LE(i)));
    }
    check(`.${ext}: the audio did not come out silent`, peak > 500, `pico ${peak}`);

    const tr = path.join(folder, 'transcript.txt');
    check(`.${ext}: left a transcript`, fs.existsSync(tr), 'is missing');
    if (fs.existsSync(tr)) {
      const text = fs.readFileSync(tr, 'utf8');
      check(`.${ext}: the transcript has content`, text.trim().length > 40, `${text.length} caracteres`);
      console.log(`      "${text.slice(0, 120).replace(/\n/g, ' ')}"`);
    }

    // The file is called "recording", which names nothing, so the meeting must
    // NOT be called that — it gets a title from what was said, or falls back to
    // its date.
    const title = await $(`document.getElementById('result-title').textContent`);
    check(`.${ext}: does not keep the generic filename`,
      title !== 'recording' && title.trim().length > 3, `title: "${title}"`);
    check(`.${ext}: receives its title with the notes`,
      title === 'Import Fixture', `title: "${title}"`);
    const timing = await $(`document.getElementById('result-speed').textContent`);
    check(`.${ext}: shows where the wait was spent`,
      /transcript .*first notes .*complete/.test(timing), timing);
    console.log(`      title: "${title}"`);

    // the file the user picked is theirs and must not be touched
    check(`.${ext}: the original file is still intact`,
      fs.existsSync(picked) && fs.statSync(picked).size > 10 * 1024, picked);

    await $(`document.getElementById('btn-new').click()`);
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(fails ? `\n${fails} failures` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(e => { console.log('FAIL', e.stack || e.message); app.exit(1); });
