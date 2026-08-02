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
// …on Metal. The first Windows run failed that assertion, and the control
// experiment (build/probe-cuda-variance.js) showed why: on the CUDA build,
// two IDENTICAL full passes differ from each other by up to 34 words on this
// same fixture. "Zero lost against one reference" is not a property any
// transcription of this backend has — the reference itself is one sample of a
// noisy process. So the tolerance is measured, not guessed: two reference
// passes set the backend's own baseline variance, and the head start must sit
// within it. On a deterministic backend the baseline is ~0 and this collapses
// back to the original strict assertion; what it can never absorb is the
// structural failure — a whole dropped window — which stays capped separately.
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
    console.log('skip  the fixture is missing: node build/make-fixtures.js');
    process.exit(0);
  }
  if (!engine.isInstalled() || !engine.hasModel('base')) {
    console.log('skip  the engine is not installed in this checkout');
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
    // ---- where it can get ahead without fighting the live loop ----
    // The two share one server, and asking it for a different model restarts
    // it: hundreds of megabytes off disk every time they alternate. On `steady`
    // live uses `base` while the final pass uses `small`, so getting ahead
    // there would reload the model every few seconds and the live transcript
    // would collapse.
    check('fast gets ahead: both want the same model', engine.canGetAhead('fast'));
    check('modest gets ahead: there is no live loop to interrupt', engine.canGetAhead('modest'));
    check('steady does NOT: base against small on the same server',
      engine.canGetAhead('steady'), false);

    // ---- the answer to beat: one pass, at the end, over the whole file ----
    // Two of them, because on some backends (CUDA) identical passes differ:
    // their disagreement is the noise floor everything below is judged against.
    const atEnd = await engine.transcribeFile(SRC, opts);
    const atEnd2 = await engine.transcribeFile(SRC, opts);
    check('the full pass produces a transcript', atEnd.length > 0);
    console.log(`  · reference: ${atEnd.length} lines from ${totalSec.toFixed(0)}s`);

    // ---- the same recording, transcribed as it arrives ----
    const run = engine.progressive(live, opts);
    growingCopy(live, pcm, 0);
    await run.advance();
    check('with too little audio it gets nothing ahead', run.consumedSec, 0);

    // Grow it the way a meeting does and let the head start keep up.
    for (let sec = 12; sec <= totalSec; sec += 12) {
      growingCopy(live, pcm, Math.min(sec, totalSec));
      await run.advance();
    }
    const headStart = run.consumedSec;
    console.log(`  · done during the meeting: ${headStart}s of ${totalSec.toFixed(0)}s`);
    check('it genuinely got work ahead', headStart > 0);
    check('but never the last window', headStart < totalSec);

    // ---- stop: finish the tail and compare ----
    growingCopy(live, pcm, totalSec);
    const progressive = await engine.transcribeFile(live, { ...opts, from: run.snapshot() });

    const words = a => a.map(l => l.replace(/^\[[^\]]+\]\s*/, '')).join(' ')
      .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
    const bag = ws => ws.reduce((m, w) => (m[w] = (m[w] || 0) + 1, m), {});
    const lostBetween = (ref, out) => {
      const bRef = bag(words(ref)), bOut = bag(words(out));
      let lost = 0, extra = 0;
      for (const w of new Set([...Object.keys(bRef), ...Object.keys(bOut)])) {
        const d = (bOut[w] || 0) - (bRef[w] || 0);
        if (d < 0) lost += -d; else extra += d;
      }
      return { lost, extra };
    };
    const wRef = words(atEnd);

    // The backend's own noise floor: what two identical passes disagree by.
    const floor = lostBetween(atEnd, atEnd2);
    // Judged against whichever reference it lands closer to — both are equally
    // valid transcripts of the same audio.
    const dA = lostBetween(atEnd, progressive);
    const dB = lostBetween(atEnd2, progressive);
    const d = dA.lost + dA.extra <= dB.lost + dB.extra ? dA : dB;
    console.log(`  · backend noise floor: ${floor.lost} lost / ${floor.extra} extra`
      + `  ·  head start: ${d.lost} lost / ${d.extra} extra of ${wRef.length}`);

    // Within the backend's own variance (plus a couple of seam words), and
    // never anywhere near a whole dropped window — that is the structural
    // failure this test exists to catch, and no noise excuses it.
    const windowWords = Math.ceil(wRef.length * (opts.windowSec / totalSec));
    check('the head start loses no more than the backend loses against itself',
      d.lost <= floor.lost + floor.extra + 3);
    check('and stays far from losing a whole window',
      d.lost < Math.max(8, Math.floor(windowWords / 2)));
    // A handful of extra words at a seam is cosmetic; an avalanche would mean
    // the overlap stopped being dropped and everything comes out twice.
    check('nor duplicates beyond noise and the odd seam word',
      d.extra <= floor.lost + floor.extra + Math.ceil(wRef.length * 0.02));

    // ---- stopping has to actually stop ----
    // Without this, a head start running late keeps pushing windows into the
    // same queue the final pass needs — and the wait this came to remove comes
    // back, behind work that is no use to anyone any more.
    const r2 = engine.progressive(live, opts);
    growingCopy(live, pcm, totalSec);
    const inFlight = r2.advance();          // no await: one is left in flight
    await r2.settle();                      // resolves when it lands
    const afterSettle = r2.consumedSec;
    await inFlight.catch(() => { });
    check('settle() waits for the window in flight', r2.consumedSec, afterSettle);

    const before = r2.consumedSec;
    growingCopy(live, pcm, totalSec);
    await r2.advance();
    check('and after settle it gets nothing more ahead', r2.consumedSec, before);

    // ---- a head start that does not match is discarded, not spliced in ----
    // Mixing a head start made with `base` into a pass with `small` leaves a
    // transcript that is half one and half the other: worse than either, and
    // with no sign of it anywhere. Unreachable today because all three tiers
    // end on `small`, but one edit to the tier table away from being real.
    const r3 = engine.progressive(live, { ...opts, model: 'base' });
    growingCopy(live, pcm, totalSec);
    await r3.advance(); await r3.settle();
    check('the head start did take windows', r3.consumedSec > 0);

    const mixed = await engine.transcribeFile(live, { ...opts, model: 'base', from: {
      ...r3.snapshot(), fingerprint: 'otro-modelo'
    } });
    check('with another fingerprint it is dropped and the whole file is done',
      words(mixed).length > 0 && Math.abs(words(mixed).length - wRef.length) <= 3);

    // And a snapshot that runs past the end: lines of audio that no longer exists.
    const shrunk = { ...r3.snapshot(), at: totalSec + 500 };
    const past = await engine.transcribeFile(live, { ...opts, model: 'base', from: shrunk });
    check('a snapshot longer than the recording is dropped too',
      words(past).length > 0 && Math.abs(words(past).length - wRef.length) <= 3);

    // ---- and it still works when nothing was done early ----
    const cold = await engine.transcribeFile(live, opts);
    check('with no head start, the result is the same',
      Math.abs(words(cold).length - wRef.length) <= 3);
  } catch (err) {
    fails++;
    console.log('FAIL  ' + (err.stack || err.message));
  }

  await engine.stop().catch(() => { });
  try { fs.unlinkSync(live); } catch { /* it never existed */ }
  console.log(fails ? `\n${fails} failures` : '\nPASS');
  process.exit(fails ? 1 : 0);
})();
