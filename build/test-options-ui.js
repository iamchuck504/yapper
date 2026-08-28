// Two things the app used to get wrong about a *new* meeting: it prefilled last
// meeting's attendees, and it had no Memo style. Both are checked against the
// real window, including across a reload, which is where the old behaviour came
// from — the names were persisted in localStorage.
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { mainWindow } = require('./harness');

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
  const win = await mainWindow();

  const $ = js => win.webContents.executeJavaScript(js);

  // --- Memo is offered, and it is a real style ---
  const styles = await $(`[...document.querySelectorAll('#style-pills .seg-btn')].map(b => b.dataset.style)`);
  check('Memo appears among the styles', styles.includes('memo'), styles.join(', '));
  const regenStyles = await $(`[...document.getElementById('regen-style').options].map(o => o.value)`);
  check('Memo on regenerate too', regenStyles.includes('memo'), regenStyles.join(', '));

  // The redesign exposes the frequent spoken-language choice beside the mic,
  // while Settings keeps the canonical control. They must remain one setting,
  // whichever doorway is used.
  await $(`document.getElementById('btn-new').click()`);
  check('the quick spoken-language control starts in sync',
    await $(`document.getElementById('quick-spoken-lang').value === document.getElementById('spoken-lang').value`),
    await $(`document.getElementById('quick-spoken-lang').value + ' / ' + document.getElementById('spoken-lang').value`));
  await $(`(() => { const q = document.getElementById('quick-spoken-lang');
    q.value = 'es'; q.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  check('changing the quick language updates the full setting',
    await $(`document.getElementById('spoken-lang').value === 'es'
      && localStorage.getItem('yapper-spoken-lang') === 'es'`),
    await $(`document.getElementById('spoken-lang').value + ' / ' + localStorage.getItem('yapper-spoken-lang')`));
  await $(`(() => { const full = document.getElementById('spoken-lang');
    full.value = 'auto'; full.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  check('changing the full setting updates the quick language',
    await $(`document.getElementById('quick-spoken-lang').value === 'auto'`),
    await $(`document.getElementById('quick-spoken-lang').value`));

  // Settings is shorter because it shows one category at a time, not because
  // controls were removed. Every old option remains in its intended section.
  const sections = {
    notes: ['style-pills', 'detail-seg', 'lang-seg', 'custom-instructions', 'llm-provider'],
    recording: ['noise-seg', 'spoken-lang', 'participants-rec', 'opt-identify-speakers', 'opt-keep-audio'],
    during: ['opt-bubble', 'opt-autodetect', 'opt-startup', 'corner-seg'],
    app: ['theme-seg']
  };
  await $(`document.getElementById('btn-settings').click()`);
  for (const [section, ids] of Object.entries(sections)) {
    await $(`document.querySelector('[data-settings-section="${section}"]').click()`);
    const visible = await $(`[...document.querySelectorAll('[data-option-section]')]
      .filter(el => getComputedStyle(el).display !== 'none').map(el => el.dataset.optionSection)`);
    check(`Settings opens only ${section}`, visible.length === 1 && visible[0] === section,
      visible.join(', '));
    const missing = await $(`${JSON.stringify(ids)}.filter(id => {
      const el = document.getElementById(id); return !el || el.closest('[data-option-section]')?.dataset.optionSection !== '${section}';
    })`);
    check(`${section} keeps every existing control`, missing.length === 0, missing.join(', '));
  }
  await $(`document.getElementById('btn-new').click()`);

  // Speaker diarization is an extra local pass, so the fast path must be the
  // default rather than something a new user has to discover and turn off.
  check('speaker identification is visibly optional',
    /Identify speakers/i.test(await $(`document.querySelector('label[for="opt-identify-speakers"], #opt-identify-speakers').parentElement.textContent`))
      && /Optional/i.test(await $(`document.getElementById('opt-identify-speakers').closest('.opt-row').textContent`))
      && /off by default/i.test(await $(`document.getElementById('opt-identify-speakers').closest('.opt-row').textContent`)),
    await $(`document.getElementById('opt-identify-speakers').closest('.opt-row').textContent`));
  check('speaker identification starts off',
    !(await $(`document.getElementById('opt-identify-speakers').checked`)), 'toggle is on');
  await $(`(() => {
    const toggle = document.getElementById('opt-identify-speakers');
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  check('enabling speaker identification is remembered',
    (await $(`localStorage.getItem('yapper-identify-speakers')`)) === 'on',
    await $(`localStorage.getItem('yapper-identify-speakers')`));

  // --- attendees are per meeting, not a preference ---
  await $(`(() => {
    document.querySelector('#style-pills .seg-btn[data-style="memo"]').click();
    const p = document.getElementById('participants-rec');
    p.value = 'Maya, Chuck';
    p.dispatchEvent(new Event('change'));
    document.getElementById('custom-instructions').value = 'focus on the launch';
    document.getElementById('custom-instructions').dispatchEvent(new Event('change'));
  })()`);
  await new Promise(r => setTimeout(r, 300));

  const stored = await $(`localStorage.getItem('yapper-options')`);
  check('the names are NOT saved in the preferences',
    !stored.includes('Maya'), stored);
  check('what genuinely is a preference is saved',
    stored.includes('memo') && stored.includes('focus on the launch'), stored);

  // Left open on purpose: the fold used to remember this and the next launch
  // opened on the wall of settings again, which is the thing the fold exists
  // to prevent.
  await $(`setOptionsOpen(true)`);

  // reload: this is what a next launch looks like
  win.webContents.reload();
  await new Promise(r => win.webContents.once('did-finish-load', r));
  await new Promise(r => setTimeout(r, 1200));

  check('on reopen, the attendees field is empty',
    (await $(`document.getElementById('participants-rec').value`)) === '',
    await $(`document.getElementById('participants-rec').value`));
  check('on reopen, the chosen style is remembered',
    (await $(`document.querySelector('#style-pills .seg-btn.active').dataset.style`)) === 'memo',
    await $(`document.querySelector('#style-pills .seg-btn.active').dataset.style`));
  check('on reopen, the options are folded again',
    await $(`document.getElementById('options-card').classList.contains('collapsed')`),
    'they opened on their own');
  // And the folded line says what is underneath it. It was painted only when
  // the fold opened or closed, so it started blank, or on last time's answer.
  check('and the folded line summarises what was remembered',
    /Memo/.test(await $(`document.getElementById('opts-sum').textContent`))
      && /Speakers on/.test(await $(`document.getElementById('opts-sum').textContent`)),
    await $(`document.getElementById('opts-sum').textContent`));
  check('on reopen, the instructions are remembered',
    (await $(`document.getElementById('custom-instructions').value`)) === 'focus on the launch',
    await $(`document.getElementById('custom-instructions').value`));
  check('on reopen, the speaker choice is remembered',
    await $(`document.getElementById('opt-identify-speakers').checked`), 'toggle returned to off');

  await $(`(() => {
    const toggle = document.getElementById('opt-identify-speakers');
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  check('speaker identification can be switched back off',
    (await $(`localStorage.getItem('yapper-identify-speakers')`)) === 'off',
    await $(`localStorage.getItem('yapper-identify-speakers')`));

  // "New meeting" must clear them too, without a reload
  await $(`(() => {
    const p = document.getElementById('participants-rec');
    p.value = 'Someone Else';
    document.getElementById('btn-new').click();
  })()`);
  await new Promise(r => setTimeout(r, 300));
  check('"New" clears the attendees',
    (await $(`document.getElementById('participants-rec').value`)) === '',
    await $(`document.getElementById('participants-rec').value`));

  console.log(fails ? `\n${fails} failures` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(e => { console.log('FAIL', e.stack || e.message); app.exit(1); });
