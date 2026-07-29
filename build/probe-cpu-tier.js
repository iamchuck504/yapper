// Anchors the low end of the tier table: what does the calibration sample cost
// on this same machine with no GPU at all? Every laptop a coworker owns lives
// somewhere between that number and the GPU one.
const fs = require('fs');
const path = require('path');
const os = require('os');

// engine.binDir() prefers the -gpu folder; hide it for this run
const GPU = path.join(__dirname, '..', 'bin', 'win-x64-gpu');
const HIDDEN = GPU + '-off';

fs.renameSync(GPU, HIDDEN);
process.on('exit', () => { try { fs.renameSync(HIDDEN, GPU); } catch { /* already back */ } });

const engine = require('../engine');

(async () => {
  console.log('binarios :', path.basename(engine.binDir()));
  console.log('CPU      :', os.cpus()[0].model.trim(), `(${os.cpus().length} hilos)`);
  const res = await engine.calibrate({ passes: 3 });
  console.log('\nmedido   :', res.msPerPass, 'ms por pasada  ->', res.tier);
})().catch(e => { console.log('FAIL', e.message); process.exit(1); });
