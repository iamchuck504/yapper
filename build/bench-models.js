// What each model actually costs per streaming pass on this machine.
// The tier table should promise only what the numbers support.
const fs = require('fs');
const path = require('path');
const engine = require('../engine');

const WAV = path.join(process.env.TEMP, 'yapper-10s.wav');

(async () => {
  const wav = fs.readFileSync(WAV);
  console.log('binarios:', path.basename(engine.binDir()), '\n');
  console.log('modelo    pasada (mediana)   cabe en 700ms   cabe en 2500ms');

  for (const model of ['base', 'small', 'medium']) {
    if (!engine.hasModel(model)) { console.log(`${model.padEnd(9)} (no descargado)`); continue; }
    await engine.start(model);
    const times = [];
    for (let i = 0; i < 5; i++) {
      const t = Date.now();
      await engine.transcribeWav(wav, { language: 'en' });
      times.push(Date.now() - t);
    }
    await engine.stop();
    times.sort((a, b) => a - b);
    const m = times[2];
    // a pass may use at most half the cadence, or the buffer grows
    const fits = c => (m <= c / 2 ? `sí (${Math.round(m / c * 100)}%)` : `NO (${Math.round(m / c * 100)}%)`);
    console.log(`${model.padEnd(9)} ${String(m).padStart(6)} ms          ${fits(700).padEnd(14)}  ${fits(2500)}`);
  }
})().catch(e => { console.log('FAIL', e.message); process.exit(1); });
