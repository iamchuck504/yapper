// Feeds a real recording into live.js at wall-clock speed, exactly as the
// renderer does during a meeting, and checks the two things that matter:
// confirmed text never changes once printed, and it does not fall behind.
const fs = require('fs');
const path = require('path');
const engine = require('../engine');
const live = require('../live');

const MEETINGS = path.join(process.env.USERPROFILE, 'Documents', 'Meetings');
const PLAY_SEC = Number(process.env.SECS || 60);
const CHUNK_MS = 200;

function pickRecording() {
  if (process.env.WAV) return process.env.WAV;
  const dirs = fs.readdirSync(MEETINGS).sort().reverse();
  for (const d of dirs) {
    const w = path.join(MEETINGS, d, 'recording.wav');
    if (fs.existsSync(w) && fs.statSync(w).size > engine.WAV_HEADER + engine.BYTES_PER_SEC * 30) return w;
  }
  return null;
}

(async () => {
  const wav = pickRecording();
  if (!wav) { console.log('FAIL  no encontré ninguna grabación .wav para probar'); process.exit(1); }
  console.log('grabación :', wav);

  const tier = engine.tierConfig(engine.guessTier());
  console.log(`tier      : ${engine.guessTier()} (modelo ${tier.liveModel}, cada ${tier.cadenceMs} ms, ventana ${tier.windowSec} s)\n`);

  const fd = fs.openSync(wav, 'r');
  const totalBytes = Math.min(fs.statSync(wav).size - engine.WAV_HEADER,
    PLAY_SEC * engine.BYTES_PER_SEC);

  let confirmed = '';
  let tentative = '';
  let passes = 0;
  let firstAt = 0;
  const started = Date.now();

  const ok = await live.start({
    model: tier.liveModel,
    cadenceMs: tier.cadenceMs,
    windowSec: tier.windowSec,
    language: 'en',
    onLine: obj => {
      if (obj.status) { console.log(`listo en ${Date.now() - started} ms\n`); return; }
      if (obj.error) { console.log('ERROR de la pasada:', obj.error); return; }
      passes++;
      if (obj.commit) {
        if (!firstAt) firstAt = Date.now() - started;
        confirmed += (confirmed ? ' ' : '') + obj.commit;
      }
      tentative = obj.tentative || '';
    }
  });
  if (!ok) { console.log('FAIL  live.start devolvió false'); process.exit(1); }

  // hand over 200 ms of audio every 200 ms, like a real meeting does
  const perChunk = Math.floor(engine.BYTES_PER_SEC * CHUNK_MS / 1000) & ~1;
  for (let at = 0; at < totalBytes; at += perChunk) {
    const size = Math.min(perChunk, totalBytes - at);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, engine.WAV_HEADER + at);
    live.write(buf);
    await new Promise(r => setTimeout(r, CHUNK_MS));
  }
  fs.closeSync(fd);

  await new Promise(r => setTimeout(r, tier.cadenceMs * 2));
  await live.stop();
  await engine.stop();

  const words = confirmed.split(/\s+/).filter(Boolean).length;
  console.log(`\n--- ${PLAY_SEC} s de reunión reproducidos en tiempo real ---`);
  console.log(`primera confirmación : ${firstAt} ms después de empezar`);
  console.log(`pasadas              : ${passes}`);
  console.log(`palabras confirmadas : ${words}`);
  console.log(`cola tentativa       : ${tentative || '(vacía)'}`);
  console.log(`\ntexto confirmado:\n${confirmed}\n`);

  if (!words) { console.log('FAIL  no se confirmó nada'); process.exit(1); }
  if (words < PLAY_SEC * 0.4) console.log(`AVISO  solo ${(words / PLAY_SEC).toFixed(1)} palabras/s — ¿silencio o va atrasado?`);
  console.log('PASS');
})().catch(e => { console.log('FAIL', e.message); process.exit(1); });
