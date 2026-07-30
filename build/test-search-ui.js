// The search view, driven for real. The thing that matters most is what it does
// when it has nothing: an empty result has to say so, and a question with no
// supporting passages must not get an answer invented for it.
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { sandbox, logger, mainWindow, within } = require('./harness');

const ROOT = sandbox('search-ui');
const say = logger(ROOT);

let fails = 0;
function check(name, ok, detail) {
  if (ok) say(`ok    ${name}`);
  else { fails++; say(`FAIL  ${name}\n      ${detail}`); }
}

function meeting(name, title, participants, transcript, notes) {
  const folder = path.join(ROOT, 'Meetings', name);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'title.txt'), title, 'utf8');
  fs.writeFileSync(path.join(folder, 'participants.txt'), participants, 'utf8');
  fs.writeFileSync(path.join(folder, 'transcript.txt'), transcript, 'utf8');
  fs.writeFileSync(path.join(folder, 'notes.md'), notes, 'utf8');
}

meeting('2026-07-13_1000', 'Pricing Review', 'Ninfa, Chuck',
  `[00:00:01] Let us settle the new pricing today.
[00:00:20] Twenty nine dollars a month is where we landed.
[00:01:10] Ninfa: enterprise stays custom, I do not want a published number.
[00:02:30] Agreed then. Twenty nine, enterprise custom.`,
  `## Summary [00:01]
The team settled the new pricing.

## Decisions [00:20]
- New pricing is twenty nine dollars a month.
- Enterprise tier stays custom, with no published price.

## Action items [01:10]
- Ninfa: write the pricing page copy
`);

meeting('2026-07-20_1400', 'Atlas Migration', 'Carlos, Chuck',
  `[00:00:05] Carlos: the Atlas vendor cannot deliver until August.
[00:00:45] So project Atlas slips by two weeks.
[00:01:30] Nothing about pricing here.`,
  `## Summary [00:05]
Atlas is delayed by the vendor.

## Decisions [00:45]
- Project Atlas slips two weeks.

## Action items [00:05]
- Carlos: chase the vendor for a firm date
`);

require('../main.js');

app.whenReady().then(async () => {
  const win = await mainWindow({ settleMs: 1500 });
  const $ = js => win.webContents.executeJavaScript(js, true);

  await $('window.yapper.refreshLibrary()');
  await $(`document.getElementById('btn-search-view').click()`);
  await new Promise(r => setTimeout(r, 400));
  check('la vista de búsqueda abre',
    !(await $("document.getElementById('view-search').classList.contains('hidden')")), 'sigue oculta');

  const results = () => $(`[...document.querySelectorAll('#search-results .result')].map(li => ({
    meeting: li.querySelector('.result-meeting').textContent,
    when: li.querySelector('.result-when').textContent,
    kind: li.querySelector('.result-kind').textContent,
    who: (li.querySelector('.result-who') || {}).textContent || '',
    text: li.querySelector('.result-text').textContent
  }))`);
  const status = () => $(`(() => { const el = document.getElementById('search-status');
    return el.classList.contains('hidden') ? '' : el.textContent; })()`);
  const answer = () => $(`(() => { const el = document.getElementById('search-answer');
    return el.classList.contains('hidden') ? '' : el.textContent; })()`);

  const run = async (q, waitMs = 1500) => {
    await $(`(() => { const i = document.getElementById('search-q'); i.value = ${JSON.stringify(q)};
      document.getElementById('btn-search').click(); })()`);
    await new Promise(r => setTimeout(r, waitMs));
  };

  // ---- words ----
  await run('pricing');
  let found = await results();
  say(`  "pricing" -> ${found.map(r => `${r.meeting}/${r.kind}`).join(', ')}`);
  check('encuentra por palabra', found.length >= 1, `${found.length} resultados`);
  check('el primero es la reunión correcta', found[0].meeting === 'Pricing Review', found[0].meeting);
  check('cada resultado trae reunión y fecha', found.every(r => r.meeting && /2026-/.test(r.when)),
    JSON.stringify(found[0]));
  check('los de transcripción traen timestamp',
    found.some(r => /\d\d:\d\d:\d\d/.test(r.when)), JSON.stringify(found.map(r => r.when)));
  check('y los participantes', found.some(r => /Ninfa/.test(r.who)), JSON.stringify(found.map(r => r.who)));

  // ---- nothing found says so ----
  await run('quesadillas');
  check('sin resultados lo dice claramente',
    /Nothing matched/i.test(await status()), await status());
  check('y no deja resultados viejos en pantalla', (await results()).length === 0,
    `${(await results()).length} filas`);
  check('ni una respuesta colgada', (await answer()) === '', await answer());

  // ---- a date narrows, and says it did ----
  await run('2026-07-20');
  found = await results();
  check('una fecha filtra', found.length && found.every(r => /2026-07-20/.test(r.when)),
    JSON.stringify(found.map(r => r.when)));
  check('y explica que filtró',
    (await $("!!document.querySelector('#search-results .result-scope')")), 'no lo dice');

  // ---- an example chip works ----
  await $(`document.querySelector('#search-examples button[data-q*="Atlas"]').click()`);
  await new Promise(r => setTimeout(r, 1500));
  found = await results();
  check('los ejemplos funcionan', found.length >= 1 && found[0].meeting === 'Atlas Migration',
    JSON.stringify(found.map(r => r.meeting)));

  // ---- opening the meeting from a result ----
  await $(`document.querySelector('#search-results .result-meeting').click()`);
  await new Promise(r => setTimeout(r, 1200));
  check('un resultado abre su reunión',
    !(await $("document.getElementById('view-meeting').classList.contains('hidden')")), 'no abrió');
  await $(`document.getElementById('btn-search-view').click()`);
  await new Promise(r => setTimeout(r, 300));

  // ---- a question gets an answer written only from the passages ----
  say('\n  --- pregunta en lenguaje natural ---');
  const t0 = Date.now();
  const asked = await within($(`window.yapper.ask('What did we decide about the new pricing?')`),
    'preguntar', 4 * 60 * 1000);
  say(`  respondió en ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  say(`  "${String(asked.answer).slice(0, 240)}"`);
  check('responde la pregunta', !!asked.answer && asked.answer.length > 20,
    JSON.stringify(asked).slice(0, 200));
  check('con los pasajes que la sostienen', (asked.results || []).length >= 1,
    `${(asked.results || []).length} pasajes`);
  check('la respuesta contiene el dato real',
    /twenty[\s-]?nine|\b29\b/i.test(asked.answer || ''), asked.answer);
  check('y cita la reunión',
    /\[[^\]]*Pricing Review/i.test(asked.answer || ''), asked.answer);

  // ---- and refuses to answer what it cannot support ----
  const unanswerable = await within(
    $(`window.yapper.ask('What did we decide about the Tokyo office lease?')`),
    'preguntar algo que no está', 4 * 60 * 1000);
  say(`  sin respaldo -> ${JSON.stringify(unanswerable).slice(0, 220)}`);
  const refused = unanswerable.reason === 'nothing-found'
    || /could not find/i.test(unanswerable.answer || '');
  check('no inventa lo que no está en las reuniones', refused,
    JSON.stringify(unanswerable).slice(0, 240));
  check('y no menciona Tokio como si se hubiera hablado',
    !/tokyo office lease (was|is) /i.test(unanswerable.answer || ''), unanswerable.answer);

  say(fails ? `\n${fails} fallos` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(e => { say('FAIL ' + (e.stack || e.message)); app.exit(1); });
