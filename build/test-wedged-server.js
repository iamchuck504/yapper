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
    // The floor is 60 s and the budget scales with the audio, so a short clip
    // is used with the deadline overridden — waiting a real minute to prove a
    // timeout works is its own kind of hang.
    engine.__setDeadline(1200);

    const t = Date.now();
    let err = null;
    try { await engine.transcribeWav(secondsOfSilence(2)); }
    catch (e) { err = e; }
    const waited = Date.now() - t;

    check('la petición termina en vez de esperar para siempre', !!err);
    check('y dice que expiró, no algo genérico', /timed out/i.test(err ? err.message : ''));
    check('dentro del plazo, no mucho después', waited < 4000);
    check('el servidor sí llegó a recibirla', hits >= 1);

    // The message has to be one the file transcription recognises, or the
    // retry that restarts the server never runs and a single wedged window
    // takes the whole transcript with it.
    const retryable = /ECONNRESET|ECONNREFUSED|socket hang up|not running|timed out/i;
    check('el mensaje dispara el reintento que reinicia el motor',
      retryable.test(err ? err.message : ''));

    // And the wedged server is let go, so the next attempt gets a fresh one
    // instead of queueing behind a corpse.
    check('el motor colgado se da por muerto', engine.loaded(), null);
    // ---- y lo que de verdad importa: ¿sobrevive un transcript real? ----
    // Un motor que se traba a mitad no debe costar la reunión entera. El
    // reintento por ventana ya reiniciaba el servidor ante caídas de conexión;
    // lo que faltaba era que un silencio contara como caída.
    const real = path.join(os.tmpdir(), 'yapper-wedge-e2e.wav');
    if (fs.existsSync(path.join(__dirname, 'calibration.wav'))) {
      const src = fs.readFileSync(path.join(__dirname, 'calibration.wav'));
      fs.writeFileSync(real, src);
      engine.__pointAtServer(null, 0);        // suelta el falso
      engine.__setDeadline(0);                // presupuesto normal otra vez

      if (engine.isInstalled() && engine.hasModel('base')) {
        const lines = await engine.transcribeFile(real, { model: 'base', language: 'en' });
        check('con el motor real, un transcript sale completo', lines.length > 0);
        await engine.stop();
      } else {
        console.log('skip  el motor real no está instalado en este checkout');
      }
    }
  } catch (e) {
    fails++;
    console.log('FAIL  ' + (e.stack || e.message));
  }

  wedged.close();
  console.log(fails ? `\n${fails} fallos` : '\nPASS');
  process.exit(fails ? 1 : 0);
});
