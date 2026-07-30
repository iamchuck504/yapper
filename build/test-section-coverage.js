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
  orphans.length === 0, `sin regla: ${orphans.join(' | ')}`);
console.log(`      (${unique.length} distinct sections across ${promptStyles.length} styles)`);

// --- and no rule is dead weight ---
const unused = rules.filter(r => !unique.some(h => r.match.test(h)));
check('there are no colour rules that no longer apply to anything',
  unused.length === 0, `sobran: ${unused.map(r => r.match.source).join(' | ')}`);

// --- the styles the prompts define are actually reachable ---
check('no defined style is left without a button',
  promptStyles.every(s => pillStyles.includes(s)),
  `no button: ${promptStyles.filter(s => !pillStyles.includes(s)).join(', ')}`);

console.log(fails ? `\n${fails} fallos` : '\nPASS');
process.exit(fails ? 1 : 0);
