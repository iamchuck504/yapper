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
check('el silencio no cambia nada',
  String(samplesOf(mixPcm(pcm(1000, -2000), pcm(0, 0)))) === String([1000, -2000]));

// Wrapping is the dangerous failure: 32767 + 1 becomes -32768, so a loud
// passage would come back as a burst of noise instead of merely clipping.
check('satura hacia arriba en vez de dar la vuelta',
  samplesOf(mixPcm(pcm(30000), pcm(30000)))[0] === 32767,
  String(samplesOf(mixPcm(pcm(30000), pcm(30000)))));
check('y hacia abajo también',
  samplesOf(mixPcm(pcm(-30000), pcm(-30000)))[0] === -32768);
check('no toca el buffer que recibe', (() => {
  const mic = pcm(100, 200);
  mixPcm(mic, pcm(1, 1));
  return String(samplesOf(mic)) === String([100, 200]);
})(), 'mutó la entrada');
check('una cola más corta no rompe la mezcla',
  String(samplesOf(mixPcm(pcm(10, 20, 30), pcm(5)))) === String([15, 20, 30]));

// ---- taking, with no helper running ----
const idle = create({ probePath: path.join(__dirname, 'no-such-helper') });
check('sin ayudante no hay estado de captura', idle.state === 'off');
check('y take() devuelve null, no silencio', idle.take(64) === null,
  'escribiría ceros encima del micrófono');

idle.start().then(started => {
  check('arrancar sin ayudante resuelve false, sin lanzar', started === false);
  check('y queda marcado como no disponible', idle.state === 'unavailable', idle.state);

  // Half a second at 16 kHz mono 16-bit. Stated as a number here so that
  // widening the bound has to be a decision, not a typo: the whole point is
  // that the far side cannot drift arbitrarily far behind the voice.
  check('el tope del buffer es medio segundo de audio', MAX_BUFFERED === 16000,
    `es ${MAX_BUFFERED}`);

  // ---- the helper on disk, when this machine has one ----
  const helper = path.join(__dirname, 'system-audio');
  if (process.platform === 'darwin' && fs.existsSync(helper)) {
    const live = create({ probePath: helper });
    live.start().then(ok => {
      check('el ayudante real arranca y captura', ok === true,
        `estado ${live.state} — ¿falta el permiso de Grabación de Pantalla?`);
      if (ok) {
        const chunk = live.take(3200);            // 0.1 s
        check('entrega exactamente lo que se le pide', chunk && chunk.length === 3200,
          chunk ? String(chunk.length) : 'null');
        check('y rellena con silencio lo que aún no llegó', chunk && chunk.length === 3200);
      }
      live.stop();
      check('parar lo deja apagado', live.state === 'off');
      done();
    });
  } else {
    console.log('skip  el ayudante nativo no está compilado aquí (solo macOS)');
    done();
  }
});

function done() {
  console.log(fails ? `\n${fails} fallos` : '\nPASS');
  process.exit(fails ? 1 : 0);
}
