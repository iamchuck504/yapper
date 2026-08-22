// The menu bar at the top left, when Yapper is the active app.
//
// Electron ships a default one and it is not this app's: it takes its name
// from package.json, so it read "yapper" in lower case; File offered only
// Close Window; and View handed every user Reload and Toggle Developer Tools —
// a stray Cmd+R during a meeting reloads the renderer mid-recording.
//
// So what is pinned here is that the menu is this app's: the two actions that
// matter are in it, they say which one is available right now, and the
// developer items are only present where a developer is.
// On Windows the menu bar is hidden — but its accelerators are not. Electron's
// DEFAULT menu (what a window has when nobody sets one) carries Reload, so a
// hidden default menu still lets a stray Ctrl+R reload the renderer with a
// recording in it. That is why this runs on both platforms: the app has to set
// its OWN menu everywhere, and the developer items have to be gated out of
// packaged builds everywhere.
const { app, Menu } = require('electron');
const { sandbox, logger, mainWindow, watchdog } = require('./harness');

if (process.platform !== 'darwin' && process.platform !== 'win32') {
  console.log('skip  no application menu worth pinning on this platform');
  process.exit(0);
}
const mac = process.platform === 'darwin';

const ROOT = sandbox('app-menu');
const say = logger(ROOT);

let fails = 0;
function check(name, ok, detail) {
  if (ok) say(`ok    ${name}`);
  else { fails++; say(`FAIL  ${name}\n      ${detail || ''}`); }
}

const pause = ms => new Promise(r => setTimeout(r, ms));
const menu = () => Menu.getApplicationMenu();
const top = label => (menu() ? menu().items.find(i => i.label === label) : null);
const under = (parent, label) => {
  const p = top(parent);
  return p && p.submenu ? p.submenu.items.find(i => i.label === label) : null;
};

// main.js registers its app:// scheme as privileged at module level, which
// Electron only allows before the app is ready — so it is loaded up front.
require('../main.js');

app.whenReady().then(async () => {
  const timer = watchdog(say, 200000);
  try {
    const win = await mainWindow();
    await pause(600);

    check('there is an application menu — ours, not Electron\'s default', !!menu());
    if (mac) {
      check('with the name capitalised, not package.json\'s', !!top('Yapper'),
        menu() ? menu().items.map(i => i.label).join(', ') : '');
      check('and the menus any macOS app is expected to have',
        ['File', 'Edit', 'View', 'Window', 'Help'].every(l => !!top(l)));
    } else {
      check('with the menus that make sense on Windows',
        ['File', 'Edit', 'View', 'Help'].every(l => !!top(l)),
        menu() ? menu().items.map(i => i.label).join(', ') : '');
      check('and none of the macOS furniture', !top('Yapper') && !top('Window'),
        menu() ? menu().items.map(i => i.label).join(', ') : '');
    }

    // Editing roles: without them the text fields cannot cut, copy or paste
    // by keyboard, which people notice immediately in a title field.
    check('Edit carries the editing roles',
      ['Cut', 'Copy', 'Paste', 'Select All'].every(l => !!under('Edit', l)));

    check('File offers the two actions that matter',
      !!under('File', 'New meeting') && !!under('File', 'Stop recording'));

    // The rest of the keyboard: listed in the menu so it can be found, and
    // routed through the page so it means the right thing for the view open.
    check('File offers Export', !!under('File', 'Export…'));
    check('Edit offers copy-as-markdown and rename',
      !!under('Edit', 'Copy notes as Markdown') && !!under('Edit', 'Rename meeting'));
    check('Go reaches the three views',
      ['Today', 'Action items', 'Search'].every(l => !!under('Go', l)));
    const accel = (m, l) => (under(m, l) || {}).accelerator || '';
    check('with the accelerators the manual promises',
      accel('Go', 'Search') === 'CmdOrCtrl+K' && accel('File', 'Export…') === 'CmdOrCtrl+E'
      && accel('Edit', 'Copy notes as Markdown') === 'CmdOrCtrl+Shift+C'
      && accel('Go', 'Today') === 'CmdOrCtrl+1' && accel('Go', 'Action items') === 'CmdOrCtrl+2',
      ['Go/Search', 'File/Export…', 'Edit/Copy notes as Markdown'].map(p => accel(...p.split('/'))).join(', '));
    const $go = js => win.webContents.executeJavaScript(js, true);
    under('Go', 'Search').click();
    await pause(400);
    check('Go › Search opens the search view',
      await $go("!document.getElementById('view-search').classList.contains('hidden')"));
    under('Go', 'Action items').click();
    await pause(400);
    check('Go › Action items opens the list',
      await $go("!document.getElementById('view-reminders').classList.contains('hidden')"));
    under('Go', 'Today').click();
    await pause(400);
    check('Go › Today goes home',
      await $go("!document.getElementById('view-home').classList.contains('hidden')"));
    check('at rest you can start, not stop',
      under('File', 'New meeting').enabled === true
      && under('File', 'Stop recording').enabled === false);

    const $ = js => win.webContents.executeJavaScript(js, true);
    await $('startRecording()');
    await pause(2500);
    check('recording it inverts: stop yes, start no',
      under('File', 'New meeting').enabled === false
      && under('File', 'Stop recording').enabled === true);

    await $('stopAndProcess()').catch(() => { });
    await pause(1500);
    check('and on stopping it comes back', under('File', 'New meeting').enabled === true);

    // Reload and the developer tools ship to developers only: a stray Cmd+R
    // during a meeting would reload the renderer with a recording in it.
    const devItems = ['Reload', 'Toggle Developer Tools'].filter(l => !!under('View', l));
    check(app.isPackaged
      ? 'packaged, View exposes no developer tools'
      : 'unpackaged, View does carry them (this run)',
      app.isPackaged ? devItems.length === 0 : devItems.length === 2,
      devItems.join(', '));
  } catch (err) {
    fails++;
    say('FAIL  ' + (err.stack || err.message));
  }
  clearTimeout(timer);
  say(fails ? `\n${fails} failures` : '\nPASS');
  app.exit(fails ? 1 : 0);
});
