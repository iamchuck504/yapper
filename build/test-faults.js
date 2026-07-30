// A different lens: break things underneath the app while it is working.
//
// Nothing so far covers what happens when the transcription server dies mid
// pass, a model is missing, two operations collide, or a meeting is deleted out
// from under a job. Those are the failures that happen on someone else's PC and
// not on the one it was written on.
const path = require('path');
const os = require("os");
const fs = require('fs');
const { execSync } = require('child_process');
const { app, dialog } = require('electron');
const { sandbox, logger, mainWindow, within } = require('./harness');

const ROOT = sandbox('faults');
const say = logger(ROOT);
const engine = require('../engine');

let fails = 0;
function check(name, ok, detail) {
  if (ok) say(`ok    ${name}`);
  else { fails++; say(`FAIL  ${name}\n      ${detail}`); }
}

function servers() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq whisper-server.exe" /NH', { encoding: 'utf8' });
    return (out.match(/whisper-server\.exe/g) || []).length;
  } catch { return 0; }
}

/** A meeting folder holding real speech, ready to transcribe. */
function seed(name, seconds = 20) {
  const src = process.env.WAV || path.join(os.tmpdir(), 'yapper-60s.wav');
  const folder = path.join(ROOT, 'Meetings', name);
  fs.mkdirSync(folder, { recursive: true });
  const pcm = fs.readFileSync(src).subarray(engine.WAV_HEADER,
    engine.WAV_HEADER + engine.BYTES_PER_SEC * seconds);
  fs.writeFileSync(path.join(folder, 'recording.wav'), engine.wavFromPcm(pcm));
  return folder;
}

dialog.showMessageBox = async () => ({ response: 0 });
require('../main.js');

app.whenReady().then(async () => {
  const win = await mainWindow({ settleMs: 1500 });
  const $ = js => win.webContents.executeJavaScript(js);
  const baseline = servers();
  say(`whisper-server al empezar: ${baseline}\n`);

  // ---- 1. the file handle: can the recording be deleted after a cycle? ----
  say('--- 1. handles de archivo tras varios ciclos ---');
  for (let i = 1; i <= 3; i++) {
    const folder = await $(`window.yapper.recordingStart('')`);
    await $(`window.yapper.recordingChunk(new Uint8Array(32000).buffer)`);
    await new Promise(r => setTimeout(r, 120));
    await $(`window.yapper.recordingFinish('', [])`);
    const wav = path.join(folder, 'recording.wav');
    let locked = false;
    try { fs.unlinkSync(wav); } catch (e) { locked = true; }
    check(`ciclo ${i}: el WAV queda liberado`, !locked, 'el archivo sigue bloqueado — descriptor filtrado');
  }

  // a start that is never finished must not keep the previous one open either
  const orphan = await $(`window.yapper.recordingStart('')`);
  const orphan2 = await $(`window.yapper.recordingStart('')`);
  let locked = false;
  try { fs.unlinkSync(path.join(orphan, 'recording.wav')); } catch { locked = true; }
  check('un arranque sin cierre no deja el anterior bloqueado', !locked,
    'la grabación anterior quedó con el descriptor abierto');
  await $(`window.yapper.recordingFinish('', [])`);
  fs.rmSync(orphan, { recursive: true, force: true });
  fs.rmSync(orphan2, { recursive: true, force: true });

  // ---- 2. the server dying mid-transcription ----
  say('\n--- 2. el servidor de transcripción muere a mitad ---');
  const f2 = seed('2026-07-29_1800', 40);
  const job = $(`window.yapper.transcribe(${JSON.stringify(f2)}).then(t => 'ok:' + t.length, e => 'err:' + e.message)`);
  await new Promise(r => setTimeout(r, 1200));
  try { execSync('taskkill /F /IM whisper-server.exe', { stdio: 'ignore' }); } catch { /* already gone */ }
  say('  (matado)');
  const r2 = await within(job, 'transcribe con el servidor muerto', 90000)
    .catch(e => 'colgado:' + e.message);
  say(`  resultado: ${String(r2).slice(0, 120)}`);
  check('no se queda colgado', !String(r2).startsWith('colgado'), String(r2));
  check('da un error legible o se recupera',
    /^ok:/.test(r2) || (/^err:/.test(r2) && String(r2).length > 12), String(r2));

  // and the app has to work again right after
  const f2b = seed('2026-07-29_1801', 15);
  const r2b = await within(
    $(`window.yapper.transcribe(${JSON.stringify(f2b)}).then(t => 'ok:' + t.length, e => 'err:' + e.message)`),
    'transcribe después de matar el servidor', 120000).catch(e => 'colgado:' + e.message);
  check('vuelve a transcribir después', /^ok:/.test(r2b), String(r2b).slice(0, 140));

  // ---- 3. two transcriptions of the same meeting at once ----
  say('\n--- 3. dos transcripciones a la vez ---');
  const f3 = seed('2026-07-29_1802', 20);
  const both = await within(Promise.all([
    $(`window.yapper.transcribe(${JSON.stringify(f3)}).then(t => t.length, e => 'err:' + e.message)`),
    $(`window.yapper.transcribe(${JSON.stringify(f3)}).then(t => t.length, e => 'err:' + e.message)`)
  ]), 'dos transcripciones simultáneas', 180000).catch(e => ['colgado', e.message]);
  say(`  resultados: ${JSON.stringify(both)}`);
  check('ninguna se cuelga', both[0] !== 'colgado', JSON.stringify(both));
  check('las dos terminan bien (se ponen en cola, no se pelean)',
    both.every(x => typeof x === 'number' && x > 50), JSON.stringify(both));
  const tr3 = path.join(f3, 'transcript.txt');
  check('el transcript no queda corrupto ni a medias',
    fs.existsSync(tr3) && fs.readFileSync(tr3, 'utf8').trim().length > 50,
    fs.existsSync(tr3) ? `${fs.readFileSync(tr3, 'utf8').length} caracteres` : 'no existe');

  // ---- 4. the meeting vanishing under a job ----
  say('\n--- 4. la reunión desaparece mientras se transcribe ---');
  const f4 = seed('2026-07-29_1803', 30);
  const job4 = $(`window.yapper.transcribe(${JSON.stringify(f4)}).then(() => 'ok', e => 'err:' + e.message)`);
  await new Promise(r => setTimeout(r, 700));
  try { fs.rmSync(f4, { recursive: true, force: true }); } catch { /* held open */ }
  const r4 = await within(job4, 'transcribe sobre carpeta borrada', 90000).catch(e => 'colgado:' + e.message);
  say(`  resultado: ${String(r4).slice(0, 120)}`);
  check('no se cuelga si le borran la carpeta', !String(r4).startsWith('colgado'), String(r4));
  check('y lo dice en palabras, sin códigos ni rutas',
    // Paths leak differently per platform, so both shapes count as a leak.
    !/ENOENT|ECONN|\\Users\\|\/Users\/|Error invoking/.test(String(r4)), String(r4));

  // ---- 5. a missing model ----
  say('\n--- 5. falta el modelo ---');
  const model = engine.modelPath('small');
  const hidden = model + '.hidden';
  let moved = false;
  try { fs.renameSync(model, hidden); moved = true; } catch (e) { say(`  (no pude mover el modelo: ${e.message})`); }
  if (moved) {
    await engine.stop();
    const f5 = seed('2026-07-29_1804', 15);
    const r5 = await within(
      $(`window.yapper.transcribe(${JSON.stringify(f5)}).then(() => 'ok', e => 'err:' + e.message)`),
      'transcribe sin modelo', 60000).catch(e => 'colgado:' + e.message);
    say(`  resultado: ${String(r5).slice(0, 140)}`);
    check('sin modelo lo explica sin jerga',
      /^err:/.test(r5) && /setup\.ps1|not installed/i.test(r5), String(r5));
    check('y no borra la grabación',
      fs.existsSync(path.join(f5, 'recording.wav')), 'se perdió el audio');
    fs.renameSync(hidden, model);
  }

  // ---- 6. child processes left behind ----
  say('\n--- 6. procesos huérfanos ---');
  await engine.stop();
  await new Promise(r => setTimeout(r, 600));
  const left = servers();
  check('no quedan servidores de más', left <= baseline, `${left} corriendo, empezó con ${baseline}`);

  say(fails ? `\n${fails} fallos` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(e => { say('FAIL ' + (e.stack || e.message)); app.exit(1); });
