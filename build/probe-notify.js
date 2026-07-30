// Does the meeting-detected toast actually reach the Windows Action Center?
//
// A probe, not a test: it shows one real notification on this desktop and
// reports what the OS did with it. Electron reports 'failed' on Windows when the
// toast is rejected (no shortcut / no app id / notifications turned off), which
// is the failure that is otherwise completely silent.
const path = require('path');
const fs = require('fs');
const { app, Notification, shell } = require('electron');
const { sandbox, logger } = require('./harness');

const ROOT = sandbox('notify-probe');
fs.mkdirSync(path.join(ROOT, 'Meetings'), { recursive: true });
const say = logger(ROOT);

const main = require('../main.js');

// Windows drops a toast whose AppUserModelID is not backed by a Start Menu
// shortcut, and reports nothing when it does. WITH_SHORTCUT=1 adds one first, to
// tell that cause apart from every other reason a toast might not appear.
const START_MENU = path.join(app.getPath('appData'),
  'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Yapper.lnk');

app.whenReady().then(async () => {
  await new Promise(r => setTimeout(r, 2500));      // let the window and splash settle

  say(`plataforma: ${process.platform}`);
  say(`Notification.isSupported(): ${Notification.isSupported()}`);
  say(`Start menu shortcut: ${fs.existsSync(START_MENU)}`);

  if (process.env.WITH_SHORTCUT === '1' && !fs.existsSync(START_MENU)) {
    const ok = shell.writeShortcutLink(START_MENU, 'create', {
      target: process.execPath,
      args: `"${path.join(__dirname, '..')}"`,
      icon: path.join(__dirname, 'yapper-icon.ico'),
      iconIndex: 0,
      appUserModelId: 'com.yapper.meetingnotes',
      description: 'Yapper'
    });
    say(`created for the test: ${ok} -> ${START_MENU}`);
    await new Promise(r => setTimeout(r, 1500));    // let the shell notice it
  }

  // Listeners have to be attached BEFORE show() runs: on Windows the events are
  // emitted inside that call, so subscribing afterwards sees nothing and looks
  // exactly like a toast that never appeared.
  const seen = [];
  const realShow = Notification.prototype.show;
  Notification.prototype.show = function (...args) {
    for (const ev of ['show', 'close', 'click', 'failed', 'action']) {
      this.on(ev, (_e, detail) => {
        seen.push(ev);
        say(`  evento: ${ev}${detail !== undefined ? ' -> ' + detail : ''}`);
      });
    }
    return realShow.apply(this, args);
  };

  const n = main.notifyMeeting('Slack');
  if (!n) { say('FAIL  notifyMeeting returned nothing — no attempt to show'); app.exit(1); return; }

  await new Promise(r => setTimeout(r, 6000));

  say('');
  if (seen.includes('failed')) say('RESULT: Windows rejected the toast.');
  else if (seen.includes('show')) say('RESULT: the toast was shown by the system.');
  else say('RESULT: neither show nor failed — the toast was delivered with no observable confirmation.');
  say(`events seen: ${seen.join(', ') || '(none)'}`);

  app.exit(0);
}).catch(e => { say('FAIL ' + (e.stack || e.message)); app.exit(1); });
