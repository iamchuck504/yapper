// Sanity check on the note styles: picking "Stand-up" has to produce a
// stand-up, not the General sections with a different label. Every style is run
// against the same real transcript and its output compared with the sections it
// promised, including the colour each heading gets in the UI.
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { mainWindow } = require('./harness');

const REAL_MEETINGS = path.join(process.env.USERPROFILE, 'Documents', 'Meetings');

// A previous run that was killed keeps a lock on its Chromium cache, and then
// wiping the folder throws EPERM *during app load* — before anything is
// printed, which looks exactly like a hang. So failure to clean is survivable:
// fall back to a folder of our own.
const BASE = path.join(app.getPath('temp'), 'yapper-styles-test');
let ROOT = BASE;
try {
  fs.rmSync(BASE, { recursive: true, force: true });
} catch {
  ROOT = `${BASE}-${process.pid}`;
}
fs.mkdirSync(path.join(ROOT, 'Meetings'), { recursive: true });
app.setPath('documents', ROOT);
app.setPath('userData', path.join(ROOT, 'user'));

// a mid-sized transcript: long enough to have real content, short enough to
// run every style in one go
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
const folder = path.join(ROOT, 'Meetings', '2026-07-29_1300');
fs.mkdirSync(folder);
fs.copyFileSync(src.p, path.join(folder, 'transcript.txt'));

// Electron on Windows buffers stdout until it exits, and this test runs seven
// model calls, so progress also goes straight to a file: a run that stalls has
// to be diagnosable while it is still stalling.
const LOG = path.join(ROOT, 'progress.log');
function say(line) {
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch { /* nothing to be done */ }
}
console.log(`live progress: ${LOG}`);

let fails = 0;
function check(name, ok, detail) {
  if (ok) say(`  ok   ${name}`);
  else { fails++; say(`  FAIL ${name}\n       ${detail}`); }
}

require('../main.js');

app.whenReady().then(async () => {
  const win = await mainWindow();
  const $ = js => win.webContents.executeJavaScript(js);

  // the styles the UI offers, and what each one asks the model for
  const styles = await $(`[...document.querySelectorAll('#style-pills .seg-btn')].map(b => b.dataset.style)`);
  const promised = await $(`window.yapper.styleSections()`);

  say(`transcript: ${path.basename(path.dirname(src.p))} (${(src.size / 1024).toFixed(0)} KB)`);
  say(`styles in the UI: ${styles.join(', ')}\n`);

  check('every UI style has defined sections',
    styles.every(s => promised[s]), styles.filter(s => !promised[s]).join(', '));
  check('there are no sections defined for styles the UI does not offer',
    Object.keys(promised).every(s => styles.includes(s)),
    Object.keys(promised).filter(s => !styles.includes(s)).join(', '));

  const norm = s => s.toLowerCase().replace(/[^a-z]/g, '');

  for (const style of styles) {
    if (!promised[style]) continue;
    const want = [...promised[style].matchAll(/^##\s+(.+)$/gm)].map(m => m[1].trim());

    say(`\n=== ${style} ===`);
    const md = await $(`window.yapper.regenerate(${JSON.stringify(folder)}, `
      + `{ style: ${JSON.stringify(style)}, detail: 'concise', custom: '', participants: '' })`);
    const got = [...md.matchAll(/^##\s+(.+)$/gm)]
      .map(m => m[1].replace(/\s*\[[\d:]+\]\s*$/, '').trim());

    say(`  asked for : ${want.join(' | ')}`);
    say(`  obtuvo: ${got.join(' | ')}`);

    // sections may be omitted when the prompt says so, but nothing may be invented
    const extra = got.filter(g => !want.some(w => norm(w) === norm(g)));
    check(`${style}: invents no sections`, extra.length === 0, `sobran: ${extra.join(', ')}`);

    const missing = want.filter(w => !got.some(g => norm(g) === norm(w)));
    check(`${style}: carries at least half the sections`,
      got.length >= Math.ceil(want.length / 2), `missing ${missing.length} of ${want.length}: ${missing.join(', ')}`);

    check(`${style}: the first section is the one it asked for`,
      got[0] && norm(got[0]) === norm(want[0]), `esperaba "${want[0]}", vino "${got[0]}"`);

    check(`${style}: the sections carry a timestamp`,
      /^##\s+.+\[\d+:\d+\]\s*$/m.test(md), 'none of them carries one');

    // every heading must be one the UI recognises, not one that fell through
    const known = await $(`(${JSON.stringify(got)}).map(h => sectionMeta(h).matched)`);
    const unknown = got.filter((_, i) => !known[i]);
    check(`${style}: the UI recognises all of its sections`,
      unknown.length === 0, `no colour rule: ${unknown.join(', ')}`);
  }

  say(fails ? `\n${fails} fallos` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(e => { console.log('FAIL', e.stack || e.message); app.exit(1); });
