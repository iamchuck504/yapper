// The transcript is the record, so the cleanup that runs over it has to remove
// the stutters and nothing else. Real speech repeats; decoders repeat
// differently, and the line between them is what these cases pin down.
const engine = require('../engine');

let fails = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      esperaba ${JSON.stringify(want)}\n      obtuve   ${JSON.stringify(got)}`); }
}

const s = engine.undoStutter;

// --- what must be removed ---
check('frase de tres palabras repetida',
  s('I want to be clear I want to be clear about this'), 'I want to be clear about this');
check('repetición al final de la línea',
  s('we ship on Friday we ship on Friday'), 'we ship on Friday');
check('ignora la puntuación al comparar',
  s('That is it. That is it'), 'That is it.');
check('ignora mayúsculas',
  s('Moving on to the budget moving on to the budget now'), 'Moving on to the budget now');
check('una repetición triple queda en una',
  s('let me be clear let me be clear let me be clear'), 'let me be clear');
check('repetición en medio de la frase',
  s('so the plan is the plan is to ship it'), 'so the plan is to ship it');

// --- what must survive ---
check('no toca repeticiones de una palabra', s('no no no'), 'no no no');
check('no toca repeticiones de dos palabras', s('very good very good'), 'very good very good');
check('deja en paz una frase normal',
  s('We agreed to ship the beta on Friday.'), 'We agreed to ship the beta on Friday.');
check('no junta palabras que solo se parecen',
  s('I want to be clear I want to be honest'), 'I want to be clear I want to be honest');
check('texto vacío', s(''), '');
check('una sola palabra', s('hello'), 'hello');

// --- whole transcripts ---
check('quita una línea que repite la anterior',
  engine.deduplicate([
    '[00:00:01] I am not asking you to do it.',
    '[00:00:05] I am not asking you to do it.',
    '[00:00:09] Anyway, moving on.'
  ]),
  ['[00:00:01] I am not asking you to do it.', '[00:00:09] Anyway, moving on.']);

check('conserva la primera marca, no la segunda',
  engine.deduplicate([
    '[00:00:01] we ship on Friday',
    '[00:00:04] we ship on Friday'
  ]),
  ['[00:00:01] we ship on Friday']);

// Seconds apart, this is the window seam: the same words re-emitted with more
// after them. Stripping the repeat leaves the sentence readable across the two
// lines, which is what it actually was.
check('a segundos de distancia lo trata como costura',
  engine.deduplicate([
    '[00:00:01] we ship on Friday',
    '[00:00:05] we ship on Friday if the tests pass'
  ]),
  ['[00:00:01] we ship on Friday', '[00:00:05] if the tests pass']);

// Half a minute later it is a person restating it, and that belongs in the record.
check('medio minuto después lo deja intacto',
  engine.deduplicate([
    '[00:00:01] we ship on Friday',
    '[00:00:40] we ship on Friday if the tests pass'
  ]),
  ['[00:00:01] we ship on Friday', '[00:00:40] we ship on Friday if the tests pass']);

check('una línea idéntica muy posterior también se conserva',
  engine.deduplicate([
    '[00:00:01] I am not asking you to do it.',
    '[00:05:00] I am not asking you to do it.'
  ]),
  ['[00:00:01] I am not asking you to do it.', '[00:05:00] I am not asking you to do it.']);

check('limpia dentro de cada línea también',
  engine.deduplicate(['[00:00:01] I want to be clear I want to be clear about this']),
  ['[00:00:01] I want to be clear about this']);

check('descarta una línea que queda vacía',
  engine.deduplicate(['[00:00:01]   ', '[00:00:05] real content here']),
  ['[00:00:05] real content here']);

check('una transcripción limpia no cambia',
  engine.deduplicate(['[00:00:01] First thing.', '[00:00:05] Second thing.']),
  ['[00:00:01] First thing.', '[00:00:05] Second thing.']);

// --- the seam: the real case, from 2026-07-12_2058 ---
check('quita la repetición en la costura entre dos líneas',
  engine.deduplicate([
    "[00:00:14] duplicate and we're trying to do that because he's like",
    "[00:00:18] he's like making like $10 million a year doing it"
  ]),
  ["[00:00:14] duplicate and we're trying to do that because he's like",
    '[00:00:18] making like $10 million a year doing it']);

check('la costura no se lleva la línea entera',
  engine.deduplicate([
    '[00:00:01] so there is a',
    '[00:00:02] there is a phase one right'
  ]),
  ['[00:00:01] so there is a', '[00:00:02] phase one right']);

check('una sola palabra en común no es una costura',
  engine.deduplicate([
    '[00:00:01] we talked about the plan',
    '[00:00:05] plan for next quarter'
  ]),
  ['[00:00:01] we talked about the plan', '[00:00:05] plan for next quarter']);

check('no vacía una línea que es toda ella la repetición',
  engine.deduplicate([
    '[00:00:01] we ship on Friday',
    '[00:00:05] on Friday'
  ]),
  ['[00:00:01] we ship on Friday', '[00:00:05] on Friday']);

// the six-times-in-a-row case that started all of this
check('el caso real: la misma frase seis veces',
  engine.deduplicate(Array.from({ length: 6 }, (_, i) =>
    `[00:00:${String(i * 5).padStart(2, '0')}] I'm not asking you to do it. I actually very much`)),
  ["[00:00:00] I'm not asking you to do it. I actually very much"]);

console.log(fails ? `\n${fails} fallos` : '\nPASS');
process.exit(fails ? 1 : 0);
