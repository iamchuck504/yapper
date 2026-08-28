// The note styles live in main.js and the colour rules live in renderer/app.js,
// so it is easy to add a style and forget the other half — the notes then come
// back with grey, unstyled sections. This checks the two halves agree, without
// spending a model call, so it can run on every change.
const fs = require('fs');
const path = require('path');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');

let fails = 0;
function check(name, ok, detail) {
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      ${detail}`); }
}

// --- the styles each side knows about ---
const setsBlock = main.slice(main.indexOf('const SECTION_SETS = {'));
const promptStyles = [...setsBlock.matchAll(/^\s{2}(\w+):\s*`/gm)].map(m => m[1]);
const pillStyles = [...html.matchAll(/data-style="([^"]+)"/g)].map(m => m[1]);
const optionStyles = [...html.matchAll(/<option value="([^"]+)">/g)]
  .map(m => m[1])
  .filter(v => promptStyles.includes(v) || pillStyles.includes(v));

check('the style buttons match the prompts',
  pillStyles.length === promptStyles.length && pillStyles.every(s => promptStyles.includes(s)),
  `botones: ${pillStyles.join(', ')}\n      prompts: ${promptStyles.join(', ')}`);
check('the regenerate dropdown offers the same styles',
  pillStyles.every(s => optionStyles.includes(s)),
  `missing from regenerate: ${pillStyles.filter(s => !optionStyles.includes(s)).join(', ')}`);

// --- every heading a style asks for has a colour rule ---
const metaSrc = app.slice(app.indexOf('const SECTION_META = ['));
const rules = eval(metaSrc.slice(metaSrc.indexOf('['), metaSrc.indexOf('];') + 1));   // eslint-disable-line no-eval
check('colour rules are loaded', rules.length > 0, `${rules.length} reglas`);

// the first heading of each style sits on the same line as the key
// (`general: ` + backtick + "## Summary"), so it does not start a line
const headings = [...setsBlock.matchAll(/(?:^|`)##\s+(.+)$/gm)].map(m => m[1].trim());
const unique = [...new Set(headings)];
const orphans = unique.filter(h => !rules.some(r => r.match.test(h)));
check('every section of every style has a colour rule',
  orphans.length === 0, `no rule: ${orphans.join(' | ')}`);
console.log(`      (${unique.length} distinct sections across ${promptStyles.length} styles)`);

// --- and no rule is dead weight ---
const unused = rules.filter(r => !unique.some(h => r.match.test(h)));
check('there are no colour rules that no longer apply to anything',
  unused.length === 0, `sobran: ${unused.map(r => r.match.source).join(' | ')}`);

// --- the styles the prompts define are actually reachable ---
check('no defined style is left without a button',
  promptStyles.every(s => pillStyles.includes(s)),
  `no button: ${promptStyles.filter(s => !pillStyles.includes(s)).join(', ')}`);

// --- UI redesign contract -------------------------------------------------
// These are the durable, interactive doors that existed before the visual
// reorganization. A prettier shell is not allowed to quietly remove one. The
// quick language selector is the one new proxy; its synchronization is driven
// against the real window in test-options-ui.js.
const requiredControls = `
btn-new btn-home btn-search-view btn-reminders btn-settings search btn-update btn-theme
mp-start mp-dismiss sp-settings sp-relaunch sp-dismiss action-summary btn-record btn-import
mic-select quick-spoken-lang gain-sys gain-mic btn-mark btn-pause btn-stop ep-keep ep-stop live-head
meeting-title opts-toggle custom-instructions llm-provider llm-baseurl llm-key llm-model btn-llm-test
spoken-lang participants-rec opt-identify-speakers opt-keep-audio btn-free-audio opt-bubble
opt-autodetect opt-startup btn-rename regen-style regen-detail regen-lang btn-regen btn-speak
voice-select btn-edit btn-copy btn-export btn-open-folder participants-meet speaker-map notes-textarea
btn-save-notes btn-cancel-notes home-setup-open btn-week-refresh search-q btn-search new-reminder
btn-add-reminder btn-select-actions select-all-actions btn-bulk-done btn-bulk-cancel
`.trim().split(/\s+/);
const interactiveIds = [...html.matchAll(/<(?:button|input|select|textarea|details)\b[^>]*\bid="([^"]+)"/g)]
  .map(match => match[1]);
const duplicateControls = interactiveIds.filter((id, index) => interactiveIds.indexOf(id) !== index);
const missingControls = requiredControls.filter(id => !interactiveIds.includes(id));
check('every pre-redesign UI control still exists', missingControls.length === 0,
  `missing: ${missingControls.join(', ')}`);
check('interactive IDs remain unique', duplicateControls.length === 0,
  `duplicates: ${[...new Set(duplicateControls)].join(', ')}`);

const requiredControlGroups = [
  'style-pills', 'detail-seg', 'lang-seg', 'noise-seg', 'corner-seg',
  'theme-seg', 'action-filter', 'home-scope', 'settings-tabs'
];
const allIds = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
const missingGroups = requiredControlGroups.filter(id => !allIds.includes(id));
check('every segmented control group remains reachable', missingGroups.length === 0,
  `missing: ${missingGroups.join(', ')}`);

const optionSections = [...html.matchAll(/data-option-section="([^"]+)"/g)].map(match => match[1]);
check('Settings exposes every option category exactly once',
  ['notes', 'recording', 'during', 'app'].every(section => optionSections.filter(x => x === section).length === 1)
    && optionSections.length === 4,
  optionSections.join(', '));

console.log(fails ? `\n${fails} failures` : '\nPASS');
process.exit(fails ? 1 : 0);
