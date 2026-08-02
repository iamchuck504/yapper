// Is "zero words lost" even a sound assertion on this backend?
//
// The mac characterised whisper-server's nondeterminism on Metal: 18 rounds,
// zero words lost, at most one duplicated at a seam. test-progressive asserts
// that. On Windows the engine runs the CUDA build, and the first Windows run
// lost 11 words — so before blaming the head start, measure the control: how
// much do two IDENTICAL full passes differ from each other here?
const fs = require('fs');
const path = require('path');
const os = require('os');
const engine = require('../engine');

const SRC = path.join(os.tmpdir(), 'yapper-60s.wav');
const opts = { model: 'base', language: 'en', windowSec: 10, overlapSec: 2 };

const words = a => a.map(l => l.replace(/^\[[^\]]+\]\s*/, '')).join(' ')
  .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
const bag = ws => ws.reduce((m, w) => (m[w] = (m[w] || 0) + 1, m), {});
function diff(a, b) {
  const A = bag(words(a)), B = bag(words(b));
  let lost = 0, extra = 0;
  for (const w of new Set([...Object.keys(A), ...Object.keys(B)])) {
    const d = (B[w] || 0) - (A[w] || 0);
    if (d < 0) lost += -d; else extra += d;
  }
  return { lost, extra };
}

(async () => {
  console.log(`backend: ${path.basename(engine.binDir())}`);
  const passes = [];
  for (let i = 0; i < 4; i++) {
    const t = Date.now();
    passes.push(await engine.transcribeFile(SRC, opts));
    console.log(`pass ${i + 1}: ${passes[i].length} lines, ${words(passes[i]).length} words, ${((Date.now() - t) / 1000).toFixed(1)}s`);
  }
  console.log('\npares de pasadas completas idénticas:');
  for (let i = 0; i < passes.length; i++) {
    for (let j = i + 1; j < passes.length; j++) {
      const d = diff(passes[i], passes[j]);
      console.log(`  ${i + 1} vs ${j + 1}: ${d.lost} perdidas, ${d.extra} extra`);
    }
  }
  await engine.stop().catch(() => { });
  process.exit(0);
})();
