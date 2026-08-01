// Clicks through the whole app watching for errors nobody would otherwise see.
// A thrown exception in the renderer does not crash anything — the button just
// stops working — so this listens for them while opening every view, toggling
// every control and running every export.
const path = require('path');
const fs = require('fs');
const { app, dialog } = require('electron');
const { mainWindow } = require('./harness');

const BASE = path.join(app.getPath('temp'), 'yapper-smoke-test');
let ROOT = BASE;
try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { ROOT = `${BASE}-${process.pid}`; }
fs.mkdirSync(path.join(ROOT, 'Meetings'), { recursive: true });
app.setPath('documents', ROOT);
app.setPath('userData', path.join(ROOT, 'user'));

// one finished meeting to click around in
const folder = path.join(ROOT, 'Meetings', '2026-07-29_1600');
fs.mkdirSync(folder);
fs.writeFileSync(path.join(folder, 'title.txt'), 'Launch Sync', 'utf8');
fs.writeFileSync(path.join(folder, 'transcript.txt'),
  '[00:00:01] We ship on Friday.\n[00:00:20] Maya owns the rollout.\n[00:02:40] Anything else?', 'utf8');
fs.writeFileSync(path.join(folder, 'notes.md'), `## Summary [00:01]
The team agreed on a Friday launch.

## Action items [00:20]
- Maya: prepare the rollout plan

## Open questions [02:40]
- Nothing outstanding.
`, 'utf8');
fs.writeFileSync(path.join(folder, 'recording.wav'), Buffer.alloc(44 + 32000 * 10));

let fails = 0;
const problems = [];
function check(name, ok, detail) {
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      ${detail}`); }
}

const saved = path.join(ROOT, 'out');
dialog.showSaveDialog = async (_w, o) => ({ canceled: false, filePath: saved + path.extname(o.defaultPath || '.txt') });
dialog.showMessageBox = async () => ({ response: 1 });   // never actually delete

require('../main.js');

app.whenReady().then(async () => {
  // settle straight away, so the listeners below are attached before anything
  // interesting happens on the page
  const win = await mainWindow({ settleMs: 0 });

  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) problems.push(`${message}  (${path.basename(source || '')}:${line})`);
  });
  win.webContents.on('render-process-gone', (_e, d) => problems.push(`el renderer murió: ${d.reason}`));
  win.webContents.on('preload-error', (_e, p, err) => problems.push(`preload: ${err.message}`));

  await new Promise(r => setTimeout(r, 1200));

  const $ = js => win.webContents.executeJavaScript(js, true);
  const click = async sel => {
    await $(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) throw new Error('no existe ' + ${JSON.stringify(sel)}); el.click(); })()`);
    await new Promise(r => setTimeout(r, 250));
  };

  // ---- it opens on the day, and the detected-meeting card floats above it ----
  check('abre en Today',
    !(await $("document.getElementById('view-home').classList.contains('hidden')")), 'no abrió ahí');

  win.webContents.send('meeting-detected', { app: 'Zoom' });
  await new Promise(r => setTimeout(r, 400));
  // offsetParent is always null on a fixed element, so visibility is measured
  // from the box it actually occupies inside the window.
  const prompt = await $(`(() => { const el = document.getElementById('meeting-prompt');
    const r = el.getBoundingClientRect();
    const css = getComputedStyle(el);
    return { hidden: el.classList.contains('hidden'), inRecordView: !!el.closest('#view-record'),
      w: Math.round(r.width), h: Math.round(r.height),
      onScreen: r.width > 0 && r.height > 0 && r.top >= 0 && r.left >= 0
        && r.bottom <= innerHeight && r.right <= innerWidth,
      shown: css.display !== 'none' && css.visibility !== 'hidden' && +css.opacity > 0,
      text: el.textContent }; })()`);
  check('el aviso de reunión detectada se ve estando en Today',
    !prompt.hidden && prompt.shown && prompt.onScreen && !prompt.inRecordView, JSON.stringify(prompt));
  check('y dice qué lo disparó', /Zoom/.test(prompt.text), prompt.text);
  await click('#mp-dismiss');
  check('se puede descartar',
    await $("document.getElementById('meeting-prompt').classList.contains('hidden')"), 'sigue ahí');

  // ---- every view opens ----
  await click('#btn-reminders');
  check('la vista de recordatorios abre',
    !(await $("document.getElementById('view-reminders').classList.contains('hidden')")), 'sigue oculta');
  await click('#btn-new');
  check('vuelve a la vista de grabar',
    !(await $("document.getElementById('view-record').classList.contains('hidden')")), 'sigue oculta');

  // ---- open the meeting ----
  await $('refreshMeetingList()');
  await new Promise(r => setTimeout(r, 400));
  await click('#meeting-list .m-item');
  check('la reunión abre',
    !(await $("document.getElementById('view-meeting').classList.contains('hidden')")), 'sigue oculta');
  check('pinta las notas por secciones',
    (await $("document.querySelectorAll('#notes .note-sec').length")) >= 3,
    await $("document.querySelectorAll('#notes .note-sec').length"));
  check('colorea la sección de pendientes',
    (await $("document.querySelectorAll('#notes .sec-action').length")) >= 1, 'ninguna');

  // ---- action items become reminders ----
  const addBtn = await $("document.querySelectorAll('#notes .li-add').length");
  check('los pendientes ofrecen añadirse a recordatorios', addBtn >= 1, `${addBtn} botones`);
  if (addBtn >= 1) {
    await click('#notes .li-add');
    check('el botón confirma que se añadió',
      (await $("document.querySelector('#notes .li-add').textContent")).includes('added'),
      await $("document.querySelector('#notes .li-add').textContent"));
    await click('#btn-reminders');
    const n = await $("document.querySelectorAll('#reminders-list .reminder').length");
    check('el recordatorio queda guardado', n >= 1, `${n} en la lista`);
    check('el contador del menú lo refleja',
      !(await $("document.getElementById('reminders-count').classList.contains('hidden')")), 'sigue oculto');
    await click('#meeting-list .m-item');
  }

  // ---- editing notes by hand ----
  await click('#btn-edit');
  check('el modo edición se activa',
    await $("document.getElementById('notes-editor') && !document.getElementById('notes-editor').classList.contains('hidden')"),
    'no apareció el editor');
  await $(`(() => { const t = document.getElementById('notes-textarea');
    t.value = currentNotesMd + '\\n\\n## Next steps [03:00]\\n- Ship it.'; })()`);
  await click('#btn-save-notes');
  await new Promise(r => setTimeout(r, 400));
  check('la edición se guarda en disco',
    fs.readFileSync(path.join(folder, 'notes.md'), 'utf8').includes('Ship it'), 'no se guardó');

  // ---- every export ----
  for (const kind of ['md', 'txt', 'transcript-md', 'both']) {
    const out = await $(`runExport(${JSON.stringify(kind)})`);
    check(`export ${kind}`, !!out && fs.existsSync(out), String(out));
  }
  const pdf = await $(`runExport('pdf')`);
  check('export pdf', !!pdf && fs.existsSync(pdf) && fs.statSync(pdf).size > 1000,
    `${pdf} (${pdf && fs.existsSync(pdf) ? fs.statSync(pdf).size : 0} bytes)`);

  // ---- copy, speak, and the option toggles ----
  await click('#btn-copy');
  check('copiar no revienta', true, '');
  await click('#btn-speak');
  await new Promise(r => setTimeout(r, 300));
  await click('#btn-speak');            // and stop again
  // Claro de salida, y el interruptor lleva y trae. El arranque se afirma aquí
  // porque main pinta el fondo de la ventana desde el mismo valor guardado: si
  // los dos dejan de coincidir, el primer arranque abre con un destello del
  // tema contrario.
  check('arranca en claro', await $("document.body.classList.contains('light')"), 'arrancó oscuro');
  await click('#btn-theme');
  check('el interruptor lleva al oscuro',
    !(await $("document.body.classList.contains('light')")), 'siguió claro');
  await click('#btn-theme');
  check('y vuelve al claro', await $("document.body.classList.contains('light')"), 'se quedó oscuro');

  await click('#btn-new');
  for (const sel of ['#style-pills .seg-btn:nth-child(3)', '#detail-seg .seg-btn:nth-child(2)',
    '#noise-seg .seg-btn:nth-child(3)']) {
    await click(sel);
  }
  check('las opciones quedan marcadas',
    (await $("document.querySelectorAll('#style-pills .seg-btn.active, #detail-seg .seg-btn.active, #noise-seg .seg-btn.active').length")) === 3,
    'alguna no se marcó');

  // ---- the search box ----
  await $(`(() => { const s = document.getElementById('search'); s.value = 'launch';
    s.dispatchEvent(new Event('input')); })()`);
  await new Promise(r => setTimeout(r, 200));
  check('la búsqueda encuentra la reunión',
    (await $("document.querySelectorAll('#meeting-list .m-item').length")) === 1, 'no la encontró');
  await $(`(() => { const s = document.getElementById('search'); s.value = 'zzzz';
    s.dispatchEvent(new Event('input')); })()`);
  await new Promise(r => setTimeout(r, 200));
  check('sin resultados muestra el aviso',
    (await $("!!document.querySelector('#meeting-list .m-empty')")), 'no avisa');
  await $(`(() => { const s = document.getElementById('search'); s.value = '';
    s.dispatchEvent(new Event('input')); })()`);

  // ---- the error path: a meeting whose folder vanished ----
  const gone = path.join(ROOT, 'Meetings', 'no-existe');
  const err = await $(`window.yapper.transcribe(${JSON.stringify(gone)}).then(() => null, e => e.message)`);
  check('una carpeta inexistente da un error legible',
    typeof err === 'string' && err.length > 10 && !/undefined/.test(err), String(err));

  check('nada lanzó errores por el camino', problems.length === 0,
    problems.slice(0, 6).join('\n      '));

  console.log(fails ? `\n${fails} fallos` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(e => { console.log('FAIL', e.stack || e.message); app.exit(1); });
