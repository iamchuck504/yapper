// The confirmation rules decide what the user sees and can never take back, so
// they get tested directly instead of only through a whole replay.
const live = require('../live');

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed++; console.log(`FAIL  ${name}\n      esperaba ${JSON.stringify(want)}, obtuve ${JSON.stringify(got)}`); }
  else console.log(`ok    ${name}`);
}

const w = (...texts) => texts.map((t, i) => ({ text: t, start: i, end: i + 1 }));

// --- commonPrefix ---------------------------------------------------------
check('prefijo idéntico', live.commonPrefix(w('I', 'want', 'to'), w('I', 'want', 'to')), 3);
check('prefijo parcial', live.commonPrefix(w('I', 'want', 'to'), w('I', 'want', 'go')), 2);
check('sin prefijo', live.commonPrefix(w('you', 'want'), w('I', 'want')), 0);
check('mayúsculas y puntuación pegada dan igual',
  live.commonPrefix(w('I', 'Want,', 'to'), w('i', 'want', 'to')), 3);
// the bug that kept agreement at zero: a stray comma token between the words
check('un token de puntuación suelto no rompe el acuerdo',
  live.commonPrefix(w('I', ',', 'want', 'to'), w('I', 'want', 'to')), 4);
check('prefijo vacío contra nada', live.commonPrefix(w('I'), []), 0);

// --- overlapWith ----------------------------------------------------------
check('repetición exacta se recorta',
  live.overlapWith(['i', 'want', 'to'], w('to', 'be', 'clear')), 1);
check('repetición de tres palabras',
  live.overlapWith(['that', 'said', 'though'], w('that', 'said', 'though', 'I')), 3);
check('sin repetición no recorta nada',
  live.overlapWith(['i', 'want'], w('completely', 'different')), 0);
check('recorta también la puntuación arrastrada',
  live.overlapWith(['said', 'though'], w('said', 'though', ',', 'I')), 2);

// --- isDegenerate ---------------------------------------------------------
check('texto normal no es degenerado',
  live.isDegenerate(w('I', 'want', 'to', 'be', 'clear', 'about', 'this'), 4), false);
check('la misma palabra cinco veces sí lo es',
  live.isDegenerate(w('the', 'the', 'the', 'the', 'the', 'the'), 4), true);
check('demasiadas palabras por segundo es alucinación',
  live.isDegenerate(w(...Array.from({ length: 60 }, (_, i) => `w${i}`)), 5), true);
check('esas mismas palabras en su tiempo real están bien',
  live.isDegenerate(w(...Array.from({ length: 60 }, (_, i) => `w${i}`)), 30), false);

// --- tailRms --------------------------------------------------------------
const silence = Buffer.alloc(16000 * 2);
check('el silencio mide cero', live.tailRms(silence, 1.5), 0);
const loud = Buffer.alloc(16000 * 2);
for (let i = 0; i < 16000; i++) loud.writeInt16LE(8000, i * 2);
check('el audio con nivel supera el umbral', live.tailRms(loud, 1.5) > 0.004, true);

console.log(failed ? `\n${failed} fallos` : '\nPASS');
process.exit(failed ? 1 : 0);
