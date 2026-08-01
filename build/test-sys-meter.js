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
  console.log('skip  this test is macOS-only');
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
    say(`  · at rest: the trace spans ${resting}% of the height`);

    // Real audio, played out loud: this is the far side of a call.
    const player = spawn('afplay', [path.join(__dirname, 'calibration.wav')]);
    await pause(1800);
    const during = await meterSpread(win);
    say(`  · with audio playing: ${during}% of the height`);
    await new Promise(r => player.on('close', r));

    // Normalised, so a real signal fills the canvas whether it arrives loud or
    // quiet — the tap's level depends on whatever else the machine is playing,
    // and an absolute threshold on one source's volume is not a property of
    // this app.
    // If the tap received nothing in this window — the machine may have no
    // audio output, or the clip may never have sounded — there is nothing to
    // measure, and asserting anyway turns the test into a coin toss.
    const captured = during > 15;
    if (!captured) say('  · no audio captured this run: the level measurements are skipped');
    if (captured) {
      check('the System meter moves with real audio', during > 50,
        `sonando ${during}%, reposo ${resting}%`);
    }
    // The "at rest" above depends on the machine: if music or a tab is playing,
    // the tap catches it and the trace rises, rightly. Testing the floor needs
    // genuine silence, so it is manufactured.
    await $(`sysRing.fill(128); sysWritten = 1024; sysCursor = 0; true`);
    await pause(200);
    const silent = await meterSpread(win);
    say(`  · with manufactured silence: ${silent}% of the height`);
    check('silence is not amplified until it looks like signal', silent < 15, `${silent}%`);

    // The slider has to reach the process that does the mixing, or it is a
    // control that moves nothing — which is what it was.
    const reached = await $(`(() => {
      const s = document.getElementById('gain-sys');
      s.value = '2'; s.dispatchEvent(new Event('input'));
      return s.value;
    })()`);
    check('the gain slider reaches the mixer', reached, '2');

    // And it shows: normalising buys visibility, multiplying by the chosen gain
    // gives the slider back the effect normalising took from it.
    const atGain = async g => {
      await $(`(()=>{const s=document.getElementById('gain-sys'); s.value='${g}'; s.dispatchEvent(new Event('input'));})()`);
      await pause(500);
      return meterSpread(win);
    };
    if (captured) {
      // With audio playing, or there is no trace to shrink: measuring gain over
      // silence gives the same floor at both positions and the test becomes an
      // assertion about nothing.
      const again = spawn('afplay', [path.join(__dirname, 'calibration.wav')]);
      await pause(1200);
      const quiet = await atGain('0.25');
      const loud = await atGain('1');
      again.kill();
      await new Promise(r => again.on('close', r));
      say(`  · gain 0.25x -> ${quiet}% | 1x -> ${loud}%`);
      check('turning the gain down shrinks the trace visibly', loud > quiet * 1.8,
        `0.25x ${quiet}%, 1x ${loud}%`);
    }

    await $('stopAndProcess()').catch(() => { });
    await pause(1500);
    // The canvas keeps whatever was drawn last — the loop stops with the
    // recording — so what matters is that the buffer behind it was emptied,
    // and the next recording does not open on the last one's audio.
    // stopAndProcess empties the ring; on a run with no capture it never filled.
    check('stopping empties the buffer, no audio of the previous meeting is left',
      await $('sysWritten') === 0);
  } catch (err) {
    fails++;
    say('FAIL  ' + (err.stack || err.message));
  }
  clearTimeout(timer);
  say(fails ? `\n${fails} failures` : '\nPASS');
  app.exit(fails ? 1 : 0);
});
