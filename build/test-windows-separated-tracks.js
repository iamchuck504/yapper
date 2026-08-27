// Drive Windows' real recording IPC with a known mixed block and two known
// source blocks. The main process must close three aligned WAVs without
// confusing the microphone with the already-mixed stream.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { sandbox, logger, mainWindow, watchdog } = require('./harness');
const engine = require('../engine');

if (process.platform !== 'win32') {
  console.log('skip  Windows separated-track IPC');
  app.exit(0);
} else {
  const root = sandbox('windows-separated-tracks');
  const say = logger(root);
  let fails = 0;
  const check = (name, ok, detail = '') => {
    if (ok) say(`ok    ${name}`);
    else { fails++; say(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`); }
  };

  require('../main.js');
  const dog = watchdog(say);
  app.whenReady().then(async () => {
    try {
      const win = await mainWindow();
      const $ = js => win.webContents.executeJavaScript(js);
      const folder = await $(`window.yapper.recordingStart('Maya, Chuck')`);
      const samples = 1600;
      await $(`(() => {
        const mic = new Int16Array(${samples});
        const sys = new Int16Array(${samples});
        const mixed = new Int16Array(${samples});
        mic.fill(1000); sys.fill(-400); mixed.fill(600);
        window.yapper.recordingChunk(mixed.buffer, { mic: mic.buffer, sys: sys.buffer });
      })()`);
      await new Promise(resolve => setTimeout(resolve, 150));
      await $(`window.yapper.recordingFinish('', [])`);

      const body = name => fs.readFileSync(path.join(folder, name)).subarray(engine.WAV_HEADER);
      const mixed = body('recording.wav');
      const mic = body('recording.mic.wav');
      const sys = body('recording.sys.wav');
      check('all three WAVs have the same clock', mixed.length === mic.length && mic.length === sys.length,
        `${mixed.length}, ${mic.length}, ${sys.length}`);
      check('recording.wav retains the renderer mix', mixed.readInt16LE(0) === 600,
        String(mixed.readInt16LE(0)));
      check('the microphone track is not the mixed stream', mic.readInt16LE(0) === 1000,
        String(mic.readInt16LE(0)));
      check('the system track is retained separately', sys.readInt16LE(0) === -400,
        String(sys.readInt16LE(0)));
      check('every WAV header closes with the real size',
        ['recording.wav', 'recording.mic.wav', 'recording.sys.wav'].every(name => {
          const wav = fs.readFileSync(path.join(folder, name));
          return wav.readUInt32LE(40) === wav.length - engine.WAV_HEADER;
        }));
    } catch (err) {
      fails++;
      say(`FAIL  ${err.stack || err.message}`);
    }
    clearTimeout(dog);
    say(fails ? `\n${fails} failures` : '\nPASS');
    app.exit(fails ? 1 : 0);
  });
}
