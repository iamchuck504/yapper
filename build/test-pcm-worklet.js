// The audio-thread tap is where Windows either keeps the two sides of a call
// or loses them forever. Exercise it without a real microphone: two input
// buses must remain aligned and mono, while their sum remains the mixed stream
// used by recording.wav and the live transcript.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let Tap;
const context = vm.createContext({
  Float32Array,
  AudioWorkletProcessor: class {
    constructor() {
      this.port = { postMessage: () => { } };
    }
  },
  registerProcessor: (_name, Type) => { Tap = Type; }
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'pcm-worklet.js'), 'utf8'), context);

let fails = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`); }
}

const tap = new Tap();
let posted;
tap.port.postMessage = packet => { posted = packet; };
const block = value => [new Float32Array(128).fill(value)];
for (let i = 0; i < 32; i++) tap.process([
  [new Float32Array(128).fill(0.25), new Float32Array(128).fill(0.5)],
  block(0.125)
]);

check('posts one 4096-frame packet', posted && posted.mixed.length === 4096,
  posted && String(posted.mixed.length));
check('microphone stereo is reduced to mono', posted && posted.mic.every(v => v === 0.375));
check('system audio stays in its own track', posted && posted.sys.every(v => v === 0.125));
check('the mixed stream is the sum of both sources', posted && posted.mixed.every(v => v === 0.5));

posted = null;
const micOnly = new Tap();
micOnly.port.postMessage = packet => { posted = packet; };
for (let i = 0; i < 32; i++) micOnly.process([block(0.2), []]);
check('an absent system source becomes aligned silence', posted
  && posted.sys.length === posted.mic.length && posted.sys.every(v => v === 0));
check('mic-only recording keeps the original mixed level', posted
  && posted.mixed.every((v, i) => v === posted.mic[i]));

console.log(fails ? `\n${fails} failures` : '\nPASS');
process.exit(fails ? 1 : 0);
