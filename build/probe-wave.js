// The real startRecording(), fed synthetic audio, watched for what the record
// view actually draws. test-record-cycle feeds PCM straight through IPC, so the
// capture graph — and the waveform loop — never runs under it. This probe runs
// exactly the path the record button runs.
const path = require('path');
const fs = require('fs');
const { app, ipcMain } = require('electron');
const { sandbox, logger, mainWindow } = require('./harness');

const ROOT = sandbox('wave-probe');
fs.mkdirSync(path.join(ROOT, 'Meetings'), { recursive: true });
const say = logger(ROOT);

let levelMsgs = 0;
require('../main.js');
ipcMain.on('bubble-state', (_e, s) => { if (s && typeof s.level === 'number') levelMsgs++; });

app.whenReady().then(async () => {
  const win = await mainWindow({ settleMs: 1500 });
  const $ = js => win.webContents.executeJavaScript(js, true);

  const consoleErrors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) consoleErrors.push(message);
  });

  // Synthetic capture: two oscillators, so both channels carry a live signal.
  await $(`(() => {
    const gen = new AudioContext();
    const mk = freq => {
      const dest = gen.createMediaStreamDestination();
      const o = gen.createOscillator(); o.frequency.value = freq;
      const g = gen.createGain(); g.gain.value = 0.5;
      o.connect(g); g.connect(dest); o.start();
      return dest.stream;
    };
    navigator.mediaDevices.getDisplayMedia = async () => mk(440);
    navigator.mediaDevices.getUserMedia = async () => mk(220);
  })()`);

  await $('startRecording()');
  await new Promise(r => setTimeout(r, 1500));

  const shot = () => $(`({
    recording,
    raf: levelRaf,
    sys: document.getElementById('viz-sys').toDataURL().length,
    mic: document.getElementById('viz-mic').toDataURL().length,
    sysPix: document.getElementById('viz-sys').toDataURL().slice(-80),
    micPix: document.getElementById('viz-mic').toDataURL().slice(-80)
  })`);

  const a = await shot();
  await new Promise(r => setTimeout(r, 400));
  const b = await shot();

  say(`recording: ${b.recording}`);
  say(`rAF id: ${a.raf} -> ${b.raf}  ${a.raf === b.raf ? '(EL LOOP ESTÁ MUERTO)' : '(vivo)'}`);
  say(`canvas sys cambia entre frames: ${a.sysPix !== b.sysPix}`);
  say(`canvas mic cambia entre frames: ${a.micPix !== b.micPix}`);
  say(`mensajes de nivel a la burbuja: ${levelMsgs}`);
  say(`errores de consola (${consoleErrors.length}):`);
  for (const e of consoleErrors.slice(0, 6)) say(`  ${e}`);

  app.exit(0);
}).catch(e => { say('FAIL ' + (e.stack || e.message)); app.exit(1); });
