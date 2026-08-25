const { app, BrowserWindow, ipcMain: electronIpcMain, session, desktopCapturer, shell, dialog, screen,
  Notification, globalShortcut, safeStorage, powerSaveBlocker, powerMonitor,
  Tray, Menu, nativeImage, systemPreferences, nativeTheme, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

// YAPPER_HOME: everything the app writes — settings, index, reminders, meetings
// and the engine — under one directory of your choosing. It exists so the
// packaged app can be launched against scratch storage (build/packaged-launch-
// check.sh) and so a second copy can run without touching the real one; the
// single-instance lock lives in userData, so it moves with it.
if (process.env.YAPPER_HOME) {
  const home = path.resolve(process.env.YAPPER_HOME);
  app.setPath('userData', path.join(home, 'user'));
  app.setPath('documents', home);
}

const os = require('os');

const { clampToArea } = require('./bounds');
const loginitem = require('./loginitem');
const engine = require('./engine');
const live = require('./live');
const llm = require('./llm');
const keystore = require('./keystore');
const library = require('./library');
const actions = require('./actions');
const search = require('./search');
const digest = require('./digest');
const provision = require('./provision');
const sysaudio = require('./sysaudio');
const speakerDiarizer = require('./speaker-diarizer');
const { pathToFileURL } = require('url');
const { resolveDirectChild, resolveRegularFile, resolveDirectFile,
  resolveDirectFileForWrite } = require('./security');
const { atomicWriteFileSync, readMeetingText, writeMeetingText,
  meetingFileExists } = require('./storage');

const MEETINGS_DIR = path.join(app.getPath('documents'), 'Meetings');
const RENDERER_DIR = path.join(__dirname, 'renderer');
const APP_SCHEME = 'yapper';
const appPageUrl = name => `${APP_SCHEME}://app/${name}`;
const MAIN_PAGE_URL = appPageUrl('index.html');
const BUBBLE_PAGE_URL = appPageUrl('bubble.html');
const SPLASH_PAGE_URL = appPageUrl('splash.html');

protocol.registerSchemesAsPrivileged([{
  scheme: APP_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true }
}]);

function pageUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    parsed.search = '';
    return parsed.href;
  } catch {
    return '';
  }
}

/** Keep a privileged renderer on the one local document it was built for. */
function lockWindowToPage(browserWindow, allowedUrl) {
  const allowed = pageUrl(allowedUrl);
  const contents = browserWindow.webContents;
  contents.on('will-navigate', (event, url) => {
    if (pageUrl(url) !== allowed) event.preventDefault();
  });
  contents.on('will-redirect', (event, url) => {
    if (pageUrl(url) !== allowed) event.preventDefault();
  });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-attach-webview', event => event.preventDefault());
}

/** Serve only bundled renderer assets, with no file:// privileges. */
function registerAppProtocol() {
  return protocol.handle(APP_SCHEME, request => {
    let url;
    try { url = new URL(request.url); } catch { return new Response('Not found', { status: 404 }); }
    if (url.host !== 'app' || url.username || url.password || url.port) {
      return new Response('Not found', { status: 404 });
    }
    let relative;
    try { relative = decodeURIComponent(url.pathname).replace(/^\/+/, ''); } catch {
      return new Response('Not found', { status: 404 });
    }
    const file = path.resolve(RENDERER_DIR, relative);
    if (!relative || (file !== RENDERER_DIR && !file.startsWith(RENDERER_DIR + path.sep))) {
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(file).href);
  });
}

// An installed copy runs from a read-only asar and cannot keep the 1.3 GB
// engine next to its code the way a development checkout does. It lives in a
// per-machine folder instead, downloaded on first run (provision.js). The
// calibration sample has to be repointed too: this process can read inside the
// asar, but the whisper server is a separate process that cannot.
if (app.isPackaged) {
  engine.setHome(engineHome());
  engine.setCalibrationWav(path.join(__dirname, 'build', 'calibration.wav')
    .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`));
}

// Two instances would fight over the whisper server's port and the settings
// file, and an installed app gets double-launched all the time. The second
// launch hands over to the first and exits.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

// One-time migration from the old Spanish folder/file names
function migrateOldData() {
  const oldDir = path.join(app.getPath('documents'), 'Reuniones');
  if (fs.existsSync(oldDir)) {
    fs.mkdirSync(MEETINGS_DIR, { recursive: true });
    for (const name of fs.readdirSync(oldDir)) {
      const dst = path.join(MEETINGS_DIR, name);
      if (!fs.existsSync(dst)) fs.renameSync(path.join(oldDir, name), dst);
    }
    try { fs.rmdirSync(oldDir); } catch { /* not empty, leave it */ }
  }
  if (!fs.existsSync(MEETINGS_DIR)) return;
  const renames = [
    ['grabacion.webm', 'recording.webm'],
    ['transcripcion.txt', 'transcript.txt'],
    ['resumen.md', 'notes.md'],
    ['titulo.txt', 'title.txt']
  ];
  for (const dirent of fs.readdirSync(MEETINGS_DIR, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    for (const [oldName, newName] of renames) {
      const oldPath = path.join(MEETINGS_DIR, dirent.name, oldName);
      const newPath = path.join(MEETINGS_DIR, dirent.name, newName);
      if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) fs.renameSync(oldPath, newPath);
    }
  }
}
// Where the Claude CLI hides when it is not on PATH — which for a GUI app on
// macOS is always, since launchd gives apps a bare PATH without /opt/homebrew.
const CLAUDE_FALLBACKS = process.platform === 'win32'
  ? [path.join(app.getPath('home'), '.local', 'bin', 'claude.exe')]
  : [
    path.join(app.getPath('home'), '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude'
  ];

let win;
let bubble = null;

const BUBBLE_IPC = new Set([
  'get-theme', 'bubble-resize', 'bubble-stop', 'bubble-pause', 'bubble-focus-main'
]);

function trustedRenderer(event, channel) {
  const frame = event && event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) return false;
  const current = pageUrl(frame.url);
  if (win && !win.isDestroyed()
      && event.sender === win.webContents && current === MAIN_PAGE_URL) return true;
  return BUBBLE_IPC.has(channel)
    && bubble && !bubble.isDestroyed()
    && event.sender === bubble.webContents && current === BUBBLE_PAGE_URL;
}

function assertTrustedRenderer(event, channel) {
  if (trustedRenderer(event, channel)) return;
  const source = event && event.senderFrame && event.senderFrame.url || 'unknown frame';
  console.warn(`[security] blocked IPC ${channel} from ${source}`);
  throw new Error('This request did not come from a trusted Yapper window.');
}

// Every renderer-to-main channel passes through this gate. This includes
// sendSync (the initial theme), ordinary sends and request/response handlers.
const ipcMain = {
  handle(channel, listener) {
    return electronIpcMain.handle(channel, (event, ...args) => {
      assertTrustedRenderer(event, channel);
      return listener(event, ...args);
    });
  },
  on(channel, listener) {
    return electronIpcMain.on(channel, (event, ...args) => {
      try {
        assertTrustedRenderer(event, channel);
      } catch {
        if (channel === 'get-theme') event.returnValue = null;
        return;
      }
      return listener(event, ...args);
    });
  }
};

function broadcast(channel, payload) {
  for (const w of [win, bubble]) {
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

// Small always-on-top window showing the live transcript while recording.
// Where the capsule appears when a recording starts. It does not remember
// being dragged — every meeting puts it back — so the corner it starts in is
// the one it lives in for most people, and the bottom right is the wrong one
// as often as it is the right one: it sits on exactly the strip of screen a
// video call fills with its own controls.
const BUBBLE_INSET = 24;   // gap from the edge when it first appears
const BUBBLE_CORNERS = new Set(['top-left', 'top-right', 'bottom-left', 'bottom-right']);

// Top right by default. The bottom is where a video call puts its own
// controls — the strip most likely to be covered exactly while it matters —
// and the right keeps it clear of the window's own content. The notch sits at
// the top of the *centre*, and the top corners stay out of its band anyway;
// see NOTCH_SAFE_TOP.
const DEFAULT_CORNER = 'top-right';

// The work area already begins below the menu bar, and on a notched Mac the
// menu bar is tall enough to contain the notch — so a window inside it cannot
// reach one. Except with the menu bar set to hide automatically: the work area
// then starts at the very top of the display, and a capsule placed there on a
// 14" or 16" MacBook is cut in half by the notch. There is no notch API to
// ask, so the top edge keeps a menu bar's worth of room whether or not one is
// currently shown.
const NOTCH_SAFE_TOP = 40;

/** The corner the capsule is asked to live in, defaulted and validated once. */
function bubbleCorner() {
  const c = readSettings().bubbleCorner;
  return BUBBLE_CORNERS.has(c) ? c : DEFAULT_CORNER;
}

function bubbleOrigin(w, h) {
  // workArea, not workAreaSize: the latter is width and height with no origin,
  // so "top" came out as y=24 in screen coordinates — underneath the menu bar
  // on macOS, and underneath a top-docked taskbar on Windows. The work area
  // knows where it actually begins.
  const display = screen.getPrimaryDisplay();
  const area = display.workArea;
  const [vertical, horizontal] = bubbleCorner().split('-');
  return {
    x: horizontal === 'left' ? area.x + BUBBLE_INSET : area.x + area.width - w - BUBBLE_INSET,
    y: vertical === 'top'
      ? Math.max(area.y + BUBBLE_INSET, display.bounds.y + NOTCH_SAFE_TOP)
      : area.y + area.height - h - BUBBLE_INSET
  };
}

function createBubble() {
  if (bubble && !bubble.isDestroyed()) { bubble.showInactive(); return; }
  const w = 470, h = 280;   // matches EXPANDED in bubble.js; it resizes itself if collapsed
  const { x, y } = bubbleOrigin(w, h);
  bubble = new BrowserWindow({
    width: w,
    height: h,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  lockWindowToPage(bubble, BUBBLE_PAGE_URL);
  bubble.setAlwaysOnTop(true, 'screen-saver');
  bubble.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  bubble.loadURL(BUBBLE_PAGE_URL);
  bubble.once('ready-to-show', () => { bubble.showInactive(); keepBubbleOnScreen(); });
  bubble.on('moved', keepBubbleOnScreen);          // after the user drags it
  bubble.on('closed', () => { bubble = null; stopBubbleHoverWatch(); });
  startBubbleHoverWatch();
}

function destroyBubble() {
  stopBubbleHoverWatch();
  if (bubble && !bubble.isDestroyed()) bubble.close();
  bubble = null;
}

// The pill opens on hover, but hover cannot be seen from inside the page: the
// pill is one big drag region so it can be moved, and Electron never delivers
// mouse events over a drag region — on Windows, and on macOS too (checked on
// macOS 27 / Electron 39 with a real cursor: no mouseenter, no mousemove, no
// mouseleave over a drag region; all three over the same window without it).
// So the cursor is watched from here instead, against the window's bounds, and
// enter/leave is pushed through the same bubble-state channel as everything
// else. The bounds are cached — they only change when the window moves or is
// resized — so each tick is one window-server call, not two.
//
// The expanded window is anchored at the same bottom-right corner and is
// strictly larger, so opening always keeps the cursor inside — hover cannot
// flap open/closed on its own.
let bubbleHoverTimer = null;
let bubbleHovered = false;
let bubbleBounds = null;

function startBubbleHoverWatch() {
  if (bubbleHoverTimer) return;
  bubbleHovered = false;
  bubbleBounds = null;
  const remember = () => { if (bubble && !bubble.isDestroyed()) bubbleBounds = bubble.getBounds(); };
  if (bubble && !bubble.isDestroyed()) {
    bubble.on('move', remember);
    bubble.on('resize', remember);
  }
  bubbleHoverTimer = setInterval(() => {
    if (!bubble || bubble.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    if (!bubbleBounds) remember();
    const b = bubbleBounds;
    const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
    if (inside !== bubbleHovered) {
      bubbleHovered = inside;
      bubble.webContents.send('bubble-state', { hover: inside });
    }
  }, 130);
}

function stopBubbleHoverWatch() {
  if (bubbleHoverTimer) clearInterval(bubbleHoverTimer);
  bubbleHoverTimer = null;
  bubbleHovered = false;
  bubbleBounds = null;
}

// The bubble is frameless, so Windows will happily let it be dragged off the
// screen — and with its header gone there is no way to stop or close it. Pull
// it back inside the work area of whichever display it mostly sits on.
const BUBBLE_MARGIN = 8;

function keepBubbleOnScreen() {
  if (!bubble || bubble.isDestroyed()) return;
  const b = bubble.getBounds();
  const area = screen.getDisplayMatching(b).workArea;
  const c = clampToArea(b, area, BUBBLE_MARGIN);
  if (c.x !== b.x || c.y !== b.y) bubble.setBounds(c);
}

ipcMain.handle('bubble-show', async () => { createBubble(); });
ipcMain.handle('bubble-hide', async () => { destroyBubble(); });
ipcMain.on('bubble-state', (_e, state) => {
  if (bubble && !bubble.isDestroyed()) bubble.webContents.send('bubble-state', state);
});

// Collapsing/expanding keeps the bottom-right corner pinned, so the pill never
// walks across the screen as it changes size.
ipcMain.on('bubble-resize', (_e, size) => {
  if (!bubble || bubble.isDestroyed() || !size) return;
  const b = bubble.getBounds();
  // A capsule that expands has to grow *away* from the nearest edges, or it
  // walks off the screen. Which edges those are is decided by where the window
  // actually sits, not by the corner it was born in: once it has been dragged,
  // the setting says nothing about its surroundings, and anchoring to it made
  // a capsule dropped in the middle of the screen jump 348 px sideways to open.
  const area = screen.getDisplayMatching(b).workArea;
  // A capsule still sitting where its corner puts it is re-placed, not moved
  // by arithmetic. Fractional display scales (first seen on a Windows machine
  // at 1.104) round every setBounds through physical pixels, so edge
  // arithmetic drifts a few pixels per resize — and since hovering resizes
  // twice, a capsule would slowly walk out of its corner over a meeting.
  const home = bubbleOrigin(b.width, b.height);
  if (Math.abs(b.x - home.x) <= 8 && Math.abs(b.y - home.y) <= 8) {
    const o = bubbleOrigin(size.w, size.h);
    bubble.setBounds({ x: o.x, y: o.y, width: size.w, height: size.h });
  } else {
    // Dragged somewhere of its own: grow away from the nearest edges, decided
    // by where it actually sits — anchoring to the configured corner made a
    // capsule dropped mid-screen jump 348 px sideways to open.
    const horizontal = (b.x + b.width / 2) < (area.x + area.width / 2) ? 'left' : 'right';
    const vertical = (b.y + b.height / 2) < (area.y + area.height / 2) ? 'top' : 'bottom';
    bubble.setBounds({
      x: horizontal === 'left' ? b.x : b.x + b.width - size.w,
      y: vertical === 'top' ? b.y : b.y + b.height - size.h,
      width: size.w,
      height: size.h
    });
  }
  keepBubbleOnScreen();   // expanding near an edge must not push it off
});
// Bubble -> main window controls
ipcMain.on('bubble-stop', () => {
  if (win && !win.isDestroyed()) win.webContents.send('remote-stop');
});
ipcMain.on('bubble-pause', () => {
  if (win && !win.isDestroyed()) win.webContents.send('remote-pause');
});
ipcMain.on('bubble-focus-main', () => {
  showMainWindow();
});

function showMainWindow() {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); }
  if (process.platform === 'darwin') app.focus({ steal: true });
}

// ---------- permissions, asked once and early ----------
// macOS asks the first time something is used, which for a meeting recorder is
// the worst possible moment: the call has started, the other side is talking,
// and the app is putting dialogs on screen. Worse, the system-audio one is not
// a yes/no — it needs the app reopened before it takes effect — so answering it
// mid-meeting still leaves that meeting recorded one-sided.
//
// So they are asked at launch instead. The microphone has an API for it.
// System audio does not: the permission is triggered by *creating* a tap, so
// the helper is run for a moment and stopped. It captures nothing that is kept.
//
// Every launch, with no "already asked" flag. The first version kept one keyed
// to the app version and it was wrong in the way that matters: macOS drops
// these permissions when an app's *code identity* changes, which for an
// ad-hoc signature is every single build. Six reinstalls later the permissions
// were gone and the flag still said they had been asked for, so the app went
// back to asking mid-meeting — the exact thing this exists to prevent. The
// probe is cheap and it stops the moment the helper says it is capturing, so
// a machine that has already granted it pays a few hundred milliseconds.

const PERMISSION_PROBE_MS = 2500;

async function primePermissions() {
  if (process.platform !== 'darwin') return;

  try {
    if (systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
      await systemPreferences.askForMediaAccess('microphone');
    }
  } catch (err) {
    console.log('[permissions] could not ask for the microphone:', err.message);
  }

  const helper = helperPath('system-audio');
  if (!fs.existsSync(helper)) return;

  // Before spawning one of our own: a helper left by a run that died still
  // holds a tap, and stacking another on top of it would prime nothing.
  const orphans = sysaudio.reapOrphans(helper);
  if (orphans) console.log(`[permissions] cleared ${orphans} helper(s) from a previous run`);

  await new Promise(resolve => {
    let proc;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { proc.kill(); } catch { /* already gone */ }
      resolve();
    };
    try {
      proc = spawn(helper, []);
    } catch (err) {
      console.log('[permissions] could not start the audio helper:', err.message);
      return resolve();
    }
    // Drained, not read: a helper whose stdout nobody empties blocks on it.
    proc.stdout.on('data', () => { });
    // "capturing" means the permission is already there — stop at once rather
    // than hold a tap for two seconds to learn nothing.
    proc.stderr.on('data', d => { if (/capturing/.test(String(d))) finish(); });
    proc.on('error', finish);
    proc.on('close', () => { settled = true; resolve(); });
    setTimeout(finish, PERMISSION_PROBE_MS);
  });
}

// ---------- the application menu ----------
// Electron ships a default one and it is not this app's: it names itself from
// package.json, so it read "yapper" in lower case; File offers only Close
// Window; and View hands every user Reload and Toggle Developer Tools. A menu
// bar that offers nothing the app does, and several things it should not, is
// worse than the absence people notice.
//
// What it carries instead is what the menu bar is for on macOS: the two
// actions that matter reachable by keyboard, the editing roles the text fields
// need, and the developer items only where a developer is.

function buildAppMenu() {
  const recording = () => rendererRecording;
  const send = channel => () => {
    showMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel);
  };
  // One channel for the rest: the renderer owns the views, so the menu only
  // names what it wants and the page decides what that means right now.
  const command = name => () => {
    showMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('ui-command', name);
  };

  return Menu.buildFromTemplate([
    // The app-name menu and its roles are macOS furniture; Windows has no
    // place to put them and renders them as oddities.
    ...(process.platform === 'darwin' ? [{
      label: 'Yapper',
      submenu: [
        { role: 'about', label: 'About Yapper' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: command('settings') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: 'Hide Yapper' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        // Here rather than buried in Settings: it is the last thing anybody
        // wants from an app, and the only place it can be done completely.
        ...(canUninstallSelf() ? [{ label: 'Uninstall Yapper…', click: () => uninstallSelf() }] : []),
        { role: 'quit', label: 'Quit Yapper' }
      ]
    }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New meeting',
          accelerator: 'CmdOrCtrl+N',
          enabled: !recording(),
          click: send('start-recording')
        },
        {
          label: 'Stop recording',
          accelerator: 'CmdOrCtrl+.',
          enabled: recording(),
          click: send('remote-stop')
        },
        { type: 'separator' },
        { label: 'Export…', accelerator: 'CmdOrCtrl+E', click: command('export') },
        // macOS keeps Settings in the app menu above; Windows has no such menu
        ...(process.platform === 'darwin' ? [] : [
          { type: 'separator' },
          { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: command('settings') }
        ]),
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Copy notes as Markdown', accelerator: 'CmdOrCtrl+Shift+C', click: command('copy-notes') },
        { label: 'Rename meeting', accelerator: 'CmdOrCtrl+Shift+R', click: command('rename') }
      ]
    },
    {
      label: 'Go',
      submenu: [
        { label: 'Today', accelerator: 'CmdOrCtrl+1', click: command('home') },
        { label: 'Action items', accelerator: 'CmdOrCtrl+2', click: command('actions') },
        { label: 'Search', accelerator: 'CmdOrCtrl+K', click: command('search') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        // Only where there is someone to use them. Shipping Reload and the
        // developer tools to everyone is how a recording gets thrown away by
        // a stray Cmd+R.
        ...(app.isPackaged ? [] : [
          { type: 'separator' },
          { role: 'reload' },
          { role: 'toggleDevTools' }
        ])
      ]
    },
    ...(process.platform === 'darwin' ? [{
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
    }] : []),
    {
      label: 'Help',
      submenu: [{
        label: 'Yapper on GitHub',
        click: () => shell.openExternal('https://github.com/iamchuck504/yapper')
      }]
    }
  ]);
}

// On macOS the menu bar is the app's face. On Windows the window hides its
// menu bar (autoHideMenuBar) — but "no menu of ours" does not mean "no menu":
// Electron installs its default one, whose accelerators keep working while
// hidden, and that default carries Reload. A stray Ctrl+R during a meeting
// reloads the renderer with the recording in it — the exact hazard the menu
// was rebuilt to remove on macOS, alive on Windows until this stopped
// returning early.
function refreshAppMenu() {
  Menu.setApplicationMenu(buildAppMenu());
}

// ---------- the menu bar ----------
// The app spends a meeting behind the call it is recording, so what it most
// needs is a way to start and stop without being found first. On macOS that is
// the menu bar. It is also the only honest place to answer "is this recording
// right now?" while the window is buried three spaces away — the floating
// bubble answers it too, but the bubble can be closed and this cannot.
//
// The icon is a template image: black artwork carried by its alpha, which
// macOS repaints for a light menu bar, a dark one, and the inverted state
// while the menu is open. Handing it the amber tile would put a coloured
// square up there that goes muddy in half of those. build/icon-tray.js writes
// it from the same artwork the app icon comes from.

let tray = null;

function trayMenu() {
  return Menu.buildFromTemplate([
    rendererRecording
      ? {
        label: 'Stop recording',
        click: () => { if (win && !win.isDestroyed()) win.webContents.send('remote-stop'); }
      }
      : {
        label: 'New meeting',
        click: () => {
          showMainWindow();
          if (win && !win.isDestroyed()) win.webContents.send('start-recording');
        }
      },
    { type: 'separator' },
    { label: 'Open Yapper', click: showMainWindow },
    { type: 'separator' },
    { label: 'Quit Yapper', click: () => app.quit() }
  ]);
}

/** Keep the menu bar honest about what the app is doing. */
function refreshTray() {
  if (!tray || tray.isDestroyed()) return;
  tray.setToolTip(rendererRecording ? 'Yapper — recording' : 'Yapper');
  if (process.platform === 'darwin') {
    // A template image cannot carry colour, so the state is said with a dot
    // beside it rather than by tinting the mark red and hoping.
    tray.setTitle(rendererRecording ? ' ●' : '');
  } else if (trayIcons) {
    // No setTitle off macOS: the recording state is the icon itself, the same
    // ink tile with an amber dot burned into the corner.
    tray.setImage(rendererRecording ? trayIcons.recording : trayIcons.resting);
  }
  tray.setContextMenu(trayMenu());
}

let trayIcons = null;

function createTray() {
  if (tray) return;
  if (process.platform === 'darwin') {
    const icon = nativeImage.createFromPath(
      path.join(__dirname, 'build', 'yapper-tray-Template.png'));
    if (icon.isEmpty()) {
      // Not worth failing a launch over: everything the menu bar offers is
      // reachable from the window.
      return console.log('[tray] icon missing; no menu bar item this run');
    }
    icon.setTemplateImage(true);
    tray = new Tray(icon);
  } else if (process.platform === 'win32') {
    // The same argument as the macOS menu bar item: a meeting is spent behind
    // the call being recorded, and the tray is where stop lives on Windows.
    // Colour is welcome here, so it wears the app icon rather than a template.
    const resting = nativeImage.createFromPath(
      path.join(__dirname, 'build', 'yapper-tray-win.png'));
    const recording = nativeImage.createFromPath(
      path.join(__dirname, 'build', 'yapper-tray-win-rec.png'));
    if (resting.isEmpty() || recording.isEmpty()) {
      return console.log('[tray] icon missing; no tray this run');
    }
    trayIcons = { resting, recording };
    tray = new Tray(resting);
    // Windows convention: a click on the tray icon brings the app up.
    tray.on('click', showMainWindow);
  } else {
    return;
  }
  refreshTray();
}

/**
 * Dark or light, for painting something before the stylesheet lands.
 *
 * The preference is what the user chose — `auto` defers to the system, and
 * anything unset is dark. Resolved here as well as in the renderer because the
 * window and the splash are painted before any of that page runs.
 */
function darkNow() {
  const pref = readSettings().theme;
  if (pref === 'auto') return nativeTheme.shouldUseDarkColors;
  return pref !== 'light';
}

function createWindow() {
  // The last theme is remembered so the window paints its own background colour
  // instead of flashing white before the stylesheet lands.
  const dark = darkNow();
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: dark ? '#0C0D10' : '#FBFAF8',
    show: false,              // revealed by the splash hand-off
    autoHideMenuBar: true,
    title: 'Yapper',
    icon: appIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  lockWindowToPage(win, MAIN_PAGE_URL);

  // Whether this window is actually on screen. The page cannot answer that
  // for itself once background throttling is off: Chromium then keeps
  // `document.hidden` false for a window that is hidden or minimized, which
  // is the point — the page keeps running — but it also means the page would
  // happily paint into a canvas nobody can see. So the answer comes from
  // here, where it is known, and is sent whenever it changes.
  const sayVisible = () => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('window-visible', win.isVisible() && !win.isMinimized());
  };
  for (const e of ['show', 'hide', 'minimize', 'restore', 'maximize', 'unmaximize']) win.on(e, sayVisible);
  win.webContents.on('did-finish-load', sayVisible);
  win.webContents.on('render-process-gone', (_event, details) => {
    abandonRendererRecording(`renderer ${details.reason || 'gone'}`);
  });
  win.webContents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => {
    if (isMainFrame && !inPlace) abandonRendererRecording('main-frame navigation');
  });

  // Belt and braces for the taskbar: running unpackaged, the process is
  // electron.exe, and Windows will happily show its icon for the button unless
  // the window says otherwise.
  try { win.setIcon(appIconPath()); } catch { /* the constructor already tried */ }

  // Chromium permissions are denied unless the request comes from the main,
  // top-level Yapper document. The bubble and any unexpected navigation get
  // no microphone, camera, screen or other browser capability.
  const allowedPermissions = new Set(['media', 'display-capture']);
  const trustedMainContents = contents => win && !win.isDestroyed()
    && contents === win.webContents && pageUrl(contents.getURL()) === MAIN_PAGE_URL;
  session.defaultSession.setPermissionCheckHandler((contents, permission) =>
    allowedPermissions.has(permission) && trustedMainContents(contents));
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(allowedPermissions.has(permission) && trustedMainContents(contents));
  });

  // Windows loopback: hands over system audio only when the trusted main frame
  // calls getDisplayMedia.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const frame = request && request.frame;
    if (!frame || frame !== win.webContents.mainFrame || pageUrl(frame.url) !== MAIN_PAGE_URL) {
      callback({});
      return;
    }
    desktopCapturer.getSources({ types: ['screen'] }).then(sources => {
      if (!sources.length) callback({});
      else callback({ video: sources[0], audio: 'loopback' });
    }).catch(() => callback({}));
  }, { useSystemPicker: false });

  win.loadURL(MAIN_PAGE_URL);
}

// ---------- app settings (kept in userData, not in the renderer) ----------

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}
function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}
/**
 * Merged onto whatever is on disk, not written over it.
 *
 * Callers read the file, change a field and write the whole object back, and
 * two of them overlapping meant the slower one restored every field the other
 * had just changed. It is not hypothetical: the first-run calibration reads at
 * launch and writes seconds later, so a theme chosen in between was silently
 * discarded — and the only symptom is a setting that did not stick.
 */
function writeSettings(s, drop = []) {
  let onDisk = {};
  try { onDisk = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { /* first write */ }
  const merged = { ...onDisk, ...s };
  // Removing a key is the one thing a merge cannot express, and two callers do
  // it on purpose: the legacy single key slot and an old keepAudio that must
  // not linger. They say so rather than relying on absence.
  for (const k of drop) delete merged[k];
  atomicWriteFileSync(settingsFile(), JSON.stringify(merged, null, 2));
}
const LEGACY_LLM_KEYS = ['llmKey', 'llmModel', 'llmBaseUrl'];

// Start with Windows. Defaults to on, but only the first time — after that the
// user's choice is what counts. macOS does not work that way and no longer
// pretends to: loginitem.js holds everything that can be decided about it, and
// nothing there registers anything the user did not ask for.

// The filesystem questions loginitem.js asks. They live here so
// the decisions that depend on them can be tested without one.
const bundleIO = {
  isDirectory(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
  // Structured, because the difference between "it is not there" and "I was
  // not allowed to look" decides whether a path may be deleted. Handing back
  // the path unchanged on failure is what would let a comparison against a
  // canonical path quietly become a comparison against a guess.
  realpath(p) {
    try { return { path: fs.realpathSync(p) }; } catch (e) { return { code: e.code || 'EIO' }; }
  },
  identity(p) {
    try { const st = fs.statSync(p); return { dev: st.dev, ino: st.ino }; }
    catch (e) { return { code: e.code || 'EIO' }; }
  },
  // Ask about this exact path every time a new decision starts. Structured
  // libxo output keeps control characters in a mount name inside JSON instead
  // of letting them create a second, convincing-looking output line. `-n`
  // avoids refreshing network statistics, and the timeout bounds a filesystem
  // that does not answer; callers fail closed on every such failure.
  mountPoint(p) {
    try {
      const out = execFileSync('/bin/df', ['-n', '--libxo', 'json', '-P', p], {
        encoding: 'utf8', maxBuffer: 64 * 1024, timeout: 2000, killSignal: 'SIGKILL'
      });
      return loginitem.parseDfMountPoint(out);
    } catch (e) {
      return { code: e.code || 'EIO' };
    }
  },
  // EROFS is a read-only filesystem. EACCES and EPERM are a directory this
  // account may not write to, which is what /Applications answers on a Mac
  // where the user is not an admin — still an install. Anything else is a
  // question that did not get answered, and 'error' is what says so: it must
  // not be folded into 'denied', which is a permission and reads as fine.
  writeStatus(p) {
    try { fs.accessSync(p, fs.constants.W_OK); return 'writable'; } catch (e) {
      if (e.code === 'EROFS') return 'read-only';
      if (e.code === 'ENOENT') return 'missing';
      if (e.code === 'EACCES' || e.code === 'EPERM') return 'denied';
      return 'error';
    }
  }
};

// Where an installed copy lives. Not a guess from the shape of a path: a copy
// has to be directly under one of these before it may register itself or
// remove itself. loginitem.js says why, and what it costs.
function installRoots() {
  return ['/Applications', path.join(app.getPath('home'), 'Applications')];
}

// What was running at startup is worked out once so later checks can prove the
// bundle is still the same directory on the same mounted volume. A path lookup
// can change under a running process even though the process itself does not.
let macRunCache = null;
function classifyMacRun() {
  return loginitem.classifyRun({
      platform: process.platform,
      isPackaged: app.isPackaged,
      exe: app.getPath('exe'),
      tempDirs: [os.tmpdir(), '/private/var/folders', '/private/tmp', '/tmp'],
      installRoots: installRoots(),
      // The startup disk's own mounts, and only those. The home directory is
      // deliberately not here: it is a location, not an authority, and letting
      // it approve its own volume is how a network or external home would have
      // approved itself — which is the opposite of what the docs promise.
      approvedVolumeMounts: ['/', '/System/Volumes/Data'],
      io: bundleIO
  });
}

function macRun() {
  if (!macRunCache) macRunCache = classifyMacRun();
  return macRunCache;
}

function currentMacRun() {
  // UNKNOWN means no proof was ever established, not a stable classification.
  // Retry it so a temporary df/filesystem failure does not disable the switch
  // and uninstaller for the lifetime of the process. A proved PERMANENT run is
  // only revalidated below; a replacement can never be freshly blessed here.
  macRunCache = loginitem.refreshUnknownRun(macRun(), classifyMacRun);
  return loginitem.revalidateRun(macRun(), bundleIO);
}

function loginItemDeps() {
  return {
    run: currentMacRun,
    getLoginItem: () => app.getLoginItemSettings(),
    setLoginItem: on => app.setLoginItemSettings({ openAtLogin: on }),
    readSettings,
    writeSettings
  };
}

function applyOpenAtLogin(enabled) {
  // macOS is not registered from here at all — startup registering anything is
  // the bug loginitem.js exists to prevent. Windows is unchanged: it needs
  // process.execPath and the app directory, and its settings file is the
  // record, because there the path is what gets registered.
  if (process.platform === 'win32') {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: process.execPath,
      args: [path.resolve(__dirname)]
    });
  }
}

function initOpenAtLogin() {
  if (process.platform === 'darwin') {
    const now = loginitem.initMac(loginItemDeps());
    // The support answer to "the switch is on and nothing starts at login", and
    // to "why is the uninstaller missing": which copy this is decides both.
    console.log(`[login-item] ${macRun().kind} copy · open at login: ${now.state}`
      + ` · uninstall ${canUninstallSelf() ? 'offered' : 'not offered'}`);
    return now.state === 'enabled';
  }
  const s = readSettings();
  if (s.openAtLogin === undefined) {
    s.openAtLogin = true;
    writeSettings(s);
  }
  applyOpenAtLogin(s.openAtLogin);
  return s.openAtLogin;
}

// What the switch shows. On macOS the system is the record — it can refuse, it
// can want approving first, and the user can revoke it in System Settings
// without telling us — so the answer carries why and not just on or off.
function openAtLoginState() {
  if (process.platform !== 'darwin') {
    return { state: readSettings().openAtLogin !== false ? 'enabled' : 'disabled' };
  }
  const run = currentMacRun();
  if (!loginitem.canRegister(run)) {
    return {
      state: run.kind === loginitem.KIND.UNKNOWN ? 'unknown' : 'unavailable',
      kind: run.kind,
      why: run.why
    };
  }
  return { ...loginitem.readState(app.getLoginItemSettings()), kind: run.kind };
}

// What the renderer paints comes back with the answer, decided in loginitem.js
// where it is tested, rather than worked out again in the page.
function openAtLoginReply(result) {
  return { ...result, view: loginitem.switchView(result) };
}

ipcMain.handle('get-open-at-login', async () => openAtLoginReply(openAtLoginState()));

// ---------- uninstalling ----------
// Dragging the bundle to the Trash is how a Mac app is removed, and it is the
// one route that cannot clean up after itself: the login item is a record in
// the system's background-task database, not a file in the bundle, so deleting
// the bundle strands an entry that System Settings goes on listing and that
// nothing here can reach — by then there is no app left to withdraw it.
//
// Windows ships a real uninstaller, so this is macOS only, and only from a copy
// installed under an approved root on the startup disk: from a disk image, a
// temporary folder or Downloads the bundle is not the one the user keeps, and
// in a dev run it is the checkout's Electron. What may be removed is decided in
// loginitem.js, and nothing is removed until its preflight has shown that the
// settings, the engine and the meetings folder have a proved safe relationship
// to the bundle. Consented data inside it are covered by its move; everything
// else must remain outside or absent until the Trash call.
function canUninstallSelf() {
  return loginitem.canUninstall(currentMacRun());
}

function uninstallDeps() {
  const parent = win && !win.isDestroyed() ? win : null;
  const ask = opts => (parent ? dialog.showMessageBox(parent, opts) : dialog.showMessageBox(opts));
  return {
    run: currentMacRun,
    getLoginItem: () => app.getLoginItemSettings(),
    setLoginItem: on => app.setLoginItemSettings({ openAtLogin: on }),
    confirm: async () => {
      const { response, checkboxChecked } = await ask({
        type: 'warning',
        buttons: ['Move to Trash', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: 'Remove Yapper from this Mac?',
        detail: 'Yapper stops itself opening at login, checks with macOS that it '
          + 'really has, and then moves itself to the Trash. If any of that '
          + 'cannot be done it stops and tells you, rather than half-removing '
          + 'itself.\n\nYour meetings are not touched: they stay in '
          + `${MEETINGS_DIR} as ordinary folders, outside the app.`,
        checkboxLabel: 'Also move settings and the downloaded engine (~600 MB) to the Trash',
        checkboxChecked: false
      });
      return { proceed: response === 0, alsoData: checkboxChecked };
    },
    // The Trash rather than rm: 600 MB of engine and every setting is a lot to
    // take on one click, and this way the click is reversible until it is
    // emptied. Absence is normalized to ENOENT so the caller can recognise it,
    // whatever shape Electron's error takes.
    trash: async (p, proof) => {
      if (!proof || p !== proof.path) {
        return { ok: false, code: 'EINVAL', message: 'The removal path did not match its proof.' };
      }
      const safe = loginitem.verifyPathProof(proof, bundleIO);
      if (!safe.ok) return safe;
      // If it was absent at the proof, stop there. Looking again would let a
      // path created between the two calls be trashed without ever proving it.
      if (safe.missing) return { ok: false, code: 'ENOENT' };
      try { await shell.trashItem(proof.path); return { ok: true }; } catch (e) {
        // Check absence only after a failed Trash. A successful proof already
        // established existence; checking before Trash only widens the window
        // in which that proved directory can be replaced.
        if (!fs.existsSync(proof.path)) return { ok: false, code: 'ENOENT' };
        return { ok: false, code: e.code, message: e.message };
      }
    },
    // Everything that would be touched, worked out and proved separate before
    // the login item — the step that cannot be undone — is touched at all.
    preflight: alsoData => {
      const run = macRun();
      return loginitem.uninstallPreflight({
        bundle: run.bundle,
        bundleIdentity: run.bundleIdentity,
        bundleMount: run.bundleMount,
        userData: app.getPath('userData'),
        engineHome: engineHome(),
        meetings: MEETINGS_DIR,
        alsoData,
        io: bundleIO
      });
    },
    report: async r => {
      await ask({ type: 'warning', buttons: ['OK'], message: r.message, detail: r.detail });
    },
    quit: () => app.quit()
  };
}

async function uninstallSelf() {
  const deps = uninstallDeps();
  const result = await loginitem.uninstall(deps);
  if (result.step === 'unavailable') {
    await deps.report({
      step: 'unavailable',
      message: 'Yapper cannot remove this copy.',
      detail: 'This is no longer the same approved installed bundle Yapper started from, or its'
        + ' mounted volume cannot be proved. Nothing has been changed.'
    });
  }
  return result;
}

ipcMain.handle('get-bubble-corner', async () => bubbleCorner());

ipcMain.handle('set-bubble-corner', async (_e, corner) => {
  if (!BUBBLE_CORNERS.has(corner)) return false;
  const s = readSettings();
  s.bubbleCorner = corner;
  writeSettings(s);
  // Move the one on screen too, so the choice is answered now rather than at
  // the start of some future meeting.
  if (bubble && !bubble.isDestroyed()) {
    const [w, h] = bubble.getSize();
    const { x, y } = bubbleOrigin(w, h);
    bubble.setPosition(x, y);
    keepBubbleOnScreen();
  }
  return true;
});

// ---------- keep the shortcuts showing the current icon ----------
// A .lnk stores its own copy of the icon path, so changing the app's icon does
// nothing to the desktop or the taskbar until the shortcut is rewritten — and
// nobody re-runs setup.ps1 after an update. The app fixes its own shortcuts
// instead, and only when they are actually out of date.

const APP_ID = 'com.yapper.meetingnotes';

function appIconPath() {
  // Installed, the icon is embedded in the exe itself — and the .ico inside the
  // asar is unreadable to the shell anyway. In development, the loose file.
  return app.isPackaged ? process.execPath : path.join(__dirname, 'build', 'yapper-icon.ico');
}

function refreshShortcutIcons() {
  if (process.platform !== 'win32') return;
  const icon = appIconPath();
  if (!fs.existsSync(icon)) return;

  const appData = app.getPath('appData');
  const links = [
    path.join(app.getPath('desktop'), 'Yapper.lnk'),
    // a pinned taskbar button is its own shortcut, kept here by Explorer
    path.join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch',
      'User Pinned', 'TaskBar', 'Yapper.lnk'),
    path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Yapper.lnk')
  ];

  for (const lnk of links) {
    if (!fs.existsSync(lnk)) continue;
    try {
      const cur = shell.readShortcutLink(lnk);
      // The app id has to match what setAppUserModelId says, or Windows treats
      // the running window and the pinned button as two different apps and the
      // taskbar keeps showing its own guess of the icon.
      if (cur.icon === icon && cur.iconIndex === 0 && cur.appUserModelId === APP_ID) continue;
      shell.writeShortcutLink(lnk, 'update', { icon, iconIndex: 0, appUserModelId: APP_ID });
      console.log(`[icon] updated ${path.basename(path.dirname(lnk))}\\${path.basename(lnk)}`);
    } catch (err) {
      console.log(`[icon] could not update ${lnk}: ${err.message}`);
    }
  }
}

// ---------- note provider (bring your own key) ----------
// The key is encrypted with the OS keystore (DPAPI on Windows, Keychain on
// macOS) rather than sitting in a readable JSON file. It never leaves the main
// process: the renderer only ever learns whether one is set.

// A key belongs to the provider it was issued for, so each one gets its own
// slot. Sharing a single slot meant that saving a Gemini key and then switching
// to OpenRouter would have sent Google's key to OpenRouter's servers — and the
// UI would have said "saved", as if that provider were set up.

/** Fold the old single-slot settings into the per-provider map, once. */
function migrateLlmSettings(s) {
  if (!s.llmByProvider) s.llmByProvider = {};
  if (s.llmKey === undefined && s.llmModel === undefined && s.llmBaseUrl === undefined) return false;
  const owner = defaultProvider(s);
  const slot = s.llmByProvider[owner] || {};
  if (s.llmKey && !slot.key) slot.key = s.llmKey;
  if (s.llmModel && !slot.model) slot.model = s.llmModel;
  if (s.llmBaseUrl && !slot.baseUrl) slot.baseUrl = s.llmBaseUrl;
  s.llmByProvider[owner] = slot;
  delete s.llmKey;
  delete s.llmModel;
  delete s.llmBaseUrl;
  return true;
}

/** This provider's stored setup. Migration is the caller's job, once. */
function llmSlot(s, id) {
  return (s.llmByProvider && s.llmByProvider[id]) || { key: null, model: '', baseUrl: '' };
}

/** Everything llm.js needs, assembled from settings. */
function llmConfig() {
  const s = readSettings();
  migrateLlmSettings(s);              // in memory is enough on the read path
  const provider = defaultProvider(s);
  const slot = llmSlot(s, provider);
  return {
    provider,
    apiKey: keystore.open(safeStorage, slot.key),
    model: slot.model || '',
    baseUrl: slot.baseUrl || '',
    claudePath: resolveClaude()
  };
}

ipcMain.handle('get-llm-settings', async () => {
  const s = readSettings();
  // migrate first, and persist it, so the old single slot does not linger in
  // the file where later code could read it by mistake
  if (migrateLlmSettings(s)) writeSettings(s, LEGACY_LLM_KEYS);
  const provider = defaultProvider(s);
  const slot = llmSlot(s, provider);
  return {
    providers: llm.providerList(),
    provider,
    model: slot.model || '',
    baseUrl: slot.baseUrl || '',
    hasKey: !!(slot.key && slot.key.v),
    keyEncrypted: !!(slot.key && slot.key.enc),
    // which other providers are already set up, so switching can say so
    configured: Object.entries(s.llmByProvider || {})
      .filter(([, v]) => v && v.key && v.key.v).map(([k]) => k),
    encryptionAvailable: safeStorage.isEncryptionAvailable()
  };
});

ipcMain.handle('set-llm-settings', async (_e, next) => {
  const s = readSettings();
  migrateLlmSettings(s);
  const provider = next.provider || 'claude-cli';
  s.llmProvider = provider;

  const slot = s.llmByProvider[provider] || { key: null, model: '', baseUrl: '' };
  if (typeof next.model === 'string') slot.model = next.model.trim();
  if (typeof next.baseUrl === 'string') slot.baseUrl = next.baseUrl.trim();
  // an absent key means "leave this provider's stored one alone"; an empty
  // string clears it
  if (typeof next.apiKey === 'string') slot.key = keystore.seal(safeStorage, next.apiKey);
  s.llmByProvider[provider] = slot;

  writeSettings(s);
  envCache = null;                   // the preflight answer just changed
  return true;
});

ipcMain.handle('test-llm', async (_e, override) => {
  const o = override || {};
  const s = readSettings();
  migrateLlmSettings(s);

  // The provider named here decides which key is used — never the stored
  // default merged with a provider the caller supplied. Merging them turned
  // "test this endpoint" into a way to send a key issued for one service to
  // another one entirely.
  const provider = (typeof o.provider === 'string' && llm.PROVIDERS[o.provider])
    ? o.provider
    : defaultProvider(s);
  const slot = llmSlot(s, provider);
  const typed = typeof o.apiKey === 'string' ? o.apiKey.trim() : '';
  const pick = (given, saved) =>
    (typeof given === 'string' && given.trim()) ? given.trim() : (saved || '');

  const cfg = {
    provider,
    // a key typed but not yet saved is honoured; otherwise this provider's own
    apiKey: typed || keystore.open(safeStorage, slot.key),
    model: pick(o.model, slot.model),
    baseUrl: pick(o.baseUrl, slot.baseUrl),
    claudePath: resolveClaude()
  };

  try {
    return await llm.test(cfg);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// The one place the preference is kept. The page used to hold its own copy in
// localStorage, so a profile could carry "light" on one side and "auto" on the
// other — main painting the window one colour and the page rendering the other.
ipcMain.on('get-theme', e => {
  const pref = readSettings().theme;
  e.returnValue = ['auto', 'light', 'dark'].includes(pref) ? pref : 'dark';
});

// The preference itself, not the colour it resolves to today: `auto` has to
// arrive here as `auto` or the next launch would paint whatever the system
// happened to be the last time the app was open.
ipcMain.on('set-theme', (_e, theme) => {
  const s = readSettings();
  const pref = ['auto', 'light', 'dark'].includes(theme) ? theme : 'dark';
  if (s.theme === pref) return;
  s.theme = pref;
  writeSettings(s);
});

// The only place a registration is asked for. It answers with what macOS did,
// which is not always what was asked: it can refuse, and it can decide the user
// has to allow it in System Settings first.
ipcMain.handle('set-open-at-login', async (_e, enabled) => {
  if (process.platform === 'darwin') {
    return openAtLoginReply(loginitem.setMac(loginItemDeps(), !!enabled));
  }
  const s = readSettings();
  s.openAtLogin = !!enabled;
  writeSettings(s);
  applyOpenAtLogin(s.openAtLogin);
  return openAtLoginReply({ state: s.openAtLogin ? 'enabled' : 'disabled' });
});

// ---------- startup splash ----------
// A small branded window covers the boot while the environment is checked, so
// the main window never appears half-ready. It never blocks startup: any
// failure just means no splash.

const MIN_SPLASH_MS = 1400;   // long enough to read, short enough not to annoy
const MAX_SPLASH_MS = 9000;   // safety net so it can never get stuck
const FADE_MS = 260;          // matches the splash's CSS transition

// Window-level opacity tween, used to fade the main window in.
function fadeIn(w, ms) {
  return new Promise(resolve => {
    if (!w || w.isDestroyed()) return resolve();
    const steps = Math.max(1, Math.round(ms / 16));
    let i = 0;
    w.setOpacity(0);
    const timer = setInterval(() => {
      if (w.isDestroyed()) { clearInterval(timer); return resolve(); }
      i++;
      const t = i / steps;
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      w.setOpacity(Math.min(1, eased));
      if (i >= steps) { clearInterval(timer); w.setOpacity(1); resolve(); }
    }, 16);
  });
}

async function bootWithSplash() {
  let splash = null;
  try {
    splash = new BrowserWindow({
      width: 320,
      height: 300,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      title: 'Yapper',
      icon: appIconPath(),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true
      }
    });
    lockWindowToPage(splash, SPLASH_PAGE_URL);
    splash.setMenuBarVisibility(false);
    await splash.loadURL(SPLASH_PAGE_URL);
    // Same theme as the window about to open behind it.
    if (!darkNow()) {
      await splash.webContents
        .executeJavaScript(`document.body.classList.add('light')`)
        .catch(() => { /* splash already gone */ });
    }
    splash.show();
  } catch {
    splash = null;   // boot without it
  }

  // With contextIsolation on, executeJavaScript runs in the isolated world and
  // cannot see the page's own functions — but both worlds share the DOM, so the
  // status node is updated directly.
  const setStatus = text => {
    if (!splash || splash.isDestroyed()) return;
    splash.webContents
      .executeJavaScript(
        `(() => { const el = document.getElementById('status');
                  if (el) el.textContent = ${JSON.stringify(text)}; })()`
      )
      .catch(() => { /* splash already gone */ });
  };

  const started = Date.now();
  let handedOver = false;

  // Hand-off: hold the splash until the app is genuinely ready, then cross-fade
  // — the splash shrinks away while the main window fades up underneath it.
  const handOff = async () => {
    if (handedOver) return;
    handedOver = true;
    await new Promise(r => setTimeout(r, Math.max(0, MIN_SPLASH_MS - (Date.now() - started))));

    if (splash && !splash.isDestroyed()) {
      splash.webContents
        .executeJavaScript("document.body.classList.add('leaving')")
        .catch(() => { /* splash already gone */ });
    }
    // start the window fade a beat later so the two overlap
    setTimeout(() => {
      if (win && !win.isDestroyed()) { win.show(); fadeIn(win, FADE_MS); }
    }, 70);
    setTimeout(() => {
      try { if (splash && !splash.isDestroyed()) splash.destroy(); } catch { /* gone */ }
      splash = null;
    }, FADE_MS + 60);
  };

  // Preflight runs alongside the window load; its result is cached for the
  // renderer so it does not pay for the checks a second time.
  setStatus(readSettings().tier ? 'Checking transcription engine' : 'Measuring this machine');
  const envPromise = checkEnvironment().then(env => {
    setStatus(env.notes && env.notes.ok ? 'Loading' : 'Notes need setup');
    return env;
  }).catch(() => ({ whisper: false, notes: { ok: false } }));

  migrateOldData();
  createWindow();

  win.webContents.once('did-finish-load', async () => {
    await envPromise;
    setStatus('Ready');
    handOff();
    // After the hand-off: a permission dialog belongs over the app, not over
    // the splash it would otherwise interrupt.
    primePermissions().catch(err =>
      console.log('[permissions] priming failed:', err.message));
  });

  // Safety net: never leave the app hidden behind a stuck splash.
  setTimeout(() => {
    if (win && !win.isDestroyed() && !win.isVisible()) { win.setOpacity(1); win.show(); }
    try { if (splash && !splash.isDestroyed()) splash.destroy(); } catch { /* gone */ }
  }, MAX_SPLASH_MS);
}

app.whenReady().then(async () => {
  await registerAppProtocol();
  if (process.platform === 'win32') {
    app.setAppUserModelId(APP_ID);
    refreshShortcutIcons();
  }
  setupAutoUpdate();
  // a monitor being unplugged or rescaled can strand the bubble off-screen too
  screen.on('display-metrics-changed', keepBubbleOnScreen);
  screen.on('display-removed', keepBubbleOnScreen);
  initOpenAtLogin();
  app.setName('Yapper');       // or the menu names itself from package.json
  refreshAppMenu();
  // Ask for the Dock tile outright rather than trusting LaunchServices to
  // remember. Replacing the bundle in place leaves it holding the old record,
  // and an ad-hoc signature changes identity with every build — so it keeps
  // deciding this is an accessory app and giving it no tile, while
  // `lsregister -f` fixes it only until the next update. Reported twice.
  if (process.platform === 'darwin' && app.dock) {
    app.dock.show().catch(() => { /* already showing */ });
  }
  createTray();
  bootWithSplash();
});
app.on('window-all-closed', () => app.quit());
// the transcription server is a child process: shut it down explicitly rather
// than leave it holding a model in memory after Yapper is gone
app.on('before-quit', () => { liveStopInternal(); engine.stop(); stopMeetingWatch(); });

function meetingFolderName(date) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}`;
}

function newMeetingFolder() {
  const base = path.join(MEETINGS_DIR, meetingFolderName(new Date()));
  let folder = base;
  for (let i = 2; fs.existsSync(folder); i++) folder = `${base}_${i}`;
  fs.mkdirSync(folder, { recursive: true });
  return fs.realpathSync(folder);
}

function requireMeetingFolder(folder) {
  return resolveDirectChild(MEETINGS_DIR, folder);
}

function resolveClaude() {
  return CLAUDE_FALLBACKS.find(p => fs.existsSync(p)) || 'claude';
}

// The provider a fresh install starts on. Claude Code is the best deal for
// whoever has it, and a dead end for everyone else: a friend installing from
// the dmg does not have the CLI, and "Claude Code was not found" at the end of
// their first meeting is the wrong moment to learn that. Without the CLI on
// disk the default is Gemini — free, no card — so the only thing missing is a
// key, and the app says so from the first screen. Nothing is persisted: the
// choice is the user's the moment they pick one.
function defaultProvider(s) {
  if (s && s.llmProvider) return s.llmProvider;
  return CLAUDE_FALLBACKS.some(p => fs.existsSync(p)) ? 'claude-cli' : 'gemini';
}

function writeParticipants(folder, participants) {
  const text = typeof participants === 'string' ? participants.trim().slice(0, 10000) : '';
  if (text) writeMeetingText(folder, 'participants.txt', text, { maxBytes: 10000 });
}

function readParticipants(folder) {
  return readMeetingText(folder, 'participants.txt', { maxBytes: 10000 }).trim();
}

function readSpeakerMap(folder) {
  const text = readMeetingText(folder, 'speaker-map.json', { maxBytes: 64 * 1024 });
  if (!text) return {};
  try { return speakerDiarizer.normalizeSpeakerMap(JSON.parse(text)); } catch { return {}; }
}

function rawMeetingTranscript(folder) {
  const name = meetingFileExists(folder, 'transcript.raw.txt') ? 'transcript.raw.txt' : 'transcript.txt';
  return readMeetingText(folder, name, { maxBytes: 64 * 1024 * 1024 });
}

// ---------- recording to disk ----------
// Chunks are appended as they arrive rather than held in memory until Stop, so
// a crash or a power cut costs the tail of the meeting instead of all of it.
// (Concatenated MediaRecorder chunks are exactly what the in-memory Blob used
// to be, so the resulting file is identical.)

// The renderer sends 16 kHz mono PCM straight from the audio graph, so the file
// on disk is already exactly what the transcriber consumes — no decoding step,
// and therefore no platform-specific media dependency to ship.

let recFd = null;
let recFolder = null;
let recBytes = 0;
let pendingImport = null;  // capability granted by the native file picker

// macOS also keeps each side of the call as its own file, because mixing
// destroys the one fact the recorder had for free: which side a word came
// from. The microphone track is the person recording, the system track is
// everyone else on the call — so the final pass can label lines Me:/Them:
// instead of guessing. The mixed recording.wav stays: the live transcript,
// crash recovery and every older meeting read it, and at 32 KB/s per extra
// file the writes cost nothing. The names start with "recording." on purpose,
// so releaseAudio and heldAudio treat them as the audio they are.
const MIC_TRACK = 'recording.mic.wav';
const SYS_TRACK = 'recording.sys.wav';
const MAX_AUDIO_CHUNK_BYTES = 1024 * 1024;
let recTracks = null;     // { micFd, sysFd, micBytes, sysBytes, sysSignal }

/** The same samples the mix just consumed, kept apart. Always the same length
 *  on both sides, so the tracks stay aligned with the mixed file's clock. */
function writeTracks(mic, sys) {
  if (!recTracks) return;
  try {
    fs.writeSync(recTracks.micFd, mic, 0, mic.length, engine.WAV_HEADER + recTracks.micBytes);
    recTracks.micBytes += mic.length;
  } catch (err) {
    console.error('[recording] mic track write failed:', err.message);
  }
  try {
    fs.writeSync(recTracks.sysFd, sys, 0, sys.length, engine.WAV_HEADER + recTracks.sysBytes);
    recTracks.sysBytes += sys.length;
  } catch (err) {
    console.error('[recording] sys track write failed:', err.message);
  }
  if (!recTracks.sysSignal && sys.some(b => b !== 0)) recTracks.sysSignal = true;
}

// macOS records both sides of a call the only way it can: a native helper
// captures system audio and its samples are added to the microphone's here.
// On Windows the renderer has already done this in its audio graph, so this
// stays dormant and the chunks arrive mixed.
// The helper's mute watch has to tell Yapper's own audio output from anyone
// else's (see othersPlaying in mac/system-audio.swift). Packaged, that is the
// bundle id family; unpackaged it is Electron's own.
if (process.platform === 'darwin') {
  process.env.YAPPER_OWN_BUNDLE_PREFIX = app.isPackaged ? 'com.yapper.' : 'com.github.Electron';
}

const sysAudio = sysaudio.create({
  probePath: helperPath('system-audio'),
  onStatus: info => {
    // The display block is taken when the recording starts, before the route
    // is known, because guessing wrong the other way costs the far side of
    // the meeting. From here on it is derived, not toggled: held only while a
    // recording is open and the far side comes through ScreenCaptureKit,
    // which cannot capture without a lit display. A tap does not need it, a
    // helper that died does not need it, and a status that arrives after the
    // file was closed (the helper drains before it exits) must not re-take it.
    // Only a status that actually settles which route is in force may move
    // it. A doubt does not (capture continues), and neither does a timeout —
    // the screen door can legitimately take longer than four seconds, since
    // it waits up to ten for a sleeping display to come back, and letting the
    // display sleep in exactly that window is how it ends up finding none.
    // A line the helper wrote that we did not recognise says nothing either.
    const settles = info.ok || info.terminal
      || ['stopped', 'helper-exit', 'permission', 'no-helper', 'spawn-failed'].includes(info.reason);
    if (settles) holdDisplayAwake(!!info.ok && info.via !== 'tap' && recFd !== null);
    if (info.ok) {
      console.log(`[audio] capturing system audio via ${info.via || 'screen'}`);
      // Sent as well as the failures: a helper that failed and then came back
      // — its own retry, or the screen door opening after the tap gave up —
      // has to be able to take its own warning off the screen.
      broadcast('system-audio-status', info);
      return;
    }
    console.log(`[audio] system audio unavailable (${info.reason})`,
      info.detail ? `— ${info.detail}` : '');
    // The renderer says "recording the microphone only" if this never turns on.
    broadcast('system-audio-status', info);
  }
});

// The native mac helpers, wherever this copy is running from. They have to sit
// outside the asar for the same reason calibration.wav does: this process can
// read in there, but nothing can be executed from inside one.
function helperPath(name) {
  const p = path.join(__dirname, 'build', name);
  return app.isPackaged ? p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`) : p;
}

// A sleeping display costs ScreenCaptureKit its system audio: it lists no
// displays while the screen is asleep, and a capture filter needs one even when
// only the audio is wanted. A meeting where you mostly listen is exactly the
// meeting where the screen dims — so the display is held awake for as long as
// that route is in use, and released the moment the recording ends.
//
// A Core Audio process tap has no such requirement, so on macOS 14.4+ the
// screen is left alone. Keeping a laptop's display lit through an hour of
// listening was a real cost, paid only because of how the audio was reached.
let displayAwake = null;

function holdDisplayAwake(on) {
  if (process.platform !== 'darwin') return;
  try {
    if (on) {
      if (displayAwake === null) displayAwake = powerSaveBlocker.start('prevent-display-sleep');
    } else if (displayAwake !== null) {
      powerSaveBlocker.stop(displayAwake);
      displayAwake = null;
    }
  } catch (err) {
    console.log('[audio] could not hold the display awake:', err.message);
  }
}

function closeRecFile() {
  holdDisplayAwake(false);
  stopSoloDrain();
  sysAudio.stop();          // whether or not a file is open, stop capturing
  if (recTracks) {
    try { engine.finishWav(recTracks.micFd, recTracks.micBytes); } catch { /* disk gone */ }
    try { engine.finishWav(recTracks.sysFd, recTracks.sysBytes); } catch { /* disk gone */ }
    recTracks = null;
  }
  if (recFd === null) return;
  try { engine.finishWav(recFd, recBytes); } catch { /* disk gone */ }
  recFd = null;
}

/// Chromium slows a window nobody is looking at down to one timer a second.
/// That is right for a web page and wrong while recording: the microphone
/// level, the check that the microphone is not delivering pure silence, and
/// the bubble's meter are all measured in the main window, and a meeting is
/// normally recorded with the call in front of Yapper. So the throttle is
/// lifted for exactly as long as a recording is open — not for the life of
/// the app, which would cost battery for nothing — and never for the bubble,
/// the splash or the PDF window.
function throttleWhileIdle(on) {
  if (!win || win.isDestroyed()) return;
  try { win.webContents.setBackgroundThrottling(on); } catch { /* window going away */ }
}

// The renderer owns the Web Audio graph. If its process dies or its main
// frame reloads, no future `recording-state: false` can arrive from that page.
// Retire the main-process half here: finalize the recoverable WAV, stop native
// capture, put Chromium back in its idle power mode, and make the controls
// outside the page tell the truth again.
function abandonRendererRecording(reason) {
  if (recFd === null && !rendererRecording) {
    throttleWhileIdle(true);
    return;
  }
  console.log(`[recording] renderer disappeared (${reason}); closing the open recording`);
  rendererRecording = false;
  closeRecFile();
  stopHeadStart();
  // And the live transcript: its loop reschedules itself unconditionally, so
  // without this it would keep asking whisper for the same window forever
  // after the recording it belonged to stopped existing.
  liveStopInternal();
  // Stopping the loop leaves the server it was talking to: whisper-server
  // holds its model in memory (and on the GPU) with nobody left to ask it
  // anything, and on this path there is no final transcription to end and
  // release it. Killing it also ends the inference already in flight, whose
  // answer nothing can receive now. It is safe twice — `stop()` lets go of
  // the process before it waits — and the next recording starts a fresh one.
  engine.stop().catch(() => { /* already gone */ });
  throttleWhileIdle(true);
  destroyBubble();
  enableMarkShortcut(false);
  meetingGoneStreak = 0;
  meetingEra++;
  meetingCurrent = null;
  refreshTray();
  refreshAppMenu();
}

ipcMain.handle('recording-start', async (_e, participants) => {
  closeRecFile();
  pendingImport = null;
  recFolder = newMeetingFolder();
  recBytes = 0;
  writeParticipants(recFolder, participants);
  recFd = engine.openWav(resolveDirectFileForWrite(recFolder, path.join(recFolder, 'recording.wav')));
  // Deliberately not awaited. The helper is usually live in a few hundred
  // milliseconds, but a machine that is refusing the permission takes seconds
  // to say so, and blocking on that would mean pressing Record and watching
  // nothing happen. Recording starts now; system audio joins the mix as soon
  // as it arrives, so the cost of being wrong is a fraction of a second of
  // one-sided audio rather than a delayed start.
  if (process.platform === 'darwin') {
    recTracks = {
      micFd: engine.openWav(resolveDirectFileForWrite(recFolder, path.join(recFolder, MIC_TRACK))),
      sysFd: engine.openWav(resolveDirectFileForWrite(recFolder, path.join(recFolder, SYS_TRACK))),
      micBytes: 0, sysBytes: 0, sysSignal: false
    };
    holdDisplayAwake(true);
    lastMicChunkAt = Date.now();     // give the renderer its grace period
    sysAudio.start();
    startSoloDrain();
  }
  sysRemainder = 0;
  startHeadStart(recFolder, participants);
  // Only after the main-process setup succeeded. A synchronous open/write
  // failure must not leave the app unthrottled while idle.
  throttleWhileIdle(false);
  return recFolder;
});

// ---------- transcribing while the meeting runs ----------
// The wait after a long meeting is almost all transcription, and none of it
// needs the meeting to be over: windows are independent, and the audio for
// minute 5 is final while minute 50 is still being spoken. So it is done as it
// arrives, and stopping leaves only the tail — about three seconds instead of
// fifty on a half-hour meeting.
//
// It is a head start, not a dependency. If it stalls, fails, or never runs,
// `transcribe` does the whole file exactly as it always did.

const HEAD_START_EVERY_MS = 15000;
let headStart = null;          // { folder, runs: [{ key, run }] }
let headStartTimer = null;

function startHeadStart(folder, participants) {
  stopHeadStart();
  headStart = null;
  const tierName = readSettings().tier || engine.guessTier();
  const tier = engine.tierConfig(tierName);
  if (!engine.isInstalled() || !engine.hasModel(tier.finalModel)) return;
  // Not on a tier where getting ahead would restart the server out from under
  // the live transcript on every window. See engine.canGetAhead.
  if (!engine.canGetAhead(tierName)) {
    console.log(`[transcribe] no head start on the ${tierName} tier: it would fight live over the model`);
    return;
  }
  const opts = {
    model: tier.finalModel,
    language: spokenLanguageNow(),
    prompt: transcriptionHint(participants)
  };
  // When the recording keeps per-side tracks, the head start works on those —
  // they are what the final pass will transcribe. The mixed file gets no run of
  // its own then: transcribing the same minutes a third time would buy nothing.
  // Most windows of the system track are digital silence and cost a file read,
  // not an inference (see the silent-window skip in engine.transcribeWindow).
  const files = recTracks
    ? [{ key: 'mic', file: resolveDirectFile(folder, path.join(folder, MIC_TRACK)) },
       { key: 'sys', file: resolveDirectFile(folder, path.join(folder, SYS_TRACK)) }]
    : [{ key: 'mixed', file: resolveDirectFile(folder, path.join(folder, 'recording.wav')) }];
  headStart = {
    folder,
    runs: files.map(({ key, file }) => ({ key, run: engine.progressive(file, opts) }))
  };
  headStartTimer = setInterval(() => {
    if (headStart) for (const r of headStart.runs) r.run.advance();
  }, HEAD_START_EVERY_MS);
}

function stopHeadStart() {
  if (headStartTimer) clearInterval(headStartTimer);
  headStartTimer = null;
  // Not awaited here: this runs from an IPC message the renderer does not wait
  // on. `transcribe` awaits it below, which is where it matters.
  if (headStart) headStart.settled = Promise.all(headStart.runs.map(r => r.run.settle()));
}

/** What is already done for this meeting, if anything: snapshots keyed by
 *  track ('mixed', or 'mic' + 'sys'), with tracks that never got a window
 *  left out. */
async function headStartFor(folder) {
  if (!headStart || headStart.folder !== folder) return null;
  // Collecting it settles it, and settling is permanent — so a transcription
  // of a meeting that is *still recording* would kill its head start for
  // everything after. No call site does that today: `transcribe` is reached
  // from stopping, from a past meeting, and from an import. It is one new call
  // site away from happening, and the failure would be silent.
  //
  // `settled` is set by stopHeadStart and by nothing else, so it says "this
  // recording has ended" in our own terms rather than reading a flag other
  // code also writes.
  if (!headStart.settled) return null;
  // Let the windows in flight land first, or the final pass redoes them.
  await headStart.settled;
  const out = {};
  for (const { key, run } of headStart.runs) {
    const snap = run.snapshot();
    if (snap.at > 0) out[key] = snap;
  }
  // A meeting with no far side drops its tracks and transcribes the mix; the
  // head start only ever ran on the tracks, so it used to be thrown away for
  // every solo memo and the whole file decoded again. The mix is byte-for-byte
  // the microphone track then (mixPcm adds zeros; sysSignal would be set by
  // anything else), so the microphone's windows are the mix's windows.
  if (headStart.micIsMixed && out.mic && !out.mixed) out.mixed = out.mic;
  return out;
}

function writeRecorded(buf) {
  if (recFd !== null) {
    try {
      fs.writeSync(recFd, buf, 0, buf.length, engine.WAV_HEADER + recBytes);
      recBytes += buf.length;
    } catch (err) {
      console.error('[recording] write failed:', err.message);
    }
  }
  // the same samples feed the live transcript, so the renderer only sends once
  if (liveOn) live.write(buf);
}

let lastMicChunkAt = 0;

ipcMain.on('recording-chunk', (_e, arrayBuffer) => {
  if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength > MAX_AUDIO_CHUNK_BYTES) {
    console.warn('[security] ignored an invalid recording chunk');
    return;
  }
  let buf = Buffer.from(arrayBuffer);
  // Empty chunks still arrive when the audio graph is running but producing
  // nothing, and counting those as "the microphone is driving" is what let a
  // recording end up empty: the pace looked healthy, so the system audio was
  // never written on its own, and the chunks themselves carried no samples.
  if (buf.length) lastMicChunkAt = Date.now();
  // The microphone sets the pace: take exactly as much system audio as the
  // renderer just sent, so the mix stays aligned with the file's own clock.
  let sys = sysAudio.take(buf.length);
  if (sys) {
    sys = applySysGain(sys);
    sendSysWave(sys);
  }
  // Silence stands in for a side that produced nothing, so both tracks keep
  // the same clock as the mix.
  if (buf.length) writeTracks(buf, sys || Buffer.alloc(buf.length));
  if (sys) buf = sysaudio.mixPcm(buf, sys);
  writeRecorded(buf);
});

// ---------- the system meter ----------
// On Windows the loopback runs through the renderer's own audio graph, so an
// analyser node draws that meter for free. On macOS the samples never reach
// the renderer at all — they are captured natively and mixed here — so the
// meter drew a flat line and its gain slider moved nothing. For the one source
// a user most wants to confirm is arriving, that is worse than showing no
// meter: it looks like silence rather than like an unanswered question.
//
// So the waveform is sent from here, already shaped the way drawWave reads it:
// one byte per point, centred on 128.

// Points of waveform per second of audio. The renderer holds these in a ring
// and walks it on its own clock, so it draws every frame instead of once per
// packet — sending finished frames at the rate audio chunks arrive looked
// robotic next to a microphone meter reading a live analyser sixty times a
// second, however overlapped the windows were. So what goes across is the new
// samples, and the drawing rate stops depending on the delivery rate.
const SYS_WAVE_RATE = 16000;   // every sample: the same kind of trace the
                               // microphone's analyser draws, not an envelope
const SAMPLES_PER_SEC = engine.BYTES_PER_SEC / 2;
let sysGain = 1;
let sysRemainder = 0;      // fractional points carried between chunks

function applySysGain(pcm) {
  if (sysGain === 1) return pcm;
  const out = Buffer.from(pcm);
  for (let i = 0; i + 1 < out.length; i += 2) {
    // saturate rather than wrap, for the same reason mixPcm does: wrapping
    // turns a loud moment into noise
    const v = Math.round(out.readInt16LE(i) * sysGain);
    out.writeInt16LE(v > 32767 ? 32767 : v < -32768 ? -32768 : v, i);
  }
  return out;
}

function sendSysWave(pcm) {
  const samples = pcm.length >> 1;
  if (!samples) return;

  // How many points this chunk is worth, carrying the fraction so the trace
  // advances at a steady rate rather than rounding a little away each time.
  const exact = (samples / SAMPLES_PER_SEC) * SYS_WAVE_RATE + sysRemainder;
  const n = Math.floor(exact);
  sysRemainder = exact - n;
  if (n <= 0) return;

  const out = Buffer.alloc(n, 128);
  const stride = samples / n;
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(Math.min(samples - 1, Math.floor(i * stride)) * 2);
    out[i] = 128 + Math.max(-128, Math.min(127, Math.round(v / 256)));
  }
  // Only the main window draws this; the bubble has no listener for it, and a
  // window that is minimized or covered is not drawing either. The renderer's
  // ring refills within a second of the window coming back.
  if (win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()) {
    win.webContents.send('system-wave', out);
  }
}

ipcMain.on('sys-gain', (_e, g) => {
  const n = Number(g);
  sysGain = Number.isFinite(n) && n >= 0 && n <= 4 ? n : 1;
});

// The microphone setting the pace has a failure mode: no microphone, no pace,
// and nothing written at all — including the system audio that was being
// captured perfectly the whole time. A refused microphone permission or an
// unplugged headset would produce an empty recording of a meeting the machine
// could hear. So when the renderer goes quiet, the far side is written on its
// own rather than piling up in a buffer nobody drains.
const SILENT_MIC_MS = 1000;
let soloTimer = null;
let soloWrote = false;

function startSoloDrain() {
  soloWrote = false;
  if (soloTimer || process.platform !== 'darwin') return;
  soloTimer = setInterval(() => {
    if (recFd === null || sysAudio.state !== 'capturing') return;
    if (Date.now() - lastMicChunkAt < SILENT_MIC_MS) return;   // the mic is driving
    let sys = sysAudio.take(engine.BYTES_PER_SEC / 2);          // half a second
    if (sys && sys.some(b => b !== 0)) {
      sys = applySysGain(sys);
      sendSysWave(sys);
      if (!soloWrote) {
        soloWrote = true;
        console.log('[audio] the microphone is silent — writing system audio on its own');
      }
      writeTracks(Buffer.alloc(sys.length), sys);
      writeRecorded(sys);
    }
  }, 500);
}

function stopSoloDrain() {
  if (soloTimer) clearInterval(soloTimer);
  soloTimer = null;
}

ipcMain.handle('recording-finish', async (_e, title, markers) => {
  const tracks = recTracks;              // closeRecFile forgets them
  closeRecFile();
  const folder = recFolder;
  const bytes = recBytes;
  recFolder = null;
  recBytes = 0;
  if (!folder) return null;
  // A meeting with no far side — nothing ever played, or no permission — has a
  // silent system track, and the mix IS the microphone then. Two passes over
  // the same audio would only cost time, so the tracks go and the mix stays.
  if (tracks && !tracks.sysSignal) {
    for (const f of [MIC_TRACK, SYS_TRACK]) {
      try { fs.unlinkSync(resolveDirectFile(folder, path.join(folder, f))); } catch { /* already gone */ }
    }
    // The head start worked on the microphone track, which is what the mix
    // is when the other side never made a sound — so its windows still count.
    if (headStart && headStart.folder === folder) headStart.micIsMixed = true;
  }
  title = typeof title === 'string' ? title.trim().slice(0, 500) : '';
  if (title) writeMeetingText(folder, 'title.txt', title, { maxBytes: 1000 });
  if (Array.isArray(markers) && markers.length) {
    const safeMarkers = markers.slice(0, 10000).map(m => String(m).slice(0, 100)).join('\n');
    writeMeetingText(folder, 'markers.txt', safeMarkers, { maxBytes: 1024 * 1024 });
  }
  return { folder, bytes };
});

// the app is going away mid-recording: close the file properly, keep the audio
app.on('before-quit', () => closeRecFile());

const MAX_IMPORT_BYTES = 1024 * 1024 * 1024;

ipcMain.handle('import-audio', async (_e, participants) => {
  pendingImport = null;
  const res = await dialog.showOpenDialog(win, {
    title: 'Import voice note',
    properties: ['openFile'],
    filters: [
      { name: 'Audio files', extensions: ['m4a', 'mp3', 'wav', 'ogg', 'opus', 'webm', 'aac', 'flac', 'wma', 'amr', 'mp4'] },
      { name: 'All files', extensions: ['*'] }
    ]
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  const src = resolveRegularFile(res.filePaths[0]);
  const size = fs.statSync(src).size;
  if (size > MAX_IMPORT_BYTES) throw new Error('That audio file is too large to import safely.');
  const folder = newMeetingFolder();
  // A phone voice note is called "recording" or "New Recording 4"; naming the
  // meeting after that tells you nothing, so those fall through to the same
  // auto-titling the recorder uses.
  const title = meaningfulName(path.basename(src, path.extname(src)));
  if (title) writeMeetingText(folder, 'title.txt', title, { maxBytes: 1000 });
  writeParticipants(folder, participants);
  pendingImport = { src, folder, open: false };
  // The renderer decodes it — Chromium already ships codecs for every format in
  // that filter list, so mp3/m4a/opus/flac all become the same 16 kHz mono WAV
  // the transcriber reads, and Yapper ships no media dependency of its own.
  return { folder, title, src, bytes: size };
});

// A meeting recorded before Yapper wrote WAV directly. The renderer can decode
// it with the same codecs it uses for imports, so those recordings are not
// stranded — they just get converted the first time they are transcribed.
ipcMain.handle('legacy-audio', async (_e, folder) => {
  folder = requireMeetingFolder(folder);
  pendingImport = null;
  if (meetingFileExists(folder, 'recording.wav')) return null;
  const legacy = fs.readdirSync(folder)
    .find(f => /^recording\.(webm|m4a|mp3|ogg|opus|mp4|aac|flac)$/i.test(f));
  if (!legacy) return null;
  const src = resolveDirectFile(folder, path.join(folder, legacy));
  if (fs.statSync(src).size > MAX_IMPORT_BYTES) {
    throw new Error('That legacy recording is too large to convert safely.');
  }
  pendingImport = { src, folder, open: false };
  return src;
});

const GENERIC_NAMES = /^(new\s+)?(recording|record|audio|voice[\s_-]*(note|memo|recording)?|sound|grabaci[oó]n|nota[\s_-]*de[\s_-]*voz|untitled|new\s+file|whatsapp\s+(audio|ptt).*|audio[\s_-]*\d*|clip)[\s_-]*\d*$/i;

/** A filename worth using as a meeting title, or '' to let the model name it. */
function meaningfulName(base) {
  const name = base.replace(/[_-]+/g, ' ').trim();
  if (!name || GENERIC_NAMES.test(name)) return '';
  if (/^[\d\s.:_-]+$/.test(name)) return '';          // just a timestamp
  return base.trim();
}

ipcMain.handle('import-read', async (_e, src) => {
  const selected = resolveRegularFile(src);
  if (!pendingImport || selected !== pendingImport.src) {
    throw new Error('Choose the audio file again before importing it.');
  }
  const buf = fs.readFileSync(selected);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

// The decoded samples come back through 'recording-chunk', the same path the
// microphone uses, so there is only one piece of code that writes a WAV.
ipcMain.handle('import-open', async (_e, folder) => {
  folder = requireMeetingFolder(folder);
  if (!pendingImport || folder !== pendingImport.folder) {
    throw new Error('That meeting is not the active import.');
  }
  closeRecFile();
  recFolder = folder;
  recBytes = 0;
  recFd = engine.openWav(resolveDirectFileForWrite(folder, path.join(folder, 'recording.wav')));
  pendingImport.open = true;
  return true;
});

ipcMain.handle('import-close', async () => {
  if (!pendingImport || !pendingImport.open) throw new Error('There is no active import.');
  try {
    closeRecFile();
    return recBytes;
  } finally {
    pendingImport = null;
  }
});

// Whisper initial_prompt biasing: nudges the model toward spelling these names/terms correctly
function transcriptionHint(participants) {
  if (!participants || !participants.trim()) return '';
  return `The people in this conversation are: ${participants.trim().replace(/\n/g, ', ')}.`;
}

/**
 * Whatever went wrong down there, said in words. Left alone, this surfaces
 * things like "read ECONNRESET" and "ENOENT: no such file or directory, open
 * 'C:\\Users\\…'" in the app's own status line.
 */
function humanTranscribeError(err) {
  const m = String(err && err.message || err);
  if (/ENOENT|no longer there/i.test(m)) return 'The recording for that meeting is no longer there.';
  if (/model .* is missing|not installed/i.test(m)) {
    // setup.ps1 is a Windows script, and pointing a Mac user at it is a dead
    // end: there the engine arrives through the first-run download instead.
    return process.platform === 'darwin'
      ? 'The transcription engine is not installed. Restart Yapper to download it again.'
      : 'The transcription engine is not installed. Run setup.ps1 from the app folder.';
  }
  if (/ECONNRESET|ECONNREFUSED|socket hang up|did not start|not running/i.test(m)) {
    return 'The transcriber stopped unexpectedly. Try again.';
  }
  if (/EACCES|EPERM|EBUSY/i.test(m)) return 'That file is in use by something else. Close it and try again.';
  if (/ENOSPC/i.test(m)) return 'The disk is full, so the transcript could not be saved.';
  return m;
}

ipcMain.handle('transcribe', async (_e, folder) => {
  folder = requireMeetingFolder(folder);
  const wav = resolveDirectFileForWrite(folder, path.join(folder, 'recording.wav'));
  if (!meetingFileExists(folder, 'recording.wav')) {
    // Two transcriptions of the same meeting can be in flight at once — the
    // button double-clicked, or a retry racing the first attempt. The winner
    // writes the transcript and releases the audio, so the loser arrives to a
    // folder with no wav and used to fail loudly at something that had in fact
    // just succeeded. If the transcript is there, that is the answer.
    if (meetingFileExists(folder, 'transcript.txt')) {
      return readMeetingText(folder, 'transcript.txt', { required: true, maxBytes: 64 * 1024 * 1024 });
    }
    // the renderer converts old recordings before calling this, so reaching
    // here means the conversion did not happen or the folder is genuinely empty
    throw new Error('No recording found in this meeting folder.');
  }
  // a meeting cut short by a crash still has a placeholder header
  if (engine.repairWav(wav)) console.log('[transcribe] repaired an interrupted recording');

  // Both per-side tracks, or the mixed file alone — never a mixture of the
  // two, since a lone track can only be half a meeting.
  const micWav = resolveDirectFileForWrite(folder, path.join(folder, MIC_TRACK));
  const sysWav = resolveDirectFileForWrite(folder, path.join(folder, SYS_TRACK));
  const twoTrack = meetingFileExists(folder, MIC_TRACK) && meetingFileExists(folder, SYS_TRACK);
  if (twoTrack) {
    engine.repairWav(micWav);
    engine.repairWav(sysWav);
  }

  const tier = engine.tierConfig(readSettings().tier || engine.guessTier());
  const send = text => {
    if (win && !win.isDestroyed()) win.webContents.send('transcribe-progress', text);
  };

  // On a machine that recorded during its first hour, `small` may still be
  // arriving. Wait for it here rather than fall back to `base` — `small` is
  // what ships precisely because `base` was not good enough on real meeting
  // audio (ARCHITECTURE §8), and the recording is on disk going nowhere.
  //
  // Only for a download already in flight. A model missing with nothing
  // running is a broken install, not a slow one: starting a fresh 490 MB fetch
  // at the moment someone asked for a transcript would hide that behind a
  // progress line instead of reporting it. Falling through lets engine.start()
  // raise "model is missing", which says so plainly.
  if (!engine.hasModel(tier.finalModel) && provisioning) {
    send('\rFinishing the engine download…');
    await ensureModel(tier.finalModel);
  }

  const opts = {
    model: tier.finalModel,
    language: spokenLanguageNow(),
    prompt: transcriptionHint(readParticipants(folder))
  };
  // Whatever was transcribed while the meeting ran, per track. Its windows are
  // identical to the ones this pass would have produced for them, so only the
  // tail is left — and if there is nothing, this is the same full pass it
  // always was.
  const head = await headStartFor(folder);
  const progress = (base, span) => ({ done, total }) => {
    send(`\rTranscribing… ${Math.round(base + done / total * span)}%`);
  };

  let lines;
  let diarization = null;
  try {
    if (twoTrack) {
      // Core ML uses the Neural Engine while Whisper uses Metal/CPU, so doing
      // both now hides most of diarization's cost behind transcription. The
      // helper is optional and its failure never costs the transcript.
      let waitingForSpeakers = false;
      let diarizationDone = false;
      const diarizationRaw = speakerDiarizer.diarizeFile(helperPath('speaker-diarize'), sysWav, {
        onProgress: (done, total) => {
          if (waitingForSpeakers && total > 0) {
            send(`\rIdentifying remote speakers locally… ${Math.round(done / total * 100)}%`);
          }
        }
      });
      const diarizationRun = diarizationRaw.then(result => { diarizationDone = true; return result; });
      const micLines = await engine.transcribeFile(micWav,
        { ...opts, from: head && head.mic, onProgress: progress(0, 50) });
      const sysLines = await engine.transcribeFile(sysWav,
        { ...opts, from: head && head.sys, onProgress: progress(50, 50) });
      if (!sysLines.length) {
        // Nobody spoke on the far side — a notification ping is enough to keep
        // the track — so there is nobody to tell apart: labelling an empty list
        // gives back an empty list, whatever the helper finds. It is still
        // chewing the whole file on the Neural Engine; waiting on it would be a
        // progress bar for nothing.
        diarizationRaw.cancel();
        lines = micLines;
      } else {
        waitingForSpeakers = true;
        if (!diarizationDone) send('\rIdentifying remote speakers locally…');
        diarization = await diarizationRun;
        const remote = speakerDiarizer.labelRemoteLines(sysLines, diarization.segments);
        lines = engine.mergeSpeakerTracks(micLines, remote.lines);
      }
    } else {
      lines = await engine.transcribeFile(wav,
        { ...opts, from: head && head.mixed, onProgress: progress(0, 100) });
    }
  } catch (err) {
    if (!liveOn) await engine.stop();
    // The same race as above, but lost later: both callers found the wav, the
    // winner finished and released the audio, and this one was mid-read when
    // it vanished. The check at the top cannot catch that — by then the file
    // was still there. A finished transcript is the answer either way.
    if (!meetingFileExists(folder, 'recording.wav') && meetingFileExists(folder, 'transcript.txt')) {
      return readMeetingText(folder, 'transcript.txt', { required: true, maxBytes: 64 * 1024 * 1024 });
    }
    throw new Error(humanTranscribeError(err));
  }
  // Leave the server up while a recording is in progress: the live loop is using
  // it, and it takes its own model back on its next pass.
  if (!liveOn) await engine.stop();

  const rawTranscript = lines.join('\n').trim();
  if (!rawTranscript) throw new Error('The transcript came out empty. Was any audio recorded?');
  const transcript = speakerDiarizer.applySpeakerMap(rawTranscript, readSpeakerMap(folder));
  try {
    if (twoTrack) {
      // Keep the machine-generated identities immutable. User-assigned names
      // are always reapplied from this source, so changing Speaker 1 from one
      // person to another cannot progressively corrupt the transcript.
      writeMeetingText(folder, 'transcript.raw.txt', rawTranscript, { maxBytes: 64 * 1024 * 1024 });
      if (diarization && diarization.segments.length) {
        writeMeetingText(folder, 'speaker-segments.json', JSON.stringify({
          version: 1,
          segments: speakerDiarizer.displaySegments(diarization.segments)
        }), { maxBytes: 16 * 1024 * 1024 });
      } else if (diarization && diarization.reason) {
        console.log('[speakers] using track-only labels:', String(diarization.reason).slice(0, 300));
      }
    }
    writeMeetingText(folder, 'transcript.txt', transcript, { maxBytes: 64 * 1024 * 1024 });
    releaseAudio(folder);
  } catch (err) {
    // Transcribing succeeded and saving did not — the folder was deleted while
    // this ran, the disk filled, the drive went away. Raw, that surfaces as
    // "ENOENT: no such file or directory, open '/Users/…'" in the app's status
    // line, which tells the user nothing they can act on.
    throw new Error(humanTranscribeError(err));
  }
  send('\n');
  return transcript;
});

// ---------- the audio's job ends with the transcript ----------
// The transcript is the record; the notes are written from it, and it is what
// gets read, searched and exported. The audio exists to produce it and to
// survive a crash on the way — 110 MB an hour, which is 4.8 GB a month for one
// two-hour meeting a day, and a recording of colleagues is more sensitive than
// its transcript. So once there is a transcript, the audio has done its job.
//
// Note the ordering: the transcript is written first, then the audio is
// released. A crash between the two costs nothing.

// Keeping the audio is a decision about one meeting, not a preference. It lives
// in memory only, so it is off on every launch, and it turns itself off again
// once it has been honoured — nobody means "keep every recording from now on"
// when they tick it for a negotiation.
let keepThisOne = false;

function releaseAudio(folder) {
  // never on a guess: only when the transcript is really there and has content
  if (!meetingFileExists(folder, 'transcript.txt')) return;
  const transcript = resolveDirectFile(folder, path.join(folder, 'transcript.txt'));
  if (fs.statSync(transcript).size < 40) return;

  if (keepThisOne) {
    keepThisOne = false;                     // that meeting, and only that one
    broadcast('keep-audio-changed', false);
    console.log('[audio] kept by request for this meeting; back to releasing');
    return;
  }

  for (const f of fs.readdirSync(folder)) {
    if (!/^recording\./i.test(f)) continue;
    try {
      const p = resolveDirectFile(folder, path.join(folder, f));
      const size = fs.statSync(p).size;
      fs.unlinkSync(p);
      console.log(`[audio] released ${f} (${(size / 1024 / 1024).toFixed(0)} MB) — the transcript is saved`);
    } catch (err) {
      console.log(`[audio] could not release ${f}: ${err.message}`);
    }
  }
}

ipcMain.handle('get-keep-audio', async () => keepThisOne);

ipcMain.handle('set-keep-audio', async (_e, keep) => {
  keepThisOne = !!keep;
  // an older build persisted this as a setting; make sure that cannot linger
  const s = readSettings();
  if (s.keepAudio !== undefined) writeSettings(s, ['keepAudio']);
  return keepThisOne;
});

/** Audio still held by meetings that already have a transcript. */
function heldAudio() {
  if (!fs.existsSync(MEETINGS_DIR)) return { bytes: 0, files: [] };
  const files = [];
  let bytes = 0;
  for (const d of fs.readdirSync(MEETINGS_DIR, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    let folder;
    try { folder = requireMeetingFolder(path.join(MEETINGS_DIR, d.name)); } catch { continue; }
    if (!meetingFileExists(folder, 'transcript.txt')) continue;
    const transcript = resolveDirectFile(folder, path.join(folder, 'transcript.txt'));
    if (fs.statSync(transcript).size < 40) continue;
    for (const f of fs.readdirSync(folder)) {
      if (!/^recording\./i.test(f)) continue;
      try {
        const p = resolveDirectFile(folder, path.join(folder, f));
        bytes += fs.statSync(p).size;
        files.push(p);
      } catch { /* gone or unsafe */ }
    }
  }
  return { bytes, files };
}

ipcMain.handle('held-audio', async () => {
  const { bytes, files } = heldAudio();
  return { bytes, count: files.length };
});

// Reclaiming space on meetings recorded before this changed is the user's call,
// not something to do to their files on their behalf at launch.
ipcMain.handle('release-held-audio', async () => {
  const { bytes, files } = heldAudio();
  if (!files.length) return { released: 0, bytes: 0 };

  const res = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Move to recycle bin', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Free up audio',
    message: `Release the audio from ${files.length} transcribed meeting${files.length === 1 ? '' : 's'}?`,
    detail: `That frees ${(bytes / 1024 / 1024).toFixed(0)} MB. Their transcripts and notes are kept — `
      + 'only the audio goes, and it goes to the recycle bin, so it can still be recovered from there.\n\n'
      + 'You will not be able to re-transcribe those meetings afterwards.'
  });
  if (res.response !== 0) return { released: 0, bytes: 0, cancelled: true };

  let released = 0, freed = 0;
  for (const p of files) {
    try {
      const size = fs.statSync(p).size;
      await shell.trashItem(p);
      released++;
      freed += size;
    } catch (err) {
      console.log(`[audio] could not release ${p}: ${err.message}`);
    }
  }
  console.log(`[audio] released ${released} files, ${(freed / 1024 / 1024).toFixed(0)} MB`);
  return { released, bytes: freed };
});

const SECTION_SETS = {
  general: `## Summary
A short paragraph with the essence of the meeting.

## Key points
Bullet points with the topics discussed and what was said about each.

## Decisions
What was decided or agreed. If there were no decisions, write "No decisions recorded."

## Action items
Tasks or commitments, including owner and due date if mentioned. If none, write "No action items recorded."

## Open questions
Topics left unresolved. Omit this section if there are none.`,
  standup: `## Summary
One short paragraph.

## Updates
Bullet points per person with what they reported (use names when identifiable).

## Blockers
Issues blocking progress. If none, write "No blockers raised."

## Next steps
What each person plans to do next.

## Action items
Tasks or commitments, including owner and due date if mentioned. If none, write "No action items recorded."`,
  one_on_one: `## Summary
A short paragraph with the essence of the conversation.

## Topics discussed
Bullet points with each topic and what was said.

## Feedback
Feedback given in either direction. Omit this section if there was none.

## Agreements
What both people agreed on. If none, write "No agreements recorded."

## Action items
Tasks or commitments, including owner and due date if mentioned. If none, write "No action items recorded."`,
  client: `## Summary
A short paragraph with the essence of the call.

## Client needs
What the client asked for, their concerns and priorities.

## Commitments
What was promised to the client, with dates if mentioned. If none, write "No commitments made."

## Risks & concerns
Potential problems raised. Omit this section if there are none.

## Action items
Tasks or commitments, including owner and due date if mentioned. If none, write "No action items recorded."

## Next steps
What happens after this call.`,
  // Written for someone who was not in the room and will not ask follow-up
  // questions: prose, not bullets, and no invented certainty.
  memo: `## Overview
Two or three sentences of prose stating what the meeting was about and why it happened. No bullets.

## Background
A short prose paragraph with the context a reader who was not there would need. Omit this section if the transcript gives no context.

## Discussion
Flowing prose, in paragraphs, covering what was actually said and the reasoning behind it. Do not use bullet points here. Attribute positions to people only where the transcript makes it clear.

## Decisions
What was decided or agreed, in prose. Where something was discussed but not settled, say so plainly rather than implying it was agreed. If nothing was decided, write "No decisions were reached."

## What is needed
What the meeting concluded is required from someone: approvals, resources, information, a decision from elsewhere. Neutral wording, no promises on anyone's behalf. Omit this section if nothing was asked for.

## Next steps
A short prose paragraph on what happens after this, including owners and dates only where the transcript states them.`,
  minutes: `## TL;DR
A few high-level bullet points capturing the essence of the meeting at a glance.

## Discussion
Bullet points recapping what was discussed, grouped by topic. Use short sub-bullets for detail where it helps.

## Decisions
Bullet points of what was decided or agreed. If none, write "No decisions recorded."

## Action items
Bullet points of tasks or commitments, including owner and due date if mentioned. If none, write "No action items recorded."

## Next steps
Bullet points of follow-ups and what happens after the meeting. Omit this section if there are none.`,
  brainstorm: `## Summary
A short paragraph with the essence of the session.

## Ideas
All ideas raised, grouped by theme.

## Standout ideas
The ideas with the most traction or enthusiasm.

## Decisions
What was decided or agreed. If none, write "No decisions recorded."

## Next steps
What happens after this session.`
};

// Which language the notes come out in. The headings and the "No … recorded."
// fallbacks stay in English whatever is picked: the renderer colours sections by
// their English names and the action-item parser reads the fallbacks.
const NOTE_LANGUAGES = { en: 'English', es: 'Spanish' };
function languageRule(lang) {
  const where = lang === 'auto'
    ? 'Write the notes in the language most of the transcript is spoken in (English if it is evenly mixed).'
    : `Write the notes in ${NOTE_LANGUAGES[lang] || 'English'}.`;
  return `${where} Whatever the language, keep every "## " heading exactly as written above, in English, and keep fallback sentences such as "No decisions recorded." exactly as written — the app reads them.`;
}

function buildPrompt(options = {}, includeTitle = false) {
  const sections = SECTION_SETS[options.style] || SECTION_SETS.general;
  const detail = options.detail === 'detailed'
    ? 'Be thorough: capture every topic, nuance, name and number mentioned.'
    : 'Be concise: short bullets, only what matters.';
  // The rules are a numbered list rather than a paragraph on purpose. When the
  // timestamp instruction was buried mid-paragraph, styles whose sections
  // carried their own strong wording (Minutes, whose every section says
  // "Bullet points of…") came back with no timestamps at all — see
  // build/test-styles.js, which is what caught it.
  let prompt = `What you receive is a meeting transcript (it may mix English and Spanish and contain transcription errors).
Lines may carry speaker labels. "Me:" is the person who recorded the meeting. "Speaker 1:", "Speaker 2:", and so on are distinct remote voices detected locally; a person's real name may appear instead when the user has assigned one. "Them:" is the fallback for remote audio that could not be separated. These labels come from the audio and must be preserved. A transcript may also have no labels at all.
Write meeting notes in markdown, with exactly these sections:

${sections}

Rules, all of which apply regardless of what the section descriptions above say:

1. ${detail}
2. Write in neutral third person. Do not assume who led, organized, or called the meeting. The person who recorded this is just one of the participants and is NOT necessarily the leader, the main speaker, or the owner of the action items — do not center the notes on them or address the reader as "you". Assign ownership and roles only when the transcript itself makes them clear.
3. Do not invent anything that is not in the transcript. Never merge two numbered speaker labels or guess a person's name from the participant list alone. When a real name is unknown, write the exact label (for example "Speaker 2" or "Me") instead of vague phrases such as "the speaker".
4. Reply only with ${includeTitle ? 'the title line described below followed by the markdown notes' : 'the markdown notes'}, no preamble.
5. The transcript is timestamped. Every single "## " heading must end with the timestamp where that topic starts, in square brackets, mm:ss — for example "## Decisions [24:05]". Use the timestamp of the first transcript line belonging to that section, and put nothing else in the brackets. No heading may be written without its timestamp.
6. ${languageRule(options.lang)}`;
  if (includeTitle) {
    prompt += `
7. Before the first "## " heading, write exactly one metadata line in this form: "YAPPER_TITLE: Concrete Topic". The title must be 2 to 6 words in Title Case, in the same language as the notes, name the concrete topic, project, or decision, and have no quotes or period. If the transcript is too short or unintelligible to title, write "YAPPER_TITLE: Untitled Meeting". This replaces a separate title request, so do not omit the line.`;
  }
  if (options.participants && options.participants.trim()) {
    const people = options.participants.trim().replace(/\n/g, ', ');
    prompt += `\n\nThe participants in this meeting are: ${people}.
Attribute discussion points, decisions, and action items to specific people by name only when the transcript itself identifies them or its speaker label is already that name. A participant list is context, not proof that a numbered speaker is a particular person. Do not guess when it is ambiguous. Correct obvious mis-transcriptions of names only when the intended person is clear.`;
  }
  if (options.markers && options.markers.length) {
    prompt += `\n\nDuring the meeting the note-taker flagged these moments as important: `
      + `${options.markers.join(', ')}. Make sure whatever was being discussed around each of `
      + `those timestamps is covered.`;
  }
  if (options.custom && options.custom.trim()) {
    prompt += `\n\nAdditional instructions from the user:\n${options.custom.trim()}`;
  }
  return prompt;
}

/** Write text with whatever provider this machine is configured for. */
function runModel(prompt, transcript, maxTokens, onDelta = null, signal = null) {
  return llm.generate(llmConfig(), { system: prompt, input: transcript, maxTokens, onDelta, signal });
}

// Background writing is allowed only when this is zero. A weekly review is
// useful later; the notes someone is waiting for are useful now.
let foregroundNotes = 0;
const noteJobs = new Map();       // canonical meeting folder -> AbortController

/**
 * Pull the optional title metadata out of a one-pass meeting draft. Models that
 * miss the instruction still leave usable notes; naming is always best-effort.
 */
function splitMeetingDraft(raw, includeTitle) {
  let summary = String(raw || '').trim();
  let title = '';
  if (includeTitle) {
    const match = summary.match(/^YAPPER_TITLE:\s*([^\r\n]+)\r?\n+/i);
    if (match) {
      title = cleanTitle(match[1]);
      summary = summary.slice(match[0].length).trim();
    }
  }
  return { summary, title };
}

/** Generate and save the notes, optionally naming the meeting in the same call. */
async function writeGeneratedMeeting(folder, options, includeTitle = false, onProgress = null) {
  folder = requireMeetingFolder(folder);
  if (noteJobs.has(folder)) throw new Error('Notes are already being generated for this meeting.');
  const controller = new AbortController();
  noteJobs.set(folder, controller);
  foregroundNotes++;
  const started = Date.now();
  let firstTextMs = null;
  try {
    if (!meetingFileExists(folder, 'transcript.txt')) {
      throw new Error('This meeting has no transcript to summarize.');
    }
    writeParticipants(folder, options && options.participants);
    const transcript = readMeetingText(folder, 'transcript.txt', {
      required: true, maxBytes: 64 * 1024 * 1024
    });
    const raw = await runModel(buildPrompt(options, includeTitle), transcript, undefined,
      (_chunk, text) => {
        if (firstTextMs === null && text) firstTextMs = Date.now() - started;
        if (onProgress) onProgress({ folder, text, firstTextMs, elapsedMs: Date.now() - started });
      }, controller.signal);
    const result = splitMeetingDraft(raw, includeTitle);
    if (!result.summary) throw new Error('The note provider returned no meeting notes.');
    writeMeetingText(folder, 'notes.md', result.summary, { maxBytes: 5 * 1024 * 1024 });
    if (result.title) writeMeetingText(folder, 'title.txt', result.title, { maxBytes: 1000 });
    refreshLibrary();
    return {
      ...result,
      metrics: { firstTextMs, notesMs: Date.now() - started }
    };
  } finally {
    if (noteJobs.get(folder) === controller) noteJobs.delete(folder);
    foregroundNotes--;
  }
}

ipcMain.handle('summarize', async (_e, folder, transcript, options) => {
  return (await writeGeneratedMeeting(folder, options)).summary;
});

// The normal stop/import path uses one provider request for both notes and the
// automatic title. Starting a second model process after the notes were ready
// was pure visible wait, especially through the Claude CLI.
ipcMain.handle('generate-notes', async (_event, folder, options, includeTitle) =>
  writeGeneratedMeeting(folder, options, !!includeTitle, payload => {
    try { if (win && !win.isDestroyed()) win.webContents.send('notes-progress', payload); } catch { /* window closed */ }
  }));

ipcMain.handle('regenerate', async (_event, folder, options) => {
  return (await writeGeneratedMeeting(folder, options, false, payload => {
    try { if (win && !win.isDestroyed()) win.webContents.send('notes-progress', payload); } catch { /* window closed */ }
  })).summary;
});

ipcMain.handle('cancel-notes', async (_event, folder) => {
  folder = requireMeetingFolder(folder);
  const controller = noteJobs.get(folder);
  if (!controller) return false;
  controller.abort();
  return true;
});

function runOk(cmd, args) {
  return new Promise(resolve => {
    try {
      const p = spawn(cmd, args);
      p.on('error', () => resolve(false));
      p.on('close', code => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

// The splash pays for this once and the renderer reuses it. On a machine that
// has never run Yapper it also includes the calibration pass, which is why it
// belongs behind the splash rather than in front of the first recording.
// The promise is cached, not its result: the splash and the renderer both ask,
// and two calibrations running at once fight over the same server.
let envCache = null;

function checkEnvironment() {
  if (!envCache) {
    envCache = (async () => {
      const whisper = engine.isInstalled() && engine.hasModel(engine.CALIBRATION_MODEL);
      const notes = await notesReady();
      return { whisper, notes, tier: whisper ? await ensureTier() : 'modest' };
    })().catch(err => {
      envCache = null;                       // let a later caller retry
      throw err;
    });
  }
  return envCache;
}

/**
 * Decide once what this machine can promise, then remember it. The measurement
 * is redone when the app is moved to different hardware, since the binaries it
 * found there may not be the ones it was calibrated with.
 */
async function ensureTier() {
  const s = readSettings();
  const flavour = path.basename(engine.binDir());
  // The measured pace decides how long a request may go unanswered before the
  // server is called dead, so it has to survive a restart — otherwise every
  // launch runs on the loose fallback deadline until something recalibrates.
  if (s.tierMs) engine.setPace(s.tierMs);
  if (s.tier && s.tierFor === flavour) {
    // A stored `fast` on Apple Silicon predates `balanced`; it is moved over
    // once, here, so the setting stops saying something this machine should
    // not run.
    const tier = engine.forThisMachine(s.tier);
    if (tier !== s.tier) {
      console.log(`[engine] stored tier ${s.tier} -> ${tier} on this hardware`);
      writeSettings({ tier });
    }
    return tier;
  }
  try {
    const res = await engine.calibrate();
    if (!res) return engine.forThisMachine(s.tier || engine.guessTier());
    const tier = engine.forThisMachine(res.tier);
    console.log(`[engine] calibrated: ${res.msPerPass} ms per pass -> ${tier} tier`);
    // Only the keys this function owns. `s` was read before a calibration that
    // takes seconds — on a CPU-only machine, many seconds — and writing the
    // whole of it here replays every field as it was back then, undoing
    // whatever the user changed while the engine was being measured. That is
    // not hypothetical: test-theme caught a theme picked mid-calibration being
    // reverted, on the first Windows run.
    writeSettings({ tier, tierFor: flavour, tierMs: res.msPerPass });
    return tier;
  } catch (err) {
    console.log('[engine] calibration failed:', err.message);
    return engine.forThisMachine(s.tier || engine.guessTier());
  }
}

/**
 * Can notes be generated at all? What counts depends on who is writing them:
 * the CLI has to actually be installed, everything else needs a key.
 */
async function notesReady() {
  const cfg = llmConfig();
  const p = llm.PROVIDERS[cfg.provider];
  if (!p) return { ok: false, provider: cfg.provider, reason: 'No note provider is configured.' };
  if (p.needsKey) {
    return cfg.apiKey
      ? { ok: true, provider: cfg.provider, label: p.label }
      : { ok: false, provider: cfg.provider, label: p.label, reason: `${p.label} has no API key yet.` };
  }
  const ok = await runOk(resolveClaude(), ['--version']);
  return ok
    ? { ok: true, provider: cfg.provider, label: p.label }
    : {
      ok: false, provider: cfg.provider, label: p.label,
      reason: 'Claude Code was not found. Install it from claude.com/code and sign in, or use an API key instead.'
    };
}

// What each style actually asks the model for. The UI uses it to stay in step
// with the prompts instead of duplicating the list of styles.
ipcMain.handle('style-sections', async () => ({ ...SECTION_SETS }));

ipcMain.handle('check-environment', async () => checkEnvironment());
// Just the provider half, uncached: the Today banner asks again after a key
// is saved or a connection test passes, so it can go away the moment it is
// no longer true.
ipcMain.handle('notes-ready', async () => notesReady());

// ---------- first-run engine download ----------
// A fresh install has the app shell and nothing to transcribe with. The
// renderer notices (check-environment says no whisper) and asks for this; the
// download reports through its own channel and the environment is re-checked —
// which is also what triggers calibration — once the engine lands.
//
// It opens on the *usable* milestone, not the complete one. The engine binary
// and `base` are ~160 MB; `small` is another ~490 MB behind them. Waiting for
// all of it before the first recording is possible costs a new user ten
// minutes of nothing, and it buys nothing back: a meeting not recorded is gone
// for good, while a transcript can always be produced afterwards from audio
// already on disk. So recording opens early and `small` keeps arriving.
//
// Two promises, therefore. `provisioning` is the whole job; `usable` settles
// the moment recording is possible, and never rejects on its own — if the run
// dies before that point, the run's own result is the answer.

let provisioning = null;      // the whole download, or null when none is running
let usable = null;            // resolves when recording can start

function engineUsable() {
  return engine.isInstalled() && engine.hasModel(engine.CALIBRATION_MODEL);
}

function engineComplete() {
  return engine.isInstalled() && engine.hasModel('base') && engine.hasModel('small');
}

/** Start the download if it is not already running. Returns the whole job. */
function startProvisioning() {
  if (provisioning) return provisioning;

  let reachedUsable;
  usable = new Promise(res => { reachedUsable = res; });

  provisioning = provision.run({
    home: engineHome(),
    gpu: engine.hasNvidiaGpu(),
    progress: p => {
      broadcast('engine-setup-progress', p);
      if (p.usable) {
        envCache = null;      // recording is possible; re-check and calibrate
        reachedUsable(true);
      }
    }
  }).then(ok => {
    provisioning = null;
    if (ok) envCache = null;            // the next check measures the machine
    reachedUsable(engineUsable());      // no-op if the milestone already fired
    return ok;
  }).catch(err => {
    provisioning = null;
    console.log('[provision] failed:', err.message);
    broadcast('engine-setup-progress', { error: err.message });
    reachedUsable(engineUsable());
    return false;
  });

  return provisioning;
}

/** What the renderer waits on before it lets anyone press record. */
function ensureEngine() {
  if (engineUsable()) {
    if (!engineComplete()) startProvisioning();   // finish `small` in the background
    return Promise.resolve(true);
  }
  const whole = startProvisioning();
  return Promise.race([usable, whole]);
}

/**
 * What transcription waits on: the download that is *already running*, not a
 * new one. By the time a meeting ends the background half has usually
 * finished; when it has not, this is where the wait happens — with the audio
 * already safe on disk.
 */
async function ensureModel(name) {
  if (engine.hasModel(name)) return true;
  if (!provisioning) return false;    // nothing in flight; the caller reports it
  await provisioning;
  return engine.hasModel(name);
}

function engineHome() {
  return app.isPackaged
    ? path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'Yapper', 'engine')
    : __dirname;
}

ipcMain.handle('engine-setup', async () => ensureEngine());

// ---------- auto-update ----------
// Installed copies keep themselves current from the release feed: checked at
// launch and every few hours, downloaded in the background, applied on quit —
// or right away if the user clicks the pill the renderer shows. A development
// checkout updates with git and skips all of this.
//
const RELEASES_LATEST = 'https://github.com/iamchuck504/yapper-releases/releases/latest';
let updater = null;

function setupAutoUpdate() {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require('electron-updater');
    updater = autoUpdater;
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;   // ignoring the pill still updates, just later
    updater.on('update-downloaded', info => broadcast('update-ready', { version: info.version }));
    updater.on('error', err => console.log('[update] check failed:', String(err && err.message).slice(0, 200)));
    updater.checkForUpdates().catch(() => { /* offline is fine */ });
    setInterval(() => updater.checkForUpdates().catch(() => { }), 4 * 60 * 60 * 1000);
  } catch (err) {
    console.log('[update] not available:', err.message);
  }
}

ipcMain.handle('update-restart', async () => {
  if (updater) { updater.quitAndInstall(); return 'installing'; }
  return 'none';
});

// The page is still one click away for anyone who would rather see it.
ipcMain.handle('open-releases-page', async () => {
  await shell.openExternal(RELEASES_LATEST);
  return true;
});

ipcMain.handle('save-notes', async (_e, folder, md) => {
  folder = requireMeetingFolder(folder);
  md = String(md || '');
  if (Buffer.byteLength(md, 'utf8') > 5 * 1024 * 1024) throw new Error('Those notes are too large to save.');
  writeMeetingText(folder, 'notes.md', md, { maxBytes: 5 * 1024 * 1024 });
  refreshLibrary();               // edited notes can change the action items
  return true;
});

// ---------- automatic meeting title ----------

const TITLE_PROMPT = `From this meeting transcript, write a short title naming what the meeting was actually about.

Rules:
- 2 to 6 words, in English.
- Name the concrete topic, project or decision — not generic filler like "Team Meeting" or "Discussion".
- Title Case. No quotes, no trailing period, no preamble.
- If the transcript is too short or unintelligible to tell, reply exactly: Untitled Meeting

Reply with the title and nothing else.`;

function cleanTitle(raw) {
  const line = String(raw || '').trim().split('\n')[0].trim();
  const cleaned = line
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[.]+$/, '')
    .replace(/[\\/:*?"<>|]/g, '')     // keep it usable as a file name
    .trim();
  if (!cleaned || /^untitled meeting$/i.test(cleaned)) return '';
  return cleaned.split(/\s+/).slice(0, 8).join(' ');
}

ipcMain.handle('generate-title', async (_e, folder) => {
  folder = requireMeetingFolder(folder);
  if (!meetingFileExists(folder, 'transcript.txt')) return '';
  const transcript = readMeetingText(folder, 'transcript.txt', { required: true, maxBytes: 64 * 1024 * 1024 });
  if (transcript.trim().length < 120) return '';        // too little was said
  // the opening minutes usually frame the meeting; keep the prompt cheap
  const excerpt = transcript.slice(0, 6000);
  let title = '';
  try {
    title = cleanTitle(await runModel(TITLE_PROMPT, excerpt, 64));
  } catch {
    return '';                                          // titling is best-effort
  }
  if (title) writeMeetingText(folder, 'title.txt', title, { maxBytes: 1000 });
  return title;
});

// ---------- exports ----------

ipcMain.handle('save-text-file', async (_e, { defaultName, content, extension, description }) => {
  const exportTypes = { md: 'Markdown', txt: 'Text' };
  if (!exportTypes[extension]) throw new Error('That export format is not supported.');
  content = String(content || '');
  if (Buffer.byteLength(content, 'utf8') > 25 * 1024 * 1024) {
    throw new Error('That export is too large to save safely.');
  }
  const safe = String(defaultName || 'yapper-export').replace(/[\\/:*?"<>|]/g, '_');
  const res = await dialog.showSaveDialog(win, {
    title: 'Export',
    defaultPath: `${safe}.${extension}`,
    filters: [{ name: exportTypes[extension], extensions: [extension] }]
  });
  if (res.canceled || !res.filePath) return null;
  fs.writeFileSync(res.filePath, content, 'utf8');
  return res.filePath;
});

ipcMain.handle('list-meetings', async () => {
  if (!fs.existsSync(MEETINGS_DIR)) return [];
  return fs.readdirSync(MEETINGS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .flatMap(d => {
      try {
        const folder = requireMeetingFolder(path.join(MEETINGS_DIR, d.name));
        return [{
        name: d.name,
        title: readMeetingText(folder, 'title.txt', { maxBytes: 1000 }).trim(),
        folder,
        hasSummary: meetingFileExists(folder, 'notes.md'),
        hasTranscript: meetingFileExists(folder, 'transcript.txt'),
        audioSec: Math.round(audioSeconds(folder))
        }];
      } catch (err) {
        console.warn(`[security] skipped invalid meeting ${d.name}: ${err.message}`);
        return [];
      }
    })
    .sort((a, b) => b.name.localeCompare(a.name));
});

/** How much audio a meeting holds, so the UI can tell a false start apart. */
function audioSeconds(folder) {
  try {
    if (meetingFileExists(folder, 'recording.wav')) {
      const wav = resolveDirectFile(folder, path.join(folder, 'recording.wav'));
      return Math.max(0, fs.statSync(wav).size - engine.WAV_HEADER) / engine.BYTES_PER_SEC;
    }
    // a legacy compressed recording: size is all we have, so only say "not empty"
    const legacy = fs.readdirSync(folder).find(f => /^recording\./i.test(f));
    return legacy && fs.statSync(resolveDirectFile(folder, path.join(folder, legacy))).size > 4096 ? -1 : 0;
  } catch {
    return 0;
  }
}

// ---------- deleting a meeting ----------
// A false start leaves a folder with a few seconds of silence in it, and there
// was no way to get rid of one. Deletion goes to the recycle bin rather than
// straight out, because the one thing this app must never do is lose audio.

function describeMeeting(folder) {
  const secs = audioSeconds(folder);
  const bits = [];
  if (secs > 0) {
    const mins = Math.floor(secs / 60);
    bits.push(mins >= 1 ? `${mins} min of audio` : `${Math.round(secs)} s of audio`);
  } else if (secs < 0) {
    bits.push('a recording');
  }
  if (meetingFileExists(folder, 'transcript.txt')) bits.push('a transcript');
  if (meetingFileExists(folder, 'notes.md')) bits.push('notes');
  return bits;
}

ipcMain.handle('delete-meeting', async (_e, folder) => {
  try {
    folder = requireMeetingFolder(folder);
  } catch {
    return { deleted: false, reason: 'That meeting is no longer there.' };
  }

  const bits = describeMeeting(folder);
  const name = path.basename(folder);
  const res = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Delete', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Delete meeting',
    message: `Delete the meeting from ${name}?`,
    detail: bits.length
      ? `It contains ${listPhrase(bits)}. It goes to the recycle bin, so it can still be recovered from there.`
      : 'It is empty — nothing was recorded. It goes to the recycle bin.'
  });
  if (res.response !== 0) return { deleted: false };

  // if this is the meeting being recorded right now, let go of the file first
  if (recFolder && path.resolve(recFolder) === path.resolve(folder)) closeRecFile();

  try {
    await shell.trashItem(folder);
  } catch (err) {
    return { deleted: false, reason: `It could not be deleted: ${err.message}` };
  }
  return { deleted: true };
});

function listPhrase(items) {
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

ipcMain.handle('load-meeting', async (_e, folder) => {
  folder = requireMeetingFolder(folder);
  const hasSpeakerSource = meetingFileExists(folder, 'transcript.raw.txt');
  const rawTranscript = hasSpeakerSource
    ? readMeetingText(folder, 'transcript.raw.txt', { maxBytes: 64 * 1024 * 1024 })
    : '';
  return {
    transcript: readMeetingText(folder, 'transcript.txt', { maxBytes: 64 * 1024 * 1024 }),
    summary: readMeetingText(folder, 'notes.md', { maxBytes: 5 * 1024 * 1024 }),
    title: readMeetingText(folder, 'title.txt', { maxBytes: 1000 }).trim(),
    participants: readMeetingText(folder, 'participants.txt', { maxBytes: 10000 }).trim(),
    // Older transcripts predate the immutable label source. Do not show a
    // mapping panel that cannot safely be reapplied from those files.
    speakers: hasSpeakerSource ? speakerDiarizer.speakerState(rawTranscript, readSpeakerMap(folder)) : [],
    hasRecording: fs.readdirSync(folder).some(f => {
      if (!f.startsWith('recording.')) return false;
      try { resolveDirectFile(folder, path.join(folder, f)); return true; } catch { return false; }
    })
  };
});

// A title typed by hand after the fact. Same file the automatic title goes to,
// so everything that reads titles — sidebar, search, digests — sees it at once.
ipcMain.handle('rename-meeting', async (_e, folder, title) => {
  folder = requireMeetingFolder(folder);
  const clean = String(title || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\\/:*?"<>|]/g, '')     // keep it usable as a file name
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  if (!clean) throw new Error('Type a title, or press Escape to keep the old one.');
  writeMeetingText(folder, 'title.txt', clean, { maxBytes: 1000 });
  refreshLibrary();
  return clean;
});

ipcMain.handle('set-speaker-map', async (_e, folder, nextMap) => {
  folder = requireMeetingFolder(folder);
  if (!meetingFileExists(folder, 'transcript.raw.txt')) {
    throw new Error('This meeting does not have separate speaker tracks.');
  }
  const rawTranscript = rawMeetingTranscript(folder);
  const map = speakerDiarizer.normalizeSpeakerMap(nextMap);
  const transcript = speakerDiarizer.applySpeakerMap(rawTranscript, map);
  writeMeetingText(folder, 'speaker-map.json', JSON.stringify(map, null, 2), { maxBytes: 64 * 1024 });
  writeMeetingText(folder, 'transcript.txt', transcript, { maxBytes: 64 * 1024 * 1024 });
  refreshLibrary();
  return { transcript, speakers: speakerDiarizer.speakerState(rawTranscript, map) };
});

ipcMain.handle('open-folder', async (_e, folder) => {
  folder = requireMeetingFolder(folder);
  return shell.openPath(folder);
});

// Only the sign-up pages the app itself offers: the renderer does not get to
// name arbitrary URLs for the OS to open.
const ALLOWED_LINKS = new Set(llm.providerList().map(p => p.keyUrl).filter(Boolean));

ipcMain.handle('open-external', async (_e, url) => {
  if (!ALLOWED_LINKS.has(url)) return false;
  await shell.openExternal(url);
  return true;
});

// ---------- the Screen Recording dead end ----------
// Telling someone to grant a permission is only useful if they can act on it.
// macOS puts this one behind a settings pane the app cannot toggle, and then
// refuses to apply the grant to a process that was already running — so the
// honest instruction has three steps, two of which the app can just do.

// Two doors, two panes. Sending someone to Screen Recording when what they
// need is System Audio Recording Only is worse than saying nothing: the switch
// they are looking for is not on that page at all.
const SETTINGS_PANE = {
  audio: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
};

ipcMain.handle('open-screen-settings', async (_e, which) => {
  if (process.platform !== 'darwin') return false;
  await shell.openExternal(SETTINGS_PANE[which] || SETTINGS_PANE.screen);
  return true;
});

ipcMain.handle('relaunch-app', async () => {
  // The renderer disables the button mid-recording, but a relaunch that throws
  // a meeting away is bad enough to check for twice. `rendererRecording` and
  // not `liveOn`: the modest tier records with no live transcript at all, so
  // `liveOn` is false through a perfectly real meeting.
  if (rendererRecording) return false;
  app.relaunch();
  app.exit(0);
  return true;
});

// ---------- reminders / action items ----------

function remindersFile() {
  return path.join(app.getPath('userData'), 'reminders.json');
}
function readReminders() {
  try {
    const list = JSON.parse(fs.readFileSync(remindersFile(), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}
function writeReminders(list) {
  atomicWriteFileSync(remindersFile(), JSON.stringify(list, null, 2));
}

// macOS exposes /var through /private/var. A validated meeting path is
// canonical, while an index created from app.getPath() can retain the alias;
// compare the real location so source links and repeated mentions survive.
function meetingFolderKey(folder) {
  try { return fs.realpathSync(folder); } catch { return path.resolve(String(folder || '')); }
}

ipcMain.handle('list-reminders', async () => readReminders());

ipcMain.handle('add-reminder', async (_e, text, source) => {
  const t = String(text || '').trim().slice(0, 2000);
  if (!t) return null;
  const now = Date.now();
  const sourceInfo = source && typeof source === 'object' ? source : { title: source };
  const origin = String(sourceInfo.title || '').trim().slice(0, 500);
  let folder = '';
  if (sourceInfo.folder) {
    try { folder = requireMeetingFolder(sourceInfo.folder); } catch { folder = ''; }
  }
  const meeting = folder
    ? meetings().find(m => meetingFolderKey(m.folder) === meetingFolderKey(folder))
    : null;
  const parsed = actions.parseActionItems(`## Action items\n- ${t}`, {
    folder,
    title: origin || (meeting && meeting.title) || '',
    date: (meeting && meeting.date) || ''
  })[0];
  const candidate = parsed || {
    text: t, owner: '', due: '', priority: 'normal', folder,
    meeting: origin || (meeting && meeting.title) || '', meetingDate: (meeting && meeting.date) || ''
  };
  const merged = actions.mergeActionItems(readReminders(), [candidate], now);
  for (const item of merged.list) if (!item.id) item.id = crypto.randomUUID();

  // A newly chosen item belongs at the top of the stack. Repeated clicks or a
  // restatement in another selected meeting enrich the existing row instead.
  if (merged.added) merged.list.unshift(merged.list.pop());
  writeReminders(merged.list);
  return merged.list.find(item => actions.isDuplicate(item, candidate)) || null;
});

ipcMain.handle('update-reminder', async (_e, id, fields) => {
  const list = readReminders();
  const r = list.find(x => x.id === id);
  if (r && fields && typeof fields === 'object') {
    if (typeof fields.done === 'boolean') r.done = fields.done;
    if (typeof fields.text === 'string' && fields.text.trim()) r.text = fields.text.trim().slice(0, 2000);
    r.updatedAt = Date.now();
    writeReminders(list);
  }
  return r || null;
});

// Several rows at once, one write. Only the done flag: bulk edits of text or
// owner would be a way of corrupting a whole list with one click.
ipcMain.handle('update-reminders', async (_e, ids, fields) => {
  const wanted = new Set(Array.isArray(ids) ? ids.map(String) : []);
  if (!wanted.size || !fields || typeof fields !== 'object' || typeof fields.done !== 'boolean') return 0;
  const list = readReminders();
  const now = Date.now();
  let changed = 0;
  for (const r of list) {
    if (!wanted.has(r.id) || r.done === fields.done) continue;
    r.done = fields.done;
    r.updatedAt = now;
    changed++;
  }
  if (changed) writeReminders(list);
  return changed;
});

ipcMain.handle('delete-reminder', async (_e, id) => {
  writeReminders(readReminders().filter(x => x.id !== id));
  return true;
});

// ---------- the library: one index over every meeting ----------
// The weekly summary, the daily digest and search all ask questions about every
// meeting at once. This keeps a derived index so they do not each re-read
// twenty-eight folders. Action items remain facts in the index, but enter the
// personal list only when the user chooses them inside a meeting.

function libraryFile() {
  return path.join(app.getPath('userData'), 'index.json');
}

let libraryCache = null;

/**
 * Bring the index up to date. Returns the meetings, newest first.
 */
function refreshLibrary() {
  const { meetings, changed } = library.refresh({
    meetingsDir: MEETINGS_DIR,
    indexFile: libraryFile()
  });
  libraryCache = meetings;

  // Changed notes also age the current week's written review, so its rewrite
  // starts now rather than when the user next opens the week view.
  if (changed.length) queueWeeklyPrewarm();

  return meetings;
}

function meetings() {
  return libraryCache || refreshLibrary();
}

ipcMain.handle('refresh-library', async () => refreshLibrary().length);

// ---------- search ----------
// The index is built from the library and thrown away when the library changes.
// A few megabytes of transcript ranks in milliseconds, so there is nothing to
// persist and nothing to keep in step.

let searchIndex = null;
let searchIndexFor = 0;

function ensureSearchIndex() {
  const list = meetings();
  if (searchIndex && searchIndexFor === list.length && searchIndex.builtFrom === libraryCache) {
    return searchIndex;
  }
  searchIndex = search.buildIndex(list, m => {
    try {
      return readMeetingText(m.folder, 'transcript.txt', { maxBytes: 64 * 1024 * 1024 });
    } catch { return ''; }
  });
  searchIndex.builtFrom = libraryCache;
  searchIndexFor = list.length;
  return searchIndex;
}

ipcMain.handle('search', async (_e, query, opts = {}) => {
  const index = ensureSearchIndex();
  const { query: parsed, results } = search.search(index, query, {
    today: library.today(),
    limit: opts.limit || 20
  });
  return {
    query: { raw: parsed.raw, question: parsed.question, people: parsed.people,
      kinds: parsed.kinds, from: parsed.from, to: parsed.to },
    results,
    searched: index.passages.length,
    meetings: index.meetings
  };
});

/**
 * A question, answered only from what the search retrieved. The passages are the
 * evidence and the citation at once: no passages, no answer.
 */
ipcMain.handle('ask', async (_e, question) => {
  const index = ensureSearchIndex();
  const { results } = search.search(index, question, { today: library.today(), limit: 12, perMeeting: 3 });
  if (!results.length) {
    return { answer: '', results: [], reason: 'nothing-found' };
  }
  try {
    const answer = await llm.generate(llmConfig(), {
      system: search.ANSWER_PROMPT,
      input: `Question: ${question}\n\nPassages from the meetings:\n\n${search.passagesForPrompt(results)}`,
      maxTokens: 600
    });
    return { answer: search.cleanAnswer(answer), results };
  } catch (err) {
    // The passages are still useful on their own, so they come back either way.
    return { answer: '', results, error: err.message };
  }
});

/** Everything the action items view needs, with its meeting resolved. */
ipcMain.handle('list-actions', async () => {
  const byFolder = new Map(meetings().map(m => [meetingFolderKey(m.folder), m]));
  return readReminders().map(r => {
    const m = byFolder.get(meetingFolderKey(r.folder));
    return {
      ...r,
      meeting: r.meeting || (m ? (m.title || m.name) : ''),
      meetingDate: r.meetingDate || (m ? m.date : ''),
      // a task mentioned in several meetings shows all of them
      mentions: (r.sources || []).filter(f => byFolder.has(meetingFolderKey(f))).map(f => ({
        folder: f,
        title: byFolder.get(meetingFolderKey(f)).title || byFolder.get(meetingFolderKey(f)).name,
        date: byFolder.get(meetingFolderKey(f)).date
      }))
    };
  });
});

// ---------- digests ----------
// Today's is assembled from the notes and costs nothing, so it is never cached:
// recomputing it is cheaper than deciding whether a cached copy is still good.
// The week's costs a model call, so it is cached under the fingerprint of the
// meetings it was built from — edit any of them and the next open regenerates.

function digestFile(name) {
  return path.join(app.getPath('userData'), 'digests', `${name}.json`);
}

function readDigest(name) {
  try {
    return JSON.parse(fs.readFileSync(digestFile(name), 'utf8'));
  } catch { return null; }
}

function writeDigest(name, data) {
  try {
    fs.mkdirSync(path.dirname(digestFile(name)), { recursive: true });
    atomicWriteFileSync(digestFile(name), JSON.stringify(data));
  } catch (err) {
    console.log(`[digest] could not cache ${name}: ${err.message}`);
  }
}

ipcMain.handle('daily-digest', async (_e, day) => {
  const list = meetings();
  const on = day || library.today();
  return {
    ...digest.dailyDigest({ meetings: list, items: readReminders(), day: on }),
    // so the view can offer the previous day that actually had something
    previous: previousDayWith(list, on)
  };
});

function previousDayWith(list, day) {
  const earlier = [...new Set(list.filter(m => m.date && m.date < day).map(m => m.date))];
  earlier.sort((a, b) => b.localeCompare(a));
  return earlier[0] || '';
}

/**
 * The written half runs in the background, one job per week at a time, so the
 * view never waits on a model. When a job lands (or fails) the renderer is
 * told and asks again; by then the answer is on disk and comes back instantly.
 *
 * A failed key is remembered so a reload does not turn into a retry loop —
 * only an explicit rewrite, or notes that actually changed, try again.
 */
const weeklyJobs = new Map();     // week label -> in-flight promise
const weeklyFailed = new Map();   // week label -> { key, error }

function writeWeeklyInBackground(week, inWeek, input, key) {
  if (weeklyJobs.has(week.label)) return;
  const job = (async () => {
    try {
      const text = await llm.generate(llmConfig(), {
        system: digest.WEEKLY_PROMPT,
        input: input.text,
        maxTokens: 1200
      });
      const parsed = digest.parseWeekly(text, inWeek);
      const summary = {
        sections: parsed.sections,
        dropped: parsed.dropped.length,
        truncated: input.truncated,
        fromMeetings: input.meetings
      };
      writeDigest(`weekly-${week.label}`, { key, summary });
      weeklyFailed.delete(week.label);
      if (win && !win.isDestroyed()) win.webContents.send('weekly-written', { from: week.from });
    } catch (err) {
      weeklyFailed.set(week.label, { key, error: err.message });
      if (win && !win.isDestroyed()) win.webContents.send('weekly-written', { from: week.from, error: err.message });
    } finally {
      weeklyJobs.delete(week.label);
    }
  })();
  weeklyJobs.set(week.label, job);
}

/**
 * The week: the facts first, then the written part. The facts never depend on
 * the model, and the written part is whatever is on disk right now — fresh,
 * stale while a rewrite runs, or absent while the first write runs. The reply
 * is immediate in every one of those states.
 */
ipcMain.handle('weekly-summary', async (_e, opts = {}) => {
  const list = meetings();
  const week = library.weekOf(opts.week || library.today());
  const inWeek = library.inRange(list, week.from, week.to);
  const facts = digest.weeklyFacts({
    meetings: list, items: readReminders(), from: week.from, to: week.to, today: library.today()
  });
  const base = {
    week: week.label, from: week.from, to: week.to, facts,
    previous: previousWeekWith(list, week.from)
  };

  if (facts.empty) return { ...base, reason: 'no-meetings' };

  const input = digest.weeklyInput(inWeek);
  if (!input.meetings) return { ...base, reason: 'no-notes' };
  if (facts.thin) return { ...base, reason: 'thin' };

  const key = digest.digestKey(inWeek);
  const saved = readDigest(`weekly-${week.label}`);
  const fresh = !!saved && saved.key === key;
  const stale = saved && !fresh ? { ...saved.summary, stale: true } : null;

  if (fresh && !opts.refresh) return { ...base, ...saved.summary, cached: true };

  if (opts.refresh) weeklyFailed.delete(week.label);
  const failed = weeklyFailed.get(week.label);
  if (failed && failed.key === key && !weeklyJobs.has(week.label)) {
    return { ...base, ...(fresh ? saved.summary : stale || {}), error: failed.error };
  }

  writeWeeklyInBackground(week, inWeek, input, key);
  if (fresh) return { ...base, ...saved.summary, cached: true, writing: true };
  if (stale) return { ...base, ...stale, cached: true, writing: true };
  return { ...base, writing: true };
});

/**
 * Pre-write the current week's review while its notes are still warm, so that
 * by the time the user opens the week view the answer is already on disk.
 * Debounced, because one recording ends in several library refreshes in a row.
 */
let weeklyPrewarmTimer = null;
const WEEKLY_IDLE_MS = 30000;
function queueWeeklyPrewarm() {
  clearTimeout(weeklyPrewarmTimer);
  weeklyPrewarmTimer = setTimeout(() => {
    if (foregroundNotes || rendererRecording) {
      queueWeeklyPrewarm();
      return;
    }
    try {
      const list = meetings();
      const week = library.weekOf(library.today());
      const inWeek = library.inRange(list, week.from, week.to);
      if (inWeek.filter(m => m.hasNotes).length < 2) return;   // the view calls this "thin"
      const input = digest.weeklyInput(inWeek);
      if (!input.meetings) return;
      const key = digest.digestKey(inWeek);
      const saved = readDigest(`weekly-${week.label}`);
      if (saved && saved.key === key) return;
      const failed = weeklyFailed.get(week.label);
      if (failed && failed.key === key) return;
      writeWeeklyInBackground(week, inWeek, input, key);
    } catch (err) {
      console.log(`[digest] weekly pre-write skipped: ${err.message}`);
    }
  }, WEEKLY_IDLE_MS);
}

/**
 * The last week that actually had a meeting, or '' if there is nothing earlier.
 * Stepping back seven days at a time would walk a new user through empty weeks
 * forever, so the offer is only made when there is something to land on.
 */
function previousWeekWith(list, from) {
  const earlier = list.filter(m => m.date && m.date < from).map(m => m.date);
  if (!earlier.length) return '';
  return earlier.sort((a, b) => b.localeCompare(a))[0];
}

// ---------- meeting auto-detection ----------
// "Which app is using the microphone right now" is the one signal that catches
// every meeting: Zoom/Teams/Slack huddles natively, and Meet/Hangouts via the
// browser. On Windows it lives in the CapabilityAccessManager consent store.

const { matchMeetingApp, whileRecording } = require('./meetings');

const MIC_CONSENT_KEY =
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone';

function micUsersWindows() {
  return new Promise(resolve => {
    let out = '';
    let p;
    let settled = false;
    let timer = null;
    const finish = value => {
      if (settled) return false;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
      return true;
    };
    try {
      p = spawn('reg', ['query', MIC_CONSENT_KEY, '/s']);
    } catch {
      return finish(null);
    }
    timer = setTimeout(() => {
      if (!finish(null)) return;
      try { p.kill(); } catch { /* already gone */ }
    }, 4000);
    timer.unref();
    p.stdout.on('data', d => { out += d.toString('utf8'); });
    p.on('error', () => finish(null));
    p.on('close', code => {
      if (code !== 0) return finish(null);
      const users = [];
      let key = '';
      let start = null;
      const flush = () => {
        // a live user has a start time but no stop time
        if (key && start && start !== '0x0') {
          const exe = key.split(/[#\\]/).pop().toLowerCase();
          if (exe.endsWith('.exe')) users.push(exe);
        }
        start = null;
      };
      for (const raw of out.split(/\r?\n/)) {
        const line = raw.trim();
        if (line.startsWith('HKEY_')) { flush(); key = line; continue; }
        const m = line.match(/^LastUsedTime(Start|Stop)\s+REG_QWORD\s+(\S+)/i);
        if (!m) continue;
        if (m[1].toLowerCase() === 'start') start = m[2];
        else if (m[2] !== '0x0') start = null;   // stopped -> not in use
      }
      flush();
      finish([...new Set(users)]);
    });
  });
}

// macOS answers the same question through CoreAudio, via the small Swift probe
// in mac/mic-probe.swift. It has to live outside the asar: this process could
// read it in there, but it cannot be executed from inside one.
function probePath() {
  return helperPath('mic-probe');
}

// The probe stays resident while auto-detection is on (`--watch`): CoreAudio
// tells it about changes, it prints a line per change, and the poll below
// reads the latest line instead of launching a process every five seconds.
// The one-shot spawn stays as the fallback for a watcher that died or has not
// answered yet, so detection never depends on the resident one being healthy.
let micWatch = null;   // { proc, users, buf }

function startMicWatch() {
  if (micWatch || process.platform !== 'darwin') return;
  const probe = probePath();
  if (!fs.existsSync(probe)) return;
  let p;
  try {
    p = spawn(probe, ['--watch'], { stdio: ['pipe', 'pipe', 'ignore'] });
  } catch {
    return;
  }
  const w = { proc: p, users: null, buf: '', updatedAt: Date.now() };
  micWatch = w;
  p.stdout.on('data', d => {
    w.buf += d.toString('utf8');
    let nl;
    while ((nl = w.buf.indexOf('\n')) >= 0) {
      const line = w.buf.slice(0, nl).trim();
      w.buf = w.buf.slice(nl + 1);
      w.users = line === '?' ? null
        : [...new Set(line.split('\t').map(s => s.trim()).filter(Boolean))];
      w.updatedAt = Date.now();
    }
  });
  const gone = () => { if (micWatch === w) micWatch = null; };
  p.on('error', gone);
  p.on('close', gone);
}

function stopMicWatch() {
  const w = micWatch;
  micWatch = null;
  if (!w) return;
  try { w.proc.stdin.end(); } catch { /* already gone */ }
  setTimeout(() => { try { w.proc.kill(); } catch { /* already gone */ } }, 1000).unref();
}

/**
 * Bundle ids capturing audio right now, or null when the question could not be
 * asked. null is not "nobody": a probe that fails must never be read as the
 * meeting having ended.
 */
function micUsersMac() {
  if (micWatch && micWatch.users && Date.now() - micWatch.updatedAt < 45000) {
    return Promise.resolve(micWatch.users.slice());
  }
  // The resident process can stay alive while its CoreAudio listener is no
  // longer delivering. Restart a stale watcher, but use a bounded one-shot for
  // this poll so stale state can never end or prolong a meeting.
  if (micWatch && Date.now() - micWatch.updatedAt >= 45000) {
    stopMicWatch();
    startMicWatch();
  }
  return new Promise(resolve => {
    const probe = probePath();
    if (!fs.existsSync(probe)) return resolve(null);
    let out = '';
    let p;
    let settled = false;
    let timer = null;
    const finish = value => {
      if (settled) return false;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
      return true;
    };
    try {
      p = spawn(probe, []);
    } catch {
      return finish(null);
    }
    timer = setTimeout(() => {
      if (!finish(null)) return;
      try { p.kill(); } catch { /* already gone */ }
    }, 4000);
    timer.unref();
    p.stdout.on('data', d => { out += d.toString('utf8'); });
    p.on('error', () => finish(null));
    p.on('close', code => {
      if (code !== 0) return finish(null);
      finish([...new Set(out.split('\n').map(l => l.trim()).filter(Boolean))]);
    });
  });
}

const micUsers = () => (process.platform === 'darwin' ? micUsersMac() : micUsersWindows());

let meetingTimer = null;
let meetingCurrent = null;
let autoDetectOn = false;
let rendererRecording = false;

let meetingGoneStreak = 0;
let meetingEndedPending = false;
// Bumped on every start and stop. A poll takes a moment to answer — a spawned
// probe on macOS, a registry query on Windows — and one that started before
// the recording did would otherwise land inside it and attach the meeting it
// saw beforehand, which is the whole thing this is trying not to do.
let meetingEra = 0;

let pollInFlight = false;

async function pollMeetings() {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  // One at a time. A probe can take longer than the five seconds between
  // ticks — a registry query on a busy Windows box — and two answers landing
  // out of order would advance or reset the streak with a stale observation.
  if (pollInFlight) return;
  pollInFlight = true;
  const era = meetingEra;
  let users;
  try {
    users = await micUsers();
  } catch {
    users = null;
  } finally {
    pollInFlight = false;
  }
  if (era !== meetingEra) return;        // a recording started or ended meanwhile
  if (users === null) return;            // could not ask; say nothing
  // The label, not the process: a call can move between helper processes
  // without ever stopping, and that must not read as a second meeting.
  const hit = matchMeetingApp(users);

  // While recording, watch for the opposite signal: the meeting app letting go
  // of the microphone. Two clear polls (~10 s) avoids reacting to a blip.
  // "The meeting app let go" only means something if one was ever on the
  // microphone during this recording: a note, or a video playing with no
  // call running, used to be told the meeting ended after ten seconds and
  // stopped on its own at 73. meetingCurrent is that memory; the step itself
  // lives in meetings.js where it can be tested as a sequence.
  if (rendererRecording) {
    const step = whileRecording({ current: meetingCurrent, streak: meetingGoneStreak }, hit);
    meetingCurrent = step.current;
    meetingGoneStreak = step.streak;
    if (step.ended && win && !win.isDestroyed()) {
      meetingEndedPending = true;
      win.webContents.send('meeting-ended', true);
    } else if (hit && meetingEndedPending) {
      // The app took the microphone again during the grace minute. Withdraw
      // the pending auto-stop instead of ending a meeting that has resumed.
      meetingEndedPending = false;
      if (win && !win.isDestroyed()) win.webContents.send('meeting-ended', false);
    }
    return;
  }

  if (!hit) { meetingCurrent = null; return; }
  if (meetingCurrent === hit) return;

  meetingCurrent = hit;
  console.log(`[meetings] ${hit} is using the microphone — offering to record`);
  if (win && !win.isDestroyed()) win.webContents.send('meeting-detected', { app: hit });
  notifyMeeting(hit);
}

// A meeting starts while you are looking at Zoom, not at Yapper, so the offer
// has to come to you. On macOS the notification carries a real button; on
// Windows the toast has no actions unless the app is installed with a shortcut,
// so the whole toast is the button and the text says so.
function notifyMeeting(label) {
  if (!Notification.isSupported()) return;

  const mac = process.platform === 'darwin';
  const n = new Notification({
    title: `${label} meeting started`,
    body: mac
      ? `Yapper can take notes on this one.`
      : `Click to start recording and take notes.`,
    silent: true,
    timeoutType: 'default',
    ...(mac ? { actions: [{ type: 'button', text: 'Start recording' }], closeButtonText: 'Ignore' } : {})
  });

  const start = () => {
    if (!win || win.isDestroyed()) return;
    win.show();
    win.focus();
    win.webContents.send('start-recording');   // the renderer owns the audio
  };
  n.on('click', start);
  n.on('action', start);
  // Whether the OS actually put it on screen is not obvious from anywhere else:
  // a notification that is refused fails silently, and the only symptom is a
  // user saying the app never told them about a meeting.
  n.on('show', () => console.log('[meetings] notification shown'));
  n.on('failed', (_e, err) =>
    console.log('[meetings] the OS refused the notification:', String(err).slice(0, 200)));
  n.show();
  return n;      // returned so a probe can watch whether the OS actually shows it
}

// Only for probes and tests: the app itself never calls this from outside.
module.exports = { notifyMeeting };

function startMeetingWatch() {
  if (meetingTimer) return;
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  // No probe on disk means no detection — better silent than a timer that
  // spawns a missing binary every five seconds.
  if (process.platform === 'darwin' && !fs.existsSync(probePath())) {
    console.log('[meetings] no mic probe built; auto-detection stays off');
    return;
  }
  // Not while recording: the meeting this recording is attached to is what
  // decides whether it may be auto-ended, and toggling auto-detection off and
  // on mid-meeting must not make the app forget the call it is in.
  if (!rendererRecording) meetingCurrent = null;
  startMicWatch();
  meetingTimer = setInterval(pollMeetings, 5000);
}

function stopMeetingWatch() {
  if (meetingTimer) clearInterval(meetingTimer);
  meetingTimer = null;
  // Detection is off from this moment: a poll already in flight must not come
  // back and end a meeting, and the streak it was counting starts over if
  // detection is switched on again.
  meetingEra++;
  meetingGoneStreak = 0;
  if (meetingEndedPending && win && !win.isDestroyed()) win.webContents.send('meeting-ended', false);
  meetingEndedPending = false;
  if (!rendererRecording) meetingCurrent = null;
  stopMicWatch();
}

// The language spoken in meetings. `auto` asks Whisper to detect it on every
// request — an extra encoder pass, ~80 ms on an M4 Pro, on every live window
// and every head-start window. A fixed language skips that; it is the user's
// choice because a call that switches languages mid-way wants detection.
// YAPPER_LANG still wins, for the harnesses that pin it.
let spokenLanguage = null;   // read from settings on first use

function spokenLanguageNow() {
  if (process.env.YAPPER_LANG) return process.env.YAPPER_LANG;
  if (spokenLanguage === null) spokenLanguage = readSettings().spokenLanguage || 'auto';
  return spokenLanguage;
}

ipcMain.on('spoken-language-set', (_e, lang) => {
  const v = typeof lang === 'string' && /^[a-z]{2,3}$/.test(lang) ? lang : 'auto';
  if (v === spokenLanguage) return;
  spokenLanguage = v;
  writeSettings({ spokenLanguage: v });
});

ipcMain.on('autodetect-set', (_e, enabled) => {
  autoDetectOn = !!enabled;
  if (autoDetectOn) startMeetingWatch(); else stopMeetingWatch();
});

ipcMain.on('recording-state', (_e, recording) => {
  rendererRecording = !!recording;
  // Including every way a recording ends: stopping, aborting, a start that
  // failed halfway — they all come through here.
  throttleWhileIdle(!rendererRecording);
  // Do not let a scheduled weekly review start while a meeting is being
  // recorded. The new meeting will queue a fresh review after its notes land.
  if (rendererRecording && weeklyPrewarmTimer) clearTimeout(weeklyPrewarmTimer);
  // No more audio is coming, so there is nothing left to get ahead of. The
  // accumulated windows stay until `transcribe` collects them.
  if (!recording) stopHeadStart();
  refreshTray();               // the menu bar says start or stop, never both
  refreshAppMenu();            // and so does File
  meetingGoneStreak = 0;
  meetingEra++;               // polls already in flight belong to what came before
  if (meetingEndedPending && win && !win.isDestroyed()) win.webContents.send('meeting-ended', false);
  meetingEndedPending = false;
  // Either way, the meeting memory starts over. A recording is attached to a
  // meeting app only by a poll that sees the app on the microphone *while it
  // records*: one seen before — a call that ended a moment ago, a prompt that
  // was ignored — must not follow a memo in and stop it. A recording started
  // from the prompt re-attaches at its first poll, a few seconds in. And once
  // a recording ends, the same app may trigger a fresh prompt later.
  meetingCurrent = null;
});

// ---------- flag a moment without leaving the meeting ----------
// A global shortcut is the point: you are looking at Zoom, not at Yapper.

const MARK_ACCELERATOR = 'CommandOrControl+Shift+M';

function enableMarkShortcut(on) {
  try {
    if (on) {
      globalShortcut.register(MARK_ACCELERATOR, () => {
        if (win && !win.isDestroyed()) win.webContents.send('mark-moment');
      });
    } else {
      globalShortcut.unregister(MARK_ACCELERATOR);
    }
  } catch { /* another app owns the combo; marking from the UI still works */ }
}

ipcMain.on('mark-shortcut', (_e, on) => enableMarkShortcut(!!on));

// ---------- live streaming transcription ----------
// The renderer feeds raw 16 kHz mono PCM on 'recording-chunk'; live.js keeps a
// rolling window and confirms text as two passes agree on it. How big a model
// and how often it runs come from this machine's measured tier — a laptop gets
// a smaller model rather than a transcript that falls further behind by the
// minute, and the `modest` tier skips the live pass entirely.

let liveOn = false;

function liveStopInternal() {
  liveOn = false;
  return live.stop();
}

ipcMain.handle('live-start', async (_e, participants) => {
  await liveStopInternal();
  const tier = engine.tierConfig(readSettings().tier || engine.guessTier());
  if (!tier.live) return false;

  // The fast tier transcribes live with `small`, which can still be arriving
  // during the first session. `base` is what the steady tier uses for exactly
  // this job and it is strictly quicker, so the live transcript degrades to it
  // rather than disappearing. The final pass still waits for `small`.
  let liveModel = tier.liveModel;
  if (!engine.hasModel(liveModel)) {
    if (!engine.hasModel(engine.CALIBRATION_MODEL)) return false;
    liveModel = engine.CALIBRATION_MODEL;
    console.log(`[live] ${tier.liveModel} not downloaded yet; using ${liveModel}`);
  }

  // On battery, half as many passes. The live loop already stretches its own
  // cadence when passes run late, but on a laptop they do not run late — the
  // GPU is fast and simply drains the battery at full pace. The text lands a
  // little later; the meeting lasts longer than the charge otherwise would.
  let cadenceMs = tier.cadenceMs;
  let onBattery = false;
  try { onBattery = powerMonitor.isOnBatteryPower(); } catch { /* not on every platform */ }
  if (onBattery && cadenceMs) {
    cadenceMs *= 2;
    console.log(`[live] on battery: one pass every ${cadenceMs} ms instead of ${tier.cadenceMs}`);
  }

  try {
    const ok = await live.start({
      model: liveModel,
      cadenceMs,
      windowSec: tier.windowSec,
      maxHoldSec: tier.maxHoldSec,
      language: spokenLanguageNow(),
      prompt: transcriptionHint(participants),
      onLine: obj => broadcast('live-transcript', JSON.stringify(obj))
    });
    liveOn = ok;
    return ok;
  } catch (err) {
    console.log('[live] could not start:', err.message);
    return false;
  }
});

// (no separate PCM channel: the samples arrive on 'recording-chunk' and are
// forwarded from there, so the file and the live text share one stream)

ipcMain.handle('live-stop', async () => liveStopInternal());

ipcMain.handle('export-pdf', async (_e, html, suggestedName) => {
  html = String(html || '');
  if (!html || Buffer.byteLength(html, 'utf8') > 10 * 1024 * 1024) {
    throw new Error('Those notes are too large to export safely.');
  }
  suggestedName = String(suggestedName || 'meeting-notes').slice(0, 160);
  const res = await dialog.showSaveDialog(win, {
    title: 'Export notes to PDF',
    defaultPath: `${(suggestedName || 'meeting-notes').replace(/[\\/:*?"<>|]/g, '_')}.pdf`,
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (res.canceled || !res.filePath) return null;

  // Render from a real file so the fonts load (a data: URL is an opaque origin
  // and cannot fetch the bundled woff2). The file goes in temp — an installed
  // app cannot write inside itself — and a <base> points its relative URLs
  // back at renderer/, which Electron can serve even from inside the asar.
  const nonce = crypto.randomBytes(8).toString('hex');
  const tmpHtml = path.join(app.getPath('temp'), `yapper-pdf-${process.pid}-${nonce}.html`);
  const baseTag = `<base href="${appPageUrl('')}">`;
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${APP_SCHEME}:; font-src ${APP_SCHEME}: data:; img-src ${APP_SCHEME}: data:">`;
  const headTags = baseTag + csp;
  const doc = /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, m => m + headTags)
    : headTags + html;
  const pdfWin = new BrowserWindow({
    show: false,
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      javascript: false
    }
  });
  lockWindowToPage(pdfWin, pathToFileURL(tmpHtml).href);
  try {
    fs.writeFileSync(tmpHtml, doc, 'utf8');
    await pdfWin.loadFile(tmpHtml);
    await new Promise(r => setTimeout(r, 250));   // let the webfont settle
    // Margins are zero on purpose: Chromium cannot paint the page background
    // into a print margin, and the notes come themed. The document brings its
    // own frame as body padding instead.
    const data = await pdfWin.webContents.printToPDF({
      printBackground: true,
      margins: { marginType: 'custom', top: 0, bottom: 0, left: 0, right: 0 },
      pageSize: 'Letter'
    });
    fs.writeFileSync(res.filePath, data);
    return res.filePath;
  } finally {
    pdfWin.destroy();
    try { fs.unlinkSync(tmpHtml); } catch { /* already gone */ }
  }
});
