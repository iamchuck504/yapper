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
{
  const from = main.indexOf('function micUsersWindows()');
  const windowsProbe = main.slice(from, main.indexOf('// macOS answers', from));
  check('a failed Windows registry query is unknown, not an empty room',
    /catch \{\s*return finish\(null\)/.test(windowsProbe)
      && /p\.on\('error', \(\) => finish\(null\)\)/.test(windowsProbe)
      && /code !== 0\) return finish\(null\)/.test(windowsProbe),
    'a registry failure could still advance the meeting-gone streak');
  check('meeting probes have a deadline instead of wedging every future poll',
    (main.match(/setTimeout\(\(\) => \{\s*if \(!finish\(null\)\) return;/g) || []).length >= 2,
    'a hung child could leave pollInFlight true forever');
}
check('the match comes from the module, not a loose map',
  /matchMeetingApp\(users\)/.test(poll), 'main.js went back to doing it on its own');
check('the end-of-meeting decision is the tested step in meetings.js',
  /whileRecording\(\{ current: meetingCurrent, streak: meetingGoneStreak \}, hit\)/.test(poll),
  'main.js went back to deciding it inline');
check('a meeting that resumes withdraws a pending automatic stop',
  /hit && meetingEndedPending/.test(poll)
    && /send\('meeting-ended', false\)/.test(poll),
  'the renderer countdown would keep running after the meeting returned');
// The step itself, as the sequences a recording actually sees. `ended` must be
// true on exactly one poll, and never for a recording no meeting app was in.
{
  const { whileRecording } = require('../meetings');
  const run = (hits, state = {}) => hits.map(h => { state = whileRecording(state, h); return state.ended; });
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check('a note with no meeting app is never told the meeting ended',
    run([null, null, null, null, null]).every(e => !e), 'ended fired');
  check('a meeting that ends is announced on the second clear poll, once',
    eq(run(['Zoom', 'Zoom', null, null, null, null]), [false, false, false, true, false, false]),
    JSON.stringify(run(['Zoom', 'Zoom', null, null, null, null])));
  check('a blip does not end the meeting',
    run(['Zoom', null, 'Zoom', null, 'Zoom']).every(e => !e), 'ended fired on a blip');
  check('a call that starts after the recording did is watched from then on',
    eq(run([null, null, 'Teams', null, null]), [false, false, false, false, true]),
    JSON.stringify(run([null, null, 'Teams', null, null])));
  check('after an in-recording hit, two clear polls end it',
    eq(run(['Zoom', null, null]), [false, false, true]), JSON.stringify(run(['Zoom', null, null])));
}
// And the memory is wiped when a recording starts or stops, so an app seen
// before the recording — a call that ended a moment ago — cannot follow a
// memo in and end it. A regex over the handler, since it cannot run here.
{
  const from = main.indexOf("ipcMain.on('recording-state'");
  const handler = main.slice(from, main.indexOf('});', from));
  check('recording-state clears the meeting memory unconditionally',
    /^\s*meetingCurrent = null;/m.test(handler) && !/if \(!rendererRecording\) meetingCurrent/.test(handler),
    'a meeting seen before the recording would be inherited by it');
  check('and retires the polls that were already in flight',
    /meetingEra\+\+/.test(handler) && /const era = meetingEra;/.test(poll)
    && /if \(era !== meetingEra\) return;/.test(poll),
    'a probe that started before the recording could still attach its meeting to it');
}

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
