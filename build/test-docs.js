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
check('el documento cita conteos de líneas', claimed.length >= 8, `${claimed.length} encontrados`);

for (const c of claimed) {
  if (!fs.existsSync(path.join(root, c.file))) {
    check(`existe ${c.file}`, false, 'el documento nombra un archivo que no está');
    continue;
  }
  const real = lines(c.file);
  // A few lines of drift is fine. Tight enough to notice a rewrite, loose
  // enough not to fail on every edit. Count the same way the doc does — with
  // node, since PowerShell's Measure-Object disagrees and that mismatch is what
  // made these numbers wrong in the first place.
  const off = Math.abs(real - c.n) / Math.max(real, c.n);
  check(`${c.file}: ${c.n} líneas`, off < 0.08, `el archivo tiene ${real}`);
}

// --- the IPC channel count ---
const pre = read('preload.js');
const count = re => (pre.match(re) || []).length;
const invoke = count(/(?:^|[^.\w])invoke\('/g);
const send = count(/ipcRenderer\.send(?:Sync)?\('/g);
const on = count(/ipcRenderer\.on\('/g);
const total = invoke + send + on;

const stated = Number((doc.match(/(\d+) channels, all declared in/) || [])[1]);
check(`el total de canales (${total}) coincide con el documento`, stated === total, `dice ${stated}`);
for (const [label, real, re] of [
  ['Request/response', invoke, /\*\*Request\/response \((\d+)\)\*\*/],
  ['Fire-and-forget', send, /\*\*Fire-and-forget \((\d+)\)\*\*/],
  ['Main → renderer', on, /\*\*Main → renderer \((\d+)\)\*\*/]
]) {
  const said = Number((doc.match(re) || [])[1]);
  check(`${label}: ${real}`, said === real, `el documento dice ${said}`);
}
check('la lista de canales del documento coincide con el puente',
  total === Number(stated) && /open-external/.test(doc), 'falta algún canal nuevo');

// --- the providers ---
const llm = require('../llm');
const ids = llm.providerList().map(p => p.id);
for (const id of ids) {
  check(`el documento describe el proveedor "${id}"`, doc.includes(`\`${id}\``), 'no aparece');
}
// only the provider table, or the tier table below it gets caught up in this
const providerTable = doc.slice(doc.indexOf('## 6.'), doc.indexOf('## 7.'));
const rows = [...providerTable.matchAll(/^\| `([\w-]+)` \| /gm)].map(m => m[1]);
check('el documento lista una fila por proveedor', rows.length === ids.length,
  `documento: ${rows.join(', ')}\n      código: ${ids.join(', ')}`);
const extra = rows.filter(r => !ids.includes(r));
check('no describe proveedores que ya no existen', extra.length === 0, extra.join(', '));

// --- the tiers ---
const engine = require('../engine');
for (const tier of Object.keys(engine.TIERS)) {
  check(`el documento describe el nivel "${tier}"`, doc.includes(`\`${tier}\``), 'no aparece');
}
const fast = engine.tierConfig('fast');
check('la cadencia del nivel fast concuerda',
  doc.includes(`every ${fast.cadenceMs / 1000} s`), `el código dice ${fast.cadenceMs} ms`);
check('lo que el documento dice de medium coincide con el código',
  /`small` is used everywhere/.test(doc)
  && !Object.values(engine.TIERS).some(t => t.liveModel === 'medium' || t.finalModel === 'medium'),
  'el documento y la tabla de niveles no dicen lo mismo');
check('el documento describe la limpieza de repeticiones',
  /Stutters are removed/.test(doc) && typeof engine.deduplicate === 'function',
  'falta en el documento o en el código');
check('el documento describe la política del audio',
  /## 9b\./.test(doc) && /audio.s job ends with the transcript/i.test(doc),
  'falta la sección del audio');

// --- the security claims ---
const main = read('main.js');
check('contextIsolation está en todas las ventanas',
  (main.match(/contextIsolation: true/g) || []).length === 3, 'no en las tres');
check('nodeIntegration está apagado en todas',
  (main.match(/nodeIntegration: false/g) || []).length === 3, 'no en las tres');
for (const page of ['index.html', 'bubble.html', 'splash.html']) {
  check(`${page} declara una CSP`,
    /Content-Security-Policy/.test(read(path.join('renderer', page))), 'no la trae');
}
// The dependency footprint is a documented claim (§10): exactly electron and
// electron-builder to develop, exactly electron-updater at runtime. Anything
// new showing up here has to be argued for in ARCHITECTURE.md first.
const pkg = JSON.parse(read('package.json'));
check('las devDependencies siguen siendo exactamente electron y electron-builder',
  JSON.stringify(Object.keys(pkg.devDependencies).sort()) === '["electron","electron-builder"]',
  JSON.stringify(Object.keys(pkg.devDependencies)));
check('la única dependencia de ejecución sigue siendo electron-updater',
  JSON.stringify(Object.keys(pkg.dependencies || {})) === '["electron-updater"]',
  JSON.stringify(Object.keys(pkg.dependencies || {})));

// --- the files the docs point a reviewer at ---
for (const f of ['preload.js', 'engine.js', 'live.js', 'main.js', 'llm.js',
  'keystore.js', 'bounds.js', 'setup.ps1', 'build/calibration.wav', 'README.md']) {
  check(`existe ${f}`, fs.existsSync(path.join(root, f)), 'el documento lo nombra y no está');
}
check('el README enlaza la arquitectura', /ARCHITECTURE\.md/.test(read('README.md')), 'sin enlace');

// --- every test the docs list, exists ---
const named = [...doc.matchAll(/`((?:test-|icon-)[\w-]+\.js)`/g)].map(m => m[1]);
check('el documento nombra pruebas', named.length >= 10, `${named.length}`);
for (const t of [...new Set(named)]) {
  check(`existe build/${t}`, fs.existsSync(path.join(root, 'build', t)), 'no está');
}

console.log(fails ? `\n${fails} fallos` : '\nPASS');
process.exit(fails ? 1 : 0);
