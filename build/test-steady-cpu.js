// The coworker case: no GPU at all. Runs the `steady` tier through a real
// replay on the CPU binaries, so the tier table is a measurement and not a hope.
const fs = require('fs');
const path = require('path');
const os = require("os");

const GPU = path.join(__dirname, '..', 'bin', 'win-x64-gpu');
const HIDDEN = GPU + '-off';
const hid = fs.existsSync(GPU);
if (hid) fs.renameSync(GPU, HIDDEN);
process.on('exit', () => { if (hid) { try { fs.renameSync(HIDDEN, GPU); } catch { /* back already */ } } });

const engine = require('../engine');
const live = require('../live');

const WAV = process.env.WAV || path.join(os.tmpdir(), 'yapper-60s.wav');
const PLAY_SEC = Number(process.env.SECS || 45);
const CHUNK_MS = 200;

(async () => {
  const cfg = engine.tierConfig('steady');
  console.log('binarios :', path.basename(engine.binDir()));
  console.log(`tier     : steady — ${cfg.liveModel} every ${cfg.cadenceMs} ms, window ${cfg.windowSec} s, hold ${cfg.maxHoldSec} s\n`);

  const fd = fs.openSync(WAV, 'r');
  const totalBytes = Math.min(fs.statSync(WAV).size - engine.WAV_HEADER, PLAY_SEC * engine.BYTES_PER_SEC);

  let confirmed = '', passes = 0, feedStart = 0;
  const lags = [];

  await live.start({
    model: cfg.liveModel, cadenceMs: cfg.cadenceMs, windowSec: cfg.windowSec,
    maxHoldSec: cfg.maxHoldSec, language: 'en',
    onLine: obj => {
      if (obj.status || obj.error) return;
      passes++;
      if (!obj.commit) return;
      lags.push((Date.now() - feedStart) / 1000 - obj.end);
      confirmed += (confirmed ? ' ' : '') + obj.commit;
    }
  });
  feedStart = Date.now();

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

  lags.sort((a, b) => a - b);
  const median = lags.length ? lags[Math.floor(lags.length / 2)] : 0;
  const worst = lags.length ? lags[lags.length - 1] : 0;
  const words = confirmed.split(/\s+/).filter(Boolean).length;

  console.log(`pasadas  : ${passes}`);
  console.log(`lag      : ${median.toFixed(1)} s median, ${worst.toFixed(1)} s worst`);
  console.log(`words    : ${words} confirmed in ${PLAY_SEC} s`);
  console.log(`\n${confirmed.slice(0, 400)}\n`);

  if (!words) { console.log('FAIL  the steady tier confirmed nothing on CPU'); process.exit(1); }
  // the point of the tier is that it does not drift further behind as it runs
  if (worst > 12) { console.log(`FAIL  fell ${worst.toFixed(1)} s behind — steady does not hold up on this CPU`); process.exit(1); }
  console.log('PASS');
})().catch(e => { console.log('FAIL', e.message); process.exit(1); });
