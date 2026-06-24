const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('actas', {
  saveRecording: (buf, title) => ipcRenderer.invoke('save-recording', buf, title),
  importAudio: () => ipcRenderer.invoke('import-audio'),
  transcribe: folder => ipcRenderer.invoke('transcribe', folder),
  summarize: (folder, transcript, options) => ipcRenderer.invoke('summarize', folder, transcript, options),
  regenerate: (folder, options) => ipcRenderer.invoke('regenerate', folder, options),
  listMeetings: () => ipcRenderer.invoke('list-meetings'),
  loadMeeting: folder => ipcRenderer.invoke('load-meeting', folder),
  openFolder: folder => ipcRenderer.invoke('open-folder', folder),
  checkEnvironment: () => ipcRenderer.invoke('check-environment'),
  exportPdf: (html, suggestedName) => ipcRenderer.invoke('export-pdf', html, suggestedName),
  onTranscribeProgress: cb => ipcRenderer.on('transcribe-progress', (_e, text) => cb(text))
});
