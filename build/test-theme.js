// Auto, Light, Dark — and the choice surviving a launch.
//
// The theme is chosen in three places that have to agree: the page toggles the
// class, main paints the window background before the stylesheet lands, and the
// splash card hands over to that window. A default only one of them follows
// opens the app on a flash of the other one, which is exactly the shape of bug
// this invites — so the default is asserted, not assumed.
//
// "Auto" is the one worth driving rather than reading: it is a preference that
// resolves to a different answer depending on the machine, and storing what it
// resolved to today instead of the word "auto" would freeze it at whatever the
// system happened to be the last time the app was open.
const fs = require('fs');
const path = require('path');
const { app, nativeTheme } = require('electron');
const { sandbox, logger, mainWindow, watchdog } = require('./harness');

const ROOT = sandbox('theme');
const say = logger(ROOT);

let fails = 0;
function check(name, ok, detail) {
  if (ok) say(`ok    ${name}`);
  else { fails++; say(`FAIL  ${name}\n      ${detail || ''}`); }
}

const pause = ms => new Promise(r => setTimeout(r, ms));
const settings = () => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'user', 'settings.json'), 'utf8')); }
  catch { return {}; }
};
/** The preference travels by IPC and lands on disk a moment later. */
const storedTheme = async want => {
  for (let i = 0; i < 40 && settings().theme !== want; i++) await pause(50);
  return settings().theme;
};

// main.js registers its app:// scheme as privileged at module level, which
// Electron only allows before the app is ready — so it is loaded up front.
require('../main.js');

app.whenReady().then(async () => {
  const timer = watchdog(say, 120000);
  try {
    const win = await mainWindow();
    const $ = js => win.webContents.executeJavaScript(js, true);
    const showing = async () =>
      (await $(`document.body.classList.contains('light')`)) ? 'light' : 'dark';
    const pick = async v => {
      await $(`document.querySelector('#theme-seg .seg-btn[data-theme="${v}"]').click()`);
      await pause(250);
    };

    // ---- what a new install opens on ----
    check('with nothing chosen, it starts dark', (await showing()) === 'dark', await showing());
    check('and what is stored says "dark", not a colour it worked out',
      (await storedTheme('dark')) === 'dark', JSON.stringify(settings().theme));

    // ---- the control offers the three, and marks the one in force ----
    const opts = await $(`[...document.querySelectorAll('#theme-seg .seg-btn')].map(b => b.dataset.theme)`);
    check('the control offers all three', JSON.stringify(opts) === '["auto","light","dark"]',
      opts.join(', '));
    check('and marks the one in force',
      (await $(`document.querySelector('#theme-seg .seg-btn.active').dataset.theme`)) === 'dark',
      await $(`document.querySelector('#theme-seg .seg-btn.active').dataset.theme`));

    // ---- explicit choices ----
    await pick('light');
    check('picking Light applies it', (await showing()) === 'light', await showing());
    check('and it is stored', (await storedTheme('light')) === 'light', JSON.stringify(settings().theme));

    // ---- auto: driven, not read ----
    // themeSource is what Electron shows prefers-color-scheme, so this is the
    // system setting as the app sees it.
    nativeTheme.themeSource = 'dark';
    await pick('auto');
    await pause(300);
    check('on Auto, a dark system paints dark', (await showing()) === 'dark', await showing());

    // And it changes with it, without reopening: the machine can switch on its own at dusk.
    nativeTheme.themeSource = 'light';
    await pause(400);
    check('and follows the system when it changes on its own', (await showing()) === 'light', await showing());

    check('what is stored is "auto", not today\'s colour',
      (await storedTheme('auto')) === 'auto', JSON.stringify(settings().theme));

    // ---- the corner button still works, and commits to a side ----
    // It cannot toggle over "auto": it would land on whatever the system already was.
    await $(`document.getElementById('btn-theme').click()`);
    await pause(250);
    check('the corner shortcut leaves Auto for a definite side',
      ['light', 'dark'].includes(settings().theme), JSON.stringify(settings().theme));
    check('and the control reflects it',
      (await $(`document.querySelector('#theme-seg .seg-btn.active').dataset.theme`)) === settings().theme,
      await $(`document.querySelector('#theme-seg .seg-btn.active').dataset.theme`));

    // ---- the next launch ----
    // Main resolves what is stored on its own, before the page exists. If that
    // drifts from this, the launch opens on a flash.
    await pick('auto');
    nativeTheme.themeSource = 'dark';
    await pause(300);
    win.webContents.reload();
    await new Promise(r => win.webContents.once('did-finish-load', r));
    await pause(900);
    // One copy. The page kept its own in localStorage and the two drifted
    // apart: settings said "auto" while that one said "light", so main painted
    // the window one colour and the page drew itself the other — with the
    // system in dark mode and the app opening light without anyone having
    // chosen it.
    check('the page keeps no copy of its own',
      (await $(`localStorage.getItem('yapper-theme')`)) === null,
      await $(`localStorage.getItem('yapper-theme')`));

    check('on reopening it is still on Auto',
      (await $(`document.querySelector('#theme-seg .seg-btn.active').dataset.theme`)) === 'auto',
      await $(`document.querySelector('#theme-seg .seg-btn.active').dataset.theme`));
    check('and Auto resolves again against the system as it is now',
      (await showing()) === 'dark', await showing());

    // A profile carrying the old copy cannot take over again: what counts is
    // what is stored, and a reload with junk planted in localStorage proves it.
    await $(`localStorage.setItem('yapper-theme', 'light')`);
    win.webContents.reload();
    await new Promise(r => win.webContents.once('did-finish-load', r));
    await pause(900);
    check('an old copy in the page does not win',
      (await $(`document.querySelector('#theme-seg .seg-btn.active').dataset.theme`)) === 'auto',
      await $(`document.querySelector('#theme-seg .seg-btn.active').dataset.theme`));
  } catch (err) {
    fails++;
    say('FAIL  ' + (err.stack || err.message));
  }
  nativeTheme.themeSource = 'system';
  clearTimeout(timer);
  say(fails ? `\n${fails} failures` : '\nPASS');
  app.exit(fails ? 1 : 0);
});
