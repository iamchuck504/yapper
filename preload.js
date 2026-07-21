const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('actas', {
  saveRecording: (buf, title, participants) => ipcRenderer.invoke('save-recording', buf, title, participants),
  importAudio: participants => ipcRenderer.invoke('import-audio', participants),
  transcribe: folder => ipcRenderer.invoke('transcribe', folder),
  summarize: (folder, transcript, options) => ipcRenderer.invoke('summarize', folder, transcript, options),
  regenerate: (folder, options) => ipcRenderer.invoke('regenerate', folder, options),
  saveNotes: (folder, md) => ipcRenderer.invoke('save-notes', folder, md),
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
  liveChunk: buf => ipcRenderer.invoke('live-chunk', buf),
  liveStop: () => ipcRenderer.invoke('live-stop'),
  onLiveTranscript: cb => ipcRenderer.on('live-transcript', (_e, line) => cb(line))
});
