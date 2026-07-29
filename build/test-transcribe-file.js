// End to end on a real recording: the final pass has to produce timestamped
// lines, report progress, and leave the server clean behind it.
const fs = require('fs');
const path = require('path');
const engine = require('../engine');

const MEETINGS = path.join(process.env.USERPROFILE, 'Documents', 'Meetings');

function pick() {
  if (process.env.WAV) return process.env.WAV;
  const dirs = fs.readdirSync(MEETINGS).sort().reverse();
  for (const d of dirs) {
    const w = path.join(MEETINGS, d, 'recording.wav');
    if (fs.existsSync(w) && fs.statSync(w).size > engine.WAV_HEADER + engine.BYTES_PER_SEC * 20) return w;
  }
  return null;
}

(async () => {
  const wav = pick();
  if (!wav) { console.log('FAIL  no hay grabación .wav para probar'); process.exit(1); }
  const secs = (fs.statSync(wav).size - engine.WAV_HEADER) / engine.BYTES_PER_SEC;
  console.log(`archivo : ${wav}`);
  console.log(`duración: ${(secs / 60).toFixed(1)} min\n`);

  const tier = engine.tierConfig(engine.guessTier());
  const seen = [];
  const t0 = Date.now();
  const lines = await engine.transcribeFile(wav, {
    model: tier.finalModel,
    language: 'en',
    prompt: 'The people in this conversation are: Ninfa, Chuck.',
    onProgress: p => seen.push(Math.round(p.done / p.total * 100))
  });
  await engine.stop();
  const took = (Date.now() - t0) / 1000;

  console.log(`modelo  : ${tier.finalModel}`);
  console.log(`tardó   : ${took.toFixed(1)} s  (${(secs / took).toFixed(1)}x tiempo real)`);
  console.log(`líneas  : ${lines.length}`);
  console.log(`progreso: ${seen.join('% ')}%`);
  console.log(`\n${lines.slice(0, 6).join('\n')}\n...\n${lines.slice(-2).join('\n')}`);

  if (!lines.length) { console.log('\nFAIL  no salió ninguna línea'); process.exit(1); }
  if (!/^\[\d\d:\d\d:\d\d\] ./.test(lines[0])) { console.log('\nFAIL  formato de marca de tiempo inesperado'); process.exit(1); }
  if (seen[seen.length - 1] !== 100) { console.log('\nFAIL  el progreso no llegó a 100%'); process.exit(1); }
  console.log('\nPASS');
})().catch(e => { console.log('FAIL', e.message); process.exit(1); });
