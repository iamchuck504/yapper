// The transcript export has to survive Markdown: a verbatim record that gets
// half-eaten by asterisks and underscores is not a record. Drives the real
// export menu with a stubbed save dialog and inspects what lands on disk.
const path = require('path');
const fs = require('fs');
const { app, dialog } = require('electron');
const { mainWindow } = require('./harness');

const ROOT = path.join(app.getPath('temp'), 'yapper-export-test');
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, 'Meetings'), { recursive: true });
app.setPath('documents', ROOT);
app.setPath('userData', path.join(ROOT, 'user'));

const folder = path.join(ROOT, 'Meetings', '2026-07-29_1400');
fs.mkdirSync(folder);
fs.writeFileSync(path.join(folder, 'title.txt'), 'Launch Sync', 'utf8');
fs.writeFileSync(path.join(folder, 'notes.md'), '## Summary [00:00]\nIt went fine.', 'utf8');
// deliberately awkward: markdown characters, an hour boundary, and a long gap
fs.writeFileSync(path.join(folder, 'transcript.txt'), [
  '[00:00:01] We should ship the *beta* on Friday.',
  '[00:00:07] The file is called report_final_v2.md',
  '[00:00:12] Use the [brackets] carefully.',
  '[00:02:30] Anyway, moving on to the budget.',
  '[01:05:00] And that is everything.'
].join('\n'), 'utf8');

let fails = 0;
function check(name, ok, detail) {
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      ${detail}`); }
}

const saved = path.join(ROOT, 'out.md');
dialog.showSaveDialog = async () => ({ canceled: false, filePath: saved });

require('../main.js');

app.whenReady().then(async () => {
  const win = await mainWindow();
  const $ = js => win.webContents.executeJavaScript(js);

  // the menu has to offer it in the first place
  const kinds = await $(`[...document.querySelectorAll('#export-menu button')].map(b => b.dataset.export)`);
  check('the menu offers the transcript as Markdown', kinds.includes('transcript-md'), kinds.join(', '));

  await $(`(async () => {
    currentFolder = ${JSON.stringify(folder)};
    const d = await window.yapper.loadMeeting(currentFolder);
    openMeetingView(d.title, d.summary, d.transcript, d.hasRecording, d.participants);
  })()`);
  await new Promise(r => setTimeout(r, 400));

  await $(`runExport('transcript-md')`);
  await new Promise(r => setTimeout(r, 400));

  check('wrote the file', fs.existsSync(saved), 'is missing');
  if (!fs.existsSync(saved)) { console.log('\n1 fallos'); return app.exit(1); }
  const md = fs.readFileSync(saved, 'utf8');
  console.log('\n' + md + '---\n');

  check('carries the meeting title', md.startsWith('# Launch Sync'), md.slice(0, 40));
  check('has a transcript heading', /^## Full transcript$/m.test(md), 'falta');
  check('the timestamps are bold', /\*\*\[00:01\]\*\*/.test(md), 'could not find them');
  check('under an hour it omits the hours field', /\*\*\[02:30\]\*\*/.test(md), 'did not omit it');
  check('past the hour mark it is included', /\*\*\[01:05:00\]\*\*/.test(md), 'did not include it');

  // the verbatim part: markdown must not eat the words
  check('escapes the asterisks', md.includes('\\*beta\\*'), 'swallowed the emphasis');
  check('escapes the underscores', md.includes('report\\_final\\_v2'), 'swallowed the underscore');
  check('escapes the brackets', md.includes('\\[brackets\\]'), 'swallowed the brackets');

  // a long silence should read as a new paragraph, a short one as a new line
  const body = md.split('## Full transcript')[1];
  check('a long silence starts a paragraph',
    /\n\n\*\*\[02:30\]\*\*/.test(body) && /\n\n\*\*\[01:05:00\]\*\*/.test(body), body);
  check('consecutive lines stay in the same paragraph',
    /\*\*\[00:01\]\*\*.*  \n\*\*\[00:07\]\*\*/.test(body), 'split them too eagerly');

  console.log(fails ? `\n${fails} failures` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(e => { console.log('FAIL', e.stack || e.message); app.exit(1); });
