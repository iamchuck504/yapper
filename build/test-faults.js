// A different lens: break things underneath the app while it is working.
//
// Nothing so far covers what happens when the transcription server dies mid
// pass, a model is missing, two operations collide, or a meeting is deleted out
// from under a job. Those are the failures that happen on someone else's PC and
// not on the one it was written on.
const path = require('path');
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
  const src = process.env.WAV || path.join(process.env.TEMP, 'yapper-60s.wav');
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
  say(`whisper-server at start: ${baseline}\n`);

  // ---- 1. the file handle: can the recording be deleted after a cycle? ----
  say('--- 1. file handles after several cycles ---');
  for (let i = 1; i <= 3; i++) {
    const folder = await $(`window.yapper.recordingStart('')`);
    await $(`window.yapper.recordingChunk(new Uint8Array(32000).buffer)`);
    await new Promise(r => setTimeout(r, 120));
    await $(`window.yapper.recordingFinish('', [])`);
    const wav = path.join(folder, 'recording.wav');
    let locked = false;
    try { fs.unlinkSync(wav); } catch (e) { locked = true; }
    check(`cycle ${i}: the WAV is released`, !locked, 'the file is still locked — leaked descriptor');
  }

  // a start that is never finished must not keep the previous one open either
  const orphan = await $(`window.yapper.recordingStart('')`);
  const orphan2 = await $(`window.yapper.recordingStart('')`);
  let locked = false;
  try { fs.unlinkSync(path.join(orphan, 'recording.wav')); } catch { locked = true; }
  check('a start without a stop does not leave the previous one locked', !locked,
    'the previous recording left its descriptor open');
  await $(`window.yapper.recordingFinish('', [])`);
  fs.rmSync(orphan, { recursive: true, force: true });
  fs.rmSync(orphan2, { recursive: true, force: true });

  // ---- 2. the server dying mid-transcription ----
  say('\n--- 2. the transcription server dies mid-run ---');
  const f2 = seed('2026-07-29_1800', 40);
  const job = $(`window.yapper.transcribe(${JSON.stringify(f2)}).then(t => 'ok:' + t.length, e => 'err:' + e.message)`);
  await new Promise(r => setTimeout(r, 1200));
  try { execSync('taskkill /F /IM whisper-server.exe', { stdio: 'ignore' }); } catch { /* already gone */ }
  say('  (matado)');
  const r2 = await within(job, 'transcribes with the server dead', 90000)
    .catch(e => 'colgado:' + e.message);
  say(`  resultado: ${String(r2).slice(0, 120)}`);
  check('does not hang', !String(r2).startsWith('colgado'), String(r2));
  check('gives a readable error or recovers',
    /^ok:/.test(r2) || (/^err:/.test(r2) && String(r2).length > 12), String(r2));

  // and the app has to work again right after
  const f2b = seed('2026-07-29_1801', 15);
  const r2b = await within(
    $(`window.yapper.transcribe(${JSON.stringify(f2b)}).then(t => 'ok:' + t.length, e => 'err:' + e.message)`),
    'transcribes after the server is killed', 120000).catch(e => 'colgado:' + e.message);
  check('transcribes again afterwards', /^ok:/.test(r2b), String(r2b).slice(0, 140));

  // ---- 3. two transcriptions of the same meeting at once ----
  say('\n--- 3. two transcriptions at once ---');
  const f3 = seed('2026-07-29_1802', 20);
  const both = await within(Promise.all([
    $(`window.yapper.transcribe(${JSON.stringify(f3)}).then(t => t.length, e => 'err:' + e.message)`),
    $(`window.yapper.transcribe(${JSON.stringify(f3)}).then(t => t.length, e => 'err:' + e.message)`)
  ]), 'two simultaneous transcriptions', 180000).catch(e => ['colgado', e.message]);
  say(`  resultados: ${JSON.stringify(both)}`);
  check('neither one hangs', both[0] !== 'colgado', JSON.stringify(both));
  check('both finish cleanly (they queue, they do not fight)',
    both.every(x => typeof x === 'number' && x > 50), JSON.stringify(both));
  const tr3 = path.join(f3, 'transcript.txt');
  check('the transcript is left neither corrupt nor half-written',
    fs.existsSync(tr3) && fs.readFileSync(tr3, 'utf8').trim().length > 50,
    fs.existsSync(tr3) ? `${fs.readFileSync(tr3, 'utf8').length} caracteres` : 'no existe');

  // ---- 4. the meeting vanishing under a job ----
  say('\n--- 4. the meeting disappears mid-transcription ---');
  const f4 = seed('2026-07-29_1803', 30);
  const job4 = $(`window.yapper.transcribe(${JSON.stringify(f4)}).then(() => 'ok', e => 'err:' + e.message)`);
  await new Promise(r => setTimeout(r, 700));
  try { fs.rmSync(f4, { recursive: true, force: true }); } catch { /* held open */ }
  const r4 = await within(job4, 'transcribes over a deleted folder', 90000).catch(e => 'colgado:' + e.message);
  say(`  resultado: ${String(r4).slice(0, 120)}`);
  check('does not hang if the folder is deleted underneath it', !String(r4).startsWith('colgado'), String(r4));
  check('and it says so in words, with no codes or paths',
    !/ENOENT|ECONN|\\Users\\|Error invoking/.test(String(r4)), String(r4));

  // ---- 5. a missing model ----
  say('\n--- 5. the model is missing ---');
  const model = engine.modelPath('small');
  const hidden = model + '.hidden';
  let moved = false;
  try { fs.renameSync(model, hidden); moved = true; } catch (e) { say(`  (could not move the model: ${e.message})`); }
  if (moved) {
    await engine.stop();
    const f5 = seed('2026-07-29_1804', 15);
    const r5 = await within(
      $(`window.yapper.transcribe(${JSON.stringify(f5)}).then(() => 'ok', e => 'err:' + e.message)`),
      'transcribe sin modelo', 60000).catch(e => 'colgado:' + e.message);
    say(`  resultado: ${String(r5).slice(0, 140)}`);
    check('with no model it explains without jargon',
      /^err:/.test(r5) && /setup\.ps1|not installed/i.test(r5), String(r5));
    check('and it does not delete the recording',
      fs.existsSync(path.join(f5, 'recording.wav')), 'the audio was lost');
    fs.renameSync(hidden, model);
  }

  // ---- 6. child processes left behind ----
  say('\n--- 6. orphan processes ---');
  await engine.stop();
  await new Promise(r => setTimeout(r, 600));
  const left = servers();
  check('no leftover servers remain', left <= baseline, `${left} running, started with ${baseline}`);

  say(fails ? `\n${fails} fallos` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(e => { say('FAIL ' + (e.stack || e.message)); app.exit(1); });
