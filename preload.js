const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('actas', {
  saveRecording: (buf, title, participants) => ipcRenderer.invoke('save-recording', buf, title, participants),
  importAudio: participants => ipcRenderer.invoke('import-audio', participants),
  transcribe: folder => ipcRenderer.invoke('transcribe', folder),
  summarize: (folder, transcript, options) => ipcRenderer.invoke('summarize', folder, transcript, options),
  regenerate: (folder, options) => ipcRenderer.invoke('regenerate', folder, options),
  saveNotes: (folder, md) => ipcRenderer.invoke('save-notes', folder, md),
  generateTitle: folder => ipcRenderer.invoke('generate-title', folder),
  saveTextFile: opts => ipcRenderer.invoke('save-text-file', opts),
  setTheme: theme => ipcRenderer.send('set-theme', theme),
  getOpenAtLogin: () => ipcRenderer.invoke('get-open-at-login'),
  setOpenAtLogin: enabled => ipcRenderer.invoke('set-open-at-login', enabled),
  listMeetings: () => ipcRenderer.invoke('list-meetings'),
  loadMeeting: folder => ipcRenderer.invoke('load-meeting', folder),
  openFolder: folder => ipcRenderer.invoke('open-folder', folder),
  checkEnvironment: () => ipcRenderer.invoke('check-environment'),
  listReminders: () => ipcRenderer.invoke('list-reminders'),
  addReminder: (text, source) => ipcRenderer.invoke('add-reminder', text, source),
  updateReminder: (id, fields) => ipcRenderer.invoke('update-reminder', id, fields),
  deleteReminder: id => ipcRenderer.invoke('delete-reminder', id),
  exportPdf: (html, suggestedName) => ipcRenderer.invoke('export-pdf', html, suggestedName),
  onTranscribeProgress: cb => ipcRenderer.on('transcribe-progress', (_e, text) => cb(text)),
  liveStart: participants => ipcRenderer.invoke('live-start', participants),
  livePcm: buf => ipcRenderer.send('live-pcm', buf),
  liveStop: () => ipcRenderer.invoke('live-stop'),
  onLiveTranscript: cb => ipcRenderer.on('live-transcript', (_e, line) => cb(line)),

  // floating bubble
  bubbleShow: () => ipcRenderer.invoke('bubble-show'),
  bubbleHide: () => ipcRenderer.invoke('bubble-hide'),
  bubbleState: state => ipcRenderer.send('bubble-state', state),
  bubbleResize: size => ipcRenderer.send('bubble-resize', size),
  onBubbleState: cb => ipcRenderer.on('bubble-state', (_e, state) => cb(state)),
  bubbleStop: () => ipcRenderer.send('bubble-stop'),
  bubbleFocusMain: () => ipcRenderer.send('bubble-focus-main'),
  onRemoteStop: cb => ipcRenderer.on('remote-stop', () => cb()),

  // meeting auto-detection
  setAutoDetect: enabled => ipcRenderer.send('autodetect-set', enabled),
  setRecordingState: recording => ipcRenderer.send('recording-state', recording),
  onMeetingDetected: cb => ipcRenderer.on('meeting-detected', (_e, info) => cb(info))
});
