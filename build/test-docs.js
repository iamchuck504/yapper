// Architecture docs go stale silently, and a stale one is worse than none —
// somebody reviews a structure that no longer exists. The numbers and claims in
// ARCHITECTURE.md that can be checked against the code, are.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const doc = fs.readFileSync(path.join(root, 'ARCHITECTURE.md'), 'utf8');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const lines = f => read(f).split('\n').length;

let fails = 0;
function check(name, ok, detail) {
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      ${detail}`); }
}

// --- the line counts in the module tables ---
const claimed = [...doc.matchAll(/\|\s*`?([\w./+ -]+?\.(?:js|css|html))`?[^|]*\|\s*(\d+)\s*\|/g)]
  .map(m => ({ file: m[1].trim(), n: Number(m[2]) }));
check('the document quotes line counts', claimed.length >= 8, `${claimed.length} encontrados`);

for (const c of claimed) {
  if (!fs.existsSync(path.join(root, c.file))) {
    check(`existe ${c.file}`, false, 'the document names a file that is missing');
    continue;
  }
  const real = lines(c.file);
  // A few lines of drift is fine. Tight enough to notice a rewrite, loose
  // enough not to fail on every edit. Count the same way the doc does — with
  // node, since PowerShell's Measure-Object disagrees and that mismatch is what
  // made these numbers wrong in the first place.
  const off = Math.abs(real - c.n) / Math.max(real, c.n);
  check(`${c.file}: ${c.n} lines`, off < 0.08, `the file has ${real}`);
}

// --- the IPC channel count ---
const pre = read('preload.js');
const count = re => (pre.match(re) || []).length;
const invoke = count(/(?:^|[^.\w])invoke\('/g);
const send = count(/ipcRenderer\.send(?:Sync)?\('/g);
const on = count(/ipcRenderer\.on\('/g);
const total = invoke + send + on;

const stated = Number((doc.match(/(\d+) channels, all declared in/) || [])[1]);
check(`the channel total (${total}) matches the document`, stated === total, `says ${stated}`);
for (const [label, real, re] of [
  ['Request/response', invoke, /\*\*Request\/response \((\d+)\)\*\*/],
  ['Fire-and-forget', send, /\*\*Fire-and-forget \((\d+)\)\*\*/],
  ['Main → renderer', on, /\*\*Main → renderer \((\d+)\)\*\*/]
]) {
  const said = Number((doc.match(re) || [])[1]);
  check(`${label}: ${real}`, said === real, `the document says ${said}`);
}
check('the channel list in the document matches the bridge',
  total === Number(stated) && /open-external/.test(doc), 'a new channel is missing');

// --- the providers ---
const llm = require('../llm');
const ids = llm.providerList().map(p => p.id);
for (const id of ids) {
  check(`the document describes the provider "${id}"`, doc.includes(`\`${id}\``), 'no aparece');
}
// only the provider table, or the tier table below it gets caught up in this
const providerTable = doc.slice(doc.indexOf('## 6.'), doc.indexOf('## 7.'));
const rows = [...providerTable.matchAll(/^\| `([\w-]+)` \| /gm)].map(m => m[1]);
check('the document lists one row per provider', rows.length === ids.length,
  `document: ${rows.join(', ')}\n      code: ${ids.join(', ')}`);
const extra = rows.filter(r => !ids.includes(r));
check('does not describe providers that no longer exist', extra.length === 0, extra.join(', '));

// --- the tiers ---
const engine = require('../engine');
for (const tier of Object.keys(engine.TIERS)) {
  check(`the document describes the "${tier}" tier`, doc.includes(`\`${tier}\``), 'no aparece');
}
const fast = engine.tierConfig('fast');
check('the fast tier cadence agrees',
  doc.includes(`every ${fast.cadenceMs / 1000} s`), `the code says ${fast.cadenceMs} ms`);
const balanced = engine.tierConfig('balanced');
check('the balanced tier cadence agrees',
  doc.includes(`every ${balanced.cadenceMs / 1000} s`), `the code says ${balanced.cadenceMs} ms`);
check('balanced is fast at a sustainable pace, not a different promise',
  balanced.liveModel === fast.liveModel && balanced.finalModel === fast.finalModel
  && balanced.windowSec === fast.windowSec && balanced.cadenceMs > fast.cadenceMs,
  'the two tiers drifted apart');
check('what the document says about medium matches the code',
  /`small` is used everywhere/.test(doc)
  && !Object.values(engine.TIERS).some(t => t.liveModel === 'medium' || t.finalModel === 'medium'),
  'the document and the tier table disagree');
check('the document describes the repetition cleanup',
  /Stutters are removed/.test(doc) && typeof engine.deduplicate === 'function',
  'missing from the document or the code');
check('the document describes the audio policy',
  /## 9b\./.test(doc) && /audio.s job ends with the transcript/i.test(doc),
  'the audio section is missing');

// --- the security claims ---
const main = read('main.js');
const windows = (main.match(/new BrowserWindow\(/g) || []).length;
check('contextIsolation is on in every window',
  (main.match(/contextIsolation: true/g) || []).length === windows, `not in all ${windows}`);
check('nodeIntegration is off in all of them',
  (main.match(/nodeIntegration: false/g) || []).length === windows, `not in all ${windows}`);
check('the Chromium sandbox is on in every window',
  (main.match(/sandbox: true/g) || []).length === windows, `not in all ${windows}`);
for (const page of ['index.html', 'bubble.html', 'splash.html']) {
  check(`${page} declares a CSP`,
    /Content-Security-Policy/.test(read(path.join('renderer', page))), 'does not carry it');
}
// The dependency footprint is a documented claim (§10): exactly electron and
// electron-builder to develop, exactly electron-updater at runtime. Anything
// new showing up here has to be argued for in ARCHITECTURE.md first.
const pkg = JSON.parse(read('package.json'));
check('the devDependencies are still the documented build tools',
  JSON.stringify(Object.keys(pkg.devDependencies).sort()) === '["@electron/asar","electron","electron-builder"]',
  JSON.stringify(Object.keys(pkg.devDependencies)));
check('the only runtime dependency is still electron-updater',
  JSON.stringify(Object.keys(pkg.dependencies || {})) === '["electron-updater"]',
  JSON.stringify(Object.keys(pkg.dependencies || {})));

// --- the files the docs point a reviewer at ---
for (const f of ['preload.js', 'engine.js', 'live.js', 'main.js', 'llm.js',
  'keystore.js', 'bounds.js', 'setup.ps1', 'build/calibration.wav', 'README.md']) {
  check(`existe ${f}`, fs.existsSync(path.join(root, f)), 'the document names it and it is not there');
}
check('the README links to the architecture', /ARCHITECTURE\.md/.test(read('README.md')), 'no link');
check('the Windows sanity runner exists',
  fs.existsSync(path.join(root, 'build', 'test-windows-sanity.ps1')), 'is missing');
check('package scripts expose both Windows sanity levels',
  pkg.scripts['test:windows'] && pkg.scripts['test:windows:package'],
  JSON.stringify(pkg.scripts));

// --- every test the docs list, exists ---
const named = [...doc.matchAll(/`((?:test-|icon-)[\w-]+\.js)`/g)].map(m => m[1]);
check('the document names tests', named.length >= 10, `${named.length}`);
for (const t of [...new Set(named)]) {
  check(`existe build/${t}`, fs.existsSync(path.join(root, 'build', t)), 'is missing');
}

console.log(fails ? `\n${fails} failures` : '\nPASS');
process.exit(fails ? 1 : 0);
