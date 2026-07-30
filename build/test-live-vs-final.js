// Transcriptions are queued against each other now, but the live loop does not
// go through that queue — it calls the server directly on a cadence. So what
// happens if someone hits "Transcribe now" on an old meeting while a live
// recording is running? Both want the same single server, with different models.
const path = require('path');
const os = require("os");
const fs = require('fs');
const { app } = require('electron');
const { sandbox, logger, mainWindow, within } = require('./harness');

const ROOT = sandbox('live-vs-final');
const say = logger(ROOT);
const engine = require('../engine');
const live = require('../live');

let fails = 0;
function check(name, ok, detail) {
  if (ok) say(`ok    ${name}`);
  else { fails++; say(`FAIL  ${name}\n      ${detail}`); }
}

require('../main.js');

app.whenReady().then(async () => {
  const win = await mainWindow({ settleMs: 1200 });
  const $ = js => win.webContents.executeJavaScript(js);

  const src = process.env.WAV || path.join(os.tmpdir(), 'yapper-60s.wav');
  const minute = fs.readFileSync(src).subarray(engine.WAV_HEADER);

  // an old meeting sitting there, ready to be re-transcribed
  const old = path.join(ROOT, 'Meetings', '2026-07-29_2100');
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'recording.wav'),
    engine.wavFromPcm(minute.subarray(0, engine.BYTES_PER_SEC * 40)));

  // start the live loop, as a recording would
  const tier = engine.tierConfig(engine.guessTier());
  let confirmed = 0, errors = [];
  const started = await live.start({
    model: tier.liveModel, cadenceMs: tier.cadenceMs, windowSec: tier.windowSec,
    maxHoldSec: tier.maxHoldSec, language: 'en',
    onLine: o => {
      if (o.error) errors.push(o.error);
      else if (o.commit) confirmed += o.commit.split(/\s+/).filter(Boolean).length;
    }
  });
  check('el vivo arranca', started === true, String(started));
  say(`  vivo con ${tier.liveModel}, final usaría ${tier.finalModel}`);

  // feed it in real time in the background
  let feeding = true;
  const BLOCK = Math.floor(engine.BYTES_PER_SEC / 5) & ~1;
  (async () => {
    for (let round = 0; round < 3 && feeding; round++) {
      for (let at = 0; at < minute.length && feeding; at += BLOCK) {
        live.write(minute.subarray(at, Math.min(at + BLOCK, minute.length)));
        await new Promise(r => setTimeout(r, 200));
      }
    }
  })();

  // long enough to load the model and get several passes in
  await new Promise(r => setTimeout(r, 16000));
  const beforeWords = confirmed;
  say(`  tras 16 s de vivo: ${beforeWords} palabras confirmadas`);
  check('el vivo está funcionando antes de interferir', beforeWords > 5, `${beforeWords} palabras`);

  // now the collision: a full transcription of another meeting, mid-recording
  say('  --- pido "Transcribe now" de una reunión vieja ---');
  const t0 = Date.now();
  const res = await within(
    $(`window.yapper.transcribe(${JSON.stringify(old)}).then(t => t.length, e => 'err:' + e.message)`),
    'transcribir mientras el vivo corre', 180000).catch(e => 'colgado:' + e.message);
  say(`  resultado: ${String(res).slice(0, 90)} en ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  check('la transcripción de la vieja funciona', typeof res === 'number' && res > 50, String(res));

  // and the live loop has to still be alive afterwards
  const midWords = confirmed;
  await new Promise(r => setTimeout(r, 8000));
  feeding = false;
  const afterWords = confirmed;
  say(`  palabras del vivo: ${beforeWords} antes, ${midWords} al terminar, ${afterWords} después`);
  say(`  errores del vivo durante la colisión: ${errors.length}`);
  if (errors.length) say(`    ${errors.slice(0, 3).join(' | ')}`);

  check('el vivo sigue confirmando después de la colisión',
    afterWords > midWords, `se quedó en ${afterWords}`);
  check('el vivo no se llenó de errores', errors.length <= 2,
    `${errors.length} errores: ${errors.slice(0, 2).join(' | ')}`);

  await live.stop();
  await engine.stop();
  say(fails ? `\n${fails} fallos` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(e => { say('FAIL ' + (e.stack || e.message)); app.exit(1); });
