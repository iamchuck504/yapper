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
    window.__wake = () => {
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

  check('grabando', await $('recording'), 'did not start');
  const early = await status();
  check('does not blame the microphone too early', !/microphone has captured/i.test(early), early);

  // the watchdog speaks after ~6 s of exact zeros
  const warned = await within((async () => {
    for (let i = 0; i < 30; i++) {
      const s = await status();
      if (/microphone has captured only silence/i.test(s)) return s;
      await new Promise(r => setTimeout(r, 500));
    }
    return '';
  })(), 'waiting for the warning', 30000);
  say(`  aviso: "${warned}"`);
  check('a microphone reading exact zeroes is reported on screen', !!warned, 'never warned');
  check('mentions the real case: wireless headset', /wireless headset/i.test(warned), warned);
  check('the recording continues — it warns, it does not abort', await $('recording'), 'it stopped');

  // the device wakes up; the warning must not outlive the problem
  await $('__wake()');
  const cleared = await within((async () => {
    for (let i = 0; i < 20; i++) {
      if (!(await status())) return true;
      await new Promise(r => setTimeout(r, 300));
    }
    return false;
  })(), 'waiting for it to clear', 15000);
  check('when the mic wakes up, the warning clears itself', cleared, await status());

  say(fails ? `\n${fails} fallos` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(e => { say('FAIL ' + (e.stack || e.message)); app.exit(1); });
