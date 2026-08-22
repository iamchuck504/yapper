// The two-track transcription branch, driven through the real app: a meeting
// folder that already holds per-side tracks (mic speaks 0-20 s, far side
// 20-40 s) is transcribed through the real IPC, and the transcript must come
// back labelled, ordered, free of hallucinated words in the silent stretches,
// and with the audio released.
//
// Run with: npx electron build/test-two-track-app.js
// (needs the engine installed; the deterministic fixture is made on demand)
const path = require('path');
const os = require('os');
const fs = require('fs');
const { app } = require('electron');

const { sandbox, logger, mainWindow, watchdog } = require('./harness');
const engine = require('../engine');

const root = sandbox('two-track-app');
const say = logger(root);

let fails = 0;
function check(name, ok, detail = '') {
  if (ok) say(`ok    ${name}`);
  else { fails++; say(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`); }
}

require('../main.js');

const dog = watchdog(say);

app.whenReady().then(async () => {
  try {
    const win = await mainWindow();
    const $ = js => win.webContents.executeJavaScript(js);

    // A meeting folder with per-side tracks, made from the JFK fixture.
    const SRC = path.join(os.tmpdir(), 'yapper-60s.wav');
    if (!fs.existsSync(SRC)) require('./make-fixtures').build(60);
    const pcm = fs.readFileSync(SRC).subarray(engine.WAV_HEADER);
    const BPS = engine.BYTES_PER_SEC;
    const sec = (a, b) => pcm.subarray(a * BPS, b * BPS);
    const silence = s => Buffer.alloc(s * BPS);

    const folder = path.join(root, 'Meetings', '2026-08-10_1200');
    fs.mkdirSync(folder, { recursive: true });
    const mic = Buffer.concat([sec(0, 20), silence(40)]);
    const sys = Buffer.concat([silence(20), sec(20, 40), silence(20)]);
    fs.writeFileSync(path.join(folder, 'recording.mic.wav'), engine.wavFromPcm(mic));
    fs.writeFileSync(path.join(folder, 'recording.sys.wav'), engine.wavFromPcm(sys));
    fs.writeFileSync(path.join(folder, 'recording.wav'),
      engine.wavFromPcm(require('../sysaudio').mixPcm(mic, sys)));

    const transcript = await $(`window.yapper.transcribe(${JSON.stringify(folder)})`);
    say('--- transcript ---\n' + transcript + '\n------------------');

    const lines = transcript.split('\n');
    const labelled = lines.filter(l => / (?:Me|Them|Speaker [1-9]\d*): /.test(l));
    check('every line is labelled', labelled.length === lines.length,
      `${labelled.length} of ${lines.length}`);
    const secOf = l => { const m = l.match(/^\[(\d+):(\d\d):(\d\d)\]/); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0; };
    // Tighter than a courtesy margin: anything past it is a word conjured out
    // of the silent stretch of that side's track.
    check('Me speaks only in the first 22 s',
      lines.filter(l => l.includes(' Me: ')).every(l => secOf(l) <= 22));
    const remoteLines = lines.filter(l => / (?:Them|Speaker [1-9]\d*): /.test(l));
    check('remote speakers speak only between 18 and 42 s',
      remoteLines.every(l => secOf(l) >= 18 && secOf(l) <= 42));
    check('both sides made it in',
      lines.some(l => l.includes(' Me: ')) && remoteLines.length > 0);
    check('the merge is time-ordered',
      lines.every((l, i) => !i || secOf(l) >= secOf(lines[i - 1])));

    check('transcript.txt was written',
      fs.readFileSync(path.join(folder, 'transcript.txt'), 'utf8') === transcript);
    check('the immutable speaker-labelled source was written',
      fs.readFileSync(path.join(folder, 'transcript.raw.txt'), 'utf8') === transcript);
    check('all three audio files were released',
      !fs.readdirSync(folder).some(f => /^recording\./i.test(f)),
      fs.readdirSync(folder).join(', '));
  } catch (err) {
    fails++;
    say(`FAIL  ${err.message}`);
  }
  clearTimeout(dog);
  say(fails ? `\n${fails} failures` : '\nPASS');
  app.exit(fails ? 1 : 0);
});
