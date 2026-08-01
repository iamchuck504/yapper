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

app.whenReady().then(async () => {
  const timer = watchdog(say, 120000);
  try {
    require('../main.js');
    const win = await mainWindow();
    const $ = js => win.webContents.executeJavaScript(js, true);
    const showing = async () =>
      (await $(`document.body.classList.contains('light')`)) ? 'light' : 'dark';
    const pick = async v => {
      await $(`document.querySelector('#theme-seg .seg-btn[data-theme="${v}"]').click()`);
      await pause(250);
    };

    // ---- what a new install opens on ----
    check('sin nada elegido, arranca en oscuro', (await showing()) === 'dark', await showing());
    check('y lo guardado dice "dark", no un color calculado',
      (await storedTheme('dark')) === 'dark', JSON.stringify(settings().theme));

    // ---- the control offers the three, and marks the one in force ----
    const opts = await $(`[...document.querySelectorAll('#theme-seg .seg-btn')].map(b => b.dataset.theme)`);
    check('el control ofrece las tres', JSON.stringify(opts) === '["auto","light","dark"]',
      opts.join(', '));
    check('y marca la que está puesta',
      (await $(`document.querySelector('#theme-seg .seg-btn.active').dataset.theme`)) === 'dark',
      await $(`document.querySelector('#theme-seg .seg-btn.active').dataset.theme`));

    // ---- explicit choices ----
    await pick('light');
    check('elegir Light lo aplica', (await showing()) === 'light', await showing());
    check('y se guarda', (await storedTheme('light')) === 'light', JSON.stringify(settings().theme));

    // ---- auto: driven, not read ----
    // themeSource es lo que Electron le enseña a prefers-color-scheme, así que
    // esto es el ajuste del sistema visto desde la app.
    nativeTheme.themeSource = 'dark';
    await pick('auto');
    await pause(300);
    check('en Auto, un sistema oscuro pinta oscuro', (await showing()) === 'dark', await showing());

    // Y cambia con él, sin reabrir: la máquina puede cambiar sola al anochecer.
    nativeTheme.themeSource = 'light';
    await pause(400);
    check('y sigue al sistema cuando cambia solo', (await showing()) === 'light', await showing());

    check('lo guardado es "auto", no el color de hoy',
      (await storedTheme('auto')) === 'auto', JSON.stringify(settings().theme));

    // ---- the corner button still works, and commits to a side ----
    // Sobre "auto" no puede alternar: caería en lo que el sistema ya era.
    await $(`document.getElementById('btn-theme').click()`);
    await pause(250);
    check('el atajo de la esquina sale de Auto a un lado concreto',
      ['light', 'dark'].includes(settings().theme), JSON.stringify(settings().theme));
    check('y el control lo refleja',
      (await $(`document.querySelector('#theme-seg .seg-btn.active').dataset.theme`)) === settings().theme,
      await $(`document.querySelector('#theme-seg .seg-btn.active').dataset.theme`));

    // ---- el arranque siguiente ----
    // Main resuelve lo guardado por su cuenta, antes de que exista la página.
    // Si se desincroniza de aquí, el arranque abre con un destello.
    await pick('auto');
    nativeTheme.themeSource = 'dark';
    await pause(300);
    win.webContents.reload();
    await new Promise(r => win.webContents.once('did-finish-load', r));
    await pause(900);
    // Una sola copia. La página tenía la suya en localStorage y las dos se
    // separaron: los ajustes decían "auto" mientras aquella decía "light", así
    // que main pintaba la ventana de un color y la página se dibujaba del otro
    // — con el sistema en oscuro y la app abriendo en claro sin que nadie lo
    // hubiera elegido.
    check('la página no guarda su propia copia',
      (await $(`localStorage.getItem('yapper-theme')`)) === null,
      await $(`localStorage.getItem('yapper-theme')`));

    check('al reabrir sigue en Auto',
      (await $(`document.querySelector('#theme-seg .seg-btn.active').dataset.theme`)) === 'auto',
      await $(`document.querySelector('#theme-seg .seg-btn.active').dataset.theme`));
    check('y Auto vuelve a resolver contra el sistema de ahora',
      (await showing()) === 'dark', await showing());

    // Un perfil que arrastra la copia vieja no puede volver a mandar: lo que
    // vale es lo guardado, y una recarga con basura en localStorage lo prueba.
    await $(`localStorage.setItem('yapper-theme', 'light')`);
    win.webContents.reload();
    await new Promise(r => win.webContents.once('did-finish-load', r));
    await pause(900);
    check('una copia vieja en la página no gana',
      (await $(`document.querySelector('#theme-seg .seg-btn.active').dataset.theme`)) === 'auto',
      await $(`document.querySelector('#theme-seg .seg-btn.active').dataset.theme`));
  } catch (err) {
    fails++;
    say('FAIL  ' + (err.stack || err.message));
  }
  nativeTheme.themeSource = 'system';
  clearTimeout(timer);
  say(fails ? `\n${fails} fallos` : '\nPASS');
  app.exit(fails ? 1 : 0);
});
