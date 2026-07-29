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

  if (!engine.isInstalled()) fail('no encuentro whisper-server para esta plataforma');
  if (!engine.hasModel('base')) fail('falta el modelo base');
  if (!fs.existsSync(WAV_10S)) fail('falta el wav de prueba de 10 s');

  const wav = fs.readFileSync(WAV_10S);
  console.log(`\nventana de prueba: ${(wav.length / 32000).toFixed(1)} s de audio\n`);

  const t0 = Date.now();
  await engine.start('base');
  console.log(`servidor listo en ${Date.now() - t0} ms (modelo cargado una vez)`);

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
  console.log(`mediana     : ${median} ms por ventana de 10 s`);
  console.log(`tier medido : ${engine.tierFromBenchmark(median)}`);
  console.log(`texto       : ${text.slice(0, 90)}`);

  const cfg = engine.tierConfig(engine.tierFromBenchmark(median));
  console.log(`\nconfig      : vivo=${cfg.live} modelo=${cfg.liveModel} cadencia=${cfg.cadenceMs}ms ventana=${cfg.windowSec}s`);
  console.log(`headroom    : una pasada usa el ${cfg.cadenceMs ? Math.round(median / cfg.cadenceMs * 100) : 0}% de su cadencia`);

  await engine.stop();
  console.log('\nservidor detenido — PASS');
})().catch(e => fail(e.message));
