// The day and the week, driven in the real window.
//
// Three things are worth more than the rest here: every line has to offer the
// meeting it came from, the weekly review must not turn into a second copy of
// the day's task list, and a week the notes cannot support has to say so instead
// of being filled in.
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { sandbox, logger, mainWindow, within } = require('./harness');

const ROOT = sandbox('home-ui');
const say = logger(ROOT);

let fails = 0;
function check(name, ok, detail) {
  if (ok) say(`ok    ${name}`);
  else { fails++; say(`FAIL  ${name}\n      ${detail}`); }
}

const p = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
const now = new Date();
const TODAY = iso(now);
const shift = days => iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days));
const monday = iso(new Date(now.getFullYear(), now.getMonth(),
  now.getDate() - ((now.getDay() + 6) % 7)));
const OVERDUE = shift(-10);

function meeting(name, files) {
  const folder = path.join(ROOT, 'Meetings', name);
  fs.mkdirSync(folder, { recursive: true });
  for (const [f, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(folder, f), content, 'utf8');
  }
}

// Today: a meeting with real notes …
meeting(`${TODAY}_0900`, {
  'title.txt': 'Standup',
  'participants.txt': 'Chuck, Maya',
  'transcript.txt': '[00:00:01] The rollout is ready for Thursday.',
  'notes.md': `## Summary [00:01]
A short standup about the rollout.

## Decisions [00:20]
- Ship the rollout on Thursday.
- Keep the old endpoint alive for one more week.

## Action items [01:00]
- Maya: update the changelog before the rollout
`
});

// … one that was transcribed and never written up …
meeting(`${TODAY}_1600`, {
  'title.txt': 'Vendor Sync',
  'participants.txt': 'Chuck, Carlos',
  'transcript.txt': '[00:00:03] Carlos said the contract is still unsigned.'
});

// … a second meeting this week, so the week has a thread to find …
meeting(`${monday}_1000`, {
  'title.txt': 'Rollout Planning',
  'participants.txt': 'Chuck, Maya, Carlos',
  'transcript.txt': '[00:00:02] We planned the rollout for next Tuesday.',
  'notes.md': `## Summary [00:02]
Planning for the rollout.

## Decisions [00:30]
- The rollout targets Tuesday.

## Open questions [01:00]
- Nobody owns the rollback script.

## Action items [01:20]
- Carlos: send the vendor contract by ${OVERDUE}
`
});

// … and one long before, which must stay out of both panels.
meeting('2026-01-05_1100', {
  'title.txt': 'Kickoff',
  'transcript.txt': '[00:00:01] Kicking the year off.',
  'notes.md': '## Decisions\n- Nothing was decided in January.\n'
});

require('../main.js');

app.whenReady().then(async () => {
  const win = await mainWindow({ settleMs: 1500 });
  const $ = js => win.webContents.executeJavaScript(js, true);

  await $('window.yapper.refreshLibrary()');
  await $(`document.getElementById('btn-home').click()`);
  await new Promise(r => setTimeout(r, 900));

  const rows = id => $(`[...document.querySelectorAll('#${id} .digest-item')].map(li => ({
    text: li.textContent,
    sources: [...li.querySelectorAll('.digest-source')].map(b => b.textContent),
    live: [...li.querySelectorAll('.digest-source:not(:disabled)')].length
  }))`);
  const visible = id => $(`!document.getElementById('${id}').classList.contains('hidden')`);
  const text = id => $(`document.getElementById('${id}').textContent`);

  // ---------------- the day ----------------
  say('\n  --- hoy ---');
  check('la vista abre en el día', await visible('view-home') && await visible('home-day'), 'no abrió');
  check('el título dice Today', (await text('home-title')).trim() === 'Today', await text('home-title'));

  const meetings = await rows('day-meetings');
  say(`  reuniones: ${meetings.map(m => m.text.trim()).join(' | ')}`);
  check('solo las de hoy, en orden',
    meetings.length === 2 && /09:00/.test(meetings[0].text) && /Standup/.test(meetings[0].text)
      && /16:00/.test(meetings[1].text) && /Vendor Sync/.test(meetings[1].text),
    JSON.stringify(meetings.map(m => m.text)));
  check('la de enero no aparece',
    !meetings.some(m => /Kickoff/.test(m.text)), JSON.stringify(meetings.map(m => m.text)));

  const decisions = await rows('day-decisions');
  say(`  decisiones: ${decisions.map(d => d.text.trim()).join(' | ')}`);
  check('las decisiones de hoy, y solo las de hoy',
    decisions.length === 2 && decisions.every(d => /Standup/.test(d.sources.join())),
    JSON.stringify(decisions));
  check('el resumen no se cuela como decisión',
    !decisions.some(d => /short standup/i.test(d.text)), JSON.stringify(decisions.map(d => d.text)));
  check('la decisión del lunes no está en el día',
    !decisions.some(d => /targets Tuesday/i.test(d.text)), JSON.stringify(decisions.map(d => d.text)));
  check('cada decisión ofrece abrir su reunión',
    decisions.every(d => d.live === 1), JSON.stringify(decisions));

  const created = await rows('day-actions');
  check('las tareas nuevas traen dueño y origen',
    created.length === 1 && /changelog/.test(created[0].text) && /Maya/.test(created[0].text)
      && created[0].live === 1,
    JSON.stringify(created));

  const attention = await rows('day-attention');
  say(`  atención: ${attention.map(a => a.text.trim()).join(' | ')}`);
  check('la reunión sin notas se avisa, con su nombre',
    attention.some(a => /no notes/i.test(a.text) && /Vendor Sync/.test(a.sources.join())),
    JSON.stringify(attention));
  check('la tarea vencida se avisa como vencida',
    attention.some(a => /overdue/i.test(a.text) && /vendor contract/i.test(a.text)),
    JSON.stringify(attention));
  check('el contador del sidebar coincide',
    (await text('home-count')) === String(attention.length),
    `${await text('home-count')} vs ${attention.length}`);

  await $(`document.querySelector('#day-decisions .digest-source').click()`);
  await new Promise(r => setTimeout(r, 1000));
  check('la fuente abre la reunión, y es la correcta',
    await visible('view-meeting') && /Standup/.test(await text('result-title')),
    `visible=${await visible('view-meeting')} title="${await text('result-title')}"`);

  // ---------------- an empty day ----------------
  say('\n  --- un día sin nada ---');
  await $(`document.getElementById('btn-home').click()`);
  await new Promise(r => setTimeout(r, 700));
  const emptyDay = await $(`(async () => {
    const d = await window.yapper.dailyDigest('2026-03-11');
    return { empty: d.empty, previous: d.previous, meetings: d.meetings.length };
  })()`);
  say(`  ${JSON.stringify(emptyDay)}`);
  check('un día vacío se declara vacío y no inventa nada',
    emptyDay.empty === true && emptyDay.meetings === 0, JSON.stringify(emptyDay));
  check('y ofrece el día anterior que sí tuvo algo',
    emptyDay.previous === '2026-01-05', emptyDay.previous);

  // ---------------- the week ----------------
  say('\n  --- la semana ---');
  await $(`document.querySelector('#home-scope .seg-btn[data-scope="week"]').click()`);
  const t0 = Date.now();
  await within($(`(async () => {
    for (let i = 0; i < 240; i++) {
      const foot = document.getElementById('week-foot');
      if (!foot.classList.contains('hidden')) return true;
      await new Promise(r => setTimeout(r, 500));
    }
    return false;
  })()`), 'la semana', 3 * 60 * 1000);
  say(`  escrita en ${((Date.now() - t0) / 1000).toFixed(0)} s`);

  const stats = await $(`[...document.querySelectorAll('.week-stat')].map(s => s.textContent)`);
  say(`  hechos: ${stats.join(' | ')}`);
  check('los hechos de la semana se muestran',
    stats.some(s => /^3meetings|^3 ?meetings/.test(s.replace(/\s+/g, ''))) || stats.length === 6,
    JSON.stringify(stats));
  check('el aviso de reuniones sin notas nombra la reunión',
    /Vendor Sync/.test(await text('week-facts')), await text('week-facts'));

  const sections = await $(`[...document.querySelectorAll('#week-sections .week-section')].map(s => ({
    title: s.querySelector('.digest-h').textContent,
    none: !!s.querySelector('.week-none'),
    items: [...s.querySelectorAll('.digest-item')].map(li => ({
      text: li.querySelector('.digest-text').textContent,
      sources: [...li.querySelectorAll('.digest-source')].map(b => b.textContent)
    }))
  }))`);
  say('  ' + JSON.stringify(sections, null, 1).replace(/\n\s*/g, ' ').slice(0, 700));

  check('las tres secciones están',
    JSON.stringify(sections.map(s => s.title)) === '["Threads","Shifts","Unresolved"]',
    JSON.stringify(sections.map(s => s.title)));
  const items = sections.flatMap(s => s.items);
  check('todo lo que se muestra cita una reunión real',
    items.length > 0 && items.every(i => i.sources.length >= 1), JSON.stringify(items));
  check('las citas son de esta semana, no de enero',
    !items.some(i => i.sources.join().includes('Kickoff')), JSON.stringify(items.map(i => i.sources)));

  const weekText = await text('week-sections');
  check('la semana NO repite la lista de tareas',
    !/changelog/i.test(weekText), weekText.slice(0, 400));
  check('ni se convierte en una lista de reuniones',
    !/^\s*(Standup|Rollout Planning)\s*$/m.test(weekText), weekText.slice(0, 400));
  check('el pie dice de cuántas reuniones salió',
    /\d meeting/.test(await text('week-note')), await text('week-note'));

  const cites = await $(`(() => { const b = document.querySelector('#week-sections .digest-source');
    return b ? b.textContent : ''; })()`);
  if (cites) {
    await $(`document.querySelector('#week-sections .digest-source').click()`);
    await new Promise(r => setTimeout(r, 1000));
    check('una cita de la semana abre su reunión', await visible('view-meeting'), 'no abrió');
    await $(`document.getElementById('btn-home').click()`);
    await new Promise(r => setTimeout(r, 600));
  }

  // ---------------- cached, and a week that cannot be written ----------------
  const second = await within($(`window.yapper.weeklySummary({})`), 'segunda lectura', 60 * 1000);
  check('la segunda vez se reusa lo ya escrito', second.cached === true,
    JSON.stringify({ cached: second.cached, reason: second.reason }));

  const thin = await within($(`window.yapper.weeklySummary({ week: '2026-01-07' })`), 'semana delgada', 60 * 1000);
  say(`  semana de enero -> ${JSON.stringify({ reason: thin.reason, sections: !!thin.sections })}`);
  check('una semana con una sola nota no se escribe: se explica',
    thin.reason === 'thin' && !thin.sections, JSON.stringify(thin).slice(0, 200));
  check('y aun así trae los hechos',
    thin.facts && thin.facts.meetings.length === 1, JSON.stringify(thin.facts || {}).slice(0, 200));

  const nothing = await within($(`window.yapper.weeklySummary({ week: '2025-02-05' })`), 'semana vacía', 60 * 1000);
  check('una semana sin reuniones tampoco se escribe',
    nothing.reason === 'no-meetings' && !nothing.sections, JSON.stringify(nothing).slice(0, 160));

  say(fails ? `\n${fails} fallos` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(e => { say('FAIL ' + (e.stack || e.message)); app.exit(1); });
