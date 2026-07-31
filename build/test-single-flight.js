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

  check('el servidor empieza libre', engine.busy(), false);

  // ---- dos exclusivos a la vez: el segundo se rehúsa, no espera ----
  const a = engine.tryExclusive(() => job(60));
  const b = engine.tryExclusive(() => job(60));
  check('mientras uno corre, busy() lo dice', engine.busy());
  check('el segundo se rehúsa en vez de encolarse', await b, null);
  check('y el primero termina normal', await a, 'done');
  check('al soltarlo vuelve a estar libre', engine.busy(), false);
  check('nunca hubo dos dentro', peak, 1);

  // ---- la carrera de verdad: reclamar durante el await de otro ----
  // Esto es lo que pasaba: la transcripción de archivo pide el turno, y el
  // bucle en vivo consulta y dispara antes de que aquella lo tome.
  peak = 0;
  const file = engine.serialize(() => job(80));   // pide turno YA
  const live = engine.tryExclusive(() => job(10));       // en el mismo tick
  check('el turno se reserva al pedirlo, no al empezar', await live, null);
  check('y la transcripción de archivo completa', await file, 'done');
  check('sin solaparse ni una vez', peak, 1);

  // ---- el orden inverso, que es el que se escapó ----
  // La primera versión sólo probaba cola-primero. En producción pasó al revés:
  // el bucle en vivo tenía una petición en el aire cuando llegó la
  // transcripción de archivo, la cola parecía vacía y arrancó encima. Dos
  // peticiones, servidor trabado, 36 minutos de reunión sin transcribir.
  peak = 0;
  const liveFirst = engine.tryExclusive(() => job(80));   // el vivo toma el turno
  const fileAfter = engine.serialize(() => job(10));      // y el archivo llega detrás
  check('el vivo tomó el turno', await liveFirst, 'done');
  check('y el archivo esperó su turno en vez de encimarse', await fileAfter, 'done');
  check('nunca hubo dos peticiones a la vez', peak, 1);

  // ---- varias en cola no se pisan entre ellas ----
  peak = 0;
  const many = await Promise.all([40, 10, 25, 5].map(ms =>
    engine.serialize(() => job(ms))));
  check('las encoladas todas completan', many, ['done', 'done', 'done', 'done']);
  check('una a la vez, siempre', peak, 1);

  // ---- un fallo no deja el candado tomado ----
  await engine.tryExclusive(async () => { throw new Error('boom'); })
    .then(() => { fails++; console.log('FAIL  el error debía propagarse'); },
      err => check('un fallo se propaga', err.message, 'boom'));
  check('y suelta el candado al caer', engine.busy(), false);

  const rejected = await engine.serialize(async () => { throw new Error('nope'); })
    .then(() => 'resolvió', e => e.message);
  check('lo mismo para la cola', rejected, 'nope');
  check('el candado queda libre', engine.busy(), false);
  check('y el servidor sigue tomable', await engine.tryExclusive(() => job(1)), 'done');

  console.log(fails ? `\n${fails} fallos` : '\nPASS');
  process.exit(fails ? 1 : 0);
})();
