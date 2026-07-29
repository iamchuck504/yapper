// Section timestamps went missing on the Minutes style, which is the one whose
// every section description starts with "Bullet points of…". Instructions
// compete for attention, so this runs the styles most likely to drown the
// timestamp rule several times and checks it survives.
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const REAL_MEETINGS = path.join(process.env.USERPROFILE, 'Documents', 'Meetings');
const BASE = path.join(app.getPath('temp'), 'yapper-stamps-test');
let ROOT = BASE;
try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { ROOT = `${BASE}-${process.pid}`; }
fs.mkdirSync(path.join(ROOT, 'Meetings'), { recursive: true });
app.setPath('documents', ROOT);
app.setPath('userData', path.join(ROOT, 'user'));

const LOG = path.join(ROOT, 'progress.log');
function say(line) {
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch { /* nothing to do */ }
}
console.log(`progreso en vivo: ${LOG}`);

function pickTranscript() {
  const found = [];
  for (const d of fs.readdirSync(REAL_MEETINGS)) {
    const p = path.join(REAL_MEETINGS, d, 'transcript.txt');
    if (fs.existsSync(p)) found.push({ p, size: fs.statSync(p).size });
  }
  found.sort((a, b) => a.size - b.size);
  return found.find(f => f.size > 8000) || found[found.length - 1];
}

const src = pickTranscript();
const folder = path.join(ROOT, 'Meetings', '2026-07-29_1500');
fs.mkdirSync(folder);
fs.copyFileSync(src.p, path.join(folder, 'transcript.txt'));

const STYLES = (process.env.STYLES || 'minutes,memo,general').split(',');
const ROUNDS = Number(process.env.ROUNDS || 2);

let fails = 0;
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
  await new Promise(r => setTimeout(r, 800));
  const $ = js => win.webContents.executeJavaScript(js);

  say(`${STYLES.join(', ')} × ${ROUNDS} rondas\n`);

  for (const style of STYLES) {
    for (let round = 1; round <= ROUNDS; round++) {
      const md = await $(`window.yapper.regenerate(${JSON.stringify(folder)}, `
        + `{ style: ${JSON.stringify(style)}, detail: 'concise', custom: '', participants: '' })`);
      const heads = [...md.matchAll(/^##\s+(.+)$/gm)].map(m => m[1].trim());
      const stamped = heads.filter(h => /\[\d+:\d+(:\d+)?\]$/.test(h));
      const bare = heads.filter(h => !/\[\d+:\d+(:\d+)?\]$/.test(h));
      const ok = heads.length > 0 && bare.length === 0;
      if (!ok) fails++;
      say(`  ${ok ? 'ok  ' : 'FAIL'} ${style} ronda ${round}: ${stamped.length}/${heads.length} con marca`
        + (bare.length ? `\n       sin marca: ${bare.join(' | ')}` : ''));
    }
  }

  say(fails ? `\n${fails} fallos` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(e => { console.log('FAIL', e.stack || e.message); app.exit(1); });
