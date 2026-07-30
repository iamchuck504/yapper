// Deleting a meeting, end to end, against a throwaway Documents folder so the
// real one is never touched. Covers the three things that can go wrong: the
// confirmation being ignored, the click also opening the meeting, and an empty
// meeting not being recognisable as one.
const path = require('path');
const fs = require('fs');
const { app, dialog } = require('electron');
const { mainWindow } = require('./harness');

const ROOT = path.join(app.getPath('temp'), 'yapper-delete-test');
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, 'Meetings'), { recursive: true });
app.setPath('documents', ROOT);                 // MEETINGS_DIR follows this
app.setPath('userData', path.join(ROOT, 'user'));

const MEETINGS = path.join(ROOT, 'Meetings');
const EMPTY = path.join(MEETINGS, '2026-07-29_0900');
const FULL = path.join(MEETINGS, '2026-07-29_1000');

// a false start: the WAV header was written and nothing else
fs.mkdirSync(EMPTY);
fs.writeFileSync(path.join(EMPTY, 'recording.wav'), Buffer.alloc(44));
// a real meeting: 30 s of audio, a transcript and notes
fs.mkdirSync(FULL);
fs.writeFileSync(path.join(FULL, 'recording.wav'), Buffer.alloc(44 + 32000 * 30));
fs.writeFileSync(path.join(FULL, 'transcript.txt'), '[00:00:00] hello', 'utf8');
fs.writeFileSync(path.join(FULL, 'notes.md'), '## Summary\nA meeting.', 'utf8');
fs.writeFileSync(path.join(FULL, 'title.txt'), 'Real Meeting', 'utf8');

let fails = 0;
function check(name, ok, detail) {
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      ${detail}`); }
}

// stand in for the confirmation dialog; record what the user was actually told
let answer = 1;
const asked = [];
dialog.showMessageBox = async (_win, opts) => {
  asked.push(opts);
  return { response: answer };
};

require('../main.js');

app.whenReady().then(async () => {
  const win = await mainWindow();

  const $ = js => win.webContents.executeJavaScript(js);
  const rows = () => $(`[...document.querySelectorAll('#meeting-list .m-item')].map(li => ({
    title: li.querySelector('.m-title').textContent,
    date: li.querySelector('.m-date').textContent,
    empty: li.classList.contains('m-void'),
    hasDelete: !!li.querySelector('.m-del')
  }))`);

  // the list is newest first, so rows are addressed by their meeting, never by
  // position — that is how the first run of this test deleted the wrong one
  const rowFor = time => `[...document.querySelectorAll('#meeting-list .m-item')]`
    + `.find(x => x.querySelector('.m-date').textContent.includes('${time}'))`;
  const clickDelete = async time => {
    const hit = await $(`(() => { const li = ${rowFor(time)};
      if (!li) return false; li.querySelector('.m-del').click(); return true; })()`);
    check(`encuentra la fila de las ${time}`, hit, 'no está en la lista');
    await new Promise(r => setTimeout(r, 700));
  };

  await $('refreshMeetingList()');
  await new Promise(r => setTimeout(r, 400));

  let list = await rows();
  check('lista las dos reuniones', list.length === 2, JSON.stringify(list));
  const emptyRow = list.find(r => r.date.includes('09:00'));
  const fullRow = list.find(r => r.date.includes('10:00'));
  check('marca la vacía como vacía', emptyRow && emptyRow.empty, JSON.stringify(emptyRow));
  check('la nombra de forma entendible',
    emptyRow && emptyRow.title === 'Empty recording', emptyRow && emptyRow.title);
  check('NO marca como vacía la que sí tiene audio', fullRow && !fullRow.empty, JSON.stringify(fullRow));
  check('cada fila tiene botón de borrar',
    list.every(r => r.hasDelete), JSON.stringify(list));

  // --- what the user is told before losing something ---
  answer = 1;
  await clickDelete('10:00');
  check('cancelar no borra nada', fs.existsSync(FULL), 'la carpeta desapareció');
  check('preguntó antes de borrar', asked.length === 1, `preguntó ${asked.length} veces`);
  check('avisa que va a la papelera',
    /recycle bin/i.test(asked[0].detail || ''), asked[0].detail);
  check('enumera lo que se perdería',
    /30 s of audio/.test(asked[0].detail) && /transcript/.test(asked[0].detail)
    && /notes/.test(asked[0].detail), asked[0].detail);
  check('el botón vuelve a estar disponible tras cancelar',
    !(await $(`${rowFor('10:00')}.querySelector('.m-del').disabled`)), 'quedó deshabilitado');
  check('cancelar tampoco abre la reunión',
    await $("document.getElementById('view-meeting').classList.contains('hidden')"),
    'abrió la reunión que se iba a borrar');

  await clickDelete('09:00');
  check('de una vacía dice que está vacía',
    /empty/i.test(asked[1].detail || ''), asked[1].detail);

  // --- confirming deletes, and only the one clicked ---
  answer = 0;
  await clickDelete('09:00');
  check('confirmar borra la carpeta', !fs.existsSync(EMPTY), 'sigue ahí');
  check('no toca la otra reunión', fs.existsSync(FULL), 'borró la que no era');

  list = await rows();
  check('la lista se actualiza sola', list.length === 1, JSON.stringify(list));
  check('la que queda es la buena',
    list[0] && list[0].title === 'Real Meeting', JSON.stringify(list[0]));

  console.log(fails ? `\n${fails} fallos` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(e => { console.log('FAIL', e.stack || e.message); app.exit(1); });
