// Meeting auto-detection, both halves of it.
//
// The rule the first macOS build got wrong: every Electron and Chromium app
// captures audio from a helper process with its own bundle id, so a real Slack
// huddle reports com.tinyspeck.slackmacgap.helper and matching the parent id
// matches nothing at all. That is what the app did on the first try — the
// probe saw the huddle and the lookup threw it away — so it is the first thing
// checked here, with the id copied from the observed failure.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { MEETING_APPS_WIN, MEETING_APPS_MAC, appOf, matchMeetingApp } = require('../meetings');

let fails = 0;
function check(name, ok, detail) {
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      ${detail || ''}`); }
}
const eq = (name, got, want) => check(name, got === want, `dio ${JSON.stringify(got)}, esperaba ${JSON.stringify(want)}`);

// ---- the helper-process bug, as observed ----
eq('un huddle de Slack real (proceso helper)',
  matchMeetingApp(['com.tinyspeck.slackmacgap.helper'], 'darwin'), 'Slack');
eq('y el proceso principal, por si acaso',
  matchMeetingApp(['com.tinyspeck.slackmacgap'], 'darwin'), 'Slack');
eq('Chromium sufija además el rol',
  matchMeetingApp(['com.google.Chrome.helper.renderer'], 'darwin'), 'a Chrome call (Meet/Hangouts)');
eq('Teams desde su helper', matchMeetingApp(['com.microsoft.teams2.helper'], 'darwin'), 'Microsoft Teams');

eq('appOf recorta el helper', appOf('com.tinyspeck.slackmacgap.helper'), 'com.tinyspeck.slackmacgap');
eq('y el rol que le cuelga', appOf('com.google.Chrome.helper.gpu'), 'com.google.Chrome');
eq('deja en paz lo que no es helper', appOf('us.zoom.xos'), 'us.zoom.xos');

// ---- what must NOT trigger a meeting ----
eq('Yapper grabando no es una reunión',
  matchMeetingApp(['com.yapper.meetingnotes'], 'darwin'), null);
eq('ni un helper de algo ajeno',
  matchMeetingApp(['com.spotify.client.helper'], 'darwin'), null);
eq('nadie capturando', matchMeetingApp([], 'darwin'), null);
eq('ni una lista ausente', matchMeetingApp(null, 'darwin'), null);

// ---- Windows keeps working, and keeps its own vocabulary ----
eq('Slack en Windows', matchMeetingApp(['slack.exe'], 'win32'), 'Slack');
eq('Zoom en Windows', matchMeetingApp(['zoom.exe'], 'win32'), 'Zoom');
eq('un exe cualquiera no dispara', matchMeetingApp(['notepad.exe'], 'win32'), null);
eq('un bundle id no cuela como exe', matchMeetingApp(['com.tinyspeck.slackmacgap'], 'win32'), null);

// ---- the first match wins, in order ----
eq('elige la app de reunión de entre varias',
  matchMeetingApp(['com.apple.podcasts', 'com.tinyspeck.slackmacgap.helper'], 'darwin'), 'Slack');

// ---- both lists say the same words ----
const winLabels = new Set(Object.values(MEETING_APPS_WIN));
const macLabels = new Set(Object.values(MEETING_APPS_MAC));
for (const label of ['Zoom', 'Microsoft Teams', 'Slack', 'Discord', 'Webex']) {
  check(`ambas plataformas dicen "${label}"`, winLabels.has(label) && macLabels.has(label),
    `win=${winLabels.has(label)} mac=${macLabels.has(label)}`);
}
check('macOS usa bundle ids, no ejecutables',
  Object.keys(MEETING_APPS_MAC).every(id => !id.endsWith('.exe') && id.includes('.')),
  Object.keys(MEETING_APPS_MAC).join(', '));

// ---- the wiring in main.js, which cannot be required without Electron ----
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const watch = main.slice(main.indexOf('function startMeetingWatch'),
  main.indexOf('function stopMeetingWatch'));
check('el vigilante arranca en Windows', /'win32'/.test(watch), 'no menciona win32');
check('y también en macOS', /'darwin'/.test(watch), 'sigue siendo solo Windows');
check('no arranca sin la sonda compilada', /probePath\(\)/.test(watch),
  'lanzaría un binario inexistente cada 5 s');

const poll = main.slice(main.indexOf('async function pollMeetings'),
  main.indexOf('function notifyMeeting'));
check('una sonda fallida no se confunde con silencio', /users === null/.test(poll),
  'null se trataría como lista vacía y cortaría la grabación');
check('la coincidencia sale del módulo, no de un mapa suelto',
  /matchMeetingApp\(users\)/.test(poll), 'main.js volvió a hacerlo por su cuenta');

// ---- the probe itself, where there is one ----
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
