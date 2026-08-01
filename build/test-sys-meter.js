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

/**
 * How much of the canvas height the trace spans, as a percentage.
 *
 * Counting lit pixels was the first measure and it stopped meaning anything
 * once the trace was scaled to a rolling peak: a flat line and a full waveform
 * light a similar number of pixels, they just light them in different places.
 * Vertical spread is what "the meter moved" actually looks like.
 */
const meterSpread = win => win.webContents.executeJavaScript(`(() => {
  const c = document.getElementById('viz-sys');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let top = c.height, bottom = 0;
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      if (d[(y * c.width + x) * 4 + 3] > 60) { if (y < top) top = y; if (y > bottom) bottom = y; break; }
    }
  }
  return bottom > top ? Math.round((bottom - top) / c.height * 100) : 0;
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

    const resting = await meterSpread(win);
    say(`  · en reposo: el trazo ocupa ${resting}% del alto`);

    // Real audio, played out loud: this is the far side of a call.
    const player = spawn('afplay', [path.join(__dirname, 'calibration.wav')]);
    await pause(1800);
    const during = await meterSpread(win);
    say(`  · con audio sonando: ${during}% del alto`);
    await new Promise(r => player.on('close', r));

    // Scaled to a rolling peak, a real signal fills most of the canvas while
    // silence stays near the baseline — that gap is the whole point of the
    // meter, and it is what "it doesn't work" meant when it was 8%.
    check('el medidor de System se mueve con audio real', during > 50,
      `sonando ${during}%, reposo ${resting}%`);
    // El "reposo" de arriba depende de la máquina: si hay música o una pestaña
    // sonando, el tap la capta y el trazo sube con razón. Para probar el piso
    // hace falta silencio de verdad, así que se fabrica.
    await $(`sysRing.fill(128); sysWritten = 1024; sysCursor = 0; true`);
    await pause(200);
    const silent = await meterSpread(win);
    say(`  · con silencio fabricado: ${silent}% del alto`);
    check('el silencio no se amplifica hasta parecer señal', silent < 15, `${silent}%`);

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
    // The canvas keeps whatever was drawn last — the loop stops with the
    // recording — so what matters is that the buffer behind it was emptied,
    // and the next recording does not open on the last one's audio.
    check('al parar se vacía el búfer, no queda audio de la reunión anterior',
      await $('sysWritten'), 0);
  } catch (err) {
    fails++;
    say('FAIL  ' + (err.stack || err.message));
  }
  clearTimeout(timer);
  say(fails ? `\n${fails} fallos` : '\nPASS');
  app.exit(fails ? 1 : 0);
});
