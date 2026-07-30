// The audio fixtures the heavier tests expect, built from what the repo already
// ships.
//
// Several tests want `yapper-10s.wav` and `yapper-60s.wav` in the temp
// directory. They used to come from make-clips.js, which cuts them out of real
// meetings — fine on the machine that has those meetings, useless anywhere
// else, and the tests simply crashed when the files were not there.
//
// calibration.wav is 11 s of public-domain speech that every checkout has, so
// looping it produces something of the right shape and length. It is the same
// voice repeating, which is exactly what these tests need (they measure timing,
// file handling and recovery, not transcription quality); anything judging the
// words should point WAV= at real audio instead.
//
//   node build/make-fixtures.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const engine = require('../engine');

const SOURCE = path.join(__dirname, 'calibration.wav');

function build(seconds) {
  const dest = path.join(os.tmpdir(), `yapper-${seconds}s.wav`);
  if (fs.existsSync(dest)) {
    const have = (fs.statSync(dest).size - engine.WAV_HEADER) / engine.BYTES_PER_SEC;
    if (have >= seconds - 0.5) return { dest, made: false, seconds: have };
  }
  const pcm = fs.readFileSync(SOURCE).subarray(engine.WAV_HEADER);
  const want = engine.BYTES_PER_SEC * seconds;
  const copies = Math.ceil(want / pcm.length);
  const looped = Buffer.concat(Array.from({ length: copies }, () => pcm)).subarray(0, want);
  fs.writeFileSync(dest, engine.wavFromPcm(looped));
  return { dest, made: true, seconds };
}

if (require.main === module) {
  if (!fs.existsSync(SOURCE)) {
    console.log(`FALTA ${SOURCE}`);
    process.exit(1);
  }
  for (const seconds of [10, 60]) {
    const r = build(seconds);
    console.log(`${r.made ? 'creado ' : 'ya está'} ${r.dest} (${Math.round(r.seconds)} s)`);
  }
}

module.exports = { build };
