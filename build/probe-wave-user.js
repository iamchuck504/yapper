// The waveform probe again, but against the REAL user profile: Chuck's saved
// microphone selection, gains and noise filter — everything his real recordings
// run with. Only the documents folder is sandboxed, so no real meeting is
// touched. This is the run that can tell "the code broke" apart from "the
// selected device is delivering silence".
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app } = require('electron');

const DOCS = path.join(os.tmpdir(), 'yapper-wave-user');
try { fs.rmSync(DOCS, { recursive: true, force: true }); } catch { /* busy */ }
fs.mkdirSync(path.join(DOCS, 'Meetings'), { recursive: true });
app.setPath('documents', DOCS);                    // real userData stays

const LOG = path.join(DOCS, 'progress.log');
function say(line) {
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch { /* nothing */ }
}

require('../main.js');

app.whenReady().then(async () => {
  let win = null;
  for (let i = 0; i < 100 && !win; i++) {
    win = require('electron').BrowserWindow.getAllWindows()
      .find(w => w.webContents.getURL().endsWith('index.html'));
    if (!win) await new Promise(r => setTimeout(r, 200));
  }
  if (!win) { say('FAIL  the window never appeared'); return app.exit(1); }
  await new Promise(r => setTimeout(r, 2500));
  const $ = js => win.webContents.executeJavaScript(js, true);

  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(message);
  });

  say('real settings:');
  say(await $(`JSON.stringify({
    mic: localStorage.getItem('yapper-mic'),
    gainSys: localStorage.getItem('yapper-gain-sys'),
    gainMic: localStorage.getItem('yapper-gain-mic'),
    noise: localStorage.getItem('yapper-noise'),
    bubble: localStorage.getItem('yapper-bubble'),
    autodetect: localStorage.getItem('yapper-autodetect')
  }, null, 2)`));

  say('microphones visible right now:');
  say(await $(`(async () => {
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.filter(d => d.kind === 'audioinput')
      .map(d => '  ' + (d.label || d.deviceId.slice(0, 12))).join('\\n');
  })()`));

  // a quiet tone through the real speakers, so the loopback has signal
  await $(`(() => {
    window.__tone = new AudioContext();
    const o = __tone.createOscillator(); o.frequency.value = 330;
    const g = __tone.createGain(); g.gain.value = 0.06;
    o.connect(g); g.connect(__tone.destination); o.start();
  })()`);

  await $('startRecording()');
  await new Promise(r => setTimeout(r, 2500));

  say(await $(`JSON.stringify({
    recording,
    ctxState: audioCtx ? audioCtx.state : '(sin audioCtx)',
    sysTracks: sysStream ? sysStream.getAudioTracks().length : -1,
    hasSysAnalyser: !!analysers.sys,
    hasMicAnalyser: !!analysers.mic
  })`));

  const pixels = id => $(`(() => {
    const c = document.getElementById(${JSON.stringify(id)});
    const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 40) lit++;
    return lit;
  })()`);
  const wave = async id => {
    const shots = [];
    for (let i = 0; i < 4; i++) { shots.push(await pixels(id)); await new Promise(r => setTimeout(r, 250)); }
    return shots;
  };

  const sys = await wave('viz-sys');
  const mic = await wave('viz-mic');
  const moving = a => new Set(a).size > 1;
  say(`sys pixels per frame: ${sys.join(', ')}  -> moving: ${moving(sys)}`);
  say(`mic pixels per frame: ${mic.join(', ')}  -> moving: ${moving(mic)}`);
  say(`errors (${errors.length}):`);
  for (const e of errors.slice(0, 6)) say(`  ${e}`);

  app.exit(0);
}).catch(e => { say('FAIL ' + (e.stack || e.message)); app.exit(1); });
