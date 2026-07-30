const { app, BrowserWindow, ipcMain, session, desktopCapturer, shell, dialog, screen,
  Notification, globalShortcut, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { clampToArea } = require('./bounds');
const engine = require('./engine');
const live = require('./live');
const llm = require('./llm');
const keystore = require('./keystore');
const library = require('./library');
const actions = require('./actions');
const search = require('./search');
const digest = require('./digest');
const provision = require('./provision');
const { pathToFileURL } = require('url');

const MEETINGS_DIR = path.join(app.getPath('documents'), 'Meetings');

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

function broadcast(channel, payload) {
  for (const w of [win, bubble]) {
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

// Small always-on-top window showing the live transcript while recording.
function createBubble() {
  if (bubble && !bubble.isDestroyed()) { bubble.showInactive(); return; }
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const w = 470, h = 280;   // matches EXPANDED in bubble.js; it resizes itself if collapsed
  bubble = new BrowserWindow({
    width: w,
    height: h,
    x: width - w - 24,
    y: height - h - 24,
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
      nodeIntegration: false
    }
  });
  bubble.setAlwaysOnTop(true, 'screen-saver');
  bubble.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  bubble.loadFile(path.join(__dirname, 'renderer', 'bubble.html'));
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
// mouse events over a drag region on Windows. So the cursor is watched from
// here instead, against the window's bounds, and enter/leave is pushed through
// the same bubble-state channel as everything else.
//
// The expanded window is anchored at the same bottom-right corner and is
// strictly larger, so opening always keeps the cursor inside — hover cannot
// flap open/closed on its own.
let bubbleHoverTimer = null;
let bubbleHovered = false;

function startBubbleHoverWatch() {
  if (bubbleHoverTimer) return;
  bubbleHovered = false;
  bubbleHoverTimer = setInterval(() => {
    if (!bubble || bubble.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    const b = bubble.getBounds();
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
  bubble.setBounds({
    x: b.x + b.width - size.w,
    y: b.y + b.height - size.h,
    width: size.w,
    height: size.h
  });
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
  if (win && !win.isDestroyed()) { win.show(); win.focus(); }
});

function createWindow() {
  // The last theme is remembered so the window paints its own background colour
  // instead of flashing white before the stylesheet lands.
  const dark = readSettings().theme !== 'light';
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
      nodeIntegration: false
    }
  });

  // Belt and braces for the taskbar: running unpackaged, the process is
  // electron.exe, and Windows will happily show its icon for the button unless
  // the window says otherwise.
  try { win.setIcon(appIconPath()); } catch { /* the constructor already tried */ }

  // Loopback de Windows: entrega el audio del sistema cuando el renderer pide getDisplayMedia
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then(sources => {
      callback({ video: sources[0], audio: 'loopback' });
    }).catch(() => callback({}));
  }, { useSystemPicker: false });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// ---------- app settings (kept in userData, not in the renderer) ----------

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}
function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}
function writeSettings(s) {
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2), 'utf8');
}

// Start with Windows. Defaults to on, but only the first time — after that the
// user's choice is what counts.
function applyOpenAtLogin(enabled) {
  if (process.platform === 'darwin' || process.platform === 'win32') {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: process.execPath,
      args: [path.resolve(__dirname)]
    });
  }
}

function initOpenAtLogin() {
  const s = readSettings();
  if (s.openAtLogin === undefined) {
    s.openAtLogin = true;
    writeSettings(s);
  }
  applyOpenAtLogin(s.openAtLogin);
  return s.openAtLogin;
}

ipcMain.handle('get-open-at-login', async () => readSettings().openAtLogin !== false);

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
  const owner = s.llmProvider || 'claude-cli';
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
  const provider = s.llmProvider || 'claude-cli';
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
  if (migrateLlmSettings(s)) writeSettings(s);
  const provider = s.llmProvider || 'claude-cli';
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
    : (s.llmProvider || 'claude-cli');
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

// Remembered only so the next launch can paint the right window background.
ipcMain.on('set-theme', (_e, theme) => {
  const s = readSettings();
  if (s.theme === theme) return;
  s.theme = theme === 'light' ? 'light' : 'dark';
  writeSettings(s);
});

ipcMain.handle('set-open-at-login', async (_e, enabled) => {
  const s = readSettings();
  s.openAtLogin = !!enabled;
  writeSettings(s);
  applyOpenAtLogin(s.openAtLogin);
  return s.openAtLogin;
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
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    });
    splash.setMenuBarVisibility(false);
    await splash.loadFile(path.join(__dirname, 'renderer', 'splash.html'));
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
  });

  // Safety net: never leave the app hidden behind a stuck splash.
  setTimeout(() => {
    if (win && !win.isDestroyed() && !win.isVisible()) { win.setOpacity(1); win.show(); }
    try { if (splash && !splash.isDestroyed()) splash.destroy(); } catch { /* gone */ }
  }, MAX_SPLASH_MS);
}

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId(APP_ID);
    refreshShortcutIcons();
  }
  setupAutoUpdate();
  // a monitor being unplugged or rescaled can strand the bubble off-screen too
  screen.on('display-metrics-changed', keepBubbleOnScreen);
  screen.on('display-removed', keepBubbleOnScreen);
  initOpenAtLogin();
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
  return folder;
}

function resolveClaude() {
  return CLAUDE_FALLBACKS.find(p => fs.existsSync(p)) || 'claude';
}

function writeParticipants(folder, participants) {
  const p = path.join(folder, 'participants.txt');
  if (participants && participants.trim()) fs.writeFileSync(p, participants.trim(), 'utf8');
}

function readParticipants(folder) {
  const p = path.join(folder, 'participants.txt');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : '';
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

function closeRecFile() {
  if (recFd === null) return;
  try { engine.finishWav(recFd, recBytes); } catch { /* disk gone */ }
  recFd = null;
}

ipcMain.handle('recording-start', async (_e, participants) => {
  closeRecFile();
  recFolder = newMeetingFolder();
  recBytes = 0;
  writeParticipants(recFolder, participants);
  recFd = engine.openWav(path.join(recFolder, 'recording.wav'));
  return recFolder;
});

ipcMain.on('recording-chunk', (_e, arrayBuffer) => {
  const buf = Buffer.from(arrayBuffer);
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
});

ipcMain.handle('recording-finish', async (_e, title, markers) => {
  closeRecFile();
  const folder = recFolder;
  const bytes = recBytes;
  recFolder = null;
  recBytes = 0;
  if (!folder) return null;
  if (title) fs.writeFileSync(path.join(folder, 'title.txt'), title, 'utf8');
  if (markers && markers.length) {
    fs.writeFileSync(path.join(folder, 'markers.txt'), markers.join('\n'), 'utf8');
  }
  return { folder, bytes };
});

// the app is going away mid-recording: close the file properly, keep the audio
app.on('before-quit', () => closeRecFile());

ipcMain.handle('import-audio', async (_e, participants) => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Import voice note',
    properties: ['openFile'],
    filters: [
      { name: 'Audio files', extensions: ['m4a', 'mp3', 'wav', 'ogg', 'opus', 'webm', 'aac', 'flac', 'wma', 'amr', 'mp4'] },
      { name: 'All files', extensions: ['*'] }
    ]
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  const src = res.filePaths[0];
  const folder = newMeetingFolder();
  // A phone voice note is called "recording" or "New Recording 4"; naming the
  // meeting after that tells you nothing, so those fall through to the same
  // auto-titling the recorder uses.
  const title = meaningfulName(path.basename(src, path.extname(src)));
  if (title) fs.writeFileSync(path.join(folder, 'title.txt'), title, 'utf8');
  writeParticipants(folder, participants);
  // The renderer decodes it — Chromium already ships codecs for every format in
  // that filter list, so mp3/m4a/opus/flac all become the same 16 kHz mono WAV
  // the transcriber reads, and Yapper ships no media dependency of its own.
  return { folder, title, src, bytes: fs.statSync(src).size };
});

// A meeting recorded before Yapper wrote WAV directly. The renderer can decode
// it with the same codecs it uses for imports, so those recordings are not
// stranded — they just get converted the first time they are transcribed.
ipcMain.handle('legacy-audio', async (_e, folder) => {
  if (fs.existsSync(path.join(folder, 'recording.wav'))) return null;
  const legacy = fs.readdirSync(folder)
    .find(f => /^recording\.(webm|m4a|mp3|ogg|opus|mp4|aac|flac)$/i.test(f));
  return legacy ? path.join(folder, legacy) : null;
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
  const buf = fs.readFileSync(src);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

// The decoded samples come back through 'recording-chunk', the same path the
// microphone uses, so there is only one piece of code that writes a WAV.
ipcMain.handle('import-open', async (_e, folder) => {
  closeRecFile();
  recFolder = folder;
  recBytes = 0;
  recFd = engine.openWav(path.join(folder, 'recording.wav'));
  return true;
});

ipcMain.handle('import-close', async () => {
  closeRecFile();
  return recBytes;
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
    return 'The transcription engine is not installed. Run setup.ps1 from the app folder.';
  }
  if (/ECONNRESET|ECONNREFUSED|socket hang up|did not start|not running/i.test(m)) {
    return 'The transcriber stopped unexpectedly. Try again.';
  }
  if (/EACCES|EPERM|EBUSY/i.test(m)) return 'That file is in use by something else. Close it and try again.';
  if (/ENOSPC/i.test(m)) return 'The disk is full, so the transcript could not be saved.';
  return m;
}

ipcMain.handle('transcribe', async (_e, folder) => {
  const wav = path.join(folder, 'recording.wav');
  if (!fs.existsSync(wav)) {
    // the renderer converts old recordings before calling this, so reaching
    // here means the conversion did not happen or the folder is genuinely empty
    throw new Error('No recording found in this meeting folder.');
  }
  // a meeting cut short by a crash still has a placeholder header
  if (engine.repairWav(wav)) console.log('[transcribe] repaired an interrupted recording');

  const tier = engine.tierConfig(readSettings().tier || engine.guessTier());
  const send = text => {
    if (win && !win.isDestroyed()) win.webContents.send('transcribe-progress', text);
  };

  let lines;
  try {
    lines = await engine.transcribeFile(wav, {
      model: tier.finalModel,
      language: process.env.YAPPER_LANG || 'auto',
      prompt: transcriptionHint(readParticipants(folder)),
      onProgress: ({ done, total }) => {
        send(`\rTranscribing… ${Math.round(done / total * 100)}%`);
      }
    });
  } catch (err) {
    if (!liveOn) await engine.stop();
    throw new Error(humanTranscribeError(err));
  }
  // Leave the server up while a recording is in progress: the live loop is using
  // it, and it takes its own model back on its next pass.
  if (!liveOn) await engine.stop();

  const transcript = lines.join('\n').trim();
  if (!transcript) throw new Error('The transcript came out empty. Was any audio recorded?');
  fs.writeFileSync(path.join(folder, 'transcript.txt'), transcript, 'utf8');
  releaseAudio(folder);
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
  const transcript = path.join(folder, 'transcript.txt');
  // never on a guess: only when the transcript is really there and has content
  if (!fs.existsSync(transcript) || fs.statSync(transcript).size < 40) return;

  if (keepThisOne) {
    keepThisOne = false;                     // that meeting, and only that one
    broadcast('keep-audio-changed', false);
    console.log('[audio] kept by request for this meeting; back to releasing');
    return;
  }

  for (const f of fs.readdirSync(folder)) {
    if (!/^recording\./i.test(f)) continue;
    const p = path.join(folder, f);
    try {
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
  if (s.keepAudio !== undefined) { delete s.keepAudio; writeSettings(s); }
  return keepThisOne;
});

/** Audio still held by meetings that already have a transcript. */
function heldAudio() {
  if (!fs.existsSync(MEETINGS_DIR)) return { bytes: 0, files: [] };
  const files = [];
  let bytes = 0;
  for (const d of fs.readdirSync(MEETINGS_DIR, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const folder = path.join(MEETINGS_DIR, d.name);
    const transcript = path.join(folder, 'transcript.txt');
    if (!fs.existsSync(transcript) || fs.statSync(transcript).size < 40) continue;
    for (const f of fs.readdirSync(folder)) {
      if (!/^recording\./i.test(f)) continue;
      const p = path.join(folder, f);
      try { bytes += fs.statSync(p).size; files.push(p); } catch { /* gone */ }
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

function buildPrompt(options = {}) {
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
Write meeting notes in English, in markdown, with exactly these sections:

${sections}

Rules, all of which apply regardless of what the section descriptions above say:

1. ${detail}
2. Write in neutral third person. Do not assume who led, organized, or called the meeting. The person who recorded this is just one of the participants and is NOT necessarily the leader, the main speaker, or the owner of the action items — do not center the notes on them or address the reader as "you". Assign ownership and roles only when the transcript itself makes them clear.
3. Do not invent anything that is not in the transcript.
4. Reply only with the markdown notes, no preamble.
5. The transcript is timestamped. Every single "## " heading must end with the timestamp where that topic starts, in square brackets, mm:ss — for example "## Decisions [24:05]". Use the timestamp of the first transcript line belonging to that section, and put nothing else in the brackets. No heading may be written without its timestamp.`;
  if (options.participants && options.participants.trim()) {
    const people = options.participants.trim().replace(/\n/g, ', ');
    prompt += `\n\nThe participants in this meeting are: ${people}.
Attribute discussion points, decisions, and action items to specific people by name when the transcript makes it reasonably clear who said or owns what. The transcript has no speaker labels, so infer from context and do not guess when it is ambiguous. Correct obvious mis-transcriptions of these names.`;
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
function runModel(prompt, transcript, maxTokens) {
  return llm.generate(llmConfig(), { system: prompt, input: transcript, maxTokens });
}

ipcMain.handle('summarize', async (_e, folder, transcript, options) => {
  writeParticipants(folder, options && options.participants);
  const out = await runModel(buildPrompt(options), transcript);
  fs.writeFileSync(path.join(folder, 'notes.md'), out, 'utf8');
  refreshLibrary();               // new notes can carry new action items
  return out;
});

ipcMain.handle('regenerate', async (_e, folder, options) => {
  const transcriptPath = path.join(folder, 'transcript.txt');
  if (!fs.existsSync(transcriptPath)) throw new Error('This meeting has no transcript to regenerate from.');
  writeParticipants(folder, options && options.participants);
  const transcript = fs.readFileSync(transcriptPath, 'utf8');
  const out = await runModel(buildPrompt(options), transcript);
  fs.writeFileSync(path.join(folder, 'notes.md'), out, 'utf8');
  refreshLibrary();               // new notes can carry new action items
  return out;
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
  if (s.tier && s.tierFor === flavour) return s.tier;
  try {
    const res = await engine.calibrate();
    if (!res) return s.tier || engine.guessTier();
    console.log(`[engine] calibrated: ${res.msPerPass} ms per pass -> ${res.tier} tier`);
    s.tier = res.tier;
    s.tierFor = flavour;
    s.tierMs = res.msPerPass;
    writeSettings(s);
    return res.tier;
  } catch (err) {
    console.log('[engine] calibration failed:', err.message);
    return s.tier || engine.guessTier();
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

// ---------- first-run engine download ----------
// A fresh install has the app shell and nothing to transcribe with. The
// renderer notices (check-environment says no whisper) and asks for this; the
// download reports through its own channel and the environment is re-checked —
// which is also what triggers calibration — once the engine lands.

let provisioning = null;

function ensureEngine() {
  if (engine.isInstalled() && engine.hasModel('base') && engine.hasModel('small')) {
    return Promise.resolve(true);
  }
  if (!provisioning) {
    provisioning = provision.run({
      home: engineHome(),
      gpu: engine.hasNvidiaGpu(),
      progress: p => broadcast('engine-setup-progress', p)
    }).then(ok => {
      provisioning = null;
      if (ok) envCache = null;          // the next check measures the machine
      return ok;
    }).catch(err => {
      provisioning = null;
      console.log('[provision] failed:', err.message);
      broadcast('engine-setup-progress', { error: err.message });
      return false;
    });
  }
  return provisioning;
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
// macOS is the exception: Squirrel.Mac refuses to apply an unsigned update, and
// there is no signing certificate yet. So on mac the app only *notices* — it
// reads latest.yml from the same feed, and the pill opens the download page
// instead of promising a restart it cannot deliver.

const RELEASES_LATEST = 'https://github.com/iamchuck504/yapper-releases/releases/latest';
let updater = null;
let macUpdateVersion = '';

function setupAutoUpdate() {
  if (!app.isPackaged) return;
  if (process.platform === 'darwin') {
    checkMacUpdate();
    setInterval(checkMacUpdate, 4 * 60 * 60 * 1000);
    return;
  }
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

async function checkMacUpdate() {
  try {
    const tmp = path.join(app.getPath('temp'), `yapper-feed-${process.pid}.yml`);
    await provision.download(`${RELEASES_LATEST}/download/latest.yml`, tmp);
    const m = fs.readFileSync(tmp, 'utf8').match(/^version:\s*(\S+)/m);
    try { fs.unlinkSync(tmp); } catch { /* temp */ }
    if (m && provision.newerVersion(m[1], app.getVersion())) {
      macUpdateVersion = m[1];
      broadcast('update-ready', { version: m[1], manual: true });
    }
  } catch (err) {
    console.log('[update] mac check failed:', String(err.message).slice(0, 120));
  }
}

ipcMain.handle('update-restart', async () => {
  if (updater) { updater.quitAndInstall(); return 'installing'; }
  if (macUpdateVersion) { shell.openExternal(RELEASES_LATEST); return 'browser'; }
  return 'none';
});

ipcMain.handle('save-notes', async (_e, folder, md) => {
  fs.writeFileSync(path.join(folder, 'notes.md'), md, 'utf8');
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
  const p = path.join(folder, 'transcript.txt');
  if (!fs.existsSync(p)) return '';
  const transcript = fs.readFileSync(p, 'utf8');
  if (transcript.trim().length < 120) return '';        // too little was said
  // the opening minutes usually frame the meeting; keep the prompt cheap
  const excerpt = transcript.slice(0, 6000);
  let title = '';
  try {
    title = cleanTitle(await runModel(TITLE_PROMPT, excerpt, 64));
  } catch {
    return '';                                          // titling is best-effort
  }
  if (title) fs.writeFileSync(path.join(folder, 'title.txt'), title, 'utf8');
  return title;
});

// ---------- exports ----------

ipcMain.handle('save-text-file', async (_e, { defaultName, content, extension, description }) => {
  const safe = String(defaultName || 'yapper-export').replace(/[\\/:*?"<>|]/g, '_');
  const res = await dialog.showSaveDialog(win, {
    title: 'Export',
    defaultPath: `${safe}.${extension}`,
    filters: [{ name: description || extension.toUpperCase(), extensions: [extension] }]
  });
  if (res.canceled || !res.filePath) return null;
  fs.writeFileSync(res.filePath, content, 'utf8');
  return res.filePath;
});

ipcMain.handle('list-meetings', async () => {
  if (!fs.existsSync(MEETINGS_DIR)) return [];
  return fs.readdirSync(MEETINGS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => {
      const folder = path.join(MEETINGS_DIR, d.name);
      const titlePath = path.join(folder, 'title.txt');
      return {
        name: d.name,
        title: fs.existsSync(titlePath) ? fs.readFileSync(titlePath, 'utf8').trim() : '',
        folder,
        hasSummary: fs.existsSync(path.join(folder, 'notes.md')),
        hasTranscript: fs.existsSync(path.join(folder, 'transcript.txt')),
        audioSec: Math.round(audioSeconds(folder))
      };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
});

/** How much audio a meeting holds, so the UI can tell a false start apart. */
function audioSeconds(folder) {
  try {
    const wav = path.join(folder, 'recording.wav');
    if (fs.existsSync(wav)) {
      return Math.max(0, fs.statSync(wav).size - engine.WAV_HEADER) / engine.BYTES_PER_SEC;
    }
    // a legacy compressed recording: size is all we have, so only say "not empty"
    const legacy = fs.readdirSync(folder).find(f => /^recording\./i.test(f));
    return legacy && fs.statSync(path.join(folder, legacy)).size > 4096 ? -1 : 0;
  } catch {
    return 0;
  }
}

// ---------- deleting a meeting ----------
// A false start leaves a folder with a few seconds of silence in it, and there
// was no way to get rid of one. Deletion goes to the recycle bin rather than
// straight out, because the one thing this app must never do is lose audio.

function insideMeetings(folder) {
  const root = path.resolve(MEETINGS_DIR) + path.sep;
  const target = path.resolve(folder);
  return target.startsWith(root) && target !== path.resolve(MEETINGS_DIR);
}

function describeMeeting(folder) {
  const secs = audioSeconds(folder);
  const bits = [];
  if (secs > 0) {
    const mins = Math.floor(secs / 60);
    bits.push(mins >= 1 ? `${mins} min of audio` : `${Math.round(secs)} s of audio`);
  } else if (secs < 0) {
    bits.push('a recording');
  }
  if (fs.existsSync(path.join(folder, 'transcript.txt'))) bits.push('a transcript');
  if (fs.existsSync(path.join(folder, 'notes.md'))) bits.push('notes');
  return bits;
}

ipcMain.handle('delete-meeting', async (_e, folder) => {
  if (!folder || !insideMeetings(folder) || !fs.existsSync(folder)) {
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
  const read = f => {
    const p = path.join(folder, f);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  };
  return {
    transcript: read('transcript.txt'),
    summary: read('notes.md'),
    title: read('title.txt').trim(),
    participants: read('participants.txt').trim(),
    hasRecording: fs.readdirSync(folder).some(f => f.startsWith('recording.'))
  };
});

ipcMain.handle('open-folder', async (_e, folder) => shell.openPath(folder));

// Only the sign-up pages the app itself offers: the renderer does not get to
// name arbitrary URLs for the OS to open.
const ALLOWED_LINKS = new Set(llm.providerList().map(p => p.keyUrl).filter(Boolean));

ipcMain.handle('open-external', async (_e, url) => {
  if (!ALLOWED_LINKS.has(url)) return false;
  await shell.openExternal(url);
  return true;
});

// ---------- reminders / action items ----------

function remindersFile() {
  return path.join(app.getPath('userData'), 'reminders.json');
}
function readReminders() {
  try { return JSON.parse(fs.readFileSync(remindersFile(), 'utf8')); } catch { return []; }
}
function writeReminders(list) {
  fs.writeFileSync(remindersFile(), JSON.stringify(list, null, 2), 'utf8');
}

ipcMain.handle('list-reminders', async () => readReminders());

ipcMain.handle('add-reminder', async (_e, text, source) => {
  const t = String(text || '').trim();
  if (!t) return null;
  const list = readReminders();
  const now = Date.now();
  const r = {
    id: crypto.randomUUID(), text: t, done: false, source: source || '',
    owner: '', due: '', priority: 'normal', folder: '', meeting: source || '',
    sources: [], createdAt: now, updatedAt: now
  };
  list.unshift(r);
  writeReminders(list);
  return r;
});

ipcMain.handle('update-reminder', async (_e, id, fields) => {
  const list = readReminders();
  const r = list.find(x => x.id === id);
  if (r) { Object.assign(r, fields); writeReminders(list); }
  return r || null;
});

ipcMain.handle('delete-reminder', async (_e, id) => {
  writeReminders(readReminders().filter(x => x.id !== id));
  return true;
});

// ---------- the library: one index over every meeting ----------
// The weekly summary, the daily digest, the action items and the search all ask
// questions about every meeting at once. This keeps a derived index so they do
// not each re-read twenty-eight folders, and folds the action items written in
// the notes into the one list the user already has.

function libraryFile() {
  return path.join(app.getPath('userData'), 'index.json');
}

let libraryCache = null;

/**
 * Bring the index up to date and pull in any action items from notes that have
 * changed. Returns the meetings, newest first.
 */
function refreshLibrary() {
  const { meetings, changed } = library.refresh({
    meetingsDir: MEETINGS_DIR,
    indexFile: libraryFile()
  });
  libraryCache = meetings;

  // Only meetings whose files actually changed can have new tasks in them, so
  // an unchanged library costs nothing.
  const incoming = changed.flatMap(m => m.items);
  if (incoming.length) {
    const now = Date.now();
    const { list, added, merged } = actions.mergeActionItems(readReminders(), incoming, now);
    for (const item of list) if (!item.id) item.id = crypto.randomUUID();
    if (added || merged) {
      writeReminders(list);
      console.log(`[library] action items: ${added} new, ${merged} folded into existing`);
    }
  }
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
    try { return fs.readFileSync(path.join(m.folder, 'transcript.txt'), 'utf8'); } catch { return ''; }
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
  const byFolder = new Map(meetings().map(m => [m.folder, m]));
  return readReminders().map(r => {
    const m = byFolder.get(r.folder);
    return {
      ...r,
      meeting: r.meeting || (m ? (m.title || m.name) : ''),
      meetingDate: r.meetingDate || (m ? m.date : ''),
      // a task mentioned in several meetings shows all of them
      mentions: (r.sources || []).filter(f => byFolder.has(f)).map(f => ({
        folder: f,
        title: byFolder.get(f).title || byFolder.get(f).name,
        date: byFolder.get(f).date
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

function readDigest(name, key) {
  try {
    const saved = JSON.parse(fs.readFileSync(digestFile(name), 'utf8'));
    return saved.key === key ? saved : null;
  } catch { return null; }
}

function writeDigest(name, data) {
  try {
    fs.mkdirSync(path.dirname(digestFile(name)), { recursive: true });
    fs.writeFileSync(digestFile(name), JSON.stringify(data), 'utf8');
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
 * The week: the facts first, then the written part. They are returned together
 * and the facts never depend on the model, so a failed call still leaves the
 * view with something true on screen.
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
  const cached = opts.refresh ? null : readDigest(`weekly-${week.label}`, key);
  if (cached) return { ...base, ...cached.summary, cached: true };

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
    return { ...base, ...summary };
  } catch (err) {
    return { ...base, error: err.message };
  }
});

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

const MEETING_APPS = {
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

const MIC_CONSENT_KEY =
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone';

function micUsersWindows() {
  return new Promise(resolve => {
    let out = '';
    let p;
    try {
      p = spawn('reg', ['query', MIC_CONSENT_KEY, '/s']);
    } catch {
      return resolve([]);
    }
    p.stdout.on('data', d => { out += d.toString('utf8'); });
    p.on('error', () => resolve([]));
    p.on('close', () => {
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
      resolve([...new Set(users)]);
    });
  });
}

let meetingTimer = null;
let meetingCurrent = null;
let autoDetectOn = false;
let rendererRecording = false;

let meetingGoneStreak = 0;

async function pollMeetings() {
  if (process.platform !== 'win32') return;
  const users = await micUsersWindows();
  const hit = users.find(exe => MEETING_APPS[exe]);

  // While recording, watch for the opposite signal: the meeting app letting go
  // of the microphone. Two clear polls (~10 s) avoids reacting to a blip.
  if (rendererRecording) {
    meetingGoneStreak = hit ? 0 : meetingGoneStreak + 1;
    if (meetingGoneStreak === 2 && win && !win.isDestroyed()) {
      win.webContents.send('meeting-ended');
    }
    return;
  }
  meetingGoneStreak = 0;

  if (!hit) { meetingCurrent = null; return; }
  if (meetingCurrent === hit) return;

  meetingCurrent = hit;
  const label = MEETING_APPS[hit];
  if (win && !win.isDestroyed()) win.webContents.send('meeting-detected', { app: label });
  notifyMeeting(label);
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
  n.show();
  return n;      // returned so a probe can watch whether the OS actually shows it
}

// Only for probes and tests: the app itself never calls this from outside.
module.exports = { notifyMeeting };

function startMeetingWatch() {
  if (meetingTimer || process.platform !== 'win32') return;
  meetingCurrent = null;
  meetingTimer = setInterval(pollMeetings, 5000);
}

function stopMeetingWatch() {
  if (meetingTimer) clearInterval(meetingTimer);
  meetingTimer = null;
  meetingCurrent = null;
}

ipcMain.on('autodetect-set', (_e, enabled) => {
  autoDetectOn = !!enabled;
  if (autoDetectOn) startMeetingWatch(); else stopMeetingWatch();
});

ipcMain.on('recording-state', (_e, recording) => {
  rendererRecording = !!recording;
  meetingGoneStreak = 0;
  // once a recording ends, allow the same app to trigger a fresh prompt later
  if (!rendererRecording) meetingCurrent = null;
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
  try {
    const ok = await live.start({
      model: tier.liveModel,
      cadenceMs: tier.cadenceMs,
      windowSec: tier.windowSec,
      maxHoldSec: tier.maxHoldSec,
      language: process.env.YAPPER_LANG || 'auto',
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
  const tmpHtml = path.join(app.getPath('temp'), `yapper-pdf-${process.pid}.html`);
  const baseTag = `<base href="${pathToFileURL(path.join(__dirname, 'renderer') + path.sep).href}">`;
  const doc = /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, m => m + baseTag)
    : baseTag + html;
  const pdfWin = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  try {
    fs.writeFileSync(tmpHtml, doc, 'utf8');
    await pdfWin.loadFile(tmpHtml);
    await new Promise(r => setTimeout(r, 250));   // let the webfont settle
    const data = await pdfWin.webContents.printToPDF({
      printBackground: true,
      margins: { marginType: 'custom', top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },
      pageSize: 'Letter'
    });
    fs.writeFileSync(res.filePath, data);
    return res.filePath;
  } finally {
    pdfWin.destroy();
    try { fs.unlinkSync(tmpHtml); } catch { /* already gone */ }
  }
});
