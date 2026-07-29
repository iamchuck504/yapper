// Does the Memo style actually produce a memo? Runs a real transcript through
// the real prompt and the configured provider, then checks the shape: the
// sections it promised, prose instead of bullets where it matters.
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const REAL_MEETINGS = path.join(process.env.USERPROFILE, 'Documents', 'Meetings');
const ROOT = path.join(app.getPath('temp'), 'yapper-memo-test');
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, 'Meetings'), { recursive: true });
app.setPath('documents', ROOT);
app.setPath('userData', path.join(ROOT, 'user'));

// borrow the longest transcript on this machine; nothing is written back to it
function pickTranscript() {
  let best = null;
  for (const d of fs.readdirSync(REAL_MEETINGS)) {
    const p = path.join(REAL_MEETINGS, d, 'transcript.txt');
    if (!fs.existsSync(p)) continue;
    const size = fs.statSync(p).size;
    if (!best || size > best.size) best = { p, size };
  }
  return best;
}

const src = pickTranscript();
if (!src) { console.log('FAIL  no hay ninguna transcripción real para probar'); app.exit(1); }
const folder = path.join(ROOT, 'Meetings', '2026-07-29_1200');
fs.mkdirSync(folder);
fs.copyFileSync(src.p, path.join(folder, 'transcript.txt'));

let fails = 0;
function check(name, ok, detail) {
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      ${detail}`); }
}

require('../main.js');

app.whenReady().then(async () => {
  const { BrowserWindow } = require('electron');
  const win = await new Promise(resolve => {
    const tick = setInterval(() => {
      const w = BrowserWindow.getAllWindows().find(x => x.webContents.getURL().includes('index.html'));
      if (w) { clearInterval(tick); resolve(w); }
    }, 200);
  });
  await new Promise(r => win.webContents.once('did-finish-load', r));
  await new Promise(r => setTimeout(r, 1000));

  console.log(`transcripción: ${src.p} (${(src.size / 1024).toFixed(0)} KB)\ngenerando…\n`);
  const t0 = Date.now();
  const md = await win.webContents.executeJavaScript(
    `window.yapper.regenerate(${JSON.stringify(folder)}, `
    + `{ style: 'memo', detail: 'concise', custom: '', participants: '' })`);
  console.log(`tardó ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
  console.log(md.slice(0, 1400));
  console.log('\n---\n');

  const heads = [...md.matchAll(/^##\s+(.+)$/gm)].map(m => m[1].replace(/\s*\[[\d:]+\]\s*$/, '').trim());
  check('devolvió markdown con secciones', heads.length >= 3, heads.join(' | '));
  check('empieza por Overview', /overview/i.test(heads[0] || ''), heads.join(' | '));
  check('trae Decisions', heads.some(h => /decision/i.test(h)), heads.join(' | '));
  check('trae Next steps', heads.some(h => /next step/i.test(h)), heads.join(' | '));
  check('no usa las secciones del estilo General',
    !heads.some(h => /key point/i.test(h)), heads.join(' | '));

  // a memo is prose: the Discussion section must not be a bullet list
  const disc = (md.split(/^##\s+/m).find(s => /^discussion/i.test(s)) || '');
  const bullets = (disc.match(/^\s*[-*]\s+/gm) || []).length;
  check('la sección Discussion es prosa, no viñetas', bullets === 0, `${bullets} viñetas`);
  check('la sección Discussion tiene contenido', disc.trim().length > 200, `${disc.trim().length} caracteres`);

  check('las secciones llevan marca de tiempo',
    /^##\s+.+\[\d+:\d+\]\s*$/m.test(md), 'ninguna la trae');

  console.log(fails ? `\n${fails} fallos` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(e => { console.log('FAIL', e.stack || e.message); app.exit(1); });
