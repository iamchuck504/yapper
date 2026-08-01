// Transcribing while the meeting is still going.
//
// The wait at the end of a long meeting is almost all transcription — 50
// seconds for 36 minutes — and none of it needs the meeting to be over. So the
// windows are taken as the audio arrives.
//
// The assertion that matters is not "it was faster", it is that the transcript
// is not made worse to get there.
//
// It was written first as "identical to a single pass", and that is not a
// sound invariant — it passed here and failed one round in eighteen under
// randomised interleavings. The reason is whisper-server: the same request
// gives a different answer depending on which requests preceded it. Measured
// directly, and not fixable from the flags — `-mc 0`, dropping
// `--carry-initial-prompt`, and `-nth 1` all behave the same way.
//
// That is not something the head start introduced. Today's pass at the end
// already runs on a server that has just answered the live loop a few hundred
// times, so there has never been a pristine reference to be identical to.
//
// So what is asserted is what actually matters and is actually true: **no
// words are lost**. Across eighteen randomised rounds, sixteen came out byte
// for byte identical, one differed only in where a segment was cut, and one
// duplicated a single word at a seam out of 311. Zero lost, ever.
//
// The hazard is one line of the window loop: a window drops any segment
// beginning inside its overlap, unless it is the last window. Take a window
// early while it happens to be the last one available, and the audio in that
// overlap is emitted twice. So the head start only takes a window when a full
// window plus its overlap of audio already sits behind it.
const fs = require('fs');
const path = require('path');
const os = require('os');
const engine = require('../engine');

let fails = 0;
function check(name, got, want = true) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      esperaba ${JSON.stringify(want)}\n      obtuve   ${JSON.stringify(got)}`); }
}

const SRC = path.join(os.tmpdir(), 'yapper-60s.wav');
const HDR = engine.WAV_HEADER;

/** A recording that grows, the way one does while someone is talking. */
function growingCopy(dest, pcm, seconds) {
  const head = Buffer.alloc(HDR);
  head.write('RIFF', 0); head.write('WAVE', 8);
  fs.writeFileSync(dest, Buffer.concat([head, pcm.subarray(0, Math.floor(seconds * 32000))]));
}

(async () => {
  if (!fs.existsSync(SRC)) {
    console.log('skip  falta el fixture: node build/make-fixtures.js');
    process.exit(0);
  }
  if (!engine.isInstalled() || !engine.hasModel('base')) {
    console.log('skip  el motor no está instalado en este checkout');
    process.exit(0);
  }

  const whole = fs.readFileSync(SRC);
  const pcm = whole.subarray(HDR);
  const totalSec = pcm.length / 32000;

  // Short windows, or a 60-second fixture is a single window and the seam —
  // the only place this can go wrong — never gets exercised.
  const opts = { model: 'base', language: 'en', windowSec: 10, overlapSec: 2 };
  const live = path.join(os.tmpdir(), 'yapper-progressive.wav');

  try {
    // ---- the answer to beat: one pass, at the end, over the whole file ----
    const atEnd = await engine.transcribeFile(SRC, opts);
    check('la pasada completa produce transcript', atEnd.length > 0);
    console.log(`  · referencia: ${atEnd.length} líneas de ${totalSec.toFixed(0)}s`);

    // ---- the same recording, transcribed as it arrives ----
    const run = engine.progressive(live, opts);
    growingCopy(live, pcm, 0);
    await run.advance();
    check('sin audio suficiente no adelanta nada', run.consumedSec, 0);

    // Grow it the way a meeting does and let the head start keep up.
    for (let sec = 12; sec <= totalSec; sec += 12) {
      growingCopy(live, pcm, Math.min(sec, totalSec));
      await run.advance();
    }
    const headStart = run.consumedSec;
    console.log(`  · adelantado durante la reunión: ${headStart}s de ${totalSec.toFixed(0)}s`);
    check('adelantó trabajo de verdad', headStart > 0);
    check('pero nunca la última ventana', headStart < totalSec);

    // ---- stop: finish the tail and compare ----
    growingCopy(live, pcm, totalSec);
    const progressive = await engine.transcribeFile(live, { ...opts, from: run.snapshot() });

    const words = a => a.map(l => l.replace(/^\[[^\]]+\]\s*/, '')).join(' ')
      .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
    const bag = ws => ws.reduce((m, w) => (m[w] = (m[w] || 0) + 1, m), {});
    const wRef = words(atEnd), wOut = words(progressive);
    const bRef = bag(wRef), bOut = bag(wOut);
    let lost = 0, extra = 0;
    for (const w of new Set([...wRef, ...wOut])) {
      const d = (bOut[w] || 0) - (bRef[w] || 0);
      if (d < 0) lost += -d; else extra += d;
    }
    check('el adelanto no pierde ni una palabra', lost, 0);
    // Un puñado de palabras de más en una costura es cosmético; una avalancha
    // significaría que el solape dejó de descartarse y todo sale doble.
    check('ni duplica más que alguna suelta en una costura', extra <= Math.ceil(wRef.length * 0.02));
    if (progressive.join('\n') !== atEnd.join('\n')) {
      console.log(`  · segmentación distinta: ${lost} perdidas, ${extra} de más de ${wRef.length}`);
    }

    // ---- parar tiene que parar de verdad ----
    // Sin esto, un adelanto con retraso sigue metiendo ventanas en la misma
    // cola que necesita la pasada final — y la espera que esto vino a quitar
    // vuelve, detrás de trabajo que ya no le sirve a nadie.
    const r2 = engine.progressive(live, opts);
    growingCopy(live, pcm, totalSec);
    const inFlight = r2.advance();          // sin await: queda una en vuelo
    await r2.settle();                      // resuelve cuando aterriza
    const afterSettle = r2.consumedSec;
    await inFlight.catch(() => { });
    check('settle() espera a la ventana en vuelo', r2.consumedSec, afterSettle);

    const before = r2.consumedSec;
    growingCopy(live, pcm, totalSec);
    await r2.advance();
    check('y despues de settle ya no adelanta mas', r2.consumedSec, before);

    // ---- un adelanto que no corresponde se descarta, no se empalma ----
    // Mezclar un adelanto hecho con `base` en una pasada con `small` deja un
    // transcript mitad y mitad: peor que cualquiera de los dos, y sin señal
    // alguna. Hoy no es alcanzable porque los tres tiers terminan con `small`,
    // pero está a una edición de la tabla de tiers de serlo.
    const r3 = engine.progressive(live, { ...opts, model: 'base' });
    growingCopy(live, pcm, totalSec);
    await r3.advance(); await r3.settle();
    check('el adelanto llegó a hacer ventanas', r3.consumedSec > 0);

    const mixed = await engine.transcribeFile(live, { ...opts, model: 'base', from: {
      ...r3.snapshot(), fingerprint: 'otro-modelo'
    } });
    check('con otra huella, se descarta y se hace el archivo entero',
      words(mixed).length > 0 && Math.abs(words(mixed).length - wRef.length) <= 3);

    // Y una foto que va más allá del final: líneas de audio que ya no existe.
    const shrunk = { ...r3.snapshot(), at: totalSec + 500 };
    const past = await engine.transcribeFile(live, { ...opts, model: 'base', from: shrunk });
    check('una foto más larga que la grabación también se descarta',
      words(past).length > 0 && Math.abs(words(past).length - wRef.length) <= 3);

    // ---- and it still works when nothing was done early ----
    const cold = await engine.transcribeFile(live, opts);
    check('sin adelanto, el resultado es el mismo',
      Math.abs(words(cold).length - wRef.length) <= 3);
  } catch (err) {
    fails++;
    console.log('FAIL  ' + (err.stack || err.message));
  }

  await engine.stop().catch(() => { });
  try { fs.unlinkSync(live); } catch { /* nunca existió */ }
  console.log(fails ? `\n${fails} fallos` : '\nPASS');
  process.exit(fails ? 1 : 0);
})();
