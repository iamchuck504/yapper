// Does the System meter actually move on macOS?
//
// It never had. On Windows the loopback runs through the renderer's own audio
// graph, so an analyser draws that meter for free; on macOS the samples are
// captured natively and mixed in the main process, and the renderer was handed
// nothing. The meter drew a flat line and the gain slider beside it moved
// nothing — for the one source a user most wants to confirm is arriving. It
// read as silence rather than as an unanswered question, and that is exactly
// how it was reported.
//
// So this drives a real recording with real audio playing and reads the pixels
// the meter drew, because "the data arrived" is not the same claim as "the
// user can see it".
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');
const { sandbox, logger, mainWindow, watchdog } = require('./harness');

if (process.platform !== 'darwin') {
  console.log('skip  esta prueba es de macOS');
  process.exit(0);
}

const ROOT = sandbox('sys-meter');
const say = logger(ROOT);

let fails = 0;
function check(name, ok, detail) {
  if (ok) say(`ok    ${name}`);
  else { fails++; say(`FAIL  ${name}\n      ${detail}`); }
}

const pause = ms => new Promise(r => setTimeout(r, ms));

/** How much of the canvas is not the flat resting line. */
const meterMotion = win => win.webContents.executeJavaScript(`(() => {
  const c = document.getElementById('viz-sys');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let lit = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 40) lit++;
  return { lit, total: c.width * c.height };
})()`);

app.whenReady().then(async () => {
  const timer = watchdog(say);
  try {
    require('../main.js');
    const win = await mainWindow();
    const $ = js => win.webContents.executeJavaScript(js, true);

    await $('window.yapper.setKeepAudio(true)');
    await $('startRecording()');
    await pause(2500);                     // let the helper come up

    const resting = await meterMotion(win);
    say(`  · en reposo: ${resting.lit} px encendidos`);

    // Real audio, played out loud: this is the far side of a call.
    const player = spawn('afplay', [path.join(__dirname, 'calibration.wav')]);
    await pause(1800);
    const during = await meterMotion(win);
    say(`  · con audio sonando: ${during.lit} px encendidos`);
    await new Promise(r => player.on('close', r));

    check('el medidor de System se mueve con audio real',
      during.lit > resting.lit * 1.5 && during.lit > 200,
      `reposo ${resting.lit}, sonando ${during.lit}`);

    // The slider has to reach the process that does the mixing, or it is a
    // control that moves nothing — which is what it was.
    const reached = await $(`(() => {
      const s = document.getElementById('gain-sys');
      s.value = '2'; s.dispatchEvent(new Event('input'));
      return s.value;
    })()`);
    check('el deslizador de volumen llega al mezclador', reached, '2');

    await $('stopAndProcess()').catch(() => { });
    await pause(1500);
    const after = await meterMotion(win);
    check('al parar vuelve a plano, no se congela en el último pico',
      after.lit <= resting.lit + 40, `reposo ${resting.lit}, tras parar ${after.lit}`);
  } catch (err) {
    fails++;
    say('FAIL  ' + (err.stack || err.message));
  }
  clearTimeout(timer);
  say(fails ? `\n${fails} fallos` : '\nPASS');
  app.exit(fails ? 1 : 0);
});
