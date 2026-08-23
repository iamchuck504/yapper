// The Screen Recording dead end, driven in the real window.
//
// Worth a test precisely because the old version *looked* fine: it told the
// user to allow the permission "then record again", which macOS does not
// honour for a process that was already running. Following the instruction
// exactly produced a second one-sided recording and no explanation. What is
// pinned here is that the two things the user cannot do from inside the app
// are on screen and reachable, and that a helper dying mid-meeting — a
// different problem with a different answer — does not raise this prompt.
//
// Not covered: the guard that holds the reopen button back while a meeting is
// in the air. Reaching it needs a real recording, so it needs a microphone;
// `stopAndProcess` re-enables the button and both live in `app.js`.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { sandbox, logger, mainWindow, watchdog, within } = require('./harness');

const ROOT = sandbox('screen-prompt');
const say = logger(ROOT);

let fails = 0;
function check(name, ok, detail) {
  if (ok) say(`ok    ${name}`);
  else { fails++; say(`FAIL  ${name}\n      ${JSON.stringify(detail)}`); }
}

const state = win => win.webContents.executeJavaScript(`(() => {
  const p = document.getElementById('screen-prompt');
  return {
    hidden: p.classList.contains('hidden'),
    text: p.innerText.replace(/\\s+/g, ' ').trim(),
    buttons: [...p.querySelectorAll('button')].map(b => b.id).join(',')
  };
})()`);

const pause = ms => new Promise(r => setTimeout(r, ms));

// Load main before app readiness, as production does, so its privileged scheme
// is registered at the only time Electron permits it.
require('../main.js');

app.whenReady().then(async () => {
  const timer = watchdog(say);
  try {
    const win = await within(mainWindow(), 'the main window');

    check('the prompt starts hidden', (await state(win)).hidden, await state(win));

    // Exactly the way it arrives in production: the native helper lives outside
    // this process, so its verdict comes in over the channel, not through the UI.
    win.webContents.send('system-audio-status', { ok: false, reason: 'permission' });
    await pause(400);

    const shown = await state(win);
    check('a denied permission raises the prompt', shown.hidden === false, shown);
    check('with all three buttons', shown.buttons, 'sp-settings,sp-relaunch,sp-dismiss');
    check('and says it must be reopened, not "record again"',
      /reopen/i.test(shown.text) && !/record again/i.test(shown.text), shown.text);

    await win.webContents.executeJavaScript(
      `document.getElementById('sp-dismiss').click(), true`);
    await pause(250);
    check('descartar lo cierra', (await state(win)).hidden, await state(win));

    // A crash mid-meeting is fixed by neither permissions nor reopening, so it
    // has a message of its own and must not raise this prompt.
    win.webContents.send('system-audio-status', { ok: false, reason: 'stopped' });
    await pause(400);
    check('a crash mid-meeting does not raise the permission prompt',
      (await state(win)).hidden, await state(win));

    // A helper that failed for its own reasons is not a permission problem,
    // and it used to be shown as one: "Allow Yapper under Screen Recording",
    // a page whose switch may well already be on. Only a refusal names a pane.
    win.webContents.send('system-audio-status', { ok: false, reason: 'helper', detail: 'aggregate device (!obj)' });
    await pause(400);
    check('a helper failure that is not a refusal does not raise the permission prompt',
      (await state(win)).hidden, await state(win));
    win.webContents.send('system-audio-status', { ok: false, reason: 'helper-exit', detail: 'exit 5' });
    await pause(400);
    check('nor does the helper dying', (await state(win)).hidden, await state(win));

    // And when it comes back — its own retry, or the screen door opening after
    // the tap gave up — the warning goes away by itself.
    win.webContents.send('system-audio-status', { ok: false, reason: 'permission', which: 'audio' });
    await pause(400);
    check('a refusal still raises it', (await state(win)).hidden === false, await state(win));
    check('and names the pane it was refused', /System Audio Recording/i.test((await state(win)).text),
      (await state(win)).text);
    win.webContents.send('system-audio-status', { ok: true, via: 'screen' });
    await pause(400);
    check('capturing again takes the prompt down', (await state(win)).hidden, await state(win));

    // A doubt is not a refusal: recording continues, so it is said in the
    // status line rather than behind a panel that offers to reopen the app.
    win.webContents.send('system-audio-status', { ok: false, reason: 'suspect', which: 'audio' });
    await pause(400);
    check('a suspected mute does not raise the permission prompt',
      (await state(win)).hidden, await state(win));
    const said = await win.webContents.executeJavaScript(
      `(() => { const el = document.getElementById('status');
        return el.classList.contains('hidden') ? '' : el.textContent; })()`);
    check('but it is said, and names the pane to check',
      /silent/i.test(said) && /System Audio Recording/i.test(said), said);

    // The same doubt about the other door says something true about that one:
    // there is no permission to grant, the door simply cannot hear everything.
    win.webContents.send('system-audio-status', { ok: false, reason: 'suspect', which: 'screen' });
    await pause(400);
    const saidScreen = await win.webContents.executeJavaScript(
      `(() => { const el = document.getElementById('status');
        return el.classList.contains('hidden') ? '' : el.textContent; })()`);
    check('a doubt about the screen door does not name a permission pane',
      /silent/i.test(saidScreen) && !/System Audio Recording/i.test(saidScreen), saidScreen);
    check('and it is owned by system audio', await win.webContents.executeJavaScript(
      `document.getElementById('status').dataset.source`) === 'sysaudio');

    // Capturing again takes it down; a line somebody else wrote does not.
    win.webContents.send('system-audio-status', { ok: true, via: 'screen' });
    await pause(400);
    check('capturing again withdraws the doubt', await win.webContents.executeJavaScript(
      `document.getElementById('status').classList.contains('hidden')`));
    await win.webContents.executeJavaScript(
      `setStatus(document.getElementById('status'), 'the microphone is asleep', true, 'mic'), true`);
    win.webContents.send('system-audio-status', { ok: true, via: 'tap' });
    await pause(400);
    check('and a microphone failure survives a system-audio recovery',
      await win.webContents.executeJavaScript(
        `!document.getElementById('status').classList.contains('hidden')`));

    // It must also survive a system-audio warning that temporarily owns the
    // shared line. Merely tagging the last writer loses the mic message when
    // the later source recovers; the owned-state registry restores it.
    win.webContents.send('system-audio-status', { ok: false, reason: 'suspect', which: 'screen' });
    await pause(400);
    check('a system-audio doubt can temporarily replace the microphone line',
      await win.webContents.executeJavaScript(
        `document.getElementById('status').dataset.source`) === 'sysaudio');
    win.webContents.send('system-audio-status', { ok: true, via: 'screen' });
    await pause(400);
    const restored = await win.webContents.executeJavaScript(`(() => {
      const el = document.getElementById('status');
      return { hidden: el.classList.contains('hidden'), source: el.dataset.source, text: el.textContent };
    })()`);
    check('and recovery restores the still-active microphone failure',
      !restored.hidden && restored.source === 'mic' && /microphone is asleep/i.test(restored.text), restored);

    const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
    check('recording clears stale status before starting the native helper',
      /clearStatus\(statusEl\);\s*currentFolder = await window\.yapper\.recordingStart/.test(renderer),
      'a synchronous no-helper status could be hidden after the IPC resolves');
    check('microphone silence is consecutive, not a lifetime peak',
      /lastMicSignalAt/.test(renderer) && !/let micPeak\s*=/.test(renderer),
      'a microphone that died after one sample would stay trusted');
  } catch (err) {
    fails++;
    say('FAIL  ' + (err.stack || err.message));
  }
  clearTimeout(timer);
  say(fails ? `\n${fails} failures` : '\nPASS');
  app.exit(fails ? 1 : 0);
});
