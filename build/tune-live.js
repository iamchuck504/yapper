// Which live model and cadence actually confirm text quickly enough to read?
// Replays the same minute of real audio through several configurations and
// reports what each one costs and how much it manages to confirm.
const fs = require('fs');
const path = require('path');
const os = require("os");
const engine = require('../engine');
const live = require('../live');

const WAV = process.env.WAV || path.join(os.tmpdir(), 'yapper-60s.wav');
const PLAY_SEC = Number(process.env.SECS || 45);
const CHUNK_MS = 200;

const CONFIGS = [
  { model: 'small', cadenceMs: 500, windowSec: 12, maxHoldSec: 1.5 },
  { model: 'small', cadenceMs: 700, windowSec: 12, maxHoldSec: 1.5 },
  { model: 'small', cadenceMs: 700, windowSec: 12, maxHoldSec: 2.5 },
  { model: 'medium', cadenceMs: 700, windowSec: 12, maxHoldSec: 1.5 }
];

async function run(cfg) {
  const fd = fs.openSync(WAV, 'r');
  const totalBytes = Math.min(fs.statSync(WAV).size - engine.WAV_HEADER,
    PLAY_SEC * engine.BYTES_PER_SEC);

  let confirmed = '', firstAt = 0, passes = 0;
  const lags = [];
  let feedStart = 0;

  await live.start({
    model: cfg.model, cadenceMs: cfg.cadenceMs, windowSec: cfg.windowSec,
    maxHoldSec: cfg.maxHoldSec, language: 'en',
    onLine: obj => {
      if (obj.status || obj.error) return;
      passes++;
      if (!obj.commit) return;
      // audio is fed in real time, so wall-clock elapsed == position in the
      // meeting: the gap to the last confirmed word IS how far behind we are
      const heard = (Date.now() - feedStart) / 1000;
      if (!firstAt) firstAt = Date.now() - feedStart;
      lags.push(heard - obj.end);
      confirmed += (confirmed ? ' ' : '') + obj.commit;
    }
  });
  feedStart = Date.now();   // the clock starts when audio does, not at model load

  const perChunk = Math.floor(engine.BYTES_PER_SEC * CHUNK_MS / 1000) & ~1;
  for (let at = 0; at < totalBytes; at += perChunk) {
    const size = Math.min(perChunk, totalBytes - at);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, engine.WAV_HEADER + at);
    live.write(buf);
    await new Promise(r => setTimeout(r, CHUNK_MS));
  }
  fs.closeSync(fd);
  await new Promise(r => setTimeout(r, cfg.cadenceMs * 2));
  await live.stop();
  await engine.stop();

  const words = confirmed.split(/\s+/).filter(Boolean).length;
  lags.sort((a, b) => a - b);
  const lag = lags.length ? lags[Math.floor(lags.length / 2)] : 0;
  const worst = lags.length ? lags[lags.length - 1] : 0;
  return { firstAt, passes, words, confirmed, lag, worst };
}

(async () => {
  console.log(`replay: ${PLAY_SEC} s de ${path.basename(WAV)}, en tiempo real\n`);
  console.log('modelo  cadencia  ventana  espera   retraso  peor  1ª conf.  palabras');
  const results = [];
  for (const cfg of CONFIGS) {
    if (!engine.hasModel(cfg.model)) { console.log(`${cfg.model} — no descargado`); continue; }
    const r = await run(cfg);
    results.push({ cfg, r });
    console.log(`${cfg.model.padEnd(7)} ${String(cfg.cadenceMs).padStart(6)}ms  `
      + `${String(cfg.windowSec).padStart(5)}s  ${String(cfg.maxHoldSec).padStart(4)}s  `
      + `${r.lag.toFixed(1).padStart(6)}s ${r.worst.toFixed(1).padStart(5)}s  `
      + `${(r.firstAt / 1000).toFixed(1).padStart(6)}s  ${String(r.words).padStart(8)}`);
  }
  for (const { cfg, r } of results) {
    console.log(`\n--- ${cfg.model} @ ${cfg.cadenceMs}ms ---\n${r.confirmed.slice(0, 400)}`);
  }
})().catch(e => { console.log('FAIL', e.message); process.exit(1); });
