// Two things the app used to get wrong about a *new* meeting: it prefilled last
// meeting's attendees, and it had no Memo style. Both are checked against the
// real window, including across a reload, which is where the old behaviour came
// from — the names were persisted in localStorage.
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const ROOT = path.join(app.getPath('temp'), 'yapper-options-test');
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, 'Meetings'), { recursive: true });
app.setPath('documents', ROOT);
app.setPath('userData', path.join(ROOT, 'user'));

let fails = 0;
function check(name, ok, detail) {
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      ${detail}`); }
}

require('../main.js');

app.whenReady().then(async () => {
  const { BrowserWindow } = require('electron');
  const win = await new Promise(resolve => {
    const tick = setInterval(() => {
      const w = BrowserWindow.getAllWindows().find(x => x.webContents.getURL().includes('index.html'));
      if (w) { clearInterval(tick); resolve(w); }
    }, 200);
  });
  await new Promise(r => win.webContents.once('did-finish-load', r));
  await new Promise(r => setTimeout(r, 1200));

  const $ = js => win.webContents.executeJavaScript(js);

  // --- Memo is offered, and it is a real style ---
  const styles = await $(`[...document.querySelectorAll('#style-pills .seg-btn')].map(b => b.dataset.style)`);
  check('Memo aparece entre los estilos', styles.includes('memo'), styles.join(', '));
  const regenStyles = await $(`[...document.getElementById('regen-style').options].map(o => o.value)`);
  check('Memo también al regenerar', regenStyles.includes('memo'), regenStyles.join(', '));

  // --- attendees are per meeting, not a preference ---
  await $(`(() => {
    document.querySelector('#style-pills .seg-btn[data-style="memo"]').click();
    const p = document.getElementById('participants-rec');
    p.value = 'Ninfa, Chuck';
    p.dispatchEvent(new Event('change'));
    document.getElementById('custom-instructions').value = 'focus on the launch';
    document.getElementById('custom-instructions').dispatchEvent(new Event('change'));
  })()`);
  await new Promise(r => setTimeout(r, 300));

  const stored = await $(`localStorage.getItem('yapper-options')`);
  check('los nombres NO se guardan en las preferencias',
    !stored.includes('Ninfa'), stored);
  check('lo que sí es preferencia se guarda',
    stored.includes('memo') && stored.includes('focus on the launch'), stored);

  // reload: this is what a next launch looks like
  win.webContents.reload();
  await new Promise(r => win.webContents.once('did-finish-load', r));
  await new Promise(r => setTimeout(r, 1200));

  check('al reabrir, el campo de asistentes está vacío',
    (await $(`document.getElementById('participants-rec').value`)) === '',
    await $(`document.getElementById('participants-rec').value`));
  check('al reabrir, el estilo elegido sí se recuerda',
    (await $(`document.querySelector('#style-pills .seg-btn.active').dataset.style`)) === 'memo',
    await $(`document.querySelector('#style-pills .seg-btn.active').dataset.style`));
  check('al reabrir, las instrucciones sí se recuerdan',
    (await $(`document.getElementById('custom-instructions').value`)) === 'focus on the launch',
    await $(`document.getElementById('custom-instructions').value`));

  // "New meeting" must clear them too, without a reload
  await $(`(() => {
    const p = document.getElementById('participants-rec');
    p.value = 'Someone Else';
    document.getElementById('btn-new').click();
  })()`);
  await new Promise(r => setTimeout(r, 300));
  check('"New" limpia los asistentes',
    (await $(`document.getElementById('participants-rec').value`)) === '',
    await $(`document.getElementById('participants-rec').value`));

  console.log(fails ? `\n${fails} fallos` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(e => { console.log('FAIL', e.stack || e.message); app.exit(1); });
