// The action items view, driven for real: the notes of several meetings produce
// the list, duplicates fold into one row, the facts shown come only from what
// the notes said, and every control works.
const path = require('path');
const fs = require('fs');
const { app, dialog } = require('electron');
const { sandbox, logger, mainWindow } = require('./harness');

const ROOT = sandbox('actions-ui');
const say = logger(ROOT);

let fails = 0;
function check(name, ok, detail) {
  if (ok) say(`ok    ${name}`);
  else { fails++; say(`FAIL  ${name}\n      ${detail}`); }
}

function meeting(name, title, notes, participants = 'Ninfa, Chuck') {
  const folder = path.join(ROOT, 'Meetings', name);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'title.txt'), title, 'utf8');
  fs.writeFileSync(path.join(folder, 'participants.txt'), participants, 'utf8');
  fs.writeFileSync(path.join(folder, 'transcript.txt'), '[00:00:01] Something was said.', 'utf8');
  fs.writeFileSync(path.join(folder, 'notes.md'), notes, 'utf8');
  return folder;
}

// Monday: the tasks are created
const planning = meeting('2026-07-27_1000', 'Launch Planning', `## Summary [00:01]
We planned the launch.

## Decisions [00:05]
- Ship on Friday.

## Action items [00:20]
- Ninfa: prepare the rollout plan by Friday
- Chuck: review the pricing deck
- Send the contract to legal
- URGENT: fix the login bug before Friday
`);

// Wednesday: one of them is restated, one is new
const standup = meeting('2026-07-29_0900', 'Wednesday Standup', `## Summary [00:01]
Quick check-in.

## Action items [00:10]
- Ninfa: prepare a rollout plan
- Book the launch venue
`);

// and a meeting with nothing to do
meeting('2026-07-28_1400', 'Retro', `## Summary [00:01]
Talked about process.

## Action items [00:09]
- No action items recorded.
`);

dialog.showMessageBox = async () => ({ response: 1 });
require('../main.js');

app.whenReady().then(async () => {
  const win = await mainWindow({ settleMs: 1500 });
  const errs = [];
  win.webContents.on('console-message', (_e, l, m) => { if (l >= 2) errs.push(m); });
  const $ = js => win.webContents.executeJavaScript(js, true);
  const click = async sel => {
    await $(`document.querySelector(${JSON.stringify(sel)}).click()`);
    await new Promise(r => setTimeout(r, 300));
  };

  await $('window.yapper.refreshLibrary()');
  const list = await $('window.yapper.listActions()');
  say(`  items: ${list.map(r => `${r.owner || '—'}/${r.text}`).join(' | ')}\n`);

  // ---- extraction ----
  check('saca los action items de las notas', list.length === 5, `${list.length}: ver arriba`);
  check('ignora "No action items recorded."',
    !list.some(r => /no action items/i.test(r.text)), 'metió el marcador');
  check('lee los responsables que sí se dijeron',
    list.filter(r => r.owner).map(r => r.owner).sort().join(',') === 'Chuck,Ninfa',
    list.map(r => r.owner).join(','));
  check('deja vacío el responsable que nadie dijo',
    list.some(r => /contract/i.test(r.text) && !r.owner), 'inventó uno');
  check('lee las fechas escritas', list.some(r => r.due === 'Friday'), 'no encontró ninguna');
  check('marca lo urgente', list.some(r => r.priority === 'high' && /login/i.test(r.text)),
    'no marcó el bug');

  // ---- duplicates ----
  const rollout = list.filter(r => /rollout/i.test(r.text));
  check('el pendiente repetido en dos reuniones es UNA fila', rollout.length === 1,
    `${rollout.length} filas`);
  check('y recuerda las dos reuniones', (rollout[0].mentions || []).length === 2,
    JSON.stringify(rollout[0].sources));
  check('conservando el responsable original', rollout[0].owner === 'Ninfa', rollout[0].owner);
  check('lo nuevo del standup sí se añade', list.some(r => /venue/i.test(r.text)), 'falta');

  // ---- the summary on the main screen ----
  const summary = await $(`(() => {
    const el = document.getElementById('action-summary');
    return { text: el.textContent, hidden: el.classList.contains('hidden') };
  })()`);
  say(`  resumen: "${summary.text}"`);
  check('la pantalla principal resume los pendientes', !summary.hidden, 'está oculto');
  check('con el número y los urgentes',
    /5 action items pending/.test(summary.text) && /1 high priority/.test(summary.text),
    summary.text);

  // ---- the view ----
  await click('#btn-reminders');
  const rows = () => $(`[...document.querySelectorAll('#reminders-list .reminder')].map(li => ({
    text: li.querySelector('.r-text').value,
    owner: (li.querySelector('.r-owner') || {}).textContent || '',
    due: (li.querySelector('.r-due') || {}).textContent || '',
    urgent: li.classList.contains('urgent'),
    meeting: (li.querySelector('.r-open') || {}).textContent || '',
    again: (li.querySelector('.r-again') || {}).textContent || '',
    done: li.classList.contains('done')
  }))`);

  let shown = await rows();
  check('la vista lista los pendientes', shown.length === 5, `${shown.length} filas`);
  check('lo urgente va primero', shown[0].urgent, JSON.stringify(shown[0]));
  check('muestra el responsable', shown.some(r => r.owner === 'Ninfa'), JSON.stringify(shown));
  check('muestra la fecha', shown.some(r => r.due === 'Friday'), JSON.stringify(shown));
  check('muestra de qué reunión salió',
    shown.some(r => r.meeting === 'Launch Planning'), JSON.stringify(shown.map(r => r.meeting)));
  check('avisa cuando se repitió en otra reunión',
    shown.some(r => /also in 1 other meeting/.test(r.again)), JSON.stringify(shown.map(r => r.again)));

  // ---- filters ----
  await click('#action-filter .seg-btn[data-filter="high"]');
  shown = await rows();
  check('el filtro de urgentes deja solo uno', shown.length === 1, `${shown.length}`);
  await click('#action-filter .seg-btn[data-filter="mine"]');
  shown = await rows();
  check('el filtro de "con responsable" deja dos', shown.length === 2, `${shown.length}`);
  await click('#action-filter .seg-btn[data-filter="done"]');
  check('sin nada hecho, el filtro lo dice',
    (await $("!!document.querySelector('#reminders-list .reminders-empty')")), 'no avisa');
  await click('#action-filter .seg-btn[data-filter="open"]');

  // ---- completing, editing, deleting ----
  await click('#reminders-list .reminder .r-check');
  await new Promise(r => setTimeout(r, 300));
  let after = await $('window.yapper.listActions()');
  check('marcar como hecho se guarda', after.filter(r => r.done).length === 1,
    `${after.filter(r => r.done).length} hechos`);
  check('y desaparece de "Open"', (await rows()).length === 4, `${(await rows()).length}`);

  await $(`(() => { const i = document.querySelector('#reminders-list .reminder .r-text');
    i.value = 'edited by hand'; i.dispatchEvent(new Event('change')); })()`);
  await new Promise(r => setTimeout(r, 400));
  after = await $('window.yapper.listActions()');
  check('editar a mano se guarda', after.some(r => r.text === 'edited by hand'),
    'no se guardó');

  const before = (await rows()).length;
  await click('#reminders-list .reminder .r-del');
  check('borrar quita la fila', (await rows()).length === before - 1,
    `${(await rows()).length} de ${before}`);

  // ---- opening the meeting it came from ----
  // Clicked from here and then polled from here: waiting inside the page races
  // with the IPC round trip the click sets off, and that is a flaky test rather
  // than a broken feature.
  await click('#action-filter .seg-btn[data-filter="all"]');
  const found = await $(`(() => {
    const btn = [...document.querySelectorAll('#reminders-list .r-open')]
      .find(b => b.textContent === 'Launch Planning');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  check('hay un botón para abrir la reunión', found, 'no lo encontré');
  const state = () => $(`({
    meeting: !document.getElementById('view-meeting').classList.contains('hidden'),
    reminders: !document.getElementById('view-reminders').classList.contains('hidden'),
    record: !document.getElementById('view-record').classList.contains('hidden'),
    title: document.getElementById('result-title').textContent
  })`);
  // Held for well past the auto-detect poll: it used to force the record view a
  // few hundred milliseconds later, so the meeting opened and then vanished.
  await new Promise(r => setTimeout(r, 6500));
  const opened = await state();
  check('abre la reunión de origen',
    opened.meeting && opened.title === 'Launch Planning', JSON.stringify(opened));
  check('y nada la cierra por detrás', !opened.record, JSON.stringify(opened));

  // ---- nothing is invented on a re-index ----
  await $('window.yapper.refreshLibrary()');
  const again = await $('window.yapper.listActions()');
  check('re-indexar no duplica nada', again.length === after.length - 1,
    `${again.length} ahora, ${after.length - 1} esperados`);

  if (errs.length) say('  errores del renderer: ' + errs.slice(0, 4).join(' | '));
  say(fails ? `\n${fails} fallos` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(e => { say('FAIL ' + (e.stack || e.message)); app.exit(1); });
