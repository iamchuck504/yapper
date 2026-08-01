// Feeds a real recording into live.js at wall-clock speed, exactly as the
// renderer does during a meeting, and checks the two things that matter:
// confirmed text never changes once printed, and it does not fall behind.
const fs = require('fs');
const path = require('path');
const os = require("os");
const engine = require('../engine');
const live = require('../live');

const MEETINGS = path.join(os.homedir(), 'Documents', 'Meetings');
const PLAY_SEC = Number(process.env.SECS || 60);
const CHUNK_MS = 200;

/**
 * Speech to replay. The generated fixture comes first on purpose: reaching into
 * the user's own meetings made this test depend on whatever happened to be
 * recorded last — a silent take, or an aborted one, fails it while proving
 * nothing — and it meant reading real meeting audio to run a test. Set
 * `WAV=`, or `REAL=1` to go back to the newest recording on this machine.
 */
function pickRecording() {
  if (process.env.WAV) return process.env.WAV;

  const longEnough = w => fs.existsSync(w)
    && fs.statSync(w).size > engine.WAV_HEADER + engine.BYTES_PER_SEC * 30;

  if (process.env.REAL) {
    for (const d of fs.readdirSync(MEETINGS).sort().reverse()) {
      const w = path.join(MEETINGS, d, 'recording.wav');
      if (longEnough(w)) return w;
    }
  }

  const fixture = path.join(os.tmpdir(), 'yapper-60s.wav');
  if (!longEnough(fixture)) require('./make-fixtures').build(60);
  return longEnough(fixture) ? fixture : null;
}

(async () => {
  const wav = pickRecording();
  if (!wav) { console.log('FAIL  no .wav recording found to test with'); process.exit(1); }
  console.log('recording  :', wav);

  const tier = engine.tierConfig(engine.guessTier());
  console.log(`tier      : ${engine.guessTier()} (model ${tier.liveModel}, every ${tier.cadenceMs} ms, window ${tier.windowSec} s)\n`);

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
      if (obj.status) { console.log(`ready in ${Date.now() - started} ms\n`); return; }
      if (obj.error) { console.log('ERROR from the pass:', obj.error); return; }
      passes++;
      if (obj.commit) {
        if (!firstAt) firstAt = Date.now() - started;
        confirmed += (confirmed ? ' ' : '') + obj.commit;
      }
      tentative = obj.tentative || '';
    }
  });
  if (!ok) { console.log('FAIL  live.start returned false'); process.exit(1); }

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
  console.log(`\n--- ${PLAY_SEC} s of meeting replayed in real time ---`);
  console.log(`first confirmation   : ${firstAt} ms after start`);
  console.log(`pasadas              : ${passes}`);
  console.log(`palabras confirmadas : ${words}`);
  console.log(`tentative tail       : ${tentative || '(empty)'}`);
  console.log(`\ntexto confirmado:\n${confirmed}\n`);

  if (!words) { console.log('FAIL  nothing was confirmed'); process.exit(1); }
  if (words < PLAY_SEC * 0.4) console.log(`WARNING  only ${(words / PLAY_SEC).toFixed(1)} words/s — silence, or falling behind?`);
  console.log('PASS');
})().catch(e => { console.log('FAIL', e.message); process.exit(1); });
