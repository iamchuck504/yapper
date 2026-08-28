// What a brand-new install actually says on screen.
//
// Not a test: a probe. It boots the app against an empty profile — no meetings,
// no reminders, no index — and prints the visible text of every view, so the
// first-run experience can be read rather than guessed at from string literals.
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { sandbox, logger, mainWindow } = require('./harness');

const ROOT = sandbox('empty-probe');
fs.mkdirSync(path.join(ROOT, 'Meetings'), { recursive: true });
const say = logger(ROOT);

require('../main.js');

app.whenReady().then(async () => {
  const win = await mainWindow({ settleMs: 2000 });
  const $ = js => win.webContents.executeJavaScript(js, true);

  // Only what a person could actually read: skip hidden nodes.
  const visibleText = sel => $(`(() => {
    const root = document.querySelector(${JSON.stringify(sel)});
    if (!root) return '(no existe ' + ${JSON.stringify(sel)} + ')';
    const out = [];
    const walk = el => {
      const css = getComputedStyle(el);
      if (css.display === 'none' || css.visibility === 'hidden') return;
      for (const node of el.childNodes) {
        if (node.nodeType === 3) { const t = node.textContent.trim(); if (t) out.push(t); }
        else if (node.nodeType === 1) walk(node);
      }
    };
    walk(root);
    return out.join(' | ');
  })()`);

  const show = async (label, sel) => {
    say(`\n### ${label}`);
    say('  ' + (await visibleText(sel)).replace(/\s*\|\s*/g, '\n  '));
  };

  say(`empty profile: ${ROOT}`);
  say(`meetings on disk: ${fs.readdirSync(path.join(ROOT, 'Meetings')).length}`);

  await show('Sidebar', '#sidebar');
  await show('New meeting (the view it opens on)', '#view-record');

  await $(`document.getElementById('btn-home').click()`);
  await new Promise(r => setTimeout(r, 400));
  await show('Today', '#view-home');

  await $(`document.querySelector('#home-scope .seg-btn[data-scope="week"]').click()`);
  await new Promise(r => setTimeout(r, 2500));
  await show('This week', '#view-home');

  await $(`document.getElementById('btn-search-view').click()`);
  await new Promise(r => setTimeout(r, 400));
  await show('Search (without searching for anything)', '#view-search');

  await $(`(() => { document.getElementById('search-q').value = 'pricing';
    document.getElementById('btn-search').click(); })()`);
  await new Promise(r => setTimeout(r, 1200));
  say('\n### Search (looking for something)');
  say('  status: ' + await $("document.getElementById('search-status').textContent"));

  await $(`document.getElementById('btn-reminders').click()`);
  await new Promise(r => setTimeout(r, 500));
  await show('Action items', '#view-reminders');

  await $(`document.getElementById('btn-new').click()`);
  await new Promise(r => setTimeout(r, 400));
  await show('New meeting', '#view-record');

  say('\n### What you see at startup (status/preflight)');
  say('  ' + await $(`(() => { const el = document.getElementById('status');
    return el.classList.contains('hidden') ? '(none)' : el.textContent; })()`));

  app.exit(0);
}).catch(e => { say('FAIL ' + (e.stack || e.message)); app.exit(1); });
