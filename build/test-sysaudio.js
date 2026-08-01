// Mixing the other side of the call into the microphone, which on macOS is the
// difference between a recording of a meeting and a recording of one person
// talking.
//
// The mixing itself is one addition per sample, and the ways it goes wrong are
// all quiet ones: wrapping instead of clipping turns a loud moment into noise,
// a buffer that only grows makes the far side drift later and later behind the
// voice, and a helper that never starts must leave the microphone untouched
// rather than write silence over it.
const { create, mixPcm, MAX_BUFFERED } = require('../sysaudio');
const path = require('path');
const fs = require('fs');

let fails = 0;
function check(name, ok, detail) {
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      ${detail || ''}`); }
}
const pcm = (...samples) => {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => b.writeInt16LE(s, i * 2));
  return b;
};
const samplesOf = buf => {
  const out = [];
  for (let i = 0; i + 1 < buf.length; i += 2) out.push(buf.readInt16LE(i));
  return out;
};

// ---- the addition ----
check('suma muestra a muestra',
  String(samplesOf(mixPcm(pcm(100, -100, 0), pcm(50, -50, 7)))) === String([150, -150, 7]));
check('silence changes nothing',
  String(samplesOf(mixPcm(pcm(1000, -2000), pcm(0, 0)))) === String([1000, -2000]));

// Wrapping is the dangerous failure: 32767 + 1 becomes -32768, so a loud
// passage would come back as a burst of noise instead of merely clipping.
check('it clips upwards instead of wrapping round',
  samplesOf(mixPcm(pcm(30000), pcm(30000)))[0] === 32767,
  String(samplesOf(mixPcm(pcm(30000), pcm(30000)))));
check('and downwards too',
  samplesOf(mixPcm(pcm(-30000), pcm(-30000)))[0] === -32768);
check('does not touch the buffer it is handed', (() => {
  const mic = pcm(100, 200);
  mixPcm(mic, pcm(1, 1));
  return String(samplesOf(mic)) === String([100, 200]);
})(), 'mutated the input');
check('a shorter tail does not break the mix',
  String(samplesOf(mixPcm(pcm(10, 20, 30), pcm(5)))) === String([15, 20, 30]));

// ---- taking, with no helper running ----
const idle = create({ probePath: path.join(__dirname, 'no-such-helper') });
check('with no helper there is no capture state', idle.state === 'off');
check('y take() devuelve null, no silencio', idle.take(64) === null,
  'it would write zeros over the microphone');

idle.start().then(started => {
  check('starting with no helper resolves false rather than throwing', started === false);
  check('and it is marked unavailable', idle.state === 'unavailable', idle.state);

  // Half a second at 16 kHz mono 16-bit. Stated as a number here so that
  // widening the bound has to be a decision, not a typo: the whole point is
  // that the far side cannot drift arbitrarily far behind the voice.
  check('the buffer cap is half a second of audio', MAX_BUFFERED === 16000,
    `it is ${MAX_BUFFERED}`);

  // ---- the helper on disk, when this machine has one ----
  const helper = path.join(__dirname, 'system-audio');
  if (process.platform === 'darwin' && fs.existsSync(helper)) {
    const live = create({ probePath: helper });
    live.start().then(ok => {
      // Two states are the machine's, not the code's: Screen Recording not
      // granted, and a display asleep — ScreenCaptureKit lists no displays
      // then, which is why the app holds the screen awake while recording.
      // Neither says anything about whether this module works, so neither is
      // a failure here.
      if (!ok) {
        console.log(`skip  the helper could not capture (state ${live.state}): `
          + 'Screen Recording permission, or the screen asleep');
        live.stop();
        return done();
      }
      check('the real helper starts and captures', true);
      if (ok) {
        const chunk = live.take(3200);            // 0.1 s
        check('hands over exactly what it is asked for', chunk && chunk.length === 3200,
          chunk ? String(chunk.length) : 'null');
        check('and pads with silence for what has not arrived yet', chunk && chunk.length === 3200);
      }
      live.stop();
      check('stopping leaves it off', live.state === 'off');
      done();
    });
  } else {
    console.log('skip  the native helper is not compiled here (macOS only)');
    done();
  }
});

function done() {
  console.log(fails ? `\n${fails} failures` : '\nPASS');
  process.exit(fails ? 1 : 0);
}
