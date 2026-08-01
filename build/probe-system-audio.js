// Does a recording on macOS actually contain the other side of the call?
//
// Energy in the file proves nothing on its own: whatever the speakers play, the
// microphone hears too, so a recording that captured only the mic looks exactly
// like one that captured both. The way to tell them apart is to take the
// speakers out of it — mute the output, play a known clip, and record. A muted
// Mac gives the microphone nothing to hear, so any signal left in the file came
// through ScreenCaptureKit, which taps the audio before it reaches the speakers.
//
//   node_modules/electron/dist/Electron.app/Contents/MacOS/Electron build/probe-system-audio.js
//
// Restores the volume it found, including when it fails.
const path = require('path');
const fs = require('fs');
const { execFileSync, spawn } = require('child_process');
const { app } = require('electron');
const { sandbox, logger, mainWindow, watchdog } = require('./harness');

if (process.platform !== 'darwin') {
  console.log('skip  esta prueba es de macOS');
  process.exit(0);
}

const ROOT = sandbox('system-audio-probe');
const say = logger(ROOT);
watchdog(say, 120000);

let fails = 0;
const check = (name, ok, detail) => {
  if (ok) say(`ok    ${name}`);
  else { fails++; say(`FAIL  ${name}\n      ${detail || ''}`); }
};

const osa = script => execFileSync('osascript', ['-e', script], { encoding: 'utf8' }).trim();
const wasMuted = osa('output muted of (get volume settings)') === 'true';
const restore = () => {
  try { osa(`set volume output muted ${wasMuted}`); } catch { /* best effort */ }
};
process.on('exit', restore);

/** Peak absolute sample of a 16-bit PCM WAV, ignoring the header. */
function peakOf(wav) {
  const b = fs.readFileSync(wav);
  let peak = 0;
  for (let i = 44; i + 1 < b.length; i += 2) {
    const v = Math.abs(b.readInt16LE(i));
    if (v > peak) peak = v;
  }
  return peak;
}

require('../main.js');

app.whenReady().then(async () => {
  const win = await mainWindow();
  const $ = js => win.webContents.executeJavaScript(js, true);

  say('  · silenciando la salida para que el micrófono no pueda oír nada');
  osa('set volume output muted true');

  // The audio is the evidence, and stopAndProcess() releases it the moment a
  // transcript exists — so this probe used to pass only when capture had
  // failed and the transcript came out empty. Working capture deleted its own
  // proof. Keep the recording for this meeting.
  await win.webContents.executeJavaScript('window.yapper.setKeepAudio(true)', true);

  await $('startRecording()');
  await new Promise(r => setTimeout(r, 2500));      // let the helper come up

  const clip = path.join(__dirname, 'calibration.wav');
  say('  · reproduciendo el clip de calibración con el volumen apagado');
  const player = spawn('afplay', [clip]);
  await new Promise(r => player.on('close', r));
  await new Promise(r => setTimeout(r, 1500));

  await $('stopAndProcess()').catch(() => { });
  await new Promise(r => setTimeout(r, 3000));
  restore();

  const folders = fs.readdirSync(path.join(ROOT, 'Meetings'));
  check('la grabación creó su carpeta', folders.length === 1, folders.join(', '));
  if (folders.length === 1) {
    const wav = path.join(ROOT, 'Meetings', folders[0], 'recording.wav');
    check('el WAV existe', fs.existsSync(wav));
    if (fs.existsSync(wav)) {
      const peak = peakOf(wav);
      const seconds = ((fs.statSync(wav).size - 44) / 32000).toFixed(1);
      say(`  · ${seconds} s grabados, pico ${peak}`);
      // The clip is speech at a normal level. Anything above a few hundred is
      // unambiguously signal rather than the noise floor of a muted machine.
      check('con el altavoz apagado, el audio del sistema llegó al archivo',
        peak > 500, `pico ${peak}: solo se grabó el micrófono`);
    }
  }

  say(fails ? `\n${fails} fallos` : '\nPASS');
  app.exit(fails ? 1 : 0);
});
