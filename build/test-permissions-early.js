// Permissions asked at launch, not in the middle of a meeting.
//
// macOS asks the first time something is used, which for a meeting recorder is
// the worst possible moment: the call has started, someone is talking, and the
// app is putting dialogs on screen. The system-audio one is worse than a
// yes/no — it needs the app reopened before it applies — so answering it
// mid-meeting still leaves that meeting recorded one-sided.
//
// The microphone has an API to ask with. System audio does not: the permission
// is triggered by *creating* a tap, so the helper is run for a moment. What
// this pins is that the moment ends — a helper left running holds a tap on
// everything the machine plays — and that it happens once rather than on every
// launch.
const { app } = require('electron');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { sandbox, logger, mainWindow, watchdog } = require('./harness');

if (process.platform !== 'darwin') {
  console.log('skip  these permissions are macOS-only');
  process.exit(0);
}

const ROOT = sandbox('permissions-early');
const say = logger(ROOT);

let fails = 0;
function check(name, ok, detail) {
  if (ok) say(`ok    ${name}`);
  else { fails++; say(`FAIL  ${name}\n      ${detail || ''}`); }
}

const pause = ms => new Promise(r => setTimeout(r, ms));
const HELPER = path.join(__dirname, 'system-audio');
const running = () => Number(execSync(`pgrep -f ${HELPER} | wc -l`).toString().trim());
const settings = () => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'user', 'settings.json'), 'utf8')); }
  catch { return {}; }
};

// The app protocol must be registered before Electron becomes ready. Start the
// helper watch first, then load the real main process at the same point a normal
// launch does.
let seen = false;
const watching = setInterval(() => { if (running() >= 1) seen = true; }, 40);
require('../main.js');

app.whenReady().then(async () => {
  const timer = watchdog(say, 200000);
  try {
    // Sampled from before the window is ready. With the permission already
    // granted the probe ends as soon as the helper says "capturing" — hundreds
    // of milliseconds — and the harness takes longer than that to hand back the
    // window, so any later reading would always arrive too late.
    const win = await mainWindow();
    await pause(3500);
    clearInterval(watching);

    check('probes the audio permission at launch', seen, 'a helper never appeared');
    // It lets the tap go: a helper left alive captures everything the machine
    // plays, with no window and no way to notice.
    check('and lets it go, leaving no tap open', running() === 0, `${running()} left`);

    // No "already asked" flag: development builds and restored apps can still
    // change code identity. A stale per-version flag could claim the prompt was
    // already handled after macOS had discarded the permission.
    check('does not lean on a flag that code identity invalidates',
      settings().permissionsAskedBy === undefined,
      JSON.stringify(settings().permissionsAskedBy));

    // Priming must not have broken the thing it exists to smooth.
    const $ = js => win.webContents.executeJavaScript(js, true);
    await $('startRecording()');
    await pause(2500);
    check('recording still works afterwards', await $('recording'));
    check('and the recording has a helper of its own', running() >= 1, `helpers: ${running()}`);
    await $('stopAndProcess()').catch(() => { });
  } catch (err) {
    fails++;
    say('FAIL  ' + (err.stack || err.message));
  }
  clearTimeout(timer);
  say(fails ? `\n${fails} failures` : '\nPASS');
  app.exit(fails ? 1 : 0);
});
