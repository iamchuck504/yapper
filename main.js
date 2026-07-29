const { app, BrowserWindow, ipcMain, session, desktopCapturer, shell, dialog, screen, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

const MEETINGS_DIR = path.join(app.getPath('documents'), 'Meetings');

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
const WHISPER_MODEL = process.env.YAPPER_MODEL || 'small';
const CLAUDE_FALLBACK = path.join(app.getPath('home'), '.local', 'bin', 'claude.exe');

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
  const w = 420, h = 280;   // matches EXPANDED in bubble.js; it resizes itself if collapsed
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
  bubble.once('ready-to-show', () => bubble.showInactive());
  bubble.on('closed', () => { bubble = null; });
}

function destroyBubble() {
  if (bubble && !bubble.isDestroyed()) bubble.close();
  bubble = null;
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
});
// Bubble -> main window controls
ipcMain.on('bubble-stop', () => {
  if (win && !win.isDestroyed()) win.webContents.send('remote-stop');
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
    backgroundColor: dark ? '#1E1F16' : '#E9E7D8',
    show: false,              // revealed by the splash hand-off
    autoHideMenuBar: true,
    title: 'Yapper',
    icon: path.join(__dirname, 'build', 'yapper-icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

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
      icon: path.join(__dirname, 'build', 'yapper-icon.ico'),
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
  setStatus('Checking transcription engine');
  const envPromise = checkEnvironment().then(env => {
    setStatus(env.claude ? 'Loading' : 'Claude Code not found');
    return env;
  }).catch(() => ({ whisper: false, claude: false }));

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
  if (process.platform === 'win32') app.setAppUserModelId('com.yapper.meetingnotes');
  initOpenAtLogin();
  bootWithSplash();
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { liveStopInternal(); stopMeetingWatch(); });

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
  return fs.existsSync(CLAUDE_FALLBACK) ? CLAUDE_FALLBACK : 'claude';
}

function writeParticipants(folder, participants) {
  const p = path.join(folder, 'participants.txt');
  if (participants && participants.trim()) fs.writeFileSync(p, participants.trim(), 'utf8');
}

function readParticipants(folder) {
  const p = path.join(folder, 'participants.txt');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : '';
}

ipcMain.handle('save-recording', async (_e, arrayBuffer, title, participants) => {
  const folder = newMeetingFolder();
  fs.writeFileSync(path.join(folder, 'recording.webm'), Buffer.from(arrayBuffer));
  if (title) fs.writeFileSync(path.join(folder, 'title.txt'), title, 'utf8');
  writeParticipants(folder, participants);
  return folder;
});

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
  const ext = path.extname(src).toLowerCase() || '.audio';
  const folder = newMeetingFolder();
  fs.copyFileSync(src, path.join(folder, 'recording' + ext));
  const title = path.basename(src, path.extname(src));
  fs.writeFileSync(path.join(folder, 'title.txt'), title, 'utf8');
  writeParticipants(folder, participants);
  return { folder, title };
});

// Whisper initial_prompt biasing: nudges the model toward spelling these names/terms correctly
function transcriptionHint(participants) {
  if (!participants || !participants.trim()) return '';
  return `The people in this conversation are: ${participants.trim().replace(/\n/g, ', ')}.`;
}

ipcMain.handle('transcribe', async (_e, folder) => {
  const audioFile = fs.readdirSync(folder).find(f => f.startsWith('recording.'));
  if (!audioFile) throw new Error('No recording found in this meeting folder.');
  const audio = path.join(folder, audioFile);
  const hint = transcriptionHint(readParticipants(folder));
  return new Promise((resolve, reject) => {
    const py = spawn('python', [path.join(__dirname, 'transcribe.py'), audio, WHISPER_MODEL, process.env.YAPPER_LANG || 'auto', hint], {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
    });
    let transcript = '';
    let errOut = '';
    py.stdout.on('data', d => {
      const text = d.toString('utf8');
      transcript += text;
      if (win && !win.isDestroyed()) win.webContents.send('transcribe-progress', text);
    });
    py.stderr.on('data', d => { errOut += d.toString('utf8'); });
    py.on('error', reject);
    py.on('close', code => {
      if (code !== 0) return reject(new Error(`Whisper failed (code ${code}): ${errOut.slice(-800)}`));
      transcript = transcript.trim();
      if (!transcript) return reject(new Error('The transcript came out empty. Was any audio recorded?'));
      fs.writeFileSync(path.join(folder, 'transcript.txt'), transcript, 'utf8');
      resolve(transcript);
    });
  });
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
  let prompt = `What you receive is a meeting transcript (it may mix English and Spanish and contain transcription errors).
Write meeting notes in English, in markdown, with exactly these sections:

${sections}

${detail}
Write in neutral third person. Do not assume who led, organized, or called the meeting. The person who recorded this is just one of the participants and is NOT necessarily the leader, the main speaker, or the owner of the action items — do not center the notes on them or address the reader as "you". Assign ownership and roles only when the transcript itself makes them clear.
Do not invent anything that is not in the transcript. Reply only with the markdown notes, no preamble.`;
  if (options.participants && options.participants.trim()) {
    const people = options.participants.trim().replace(/\n/g, ', ');
    prompt += `\n\nThe participants in this meeting are: ${people}.
Attribute discussion points, decisions, and action items to specific people by name when the transcript makes it reasonably clear who said or owns what. The transcript has no speaker labels, so infer from context and do not guess when it is ambiguous. Correct obvious mis-transcriptions of these names.`;
  }
  if (options.custom && options.custom.trim()) {
    prompt += `\n\nAdditional instructions from the user:\n${options.custom.trim()}`;
  }
  return prompt;
}

function runClaude(prompt, transcript) {
  return new Promise((resolve, reject) => {
    const proc = spawn(resolveClaude(), ['-p', prompt, '--output-format', 'text'], {
      env: { ...process.env }
    });
    let out = '';
    let errOut = '';
    proc.stdout.on('data', d => { out += d.toString('utf8'); });
    proc.stderr.on('data', d => { errOut += d.toString('utf8'); });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`Claude failed (code ${code}): ${errOut.slice(-800)}`));
      resolve(out.trim());
    });
    proc.stdin.write(transcript, 'utf8');
    proc.stdin.end();
  });
}

ipcMain.handle('summarize', async (_e, folder, transcript, options) => {
  writeParticipants(folder, options && options.participants);
  const out = await runClaude(buildPrompt(options), transcript);
  fs.writeFileSync(path.join(folder, 'notes.md'), out, 'utf8');
  return out;
});

ipcMain.handle('regenerate', async (_e, folder, options) => {
  const transcriptPath = path.join(folder, 'transcript.txt');
  if (!fs.existsSync(transcriptPath)) throw new Error('This meeting has no transcript to regenerate from.');
  writeParticipants(folder, options && options.participants);
  const transcript = fs.readFileSync(transcriptPath, 'utf8');
  const out = await runClaude(buildPrompt(options), transcript);
  fs.writeFileSync(path.join(folder, 'notes.md'), out, 'utf8');
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

// Importing faster_whisper takes a second or two, so the result is cached:
// the splash pays for it once and the renderer reuses it.
let envCache = null;

async function checkEnvironment() {
  if (envCache) return envCache;
  const [whisper, claude] = await Promise.all([
    runOk('python', ['-c', 'import faster_whisper']),
    runOk(resolveClaude(), ['--version'])
  ]);
  envCache = { whisper, claude };
  return envCache;
}

ipcMain.handle('check-environment', async () => checkEnvironment());

ipcMain.handle('save-notes', async (_e, folder, md) => {
  fs.writeFileSync(path.join(folder, 'notes.md'), md, 'utf8');
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
    title = cleanTitle(await runClaude(TITLE_PROMPT, excerpt));
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
        hasTranscript: fs.existsSync(path.join(folder, 'transcript.txt'))
      };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
});

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
  const r = { id: crypto.randomUUID(), text: t, done: false, source: source || '', createdAt: Date.now() };
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

async function pollMeetings() {
  if (process.platform !== 'win32') return;
  const users = await micUsersWindows();
  const hit = users.find(exe => MEETING_APPS[exe]);
  if (!hit) { meetingCurrent = null; return; }
  if (meetingCurrent === hit || rendererRecording) return;

  meetingCurrent = hit;
  const label = MEETING_APPS[hit];
  if (win && !win.isDestroyed()) win.webContents.send('meeting-detected', { app: label });
  if (Notification.isSupported() && (!win || !win.isFocused())) {
    const n = new Notification({
      title: 'Meeting detected',
      body: `Yapper noticed ${label} using your microphone. Open Yapper to take notes.`,
      silent: true
    });
    n.on('click', () => { if (win && !win.isDestroyed()) { win.show(); win.focus(); } });
    n.show();
  }
}

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
  // once a recording ends, allow the same app to trigger a fresh prompt later
  if (!rendererRecording) meetingCurrent = null;
});

// ---------- live streaming transcription ----------
// The renderer feeds raw 16 kHz mono PCM; the worker keeps a rolling buffer and
// emits confirmed/tentative text every ~0.7 s (see transcribe_stream.py).

let liveWorker = null;

function liveStopInternal() {
  if (liveWorker) {
    try { liveWorker.stdin.end(); } catch { /* closed */ }
    try { liveWorker.kill(); } catch { /* gone */ }
    liveWorker = null;
  }
}

ipcMain.handle('live-start', async (_e, participants) => {
  liveStopInternal();
  // the live pass gets a larger model than the final one: on GPU it is still
  // ~0.3 s per pass and noticeably more accurate (the worker drops to `small`
  // by itself if it has to fall back to CPU)
  const liveModel = process.env.YAPPER_LIVE_MODEL || 'medium';
  liveWorker = spawn('python',
    [path.join(__dirname, 'transcribe_stream.py'), liveModel, process.env.YAPPER_LANG || 'auto', transcriptionHint(participants)],
    { env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });

  let buf = '';
  liveWorker.stdout.on('data', d => {
    buf += d.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) broadcast('live-transcript', line);
    }
  });
  liveWorker.stderr.on('data', d => console.log('[stream]', d.toString('utf8').trim()));
  liveWorker.on('error', () => {
    broadcast('live-transcript', JSON.stringify({ error: 'streaming worker failed to start' }));
  });
  return true;
});

ipcMain.on('live-pcm', (_e, arrayBuffer) => {
  if (!liveWorker || !liveWorker.stdin.writable) return;
  try { liveWorker.stdin.write(Buffer.from(arrayBuffer)); } catch { /* worker gone */ }
});

ipcMain.handle('live-stop', async () => liveStopInternal());

ipcMain.handle('export-pdf', async (_e, html, suggestedName) => {
  const res = await dialog.showSaveDialog(win, {
    title: 'Export notes to PDF',
    defaultPath: `${(suggestedName || 'meeting-notes').replace(/[\\/:*?"<>|]/g, '_')}.pdf`,
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (res.canceled || !res.filePath) return null;

  // Render from a real file inside renderer/ so relative font URLs resolve
  // (a data: URL is an opaque origin and cannot load the bundled woff2).
  const tmpHtml = path.join(__dirname, 'renderer', '.pdf-export.html');
  const pdfWin = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  try {
    fs.writeFileSync(tmpHtml, html, 'utf8');
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
