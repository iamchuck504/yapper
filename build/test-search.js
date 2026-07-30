// Search has to find the thing that was actually said and rank it above the
// thing that merely shares a word. And it must return nothing rather than
// something wrong: an empty result is a fine answer, a confident irrelevant one
// is not.
const s = require('../search');

let fails = 0;
function check(name, ok, detail) {
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      ${detail}`); }
}
/** For assertions about a value rather than a condition — including zero. */
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want),
    `esperaba ${JSON.stringify(want)}, obtuve ${JSON.stringify(got)}`);
}

// ---------------------------------------------------------------- passages

const transcript = `[00:00:01] Right, let us talk about the new pricing.
[00:00:12] I think twenty nine dollars is the number.
[00:00:24] Maya said the enterprise tier should stay custom.
[00:01:40] Moving on to project Atlas and the migration.
[00:02:05] Atlas slips two weeks because of the vendor.
[00:03:30] Anything else? No. Good.`;

const cut = s.transcriptPassages(transcript, { title: 'Pricing Review', date: '2026-07-13', participants: ['Maya'] });
check('corta la transcripcion en pasajes', cut.length >= 3, `${cut.length} pasajes`);
check('cada pasaje conserva su marca de tiempo', cut.every(p => /^\d\d:\d\d:\d\d$/.test(p.stamp)),
  JSON.stringify(cut.map(p => p.stamp)));
eq('el primero empieza donde empieza el audio', cut[0].stamp, '00:00:01');
check('agrupa varias líneas seguidas', cut[0].text.includes('twenty nine'), cut[0].text);
check('no mete líneas lejanas en el mismo pasaje', !cut[0].text.includes('Atlas'), cut[0].text);

eq('las secciones de notas clasificadas',
  ['Decisions', 'Action items', 'Risks & concerns', 'Open questions', 'Summary'].map(s.sectionKind),
  ['decision', 'action', 'risk', 'question', 'notes']);

// ---------------------------------------------------------------- the corpus

const MEETINGS = [
  {
    folder: 'f1', name: '2026-07-13_1000', title: 'Pricing Review', date: '2026-07-13',
    participants: ['Maya', 'Chuck'],
    sections: [
      { heading: 'Decisions', body: '- Pricing moves to twenty nine dollars a month.\n- Enterprise stays custom.' },
      { heading: 'Action items', body: '- Maya: write the pricing page copy' }
    ]
  },
  {
    folder: 'f2', name: '2026-07-20_1400', title: 'Atlas Migration', date: '2026-07-20',
    participants: ['Carlos', 'Chuck'],
    sections: [
      { heading: 'Decisions', body: '- Atlas migration is pushed two weeks.' },
      { heading: 'Action items', body: '- Carlos: talk to the vendor about the delay' }
    ]
  },
  {
    folder: 'f3', name: '2026-06-02_0900', title: 'Launch Retro', date: '2026-06-02',
    participants: ['Maria', 'Chuck'],
    sections: [
      { heading: 'Summary', body: 'Maria walked through how the launch went.' },
      { heading: 'Decisions', body: '- No changes to the launch process.' }
    ]
  }
];

const TRANSCRIPTS = {
  f1: transcript,
  f2: `[00:00:05] Carlos here. The Atlas vendor cannot deliver until August.
[00:00:40] So Atlas slips two weeks, we agreed.
[00:02:00] Pricing is not in scope for this one.`,
  f3: `[00:00:03] Maria: the launch went better than we expected.
[00:00:30] Maria said the onboarding emails were the weak part.`
};

const index = s.buildIndex(MEETINGS, m => TRANSCRIPTS[m.folder] || '');
eq('el indice cubre las tres reuniones', index.meetings, 3);
check('e incluye notas y transcripción',
  index.passages.some(p => p.kind === 'decision') && index.passages.some(p => p.kind === 'transcript'),
  JSON.stringify([...new Set(index.passages.map(p => p.kind))]));

const find = (q, opts) => s.search(index, q, { today: '2026-07-30', ...opts });
const titles = r => r.results.map(x => x.meeting.title);

// ---------------------------------------------------------------- words

let r = find('pricing');
eq('encuentra por palabra', titles(r)[0], 'Pricing Review');
check('y no devuelve la reunión que solo la menciona de paso primero',
  titles(r)[0] === 'Pricing Review', JSON.stringify(titles(r)));

r = find('"enterprise tier should stay custom"');
check('una frase exacta encuentra su pasaje', r.results.length >= 1, `${r.results.length}`);
check('y solo pasajes que la contienen',
  r.results.every(x => /enterprise tier should stay custom/i.test(x.text)), JSON.stringify(r.results.map(x => x.text)));

r = find('"esto no lo dijo nadie nunca"');
eq('una frase que no existe no devuelve nada', r.results.length, 0);

r = find('');
eq('una busqueda vacia no devuelve nada', find('').results.length, 0);
eq('y una de solo muletillas tampoco', find('the and of').results.length, 0);

// ---------------------------------------------------------------- people

r = find('what did Maria say about the launch');
eq('una pregunta por persona la encuentra', titles(r)[0], 'Launch Retro');
eq('y la detecta como pregunta', r.query.question, true);
check('reconociendo el nombre', r.query.people.includes('Maria'), JSON.stringify(r.query.people));

r = find('show me the pending items assigned to Carlos');
check('los pendientes de una persona salen de su reunión',
  r.results.some(x => x.meeting.title === 'Atlas Migration'), JSON.stringify(titles(r)));
check('y prioriza la sección de pendientes',
  r.query.kinds.includes('action'), JSON.stringify(r.query.kinds));

// ---------------------------------------------------------------- topics, decisions

r = find('when did we talk about project Atlas');
eq('encuentra el proyecto', titles(r)[0], 'Atlas Migration');

r = find('what did we decide about the new pricing');
check('una pregunta sobre una decisión la encuentra',
  r.results[0].meeting.title === 'Pricing Review', JSON.stringify(titles(r)));
eq('y prefiere la seccion de decisiones', r.results[0].kind, 'decision');

// ---------------------------------------------------------------- dates

check('una fecha concreta filtra', find('pricing 2026-07-20').results.every(x => x.meeting.date === '2026-07-20'), 'colaron otras');
r = find('what happened in June');
check('un mes filtra', r.results.length && r.results.every(x => x.meeting.date.startsWith('2026-06')),
  JSON.stringify(r.results.map(x => x.meeting.date)));
eq('lee el rango del mes', [r.query.from, r.query.to], ['2026-06-01', '2026-06-30']);
eq('"last week" se calcula desde hoy',
  s.parseQuery('last week', { today: '2026-07-30' }).from, '2026-07-16');
eq('"today" tambien',
  s.parseQuery('meetings today', { today: '2026-07-30' }).from, '2026-07-30');
eq('sin fechas en la consulta, no filtra por fecha',
  s.parseQuery('pricing').from, '');

// ---------------------------------------------------------------- shape

r = find('Atlas');
check('cada resultado trae su reunión y su fecha',
  r.results.every(x => x.meeting.title && x.meeting.date), JSON.stringify(r.results[0]));
check('los de transcripción traen timestamp',
  r.results.filter(x => x.kind === 'transcript').every(x => x.stamp), 'alguno sin marca');
check('y los participantes de la reunión',
  r.results.every(x => Array.isArray(x.meeting.participants)), 'faltan');
check('una reunión no puede llenar la página',
  Math.max(...Object.values(r.results.reduce((acc, x) => {
    acc[x.meeting.folder] = (acc[x.meeting.folder] || 0) + 1; return acc;
  }, {}))) <= 2, JSON.stringify(titles(r)));

// ---------------------------------------------------------------- the prompt

const forModel = s.passagesForPrompt(find('pricing').results.slice(0, 3));
check('los pasajes se etiquetan para el modelo', /\[Pricing Review/.test(forModel), forModel.slice(0, 80));
check('con la fecha', /\(2026-07-13\)/.test(forModel), forModel.slice(0, 120));
check('el prompt prohíbe inventar',
  /only what the passages say/i.test(s.ANSWER_PROMPT) && /could not find that/i.test(s.ANSWER_PROMPT),
  'no lo dice');
check('y exige citar', /cite the meeting/i.test(s.ANSWER_PROMPT), 'no lo exige');

console.log(fails ? `\n${fails} fallos` : '\nPASS');
process.exit(fails ? 1 : 0);
