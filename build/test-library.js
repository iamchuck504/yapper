// The index is what every cross-meeting feature reads, so its date handling and
// its "has this changed?" fingerprint have to be right. Both are easy to get
// subtly wrong and hard to notice afterwards: a week that starts on the wrong
// day, or a cache that never notices an edited note.
const fs = require('fs');
const path = require('path');
const os = require('os');
const lib = require('../library');

let fails = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      esperaba ${JSON.stringify(want)}\n      obtuve   ${JSON.stringify(got)}`); }
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'yapper-library-'));
const MEETINGS = path.join(ROOT, 'Meetings');
const INDEX = path.join(ROOT, 'index.json');
fs.mkdirSync(MEETINGS, { recursive: true });

function meeting(name, files) {
  const folder = path.join(MEETINGS, name);
  fs.mkdirSync(folder, { recursive: true });
  for (const [f, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(folder, f), content, 'utf8');
  }
  return folder;
}

// ---------------------------------------------------------------- dates

check('la fecha sale del nombre de la carpeta', lib.dateOf('2026-07-30_1415'), '2026-07-30');
check('un nombre raro no da fecha', lib.dateOf('borrador'), '');
check('un nombre con sufijo también', lib.dateOf('2026-07-30_1415_2'), '2026-07-30');

// Thursday 30 July 2026 — its week runs Monday 27 to Sunday 2 August
const w = lib.weekOf('2026-07-30');
check('la semana empieza el lunes', w.from, '2026-07-27');
check('y termina el domingo', w.to, '2026-08-02');
check('un domingo pertenece a la semana que acaba', lib.weekOf('2026-08-02').from, '2026-07-27');
check('un lunes empieza la suya', lib.weekOf('2026-08-03').from, '2026-08-03');
check('la etiqueta de semana es estable',
  lib.weekOf('2026-07-30').label === lib.weekOf('2026-07-27').label, true);
check('y cambia al pasar a la siguiente',
  lib.weekOf('2026-08-03').label !== lib.weekOf('2026-07-30').label, true);
check('una semana a caballo entre meses no se parte',
  [lib.weekOf('2026-07-31').from, lib.weekOf('2026-07-31').to], ['2026-07-27', '2026-08-02']);

// ---------------------------------------------------------------- reading

meeting('2026-07-30_0900', {
  'title.txt': 'Launch Sync',
  'participants.txt': 'Maya, Chuck',
  'transcript.txt': '[00:00:01] We ship on Friday.',
  'notes.md': `## Summary [00:01]
Agreed to launch.

## Decisions [00:05]
- Ship on Friday.

## Action items [00:20]
- Maya: prepare the rollout plan by Friday
- Chuck: review the pricing deck
`
});

let { meetings, changed } = lib.refresh({ meetingsDir: MEETINGS, indexFile: INDEX });
check('encuentra la reunión', meetings.length, 1);
check('la lee entera', changed.length, 1);
const m = meetings[0];
check('lee el título', m.title, 'Launch Sync');
check('lee los participantes', m.participants, ['Maya', 'Chuck']);
check('sabe que tiene notas y transcript', [m.hasNotes, m.hasTranscript], [true, true]);
check('indexa las secciones de las notas',
  m.sections.map(s => s.heading), ['Summary', 'Decisions', 'Action items']);
check('extrae los action items', m.items.length, 2);
check('con su responsable', m.items.map(i => i.owner), ['Maya', 'Chuck']);
check('y su reunión de origen', m.items[0].meeting, 'Launch Sync');

// ---------------------------------------------------------------- the cache

({ meetings, changed } = lib.refresh({ meetingsDir: MEETINGS, indexFile: INDEX }));
check('la segunda vez no vuelve a leerla', changed.length, 0);
check('pero sigue estando', meetings.length, 1);

// editing the notes must invalidate it
fs.writeFileSync(path.join(MEETINGS, '2026-07-30_0900', 'notes.md'),
  '## Action items\n- Maya: prepare the rollout plan\n- Chuck: review the deck\n- Send the contract\n', 'utf8');
({ meetings, changed } = lib.refresh({ meetingsDir: MEETINGS, indexFile: INDEX }));
check('editar las notas la vuelve a leer', changed.length, 1);
check('y los items se actualizan', meetings[0].items.length, 3);

// a brand new meeting appears
meeting('2026-07-28_1500', { 'title.txt': 'Planning', 'transcript.txt': '[00:00:01] Hello.' });
({ meetings, changed } = lib.refresh({ meetingsDir: MEETINGS, indexFile: INDEX }));
check('una reunión nueva se añade', meetings.length, 2);
check('y solo se lee la nueva', changed.map(c => c.title), ['Planning']);
check('las más nuevas van primero', meetings.map(x => x.name),
  ['2026-07-30_0900', '2026-07-28_1500']);

// a deleted meeting disappears
fs.rmSync(path.join(MEETINGS, '2026-07-28_1500'), { recursive: true, force: true });
({ meetings } = lib.refresh({ meetingsDir: MEETINGS, indexFile: INDEX }));
check('una reunión borrada desaparece del índice', meetings.length, 1);

// a corrupt index must not be fatal
fs.writeFileSync(INDEX, 'not json at all', 'utf8');
({ meetings, changed } = lib.refresh({ meetingsDir: MEETINGS, indexFile: INDEX }));
check('un índice corrupto se reconstruye', meetings.length, 1);
check('leyéndolo todo de nuevo', changed.length, 1);

// ---------------------------------------------------------------- selecting

meeting('2026-07-29_1000', { 'title.txt': 'Yesterday', 'transcript.txt': '[00:00:01] x' });
meeting('2026-07-30_1600', { 'title.txt': 'Later today', 'transcript.txt': '[00:00:01] y' });
meeting('2026-07-20_1000', { 'title.txt': 'Last week', 'transcript.txt': '[00:00:01] z' });
meeting('2026-07-30_1100', { 'title.txt': 'Sin nada' });          // no transcript, no notes
({ meetings } = lib.refresh({ meetingsDir: MEETINGS, indexFile: INDEX }));

check('las de un día concreto', lib.onDay(meetings, '2026-07-30').length, 3);
check('ordenadas por hora, la última primero',
  lib.onDay(meetings, '2026-07-30').map(x => x.title), ['Later today', 'Sin nada', 'Launch Sync']);
check('las de un rango de fechas',
  lib.inRange(meetings, '2026-07-27', '2026-08-02').map(x => x.title).sort(),
  ['Later today', 'Launch Sync', 'Sin nada', 'Yesterday']);
check('la de la semana anterior queda fuera',
  lib.inRange(meetings, '2026-07-27', '2026-08-02').some(x => x.title === 'Last week'), false);
check('solo las que tienen contenido',
  lib.withContent(lib.onDay(meetings, '2026-07-30')).map(x => x.title),
  ['Later today', 'Launch Sync']);

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(fails ? `\n${fails} fallos` : '\nPASS');
process.exit(fails ? 1 : 0);
