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
const { app, Menu } = require('electron');
const { sandbox, logger, mainWindow, watchdog } = require('./harness');

if (process.platform !== 'darwin') {
  console.log('skip  the application menu is macOS-only');
  process.exit(0);
}

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

app.whenReady().then(async () => {
  const timer = watchdog(say, 200000);
  try {
    require('../main.js');
    const win = await mainWindow();
    await pause(600);

    check('there is an application menu', !!menu());
    check('with the name capitalised, not package.json\'s', !!top('Yapper'),
      menu() ? menu().items.map(i => i.label).join(', ') : '');
    check('and the menus any macOS app is expected to have',
      ['File', 'Edit', 'View', 'Window', 'Help'].every(l => !!top(l)));

    // Editing roles: without them the text fields cannot cut, copy or paste
    // by keyboard, which people notice immediately in a title field.
    check('Edit carries the editing roles',
      ['Cut', 'Copy', 'Paste', 'Select All'].every(l => !!under('Edit', l)));

    check('File offers the two actions that matter',
      !!under('File', 'New meeting') && !!under('File', 'Stop recording'));
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
