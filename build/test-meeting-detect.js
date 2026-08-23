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
eq('a real Slack huddle (helper process)',
  matchMeetingApp(['com.tinyspeck.slackmacgap.helper'], 'darwin'), 'Slack');
eq('and the main process, just in case',
  matchMeetingApp(['com.tinyspeck.slackmacgap'], 'darwin'), 'Slack');
eq('Chromium suffixes the role as well',
  matchMeetingApp(['com.google.Chrome.helper.renderer'], 'darwin'), 'a Chrome call (Meet/Hangouts)');
eq('Teams from its helper', matchMeetingApp(['com.microsoft.teams2.helper'], 'darwin'), 'Microsoft Teams');

eq('appOf trims the helper', appOf('com.tinyspeck.slackmacgap.helper'), 'com.tinyspeck.slackmacgap');
eq('and the role hanging off it', appOf('com.google.Chrome.helper.gpu'), 'com.google.Chrome');
eq('leaves alone what is not a helper', appOf('us.zoom.xos'), 'us.zoom.xos');

// ---- what must NOT trigger a meeting ----
eq('Yapper recording is not a meeting',
  matchMeetingApp(['com.yapper.meetingnotes'], 'darwin'), null);
eq('nor a helper of something unrelated',
  matchMeetingApp(['com.spotify.client.helper'], 'darwin'), null);
eq('nadie capturando', matchMeetingApp([], 'darwin'), null);
eq('nor an absent list', matchMeetingApp(null, 'darwin'), null);

// ---- Windows keeps working, and keeps its own vocabulary ----
eq('Slack on Windows', matchMeetingApp(['slack.exe'], 'win32'), 'Slack');
eq('Zoom on Windows', matchMeetingApp(['zoom.exe'], 'win32'), 'Zoom');
eq('any old exe does not fire', matchMeetingApp(['notepad.exe'], 'win32'), null);
eq('a bundle id does not pass as an exe', matchMeetingApp(['com.tinyspeck.slackmacgap'], 'win32'), null);

// ---- the first match wins, in order ----
eq('picks the meeting app out of several',
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
check('the watcher starts on Windows', /'win32'/.test(watch), 'does not mention win32');
check('and on macOS too', /'darwin'/.test(watch), 'still Windows-only');
check('does not start without the probe compiled', /probePath\(\)/.test(watch),
  'it would launch a binary that does not exist every 5 s');

const poll = main.slice(main.indexOf('async function pollMeetings'),
  main.indexOf('function notifyMeeting'));
check('a failed probe is not mistaken for silence', /users === null/.test(poll),
  'null would be treated as an empty list and cut the recording');
check('the match comes from the module, not a loose map',
  /matchMeetingApp\(users\)/.test(poll), 'main.js went back to doing it on its own');
check('a recording with no meeting app in it is never told the meeting ended',
  /meetingSeenWhileRecording/.test(poll) && /else if \(meetingSeenWhileRecording\)/.test(poll),
  'a memo with no call running would be stopped on its own after 70 s');

// ---- the probe itself, where there is one ----
const probe = path.join(__dirname, 'mic-probe');
if (process.platform === 'darwin' && fs.existsSync(probe)) {
  const r = spawnSync(probe, [], { encoding: 'utf8', timeout: 10000 });
  check('the probe answers without an error', r.status === 0, `exited with ${r.status}: ${r.stderr}`);
  const lines = (r.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
  check('and answers in bundle ids, one per line',
    lines.every(l => /^[\w.-]+$/.test(l)), JSON.stringify(lines));
} else {
  console.log('skip  the probe is not compiled here (it is only built on macOS)');
}

console.log(fails ? `\n${fails} failures` : '\nPASS');
process.exit(fails ? 1 : 0);
