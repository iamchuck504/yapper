// What happens when whisper-server accepts a request and never answers.
//
// This is not hypothetical. It happened twice in one day: sockets open, the
// server burning no CPU, no reply ever, and the app sitting on "Transcribing…"
// for as long as anyone was willing to look at it. A 36-minute meeting went
// untranscribed until someone read `lsof` and killed a process — which is not
// a recovery path anyone else has.
//
// The race that caused it is fixed. A server can still wedge for reasons of
// its own, so what is pinned here is the floor beneath that: a request that
// does not answer has to end, say so, and leave things in a state the next
// attempt can work from.
//
// Driven against a fake server rather than whisper, because the point is the
// app's behaviour when the far side goes quiet — and a real wedge cannot be
// summoned on demand.
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

let fails = 0;
function check(name, got, want = true) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      esperaba ${JSON.stringify(want)}\n      obtuve   ${JSON.stringify(got)}`); }
}

// A server that takes the request and goes silent, exactly like the real one did.
let hits = 0;
const wedged = http.createServer(req => { hits++; req.resume(); /* and nothing */ });

wedged.listen(0, '127.0.0.1', async () => {
  const port = wedged.address().port;

  // engine.js talks to whatever port it started a server on, so it is pointed
  // at this one through its own internals rather than by faking a process.
  const engine = require('../engine');
  engine.__pointAtServer({ killed: false }, port);

  const WAV_HEADER = 44;
  const secondsOfSilence = n => {
    const b = Buffer.alloc(WAV_HEADER + n * 32000);
    b.write('RIFF', 0); b.write('WAVE', 8);
    return b;
  };

  try {
    // ---- the deadline comes from what the machine measured, not a blind multiple ----
    // The first version gave four times real time, which sounded prudent and
    // was useless: a two-minute window takes ~3 s on a calibrated machine and
    // was handed eight minutes. A wedge should cost seconds.
    const wav = n => Buffer.alloc(44 + n * 32000);

    engine.setPace(0);                       // nothing measured yet
    const blind = engine.deadlineFor(wav(120), 'small');
    check('unmeasured, it falls back to the loose budget', blind, 480000);

    engine.setPace(111);                     // what this Mac measured
    const cold = engine.deadlineFor(wav(120), 'small');
    check('measured, the deadline tightens a great deal', cold < blind / 10);
    check('but leaves room to spare over the real ~3 s', cold > 20000);

    // `base` costs less than `small`, and the deadline reflects it
    check('a cheaper model asks for less time',
      engine.deadlineFor(wav(120), 'base') < cold);

    // and it scales with the audio: a live window is not a final one
    check('ten seconds of audio ask less than a hundred and twenty',
      engine.deadlineFor(wav(10), 'small') < engine.deadlineFor(wav(120), 'small'));

    // The floor is 60 s and the budget scales with the audio, so a short clip
    // is used with the deadline overridden — waiting a real minute to prove a
    // timeout works is its own kind of hang.
    engine.__setDeadline(1200);

    const t = Date.now();
    let err = null;
    try { await engine.transcribeWav(secondsOfSilence(2)); }
    catch (e) { err = e; }
    const waited = Date.now() - t;

    check('the request ends instead of waiting forever', !!err);
    check('and says it timed out, not something generic', /timed out/i.test(err ? err.message : ''));
    check('within the deadline, not long after it', waited < 4000);
    check('the server did receive it', hits >= 1);

    // The message has to be one the file transcription recognises, or the
    // retry that restarts the server never runs and a single wedged window
    // takes the whole transcript with it.
    const retryable = /ECONNRESET|ECONNREFUSED|socket hang up|not running|timed out/i;
    check('the message triggers the retry that restarts the engine',
      retryable.test(err ? err.message : ''));

    // And the wedged server is let go, so the next attempt gets a fresh one
    // instead of queueing behind a corpse.
    check('the wedged engine is given up for dead', engine.loaded(), null);
    // ---- and what actually matters: does a real transcript survive? ----
    // An engine that wedges halfway should not cost the whole meeting. The
    // per-window retry already restarted the server on a dropped connection;
    // what was missing was silence counting as a drop.
    const real = path.join(os.tmpdir(), 'yapper-wedge-e2e.wav');
    if (fs.existsSync(path.join(__dirname, 'calibration.wav'))) {
      const src = fs.readFileSync(path.join(__dirname, 'calibration.wav'));
      fs.writeFileSync(real, src);
      engine.__pointAtServer(null, 0);        // let the fake one go
      engine.__setDeadline(0);                // presupuesto normal otra vez

      if (engine.isInstalled() && engine.hasModel('base')) {
        const lines = await engine.transcribeFile(real, { model: 'base', language: 'en' });
        check('with the real engine, a transcript comes out whole', lines.length > 0);
        await engine.stop();
      } else {
        console.log('skip  the real engine is not installed in this checkout');
      }
    }
  } catch (e) {
    fails++;
    console.log('FAIL  ' + (e.stack || e.message));
  }

  wedged.close();
  console.log(fails ? `\n${fails} failures` : '\nPASS');
  process.exit(fails ? 1 : 0);
});
