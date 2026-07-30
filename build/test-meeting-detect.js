// Meeting auto-detection has to work the same on both platforms, and the two
// halves are easy to drift apart: Windows reads the registry for .exe names,
// macOS runs a Swift probe that answers with bundle ids. This checks that the
// wiring covers both, that the two app lists agree on what they call things,
// and — where the probe exists — that it behaves as the caller assumes.
//
// It reads main.js as text on purpose: requiring it would pull in Electron.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

let fails = 0;
function check(name, ok, detail) {
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      ${detail || ''}`); }
}

const ROOT = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

// ---- the watcher must start on both platforms ----
const watch = main.slice(main.indexOf('function startMeetingWatch'),
  main.indexOf('function stopMeetingWatch'));
check('el vigilante arranca en Windows', /'win32'/.test(watch), 'no menciona win32');
check('y también en macOS', /'darwin'/.test(watch), 'sigue siendo solo Windows');
check('no arranca sin la sonda compilada', /probePath\(\)/.test(watch),
  'arrancaría un timer que lanza un binario inexistente cada 5 s');

// ---- a failed probe is not "nobody is in a meeting" ----
const poll = main.slice(main.indexOf('async function pollMeetings'),
  main.indexOf('function notifyMeeting'));
check('una sonda fallida no se confunde con silencio', /users === null/.test(poll),
  'null se trataría como lista vacía y cortaría la grabación');
check('la lista de apps se elige por plataforma', /meetingApps\(\)/.test(poll), 'usa un mapa fijo');

// ---- both app lists, same vocabulary ----
const listOf = name => {
  const start = main.indexOf(`const ${name} = {`);
  const body = main.slice(start, main.indexOf('};', start));
  const out = {};
  for (const m of body.matchAll(/'([^']+)':\s*'([^']+)'/g)) out[m[1]] = m[2];
  return out;
};
const winApps = listOf('MEETING_APPS');
const macApps = listOf('MEETING_APPS_MAC');

check('la lista de Windows sigue ahí', Object.keys(winApps).length >= 8, JSON.stringify(winApps));
check('la de macOS también', Object.keys(macApps).length >= 8, JSON.stringify(macApps));
check('macOS usa bundle ids, no ejecutables',
  Object.keys(macApps).every(id => !id.endsWith('.exe') && id.includes('.')),
  Object.keys(macApps).join(', '));

// Slack is what started this: a huddle has to be recognised on both.
check('Slack está en Windows', Object.values(winApps).includes('Slack'));
check('Slack está en macOS', macApps['com.tinyspeck.slackmacgap'] === 'Slack',
  `es ${macApps['com.tinyspeck.slackmacgap']}`);

const winLabels = new Set(Object.values(winApps));
for (const label of ['Zoom', 'Microsoft Teams', 'Slack', 'Discord', 'Webex']) {
  check(`ambas plataformas dicen "${label}"`,
    winLabels.has(label) && Object.values(macApps).includes(label));
}

// ---- the probe itself, when this machine has one ----
const probe = path.join(__dirname, 'mic-probe');
if (process.platform === 'darwin' && fs.existsSync(probe)) {
  const r = spawnSync(probe, [], { encoding: 'utf8', timeout: 10000 });
  check('la sonda responde sin error', r.status === 0, `salió con ${r.status}: ${r.stderr}`);
  const lines = (r.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
  check('y responde en bundle ids, uno por línea',
    lines.every(l => /^[\w.-]+$/.test(l)), JSON.stringify(lines));
} else {
  console.log('skip  la sonda no está compilada aquí (solo se construye en macOS)');
}

console.log(fails ? `\n${fails} fallos` : '\nPASS');
process.exit(fails ? 1 : 0);
