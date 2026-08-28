// Exports are real documents, not only files that exist. The transcript has to
// survive Markdown, and the PDF has to carry its identity while letting notes
// flow across pages instead of making every section an indivisible sheet.
// Drives the real export menu with a stubbed save dialog and inspects both the
// document HTML and what lands on disk.
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
fs.writeFileSync(path.join(folder, 'notes.md'), `## Summary [00:00]
The launch review covered readiness, customer communication, support coverage, and the final release decision. The team agreed that the remaining work is small enough to finish without moving the date.

## Key points [01:15]
- The release candidate completed the full regression suite.
- Support has the escalation guide and the customer-facing status language.
- Product analytics will watch activation and first-session completion.
- The rollback package was tested in staging and remains available.

## Decisions [08:40]
- Keep the planned release window.
- Use the staged rollout rather than opening access to every account at once.
- Review the first cohort before expanding the rollout.

## Action items [13:20]
- Maya: publish the final release notes before the rollout begins.
- Robert: confirm the support rotation and escalation channel.
- Nina: share the activation dashboard with the launch group.

## Risks [18:05]
- A late support handoff could slow the response to early customer questions.
- The team will pause expansion if activation falls below the agreed threshold.

## Next steps [22:10]
- Complete the named action items, begin the first cohort, and reconvene after the initial metrics are available.
`, 'utf8');
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
const savedPdf = path.join(ROOT, 'out.pdf');
dialog.showSaveDialog = async (_win, opts) => ({
  canceled: false,
  filePath: String(opts.defaultPath || '').endsWith('.pdf') ? savedPdf : saved
});

require('../main.js');

app.whenReady().then(async () => {
  const win = await mainWindow();
  const $ = js => win.webContents.executeJavaScript(js);

  // the menu has to offer it in the first place
  const kinds = await $(`[...document.querySelectorAll('#export-menu > [data-export]')].map(b => b.dataset.export)`);
  check('the menu offers the transcript as Markdown', kinds.includes('transcript-md'), kinds.join(', '));
  check('PDF style comes before the formats, with Notes as PDF first',
    await $(`document.querySelector('#export-menu > :first-child').classList.contains('menu-sub')`)
      && kinds[0] === 'pdf',
    kinds.join(', '));
  await $(`document.getElementById('btn-export').click();
    document.querySelector('[data-pdf-theme="light"]').click()`);
  check('choosing PDF style does not close or trigger an export',
    !(await $(`document.getElementById('export-menu').classList.contains('hidden')`)),
    'the menu closed before a format was chosen');

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

  // The exact HTML sent to Chromium is the pagination contract. A title/date
  // masthead should be visible, while only small reading units — not an entire
  // notes section — are kept together at a page boundary.
  const pdfHtml = await $(`buildPdfHtml('Launch Sync', 'dark')`);
  check('the PDF has a document header',
    /<header class="pdf-header">/.test(pdfHtml), pdfHtml.slice(0, 500));
  check('a dark PDF paints the complete page and content canvas',
    /@page \{[^}]*background: #0C0D10;/.test(pdfHtml)
      && /html, body \{ background: #0C0D10 !important; \}/.test(pdfHtml),
    'the complete page is not explicitly dark');
  check('the header carries Yapper Notes, the meeting title and date',
    /<span>Yapper Notes<\/span>/.test(pdfHtml)
      && /<h1 class="pdf-title">Launch Sync<\/h1>/.test(pdfHtml)
      && /<div class="pdf-date">29\/07\/2026 · 14:00<\/div>/.test(pdfHtml),
    pdfHtml.slice(0, 900));
  check('whole note sections may flow across pages',
    /\.note-sec\s*\{[^}]*break-inside:\s*auto;[^}]*page-break-inside:\s*auto;/.test(pdfHtml)
      && !/\.note-sec\s*\{[^}]*page-break-inside:\s*avoid;/.test(pdfHtml),
    pdfHtml.match(/\.note-sec\s*\{[^}]*\}/)?.[0] || 'missing rule');
  check('a section rule, timestamp and title stay together',
    /<div class="pdf-section-head"><div class="note-rule">/.test(pdfHtml)
      && /\.pdf-section-head\s*\{[^}]*break-inside:\s*avoid;[^}]*break-after:\s*avoid;/.test(pdfHtml),
    'missing atomic section heading');

  // Force a genuinely multi-page document through Chromium too. It is long on
  // purpose: the old whole-section rule turned each one of these chapters into
  // a mostly empty page, while the new rule can use the space that remains.
  const longPdfNotes = Array.from({ length: 8 }, (_, section) => {
    const bullets = Array.from({ length: 8 }, (_, item) =>
      `- Detail ${section + 1}.${item + 1}: enough context to make this a realistic meeting note that wraps cleanly when needed.`);
    return `## Topic ${section + 1} [${String(section * 3).padStart(2, '0')}:00]\n${bullets.join('\n')}`;
  }).join('\n\n');
  await $(`renderNotes(${JSON.stringify(longPdfNotes)})`);
  await $(`pdfTheme = 'dark'`);
  const pdf = await $(`runExport('pdf')`);
  await new Promise(r => setTimeout(r, 400));
  check('writes a readable PDF document',
    pdf === savedPdf && fs.existsSync(savedPdf) && fs.statSync(savedPdf).size > 1000,
    `${pdf} (${fs.existsSync(savedPdf) ? fs.statSync(savedPdf).size : 0} bytes)`);

  console.log(fails ? `\n${fails} failures` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(e => { console.log('FAIL', e.stack || e.message); app.exit(1); });
