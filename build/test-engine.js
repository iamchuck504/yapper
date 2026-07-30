// Exercises engine.js end to end: start the server once, transcribe several
// windows through it, and report what a streaming pass actually costs here.
const fs = require('fs');
const path = require('path');
const engine = require('../engine');

const WAV_10S = path.join(process.env.TEMP, 'yapper-10s.wav');

function fail(msg) { console.log('FAIL  ' + msg); process.exit(1); }

(async () => {
  console.log('plataforma  :', engine.platformKey());
  console.log('binarios    :', engine.binDir());
  console.log('instalado   :', engine.isInstalled());
  console.log('NVIDIA      :', engine.hasNvidiaGpu());
  console.log('tier previo :', engine.guessTier());

  if (!engine.isInstalled()) fail('no whisper-server found for this platform');
  if (!engine.hasModel('base')) fail('the base model is missing');
  if (!fs.existsSync(WAV_10S)) fail('the 10 s test wav is missing');

  const wav = fs.readFileSync(WAV_10S);
  console.log(`\ntest window: ${(wav.length / 32000).toFixed(1)} s of audio\n`);

  const t0 = Date.now();
  await engine.start('base');
  console.log(`server ready in ${Date.now() - t0} ms (model loaded once)`);

  const times = [];
  let text = '';
  for (let i = 0; i < 5; i++) {
    const t = Date.now();
    const res = await engine.transcribeWav(wav, { language: 'en' });
    times.push(Date.now() - t);
    text = (res.text || (res.segments || []).map(s => s.text).join(' ') || '').trim();
  }
  times.sort((a, b) => a - b);
  const median = times[2];

  console.log(`pasadas     : ${times.join(', ')} ms`);
  console.log(`median      : ${median} ms per 10 s window`);
  console.log(`tier medido : ${engine.tierFromBenchmark(median)}`);
  console.log(`texto       : ${text.slice(0, 90)}`);

  const cfg = engine.tierConfig(engine.tierFromBenchmark(median));
  console.log(`\nconfig      : live=${cfg.live} model=${cfg.liveModel} cadence=${cfg.cadenceMs}ms window=${cfg.windowSec}s`);
  console.log(`headroom    : one pass uses ${cfg.cadenceMs ? Math.round(median / cfg.cadenceMs * 100) : 0}% of its cadence`);

  await engine.stop();
  console.log('\nservidor detenido — PASS');
})().catch(e => fail(e.message));
