// The digests are the features with the most room to say something that is not
// true: they read across many meetings and present a short conclusion, which is
// exactly where a detail gets attached to the wrong meeting or a date appears
// out of nowhere. So the rules are tested one by one — what a due date is
// allowed to resolve to, what reaches the model, and what is thrown away when it
// comes back uncited.
const digest = require('../digest');

let fails = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      esperaba ${JSON.stringify(want)}\n      obtuve   ${JSON.stringify(got)}`); }
}
function ok(name, cond, detail) {
  if (cond) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      ${detail}`); }
}

function meeting(name, extra = {}) {
  return {
    folder: `C:/M/${name}`, name, date: name.slice(0, 10),
    title: extra.title || name, participants: extra.participants || [],
    hasNotes: extra.sections ? true : !!extra.hasNotes,
    hasTranscript: extra.hasTranscript !== false,
    sections: extra.sections || [], stamp: extra.stamp || 'a:1:1;'
  };
}

// ---------------------------------------------------------------- cache key

console.log('\n-- la llave del caché --');
const m1 = meeting('2026-07-27_0900');
const m2 = meeting('2026-07-28_1000');
check('la misma semana da la misma llave',
  digest.digestKey([m1, m2]) === digest.digestKey([m1, m2]), true);
check('el orden no la cambia',
  digest.digestKey([m1, m2]) === digest.digestKey([m2, m1]), true);
check('una nota editada sí la cambia',
  digest.digestKey([m1, m2]) === digest.digestKey([m1, { ...m2, stamp: 'a:2:9;' }]), false);
check('una reunión nueva también',
  digest.digestKey([m1, m2]) === digest.digestKey([m1, m2, meeting('2026-07-29_1100')]), false);

// ---------------------------------------------------------------- due dates

console.log('\n-- una fecha solo si está escrita --');
check('ISO', digest.dueOn('2026-08-03', '2026-07-29'), '2026-08-03');
check('mes y día', digest.dueOn('July 30', '2026-07-29'), '2026-07-30');
check('día y mes', digest.dueOn('3 August', '2026-07-29'), '2026-08-03');
check('con año explícito', digest.dueOn('August 3, 2027', '2026-07-29'), '2027-08-03');
check('barras', digest.dueOn('8/3', '2026-07-29'), '2026-08-03');
check('barras con año corto', digest.dueOn('8/3/27', '2026-07-29'), '2027-08-03');
for (const vague of ['Friday', 'end of week', 'next week', 'tomorrow', 'soon', 'Q3', '']) {
  check(`"${vague}" no se convierte en fecha`, digest.dueOn(vague, '2026-07-29'), '');
}

// ---------------------------------------------------------------- daily

console.log('\n-- el resumen del día --');
const TODAY = '2026-07-29';

const standup = meeting('2026-07-29_0900', {
  title: 'Standup', participants: ['Chuck', 'Maya'],
  sections: [
    { heading: 'Summary [00:01]', body: 'A short standup about the rollout.' },
    { heading: 'Decisions [00:20]', body: '- Ship the rollout on Thursday.\n- Keep the old endpoint for a week.' },
    { heading: 'Action items [01:00]', body: '- Maya: update the changelog' }
  ]
});
const review = meeting('2026-07-29_1400', {
  title: 'Design Review', participants: ['Chuck', 'Carlos'],
  sections: [
    { heading: 'Decisions', body: 'None' },
    { heading: 'Open questions', body: '- Who owns the migration script?' }
  ]
});
const untouched = meeting('2026-07-29_1600', { title: 'Sync', hasNotes: false, hasTranscript: true });
const lastWeek = meeting('2026-07-21_1000', {
  title: 'Planning',
  sections: [{ heading: 'Decisions', body: '- Pricing stays at twenty nine.' }]
});
const MEETINGS = [standup, review, untouched, lastWeek];

const ITEMS = [
  { text: 'update the changelog', owner: 'Maya', due: '', priority: 'normal', done: false, folder: standup.folder, meeting: 'Standup', sources: [standup.folder] },
  { text: 'fix the login bug', owner: '', due: '', priority: 'high', done: false, folder: review.folder, meeting: 'Design Review', sources: [review.folder] },
  { text: 'send the vendor contract', owner: 'Carlos', due: 'July 24', priority: 'normal', done: false, folder: lastWeek.folder, meeting: 'Planning', sources: [lastWeek.folder] },
  { text: 'book the venue', owner: 'Chuck', due: 'August 12', priority: 'normal', done: false, folder: lastWeek.folder, meeting: 'Planning', sources: [lastWeek.folder] },
  { text: 'archive the old repo', owner: 'Chuck', due: 'July 20', priority: 'normal', done: true, folder: lastWeek.folder, meeting: 'Planning', sources: [lastWeek.folder] }
];

const day = digest.dailyDigest({ meetings: MEETINGS, items: ITEMS, day: TODAY });

check('solo las reuniones de hoy', day.meetings.map(m => m.title), ['Standup', 'Design Review', 'Sync']);
check('en el orden en que ocurrieron', day.meetings.map(m => m.time), ['09:00', '14:00', '16:00']);
check('cada una trae su carpeta para poder abrirla',
  day.meetings.every(m => m.folder.startsWith('C:/M/')), true);
check('las decisiones salen de la sección de decisiones',
  day.decisions.map(d => d.text),
  ['Ship the rollout on Thursday.', 'Keep the old endpoint for a week.']);
check('cada decisión sabe de qué reunión vino',
  day.decisions.map(d => d.meeting.title), ['Standup', 'Standup']);
check('"None" no cuenta como decisión', day.counts.decisions, 2);
ok('el resumen no se cuela como decisión',
  !day.decisions.some(d => /short standup/i.test(d.text)), JSON.stringify(day.decisions));
ok('ni la decisión de la semana pasada',
  !day.decisions.some(d => /twenty nine/i.test(d.text)), JSON.stringify(day.decisions));

check('las tareas de hoy son las de las reuniones de hoy',
  day.created.map(i => i.text).sort(), ['fix the login bug', 'update the changelog']);
ok('una tarea completada no aparece nunca',
  !JSON.stringify(day).includes('archive the old repo'), 'apareció');

const kinds = day.attention.map(a => a.kind);
ok('avisa de la reunión transcrita sin notas', kinds.includes('no-notes'), JSON.stringify(day.attention));
check('la señala por nombre',
  day.attention.filter(a => a.kind === 'no-notes').map(a => a.meeting.title), ['Sync']);
check('lo vencido es lo que tiene fecha pasada y sigue abierto',
  day.attention.filter(a => a.kind === 'overdue').map(a => a.text), ['send the vendor contract']);
ok('una fecha futura no está vencida',
  !day.attention.some(a => /book the venue/.test(a.text)), JSON.stringify(day.attention));
check('lo urgente de hoy también sube',
  day.attention.filter(a => a.kind === 'urgent').map(a => a.text), ['fix the login bug']);
check('los contadores cuadran',
  day.counts, { meetings: 3, decisions: 2, created: 2, openTotal: 4 });

const quiet = digest.dailyDigest({ meetings: MEETINGS, items: [], day: '2026-07-25' });
check('un día sin nada se declara vacío', quiet.empty, true);
check('y no inventa reuniones', quiet.meetings.length, 0);

const quietButOwing = digest.dailyDigest({ meetings: MEETINGS, items: ITEMS, day: '2026-07-25' });
ok('un día sin reuniones pero con algo vencido no está vacío',
  quietButOwing.empty === false && quietButOwing.attention.length > 0,
  JSON.stringify(quietButOwing.counts));

// ---------------------------------------------------------------- weekly facts

console.log('\n-- los hechos de la semana --');
const facts = digest.weeklyFacts({
  meetings: MEETINGS, items: ITEMS, from: '2026-07-27', to: '2026-08-02', today: TODAY
});
check('solo la semana pedida', facts.meetings.map(m => m.title), ['Standup', 'Design Review', 'Sync']);
check('la semana pasada queda fuera',
  facts.meetings.some(m => m.title === 'Planning'), false);
check('cuenta las decisiones de la semana', facts.decisionCount, 2);
check('la gente, por cuántas veces apareció',
  facts.people.map(p => `${p.name}:${p.count}`), ['Chuck:2', 'Carlos:1', 'Maya:1']);
check('los días con reunión', facts.days, [{ date: '2026-07-29', count: 3 }]);
check('las reuniones sin notas quedan señaladas',
  facts.missingNotes.map(m => m.title), ['Sync']);
check('lo vencido se cuenta una vez', facts.overdue, 1);
check('las tareas abiertas nacidas en la semana', facts.openFromWeek, 2);
check('dos reuniones con notas ya no es una semana delgada', facts.thin, false);
check('una sola sí — no hay hilos que cruzar',
  digest.weeklyFacts({ meetings: [standup, untouched], from: '2026-07-27', to: '2026-08-02' }).thin, true);
check('una semana sin reuniones se declara vacía',
  digest.weeklyFacts({ meetings: MEETINGS, from: '2026-06-01', to: '2026-06-07' }).empty, true);

// ---------------------------------------------------------------- weekly input

console.log('\n-- lo que se le manda al modelo --');
const input = digest.weeklyInput([standup, review, untouched, lastWeek]);
ok('lleva los títulos y las fechas',
  /=== Standup \| 2026-07-29 \| Chuck, Maya ===/.test(input.text), input.text.slice(0, 200));
ok('lleva las decisiones', /Ship the rollout on Thursday/.test(input.text), 'faltan');
ok('NO lleva la sección de tareas — así no puede repetirlas',
  !/changelog/i.test(input.text), input.text);
ok('una reunión sin notas no se manda', !/=== Sync/.test(input.text), input.text);
check('cuenta cuántas mandó', input.meetings, 3);

const long = meeting('2026-07-30_0900', {
  title: 'Marathon',
  sections: [{ heading: 'Summary', body: 'x'.repeat(digest.MAX_MEETING_CHARS + 500) }]
});
const cut = digest.weeklyInput([long]);
ok('una nota enorme se recorta', cut.text.length < digest.MAX_MEETING_CHARS + 300, `${cut.text.length}`);
check('y el recorte se reporta, no se esconde', cut.truncated, 1);

// ---------------------------------------------------------------- weekly parse

console.log('\n-- lo que se acepta de vuelta --');
const week = [standup, review, lastWeek];
const good = digest.parseWeekly(`## Threads
- The rollout moved from a plan to a date. [Standup, Planning]
- Pricing was settled and not reopened. [Planning, Standup]

## Shifts
- The old endpoint now survives a week longer than agreed. [Standup]

## Unresolved
- Nobody owns the migration script. [Design Review]
`, week);

check('las tres secciones, en orden', good.sections.map(s => s.title), ['Threads', 'Shifts', 'Unresolved']);
check('los hilos se conservan', good.sections[0].items.length, 2);
check('la cita se resuelve a reuniones reales',
  good.sections[0].items[0].cites.map(c => c.title), ['Standup', 'Planning']);
check('con su carpeta, para poder abrirlas',
  good.sections[0].items[0].cites.every(c => c.folder.startsWith('C:/M/')), true);
check('el corchete se saca del texto',
  good.sections[0].items[0].text, 'The rollout moved from a plan to a date.');
check('nada se descartó', good.dropped.length, 0);

const bad = digest.parseWeekly(`## Threads
- The Tokyo office lease was signed on Tuesday. [Tokyo Kickoff]
- Hiring slowed down this week.
- The rollout moved to Thursday. [Standup, Planning]

## Shifts
None

## Unresolved
None
`, week);
check('una cita a una reunión que no existe se descarta',
  bad.sections[0].items.map(i => i.text), ['The rollout moved to Thursday.']);
check('y una afirmación sin fuente también', bad.dropped.length, 2);
ok('se dice por qué se descartó cada una',
  bad.dropped.every(d => d.why), JSON.stringify(bad.dropped));
ok('lo inventado no sobrevive en ninguna parte',
  !JSON.stringify(bad.sections).includes('Tokyo'), JSON.stringify(bad.sections));
check('"None" se entiende como vacío a propósito',
  bad.sections.slice(1).map(s => s.none), [true, true]);

const missing = digest.parseWeekly('## Threads\n- Something happened. [Standup, Planning]\n', week);
check('una sección que el modelo no escribió sigue existiendo',
  missing.sections.map(s => `${s.title}:${s.items.length}`), ['Threads:1', 'Shifts:0', 'Unresolved:0']);
check('una respuesta vacía se declara vacía',
  digest.parseWeekly('', week).empty, true);
check('y una respuesta entera sin citas también',
  digest.parseWeekly('## Threads\n- We talked about many things.\n', week).empty, true);

console.log(fails ? `\n${fails} fallos` : '\nPASS');
process.exit(fails ? 1 : 0);
