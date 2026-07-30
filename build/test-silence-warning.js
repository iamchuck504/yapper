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

  check('grabando', await $('recording'), 'no arrancó');
  const early = await status();
  check('no acusa al micrófono antes de tiempo', !/microphone has captured/i.test(early), early);

  // the watchdog speaks after ~6 s of exact zeros
  const warned = await within((async () => {
    for (let i = 0; i < 30; i++) {
      const s = await status();
      if (/microphone has captured only silence/i.test(s)) return s;
      await new Promise(r => setTimeout(r, 500));
    }
    return '';
  })(), 'esperar el aviso', 30000);
  say(`  aviso: "${warned}"`);
  check('un micrófono en ceros exactos se dice en pantalla', !!warned, 'nunca avisó');
  check('menciona el caso real: headset inalámbrico', /wireless headset/i.test(warned), warned);
  check('la grabación sigue — avisa, no aborta', await $('recording'), 'se detuvo');

  // the device wakes up; the warning must not outlive the problem
  await $('__wake()');
  const cleared = await within((async () => {
    for (let i = 0; i < 20; i++) {
      if (!(await status())) return true;
      await new Promise(r => setTimeout(r, 300));
    }
    return false;
  })(), 'esperar que se limpie', 15000);
  check('cuando el mic despierta, el aviso se va solo', cleared, await status());

  say(fails ? `\n${fails} fallos` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(e => { say('FAIL ' + (e.stack || e.message)); app.exit(1); });
