// The transcript is the record now, and the audio goes once it exists. That is
// deleting the user's recording, so the conditions have to be exact: only after
// a real transcript is on disk, never when transcription failed, never when they
// asked to keep it, and never before the transcript is written.
const path = require('path');
const fs = require('fs');
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

function seed(name, seconds = 20) {
  const src = process.env.WAV || path.join(process.env.TEMP, 'yapper-60s.wav');
  const folder = path.join(ROOT, 'Meetings', name);
  fs.mkdirSync(folder, { recursive: true });
  const pcm = fs.readFileSync(src).subarray(engine.WAV_HEADER,
    engine.WAV_HEADER + engine.BYTES_PER_SEC * seconds);
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
  say('--- 1. transcripción exitosa ---');
  const a = seed('2026-07-29_2000');
  const before = fs.statSync(path.join(a, 'recording.wav')).size;
  const len = await within(
    $(`window.yapper.transcribe(${JSON.stringify(a)}).then(t => t.length, e => 'err:' + e.message)`),
    'transcribir', 120000);
  check('transcribe', typeof len === 'number' && len > 50, String(len));
  check('el transcript queda en disco', has(a, 'transcript.txt'), 'no está');
  check(`libera el audio (${(before / 1024 / 1024).toFixed(1)} MB)`, !has(a, 'recording.wav'),
    'el WAV sigue ahí');
  check('el transcript tiene contenido de verdad',
    fs.readFileSync(path.join(a, 'transcript.txt'), 'utf8').trim().length > 50, 'está casi vacío');

  // and the meeting still reads correctly with no audio
  const loaded = await $(`window.yapper.loadMeeting(${JSON.stringify(a)})`);
  check('la reunión se abre igual sin audio', loaded.transcript.length > 50, 'sin transcript');
  check('y sabe que ya no hay grabación', loaded.hasRecording === false, String(loaded.hasRecording));
  await $('refreshMeetingList()');
  await new Promise(r => setTimeout(r, 400));
  const row = await $(`(() => {
    const li = [...document.querySelectorAll('#meeting-list .m-item')]
      .find(x => x.querySelector('.m-date').textContent.includes('20:00'));
    return li ? { empty: li.classList.contains('m-void'), title: li.querySelector('.m-title').textContent } : null;
  })()`);
  check('NO la marca como grabación vacía', row && !row.empty, JSON.stringify(row));

  // ---- 2. a failed transcription keeps the audio ----
  say('\n--- 2. transcripción fallida ---');
  const b = seed('2026-07-29_2001');
  const model = engine.modelPath('small');
  const hidden = model + '.hidden';
  fs.renameSync(model, hidden);
  await engine.stop();
  const err = await within(
    $(`window.yapper.transcribe(${JSON.stringify(b)}).then(() => 'ok', e => 'err:' + e.message)`),
    'transcribir sin modelo', 60000);
  fs.renameSync(hidden, model);
  say(`  ${String(err).slice(0, 90)}`);
  check('falla como debe', String(err).startsWith('err:'), String(err));
  check('conserva el audio cuando falla', has(b, 'recording.wav'), 'lo borró igual');
  check('y no deja un transcript a medias', !has(b, 'transcript.txt'), 'escribió uno');

  // it can be retried afterwards, which is the whole point of keeping it
  const retry = await within(
    $(`window.yapper.transcribe(${JSON.stringify(b)}).then(t => t.length, e => 'err:' + e.message)`),
    'reintentar', 120000);
  check('se puede reintentar y entonces sí libera',
    typeof retry === 'number' && !has(b, 'recording.wav'), String(retry));

  // ---- 3. an empty transcript keeps the audio ----
  say('\n--- 3. audio sin habla ---');
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
  check('nunca cambia el audio por un transcript de dos palabras',
    has(c, 'recording.wav') ? true : tSize >= 40,
    `transcript de ${tSize} bytes y el audio ya no está`);

  // ---- 4. "Keep this meeting's audio": one meeting, then off again ----
  say("\n--- 4. \"Keep this meeting's audio\" ---");
  check('arranca apagado', (await $('window.yapper.getKeepAudio()')) === false, 'venía encendido');
  check('y el interruptor de la pantalla también',
    (await $("document.getElementById('opt-keep-audio').checked")) === false, 'venía marcado');

  await $(`(() => { const t = document.getElementById('opt-keep-audio');
    t.checked = true; t.dispatchEvent(new Event('change')); })()`);
  await new Promise(r => setTimeout(r, 300));

  const d = seed('2026-07-29_2003');
  await within($(`window.yapper.transcribe(${JSON.stringify(d)})`), 'transcribir con keepAudio', 120000);
  check('encendido, conserva el audio de ESA reunión', has(d, 'recording.wav'), 'lo borró igual');
  check('y aun así deja el transcript', has(d, 'transcript.txt'), 'no lo dejó');

  // and it must have turned itself off again
  await new Promise(r => setTimeout(r, 300));
  check('se apaga solo después de honrarlo',
    (await $('window.yapper.getKeepAudio()')) === false, 'sigue encendido');
  check('el interruptor de la pantalla se desmarca solo',
    (await $("document.getElementById('opt-keep-audio').checked")) === false, 'sigue marcado');

  // so the very next meeting releases again, without touching anything
  const d2 = seed('2026-07-29_2006');
  await within($(`window.yapper.transcribe(${JSON.stringify(d2)})`), 'la siguiente reunión', 120000);
  check('la siguiente reunión ya libera el audio', !has(d2, 'recording.wav'), 'lo conservó');
  check('y la anterior sigue conservando el suyo', has(d, 'recording.wav'), 'se lo llevó después');

  // nothing about it may be written to settings, or it would survive a restart
  const settings = JSON.parse(fs.readFileSync(path.join(ROOT, 'user', 'settings.json'), 'utf8'));
  check('no queda guardado en los ajustes', settings.keepAudio === undefined,
    JSON.stringify(settings));

  // ---- 5. reclaiming what older meetings still hold ----
  say('\n--- 5. liberar lo que ya estaba guardado ---');
  const e1 = seed('2026-07-29_2004', 30);
  fs.writeFileSync(path.join(e1, 'transcript.txt'), '[00:00:01] Already transcribed long ago.', 'utf8');
  const e2 = seed('2026-07-29_2005', 30);          // no transcript: must be left alone
  const held = await $('window.yapper.heldAudio()');
  say(`  retenido: ${(held.bytes / 1024 / 1024).toFixed(1)} MB en ${held.count} archivos`);
  check('cuenta solo las reuniones ya transcritas', held.count >= 1, JSON.stringify(held));

  confirm = 1;                                     // cancel
  const cancelled = await $('window.yapper.releaseHeldAudio()');
  check('cancelar no borra nada',
    cancelled.released === 0 && has(e1, 'recording.wav'), JSON.stringify(cancelled));

  confirm = 0;                                     // confirm
  const freed = await $('window.yapper.releaseHeldAudio()');
  say(`  liberado: ${(freed.bytes / 1024 / 1024).toFixed(1)} MB de ${freed.released} archivos`);
  check('confirmar libera la transcrita', !has(e1, 'recording.wav'), 'sigue ahí');
  check('y NO toca la que no tiene transcript', has(e2, 'recording.wav'), 'borró la no transcrita');
  check('conserva el transcript de la liberada', has(e1, 'transcript.txt'), 'se llevó el transcript');
  const after = await $('window.yapper.heldAudio()');
  check('ya no queda nada retenido', after.count === 0, JSON.stringify(after));

  say(fails ? `\n${fails} fallos` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(e => { say('FAIL ' + (e.stack || e.message)); app.exit(1); });
