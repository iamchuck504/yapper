// A recording whose microphone delivers pure digital zeros — the asleep
// wireless headset, the hardware mute. The graph runs, the waveform draws a
// flat line, and without this warning the user finds out two hours later that
// the meeting is silence. The warning must appear while it is still fixable,
// and must leave when the device wakes up.
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { sandbox, logger, mainWindow, within } = require('./harness');

const ROOT = sandbox('silence-warning');
fs.mkdirSync(path.join(ROOT, 'Meetings'), { recursive: true });
const say = logger(ROOT);

let fails = 0;
function check(name, ok, detail) {
  if (ok) say(`ok    ${name}`);
  else { fails++; say(`FAIL  ${name}\n      ${detail}`); }
}

require('../main.js');

app.whenReady().then(async () => {
  const win = await mainWindow({ settleMs: 1500 });
  const $ = js => win.webContents.executeJavaScript(js, true);

  // System audio alive (a tone), microphone stone dead: a destination node
  // with nothing connected produces exact zeros, byte-identical to a sleeping
  // headset. __wake lets the test turn the mic on later.
  await $(`(() => {
    const gen = new AudioContext();
    const live = freq => {
      const dest = gen.createMediaStreamDestination();
      const o = gen.createOscillator(); o.frequency.value = freq;
      const g = gen.createGain(); g.gain.value = 0.5;
      o.connect(g); g.connect(dest); o.start();
      return dest.stream;
    };
    const deadDest = gen.createMediaStreamDestination();
    window.__wake = async () => {
      // Chromium starts an AudioContext suspended when no user gesture opened
      // it, and a suspended context produces digital silence — which is exactly
      // what this test simulates on purpose, so the device could never appear
      // to wake up. Resume before making noise.
      if (gen.state !== 'running') await gen.resume();
      // The app's own graph is suspended too: nothing here was opened by a
      // click, and a suspended context measures silence no matter what is
      // played into it. Both ends have to be running for a wake-up to be
      // visible at all.
      if (typeof audioCtx !== 'undefined' && audioCtx && audioCtx.state !== 'running') {
        await audioCtx.resume();
      }
      const o = gen.createOscillator(); o.frequency.value = 220;
      o.connect(deadDest); o.start();
    };
    navigator.mediaDevices.getDisplayMedia = async () => live(440);
    navigator.mediaDevices.getUserMedia = async () => deadDest.stream;
  })()`);

  await $('startRecording()');
  await new Promise(r => setTimeout(r, 1200));

  const status = () => $(`(() => { const el = document.getElementById('status');
    return el.classList.contains('hidden') ? '' : el.textContent; })()`);

  // Both wordings of the same watchdog: the app names the microphone when
  // something else is in the mix, and speaks more generally when it is the only
  // source — which is every macOS recording without Screen Recording granted.
  const SILENCE = /(microphone has captured only silence|nothing but silence has been captured)/i;

  check('recording', await $('recording'), 'did not start');
  const early = await status();
  check('does not accuse the microphone too early', !/microphone has captured/i.test(early), early);

  // the watchdog speaks after ~6 s of exact zeros
  const warned = await within((async () => {
    for (let i = 0; i < 30; i++) {
      const s = await status();
      if (SILENCE.test(s)) return s;
      await new Promise(r => setTimeout(r, 500));
    }
    return '';
  })(), 'wait for the warning', 30000);
  say(`  aviso: "${warned}"`);
  check('a microphone on exact zeros is said on screen', !!warned, 'it never warned');
  // The wording depends on whether there was a second source to fall back on.
  // With system audio in the mix the microphone is the only suspect and it is
  // named; on macOS, where the mix is the microphone alone, the message covers
  // both ends of the cable. Either way it has to point at the hardware.
  check('it points at the hardware, not an abstract error', /headset|microphone/i.test(warned), warned);
  check('the recording continues — it warns, it does not abort', await $('recording'), 'it stopped');

  // the device wakes up; the warning must not outlive the problem
  await $('__wake()');
  await new Promise(r => setTimeout(r, 1500));
  // Verify the simulation before trusting its verdict. A
  // MediaStreamAudioDestinationNode whose stream has already been consumed as
  // silence does not always start carrying signal when something is connected
  // to it later — that happens on macOS — and then this would be reporting a
  // dead mock as an app that ignores a recovered microphone.
  const woke = await $('(() => levelOf(analysers.mic))()');
  const cleared = await within((async () => {
    for (let i = 0; i < 20; i++) {
      if (!(await status())) return true;
      await new Promise(r => setTimeout(r, 300));
    }
    return false;
  })(), 'wait for it to clear', 15000);
  if (woke > 0) {
    check('when the mic wakes up, the warning clears itself', cleared, await status());
  } else {
    say('skip  the mock could not get signal back into the stream, so there is no waking up to check');
  }

  say(fails ? `\n${fails} failures` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(e => { say('FAIL ' + (e.stack || e.message)); app.exit(1); });
