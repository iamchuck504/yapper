// Does the Memo style actually produce a memo? Runs a real transcript through
// the real prompt and the configured provider, then checks the shape: the
// sections it promised, prose instead of bullets where it matters.
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { mainWindow } = require('./harness');

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
if (!src) { console.log('FAIL  there is no real transcript to test with'); app.exit(1); }
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
  const win = await mainWindow();

  console.log(`transcript: ${src.p} (${(src.size / 1024).toFixed(0)} KB)\ngenerating…\n`);
  const t0 = Date.now();
  const md = await win.webContents.executeJavaScript(
    `window.yapper.regenerate(${JSON.stringify(folder)}, `
    + `{ style: 'memo', detail: 'concise', custom: '', participants: '' })`);
  console.log(`took ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
  console.log(md.slice(0, 1400));
  console.log('\n---\n');

  const heads = [...md.matchAll(/^##\s+(.+)$/gm)].map(m => m[1].replace(/\s*\[[\d:]+\]\s*$/, '').trim());
  check('returned markdown with sections', heads.length >= 3, heads.join(' | '));
  check('starts with Overview', /overview/i.test(heads[0] || ''), heads.join(' | '));
  check('carries Decisions', heads.some(h => /decision/i.test(h)), heads.join(' | '));
  check('carries Next steps', heads.some(h => /next step/i.test(h)), heads.join(' | '));
  check('does not use the General style sections',
    !heads.some(h => /key point/i.test(h)), heads.join(' | '));

  // a memo is prose: the Discussion section must not be a bullet list
  const disc = (md.split(/^##\s+/m).find(s => /^discussion/i.test(s)) || '');
  const bullets = (disc.match(/^\s*[-*]\s+/gm) || []).length;
  check('the Discussion section is prose, not bullets', bullets === 0, `${bullets} bullets`);
  check('the Discussion section has content', disc.trim().length > 200, `${disc.trim().length} caracteres`);

  check('the sections carry a timestamp',
    /^##\s+.+\[\d+:\d+\]\s*$/m.test(md), 'none of them carries one');

  console.log(fails ? `\n${fails} fallos` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(e => { console.log('FAIL', e.stack || e.message); app.exit(1); });
