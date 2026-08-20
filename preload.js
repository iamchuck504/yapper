const { contextBridge, ipcRenderer } = require('electron');

// When a handler in the main process rejects, Electron wraps the reason:
//   "Error invoking remote method 'transcribe': Error: <the actual message>"
// The UI shows that message to the user, so the wrapper has to come off — once,
// here, rather than at each of the places that display an error.
function invoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args).catch(err => {
    const message = String((err && err.message) || err)
      .replace(/^Error invoking remote method '[^']*':\s*/, '')
      .replace(/^(?:Error:\s*)+/, '')
      .trim();
    throw new Error(message || 'Something went wrong.');
  });
}

contextBridge.exposeInMainWorld('yapper', {
  // What the renderer is allowed to ask the machine for differs by platform:
  // system audio exists on Windows and nowhere else, and asking for it anyway
  // costs a Screen Recording permission on macOS in exchange for nothing.
  platform: process.platform,

  recordingStart: participants => invoke('recording-start', participants),
  recordingChunk: buf => ipcRenderer.send('recording-chunk', buf),
  recordingFinish: (title, markers) => invoke('recording-finish', title, markers),
  markShortcut: on => ipcRenderer.send('mark-shortcut', on),
  onMarkMoment: cb => ipcRenderer.on('mark-moment', () => cb()),
  onMeetingEnded: cb => ipcRenderer.on('meeting-ended', () => cb()),
  onStartRecording: cb => ipcRenderer.on('start-recording', () => cb()),
  bubblePause: () => ipcRenderer.send('bubble-pause'),
  onRemotePause: cb => ipcRenderer.on('remote-pause', () => cb()),
  importAudio: participants => invoke('import-audio', participants),
  importRead: src => invoke('import-read', src),
  legacyAudio: folder => invoke('legacy-audio', folder),
  importOpen: folder => invoke('import-open', folder),
  importClose: () => invoke('import-close'),
  transcribe: folder => invoke('transcribe', folder),
  summarize: (folder, transcript, options) => invoke('summarize', folder, transcript, options),
  regenerate: (folder, options) => invoke('regenerate', folder, options),
  saveNotes: (folder, md) => invoke('save-notes', folder, md),
  generateTitle: folder => invoke('generate-title', folder),
  saveTextFile: opts => invoke('save-text-file', opts),
  setTheme: theme => ipcRenderer.send('set-theme', theme),
  // Read here, synchronously, and only here: the theme has to be right on the
  // first frame, so there is no round trip to wait for — and it kept it from
  // living in localStorage as well, where the renderer's copy and the one main
  // paints the window from could disagree. They did.
  theme: ipcRenderer.sendSync('get-theme'),
  getOpenAtLogin: () => invoke('get-open-at-login'),
  getKeepAudio: () => invoke('get-keep-audio'),
  setKeepAudio: keep => invoke('set-keep-audio', keep),
  onKeepAudioChanged: cb => ipcRenderer.on('keep-audio-changed', (_e, keep) => cb(keep)),
  heldAudio: () => invoke('held-audio'),
  releaseHeldAudio: () => invoke('release-held-audio'),
  setOpenAtLogin: enabled => invoke('set-open-at-login', enabled),
  getBubbleCorner: () => invoke('get-bubble-corner'),
  setBubbleCorner: corner => invoke('set-bubble-corner', corner),
  listMeetings: () => invoke('list-meetings'),
  loadMeeting: folder => invoke('load-meeting', folder),
  deleteMeeting: folder => invoke('delete-meeting', folder),
  openFolder: folder => invoke('open-folder', folder),
  openExternal: url => invoke('open-external', url),
  checkEnvironment: () => invoke('check-environment'),
  engineSetup: () => invoke('engine-setup'),
  onEngineSetup: cb => ipcRenderer.on('engine-setup-progress', (_e, p) => cb(p)),
  updateRestart: () => invoke('update-restart'),
  openReleasesPage: () => invoke('open-releases-page'),
  onUpdateReady: cb => ipcRenderer.on('update-ready', (_e, info) => cb(info)),
  styleSections: () => invoke('style-sections'),
  getLlmSettings: () => invoke('get-llm-settings'),
  setLlmSettings: next => invoke('set-llm-settings', next),
  testLlm: override => invoke('test-llm', override),
  listReminders: () => invoke('list-reminders'),
  listActions: () => invoke('list-actions'),
  refreshLibrary: () => invoke('refresh-library'),
  search: (query, opts) => invoke('search', query, opts),
  ask: question => invoke('ask', question),
  dailyDigest: day => invoke('daily-digest', day),
  weeklySummary: opts => invoke('weekly-summary', opts),
  onWeeklyWritten: cb => ipcRenderer.on('weekly-written', (_e, info) => cb(info)),
  addReminder: (text, source) => invoke('add-reminder', text, source),
  updateReminder: (id, fields) => invoke('update-reminder', id, fields),
  deleteReminder: id => invoke('delete-reminder', id),
  exportPdf: (html, suggestedName) => invoke('export-pdf', html, suggestedName),
  onTranscribeProgress: cb => ipcRenderer.on('transcribe-progress', (_e, text) => cb(text)),
  liveStart: participants => invoke('live-start', participants),
  liveStop: () => invoke('live-stop'),
  onLiveTranscript: cb => ipcRenderer.on('live-transcript', (_e, line) => cb(line)),

  // floating bubble
  bubbleShow: () => invoke('bubble-show'),
  bubbleHide: () => invoke('bubble-hide'),
  bubbleState: state => ipcRenderer.send('bubble-state', state),
  bubbleResize: size => ipcRenderer.send('bubble-resize', size),
  onBubbleState: cb => ipcRenderer.on('bubble-state', (_e, state) => cb(state)),
  bubbleStop: () => ipcRenderer.send('bubble-stop'),
  bubbleFocusMain: () => ipcRenderer.send('bubble-focus-main'),
  onRemoteStop: cb => ipcRenderer.on('remote-stop', () => cb()),

  // meeting auto-detection
  setAutoDetect: enabled => ipcRenderer.send('autodetect-set', enabled),
  setRecordingState: recording => ipcRenderer.send('recording-state', recording),
  onMeetingDetected: cb => ipcRenderer.on('meeting-detected', (_e, info) => cb(info)),

  // macOS only: system audio is captured natively, so whether it worked is
  // something only the main process knows.
  onSystemAudioStatus: cb => ipcRenderer.on('system-audio-status', (_e, info) => cb(info)),

  // macOS only: the two halves of granting Screen Recording that the user
  // cannot reach from inside the app.
  // macOS only: the system meter is drawn from what the main process mixed,
  // because these samples never pass through this side.
  onSystemWave: cb => ipcRenderer.on('system-wave', (_e, bytes) => cb(bytes)),
  setSysGain: g => ipcRenderer.send('sys-gain', g),

  openScreenSettings: which => invoke('open-screen-settings', which),
  relaunchApp: () => invoke('relaunch-app')
});
