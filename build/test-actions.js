// Action items are pulled out of the notes and shown as facts about a meeting,
// so the parsing must not invent an owner or a date that nobody wrote, and the
// duplicate detection must not merge two different tasks into one.
const a = require('../actions');

let fails = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      esperaba ${JSON.stringify(want)}\n      obtuve   ${JSON.stringify(got)}`); }
}

// ---------------------------------------------------------------- parsing

const NOTES = `## Summary [00:01]
It went fine.

## Action items [00:20]
- Ninfa: prepare the rollout plan by Friday
- **Chuck** — review the pricing deck
- Send the contract to legal
- Richard: sign off on the budget by March 3
- URGENT: fix the login bug

## Open questions [02:40]
- Nothing outstanding.
`;

const items = a.parseActionItems(NOTES, { folder: 'C:/M/2026-07-30_1000', title: 'Launch Sync', date: '2026-07-30' });
check('saca un item por viñeta', items.length, 5);
check('lee el responsable escrito con dos puntos', items[0].owner, 'Ninfa');
check('lee el responsable en negrita con guion', items[1].owner, 'Chuck');
check('no inventa responsable cuando no hay', items[2].owner, '');
check('lee la fecha escrita', items[0].due, 'Friday');
check('lee una fecha con mes y día', items[3].due, 'March 3');
check('no inventa fecha cuando no hay', items[1].due, '');
check('quita la fecha del texto', items[0].text, 'prepare the rollout plan');
check('marca la prioridad solo si se dice', [items[4].priority, items[2].priority], ['high', 'normal']);
check('recuerda de qué reunión salió', items[0].meeting, 'Launch Sync');
check('quita el markdown del texto', items[1].text, 'review the pricing deck');

check('ignora "No action items recorded."',
  a.parseActionItems('## Action items\n- No action items recorded.\n').length, 0);
check('no lee de otras secciones',
  a.parseActionItems('## Key points\n- Ninfa: this is not a task\n').length, 0);
check('encuentra la sección aunque se llame distinto',
  a.parseActionItems('## Commitments\n- Send the quote\n').length, 1);
check('también "Next steps"',
  a.parseActionItems('## Next steps\n- Book the room\n').length, 1);
check('unas notas sin secciones no dan items', a.parseActionItems('just a paragraph').length, 0);
check('notas vacías', a.parseActionItems('').length, 0);

// a sentence with a colon is not an owner
check('una frase con dos puntos no es un responsable',
  a.splitOwner('Decide the following: whether to ship').owner, '');
check('tampoco un verbo al inicio',
  a.splitOwner('Review the deck: it needs work').owner, '');

// ---------------------------------------------------------------- duplicates

const same = (x, y) => a.isDuplicate({ text: x, owner: '' }, { text: y, owner: '' });

check('el mismo texto es duplicado',
  same('prepare the rollout plan', 'prepare the rollout plan'), true);
check('reformulado también',
  same('prepare the rollout plan', 'prepare a rollout plan'), true);
check('con palabras de relleno distintas',
  same('send the contract to legal', 'send contract to legal team'), true);
check('dos tareas distintas NO son duplicado',
  same('prepare the rollout plan', 'review the pricing deck'), false);
check('mismo verbo pero objeto distinto',
  same('send the contract to legal', 'send the invoice to finance'), false);

check('responsables distintos no se unen',
  a.isDuplicate({ text: 'review the deck', owner: 'Ninfa' }, { text: 'review the deck', owner: 'Chuck' }), false);
check('si uno no tiene responsable, sí',
  a.isDuplicate({ text: 'review the deck', owner: '' }, { text: 'review the deck', owner: 'Chuck' }), true);
check('un nombre completo coincide con el de pila',
  a.isDuplicate({ text: 'review the deck', owner: 'Ninfa' }, { text: 'review the deck', owner: 'Ninfa Ursula' }), true);

// ---------------------------------------------------------------- merging

const first = a.mergeActionItems([], [
  { text: 'prepare the rollout plan', owner: 'Ninfa', due: '', folder: 'f1', meeting: 'Planning' }
], 1000);
check('el primero se añade', [first.added, first.merged], [1, 0]);
check('guarda su reunión de origen', first.list[0].sources, ['f1']);

const second = a.mergeActionItems(first.list, [
  { text: 'prepare a rollout plan', owner: '', due: 'Friday', folder: 'f2', meeting: 'Standup' }
], 2000);
check('el mismo pendiente en otra reunión no se duplica', [second.added, second.merged], [0, 1]);
check('acumula las dos reuniones', second.list[0].sources, ['f1', 'f2']);
check('rellena la fecha que faltaba', second.list[0].due, 'Friday');
check('conserva el responsable que ya tenía', second.list[0].owner, 'Ninfa');
check('sigue habiendo una sola fila', second.list.length, 1);

const third = a.mergeActionItems(second.list, [
  { text: 'review the pricing deck', owner: 'Chuck', due: '', folder: 'f2', meeting: 'Standup' }
], 3000);
check('una tarea nueva sí se añade', [third.added, third.merged], [1, 0]);
check('quedan dos', third.list.length, 2);

const urgent = a.mergeActionItems(third.list, [
  { text: 'prepare the rollout plan', owner: 'Ninfa', due: '', folder: 'f3', priority: 'high' }
], 4000);
check('si luego se marca urgente, sube', urgent.list[0].priority, 'high');

// what is already checked off must not be resurrected as new
const done = a.mergeActionItems(
  [{ text: 'send the contract to legal', owner: '', done: true, sources: ['f1'] }],
  [{ text: 'send contract to legal', owner: '', folder: 'f9' }], 5000);
check('un pendiente ya hecho no reaparece como nuevo', [done.added, done.merged], [0, 1]);
check('y sigue marcado como hecho', done.list[0].done, true);

// the old reminders, which have none of the new fields, must survive contact
const legacy = a.mergeActionItems(
  [{ id: 'x', text: 'call the bank', done: false, source: '', createdAt: 1 }],
  [{ text: 'book the venue', owner: '', folder: 'f4' }], 6000);
check('un reminder viejo no se rompe', legacy.list.length, 2);
check('y se queda como estaba', legacy.list[0].text, 'call the bank');

console.log(fails ? `\n${fails} fallos` : '\nPASS');
process.exit(fails ? 1 : 0);
