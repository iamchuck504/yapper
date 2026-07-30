// The same probe, but with the REAL capture path: Windows loopback for system
// audio and the real default microphone. A tone is played through the speakers
// so the loopback has something to show. Reports everything that could explain
// a flat waveform: context state, track counts, which analysers exist, and
// whether the drawn pixels actually move.
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { sandbox, logger, mainWindow } = require('./harness');

const ROOT = sandbox('wave-real-probe');
fs.mkdirSync(path.join(ROOT, 'Meetings'), { recursive: true });
const say = logger(ROOT);

require('../main.js');

app.whenReady().then(async () => {
  const win = await mainWindow({ settleMs: 1500 });
  const $ = js => win.webContents.executeJavaScript(js, true);

  const consoleErrors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) consoleErrors.push(message);
  });

  // A quiet tone out of the speakers, so the system loopback has signal.
  await $(`(() => {
    window.__tone = new AudioContext();
    const o = __tone.createOscillator(); o.frequency.value = 330;
    const g = __tone.createGain(); g.gain.value = 0.08;
    o.connect(g); g.connect(__tone.destination); o.start();
  })()`);

  await $('startRecording()');
  await new Promise(r => setTimeout(r, 2500));

  const report = await $(`({
    recording,
    ctxState: audioCtx ? audioCtx.state : '(no audioCtx)',
    sysTracks: sysStream ? sysStream.getAudioTracks().length : -1,
    hasSysAnalyser: !!analysers.sys,
    hasMicAnalyser: !!analysers.mic,
    raf: levelRaf
  })`);
  say(JSON.stringify(report, null, 2));

  const pixels = id => $(`(() => {
    const c = document.getElementById(${JSON.stringify(id)});
    const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 40) lit++;
    return { lit, total: px.length / 4 };
  })()`);

  const wave = async id => {
    const shots = [];
    for (let i = 0; i < 4; i++) {
      shots.push((await pixels(id)).lit);
      await new Promise(r => setTimeout(r, 250));
    }
    return shots;
  };

  const sys = await wave('viz-sys');
  const mic = await wave('viz-mic');
  say(`sys píxeles encendidos por frame: ${sys.join(', ')}`);
  say(`mic píxeles encendidos por frame: ${mic.join(', ')}`);
  const moving = a => new Set(a).size > 1;
  say(`sys se mueve: ${moving(sys)}   mic se mueve: ${moving(mic)}`);
  say(`errores de consola (${consoleErrors.length}):`);
  for (const e of consoleErrors.slice(0, 6)) say(`  ${e}`);

  await $('stopRecording && stopRecording()').catch(() => {});
  app.exit(0);
}).catch(e => { say('FAIL ' + (e.stack || e.message)); app.exit(1); });
