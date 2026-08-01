// One server, one inference. Pure logic, no whisper and no Electron.
//
// The bug this pins was found in production, not in a test: two /inference
// requests in flight at once and whisper-server wedges — sockets open, no CPU,
// no answer, ever. It got there through check-then-act. `busy()` said false,
// the live loop then awaited a model switch, and a full-file transcription
// started in that gap. Both had a request out.
//
// So what is asserted is not "they do not overlap in practice" but that the
// claim cannot be taken twice, including across the await that used to be the
// gap.
const engine = require('../engine');

let fails = 0;
function check(name, got, want = true) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      esperaba ${JSON.stringify(want)}\n      obtuve   ${JSON.stringify(got)}`); }
}

const tick = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // A counter that rises on entry and falls on exit: if two ever run at once,
  // `peak` records it and no amount of ordering luck can hide it.
  let inside = 0, peak = 0;
  const job = async (ms) => {
    inside++; peak = Math.max(peak, inside);
    await tick(ms);
    inside--;
    return 'done';
  };

  check('the server starts free', engine.busy(), false);

  // ---- two exclusives at once: the second refuses rather than waits ----
  const a = engine.tryExclusive(() => job(60));
  const b = engine.tryExclusive(() => job(60));
  check('while one runs, busy() says so', engine.busy());
  check('the second refuses instead of queueing', await b, null);
  check('and the first finishes normally', await a, 'done');
  check('al soltarlo vuelve a estar libre', engine.busy(), false);
  check('nunca hubo dos dentro', peak, 1);

  // ---- the real race: claiming during someone else's await ----
  // This is what happened: the file transcription asks for the turn, and the
  // live loop checks and fires before that one has taken it.
  peak = 0;
  const file = engine.serialize(() => job(80));   // pide turno YA
  const live = engine.tryExclusive(() => job(10));       // in the same tick
  check('the turn is claimed when asked for, not when started', await live, null);
  check('and the file transcription completes', await file, 'done');
  check('without overlapping even once', peak, 1);

  // ---- the reverse order, which is the one that got away ----
  // The first version only tried queue-first. In production it went the other
  // way round: the live loop had a request in the air when the file
  // transcription arrived, the queue looked empty and it started on top. Two
  // requests, a wedged server, 36 minutes of meeting left untranscribed.
  peak = 0;
  const liveFirst = engine.tryExclusive(() => job(80));   // live takes the turn
  const fileAfter = engine.serialize(() => job(10));      // and the file arrives behind it
  check('live took the turn', await liveFirst, 'done');
  check('and the file waited its turn instead of piling on', await fileAfter, 'done');
  check('there were never two requests at once', peak, 1);

  // ---- several queued do not tread on each other ----
  peak = 0;
  const many = await Promise.all([40, 10, 25, 5].map(ms =>
    engine.serialize(() => job(ms))));
  check('the queued ones all complete', many, ['done', 'done', 'done', 'done']);
  check('one at a time, always', peak, 1);

  // ---- a failure does not leave the lock held ----
  await engine.tryExclusive(async () => { throw new Error('boom'); })
    .then(() => { fails++; console.log('FAIL  the error should have propagated'); },
      err => check('a failure propagates', err.message, 'boom'));
  check('and releases the lock on the way down', engine.busy(), false);

  const rejected = await engine.serialize(async () => { throw new Error('nope'); })
    .then(() => 'resolved', e => e.message);
  check('the same for the queue', rejected, 'nope');
  check('the lock is left free', engine.busy(), false);
  check('and the server can still be claimed', await engine.tryExclusive(() => job(1)), 'done');

  console.log(fails ? `\n${fails} failures` : '\nPASS');
  process.exit(fails ? 1 : 0);
})();
