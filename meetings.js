// Which running app counts as "a meeting just started".
//
// The signal is the same on both platforms — who holds the microphone — but the
// name that comes back is not. Windows reports an executable (slack.exe) out of
// the consent store; macOS reports a bundle id out of CoreAudio. So the two
// vocabularies live side by side here, deliberately mapping to identical
// labels: the app says "Slack meeting started" on either machine, and the test
// enforces that they never drift into saying two different things.
//
// It lives outside main.js so it can be tested without pulling in Electron.

const MEETING_APPS_WIN = {
  'zoom.exe': 'Zoom',
  'teams.exe': 'Microsoft Teams',
  'ms-teams.exe': 'Microsoft Teams',
  'slack.exe': 'Slack',
  'discord.exe': 'Discord',
  'webexmta.exe': 'Webex',
  'webex.exe': 'Webex',
  'chrome.exe': 'a Chrome call (Meet/Hangouts)',
  'msedge.exe': 'an Edge call',
  'brave.exe': 'a Brave call',
  'firefox.exe': 'a Firefox call'
};

const MEETING_APPS_MAC = {
  'us.zoom.xos': 'Zoom',
  'com.microsoft.teams': 'Microsoft Teams',
  'com.microsoft.teams2': 'Microsoft Teams',
  'com.tinyspeck.slackmacgap': 'Slack',
  'com.hnc.Discord': 'Discord',
  'com.cisco.webexmeetingsapp': 'Webex',
  'com.google.Chrome': 'a Chrome call (Meet/Hangouts)',
  'com.microsoft.edgemac': 'an Edge call',
  'com.brave.Browser': 'a Brave call',
  'org.mozilla.firefox': 'a Firefox call',
  'com.apple.Safari': 'a Safari call',
  'com.apple.WebKit.GPU': 'a Safari call',
  'com.apple.FaceTime': 'FaceTime'
};

/**
 * The bundle id of the process that actually opens the microphone, reduced to
 * the app it belongs to.
 *
 * Every Electron and Chromium app — Slack, Teams, Discord, Chrome, Brave, Edge
 * — captures from a helper process, and the helper carries its own bundle id:
 * a real Slack huddle reports `com.tinyspeck.slackmacgap.helper`, never the
 * bare `com.tinyspeck.slackmacgap`. Chromium goes further and suffixes the
 * role, as in `com.google.Chrome.helper.renderer`. Matching the parent means
 * matching nothing, which is exactly how this shipped broken the first time.
 */
function appOf(bundleId) {
  return String(bundleId).replace(/\.helper(\..+)?$/i, '');
}

/**
 * The label for the first id that names a meeting app, or null if none do.
 * `ids` is what the platform reported: executables on Windows, bundle ids on
 * macOS.
 */
function matchMeetingApp(ids, platform = process.platform) {
  const apps = platform === 'darwin' ? MEETING_APPS_MAC : MEETING_APPS_WIN;
  for (const raw of ids || []) {
    const id = String(raw).trim();
    const label = apps[id] || (platform === 'darwin' ? apps[appOf(id)] : undefined);
    if (label) return label;
  }
  return null;
}

/**
 * One poll while a recording is running. `current` is the meeting app this
 * recording is attached to (null when none has been seen), `streak` how many
 * polls in a row it has been absent, `hit` what this poll found. Returns the
 * next state and whether this is the poll that says "the meeting ended":
 * exactly the second clear poll after an app was seen, so a blip does not end
 * a meeting and a recording that never had a meeting app in it — a note, a
 * video playing — is never told one ended.
 */
function whileRecording({ current = null, streak = 0 } = {}, hit) {
  if (hit) return { current: hit, streak: 0, ended: false };
  if (!current) return { current: null, streak: 0, ended: false };
  const next = streak + 1;
  return { current, streak: next, ended: next === 2 };
}

module.exports = { MEETING_APPS_WIN, MEETING_APPS_MAC, appOf, matchMeetingApp, whileRecording };
