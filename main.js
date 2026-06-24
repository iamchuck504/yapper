const { app, BrowserWindow, ipcMain, session, desktopCapturer, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
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
const WHISPER_MODEL = process.env.ACTAS_MODEL || 'small';
const CLAUDE_FALLBACK = path.join(app.getPath('home'), '.local', 'bin', 'claude.exe');

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: '#12141c',
    autoHideMenuBar: true,
    title: 'Actas',
    icon: path.join(__dirname, 'build', 'app.ico'),
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

app.whenReady().then(() => {
  migrateOldData();
  createWindow();
});
app.on('window-all-closed', () => app.quit());

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

ipcMain.handle('save-recording', async (_e, arrayBuffer, title) => {
  const folder = newMeetingFolder();
  fs.writeFileSync(path.join(folder, 'recording.webm'), Buffer.from(arrayBuffer));
  if (title) fs.writeFileSync(path.join(folder, 'title.txt'), title, 'utf8');
  return folder;
});

ipcMain.handle('import-audio', async () => {
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
  return { folder, title };
});

ipcMain.handle('transcribe', async (_e, folder) => {
  const audioFile = fs.readdirSync(folder).find(f => f.startsWith('recording.'));
  if (!audioFile) throw new Error('No recording found in this meeting folder.');
  const audio = path.join(folder, audioFile);
  return new Promise((resolve, reject) => {
    const py = spawn('python', [path.join(__dirname, 'transcribe.py'), audio, WHISPER_MODEL, process.env.ACTAS_LANG || 'auto'], {
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
Do not invent anything that is not in the transcript. Reply only with the markdown notes, no preamble.`;
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
  const out = await runClaude(buildPrompt(options), transcript);
  fs.writeFileSync(path.join(folder, 'notes.md'), out, 'utf8');
  return out;
});

ipcMain.handle('regenerate', async (_e, folder, options) => {
  const transcriptPath = path.join(folder, 'transcript.txt');
  if (!fs.existsSync(transcriptPath)) throw new Error('This meeting has no transcript to regenerate from.');
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

ipcMain.handle('check-environment', async () => {
  const [whisper, claude] = await Promise.all([
    runOk('python', ['-c', 'import faster_whisper']),
    runOk(resolveClaude(), ['--version'])
  ]);
  return { whisper, claude };
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
    hasRecording: fs.readdirSync(folder).some(f => f.startsWith('recording.'))
  };
});

ipcMain.handle('open-folder', async (_e, folder) => shell.openPath(folder));

ipcMain.handle('export-pdf', async (_e, html, suggestedName) => {
  const res = await dialog.showSaveDialog(win, {
    title: 'Export notes to PDF',
    defaultPath: `${(suggestedName || 'meeting-notes').replace(/[\\/:*?"<>|]/g, '_')}.pdf`,
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (res.canceled || !res.filePath) return null;

  const pdfWin = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  try {
    await pdfWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const data = await pdfWin.webContents.printToPDF({
      printBackground: true,
      margins: { marginType: 'custom', top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },
      pageSize: 'Letter'
    });
    fs.writeFileSync(res.filePath, data);
    return res.filePath;
  } finally {
    pdfWin.destroy();
  }
});
