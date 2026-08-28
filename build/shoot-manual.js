// Screenshots for the manual, taken from the real app against seeded demo
// data. Every image in docs/img/ comes from this script, so retaking them
// after a UI change is one command:
//
//   node_modules\electron\dist\electron.exe build\shoot-manual.js
//
// The two provider-written panels use deterministic demo prose over the real
// indexed meetings. Screenshots must be reproducible without an account or a
// network; everything around that prose is still rendered by the production UI.
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');
const { sandbox, logger, mainWindow } = require('./harness');

const ROOT = sandbox('shoot-manual');
const say = logger(ROOT);
const OUT = path.join(__dirname, '..', 'docs', 'img');
fs.mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- demo data

const p = n => String(n).padStart(2, '0');
const now = new Date();
const iso = d => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
const TODAY = iso(now);
const day = off => iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + off));
const monday = iso(new Date(now.getFullYear(), now.getMonth(),
  now.getDate() - ((now.getDay() + 6) % 7)));

function meeting(name, files) {
  const folder = path.join(ROOT, 'Meetings', name);
  fs.mkdirSync(folder, { recursive: true });
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(folder, f), c, 'utf8');
}

meeting(`${monday}_1000`, {
  'title.txt': 'Q3 Planning',
  'participants.txt': 'Ana, Luis, Sam',
  'transcript.txt': `[00:00:04] Let us lock the quarter down today.
[00:03:12] Ana: the new pricing lands at twenty nine a month, we all agreed last time.
[00:07:45] The rollout targets the second week of August.
[00:15:30] Luis: I still do not know who owns the migration runbook.
[00:22:10] Sam: I will draft the pricing page and send it around.`,
  'notes.md': `## Summary [00:04]
The team locked the Q3 plan: pricing confirmed and the rollout scheduled.

## Decisions [03:12]
- New pricing is twenty nine dollars a month.
- The rollout targets the second week of August.

## Open questions [15:30]
- Nobody owns the migration runbook yet.

## Action items [22:10]
- Sam: draft the pricing page by August 4
- Luis: confirm the vendor contract by July 28
`
});

meeting(`${day(-1)}_1500`, {
  'title.txt': 'Design Review',
  'participants.txt': 'Ana, Marta',
  'transcript.txt': `[00:00:06] Marta walked through the new onboarding flow.
[00:09:40] Ana: the empty states need real copy, not lorem ipsum.
[00:18:02] We agreed to cut the tour to three steps.`,
  'notes.md': `## Summary [00:06]
Review of the onboarding flow. The tour gets shorter.

## Decisions [18:02]
- The onboarding tour is cut from seven steps to three.

## Action items [09:40]
- Marta: write real copy for the empty states
`
});

meeting(`${TODAY}_0900`, {
  'title.txt': 'Standup',
  'participants.txt': 'Ana, Luis, Sam',
  'transcript.txt': `[00:00:03] Quick round before the vendor call.
[00:04:18] The rollout moves up one week: August first.
[00:07:50] Sam: pricing page draft is out for review.`,
  'notes.md': `## Summary [00:03]
Short standup. The rollout moved earlier.

## Decisions [04:18]
- The rollout moves up one week, to August 1.

## Action items [07:50]
- Ana: review the pricing page draft by Friday
- URGENT: fix the signup error on mobile
`
});

meeting(`${TODAY}_1600`, {
  'title.txt': 'Vendor Sync',
  'participants.txt': 'Luis, Sam',
  'transcript.txt': `[00:00:05] The vendor says the contract needs one more legal pass.
[00:12:30] Delivery stays on schedule if we sign this week.`
  // no notes on purpose: Today flags it as "needs attention"
});

meeting('2026-07-14_1100', {
  'title.txt': 'Retro: onboarding sprint',
  'participants.txt': 'Ana, Marta, Luis',
  'transcript.txt': '[00:00:07] What went well, what did not.',
  'notes.md': `## Summary [00:07]
Sprint retro. Mostly positive.

## Action items [00:07]
- Luis: archive the old landing experiments
`
});

// ---------------------------------------------------------------- shooting

require('../main.js');

const shot = async (win, name) => {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, name), img.toPNG());
  say(`  ${name}  ${img.getSize().width}x${img.getSize().height}`);
};

app.whenReady().then(async () => {
  const win = await mainWindow({ settleMs: 2000 });
  const $ = js => win.webContents.executeJavaScript(js, true);
  const wait = ms => new Promise(r => setTimeout(r, ms));

  // Match the real default window so the manual never advertises a layout the
  // installed app does not open with.
  win.setBounds({ x: 40, y: 40, width: 1100, height: 840 });
  await $('window.yapper.refreshLibrary()');
  await wait(400);

  // -- 1. Today --
  await $(`document.getElementById('btn-home').click()`);
  await wait(900);
  await shot(win, '01-today.png');

  // -- 2. the meeting-detected card floating over it --
  win.webContents.send('meeting-detected', { app: 'Zoom' });
  await wait(500);
  await shot(win, '02-meeting-detected.png');
  await $(`document.getElementById('mp-dismiss').click()`);

  // -- 3. This week --
  await $(`document.querySelector('#home-scope .seg-btn[data-scope="week"]').click()`);
  await wait(500);
  await $(`(async () => {
    const w = await window.yapper.weeklySummary({});
    const refs = {
      q3: { title: 'Q3 Planning', folder: ${JSON.stringify(path.join(ROOT, 'Meetings', `${monday}_1000`))} },
      standup: { title: 'Standup', folder: ${JSON.stringify(path.join(ROOT, 'Meetings', `${TODAY}_0900`))} },
      design: { title: 'Design Review', folder: ${JSON.stringify(path.join(ROOT, 'Meetings', `${day(-1)}_1500`))} }
    };
    renderWeek({ ...w, reason: undefined, writing: false, cached: false,
      fromMeetings: 3, dropped: 0, truncated: 0,
      sections: [
        { title: 'Threads', items: [
          { text: 'Pricing and rollout timing stayed connected throughout the week.', cites: [refs.q3, refs.standup] }
        ] },
        { title: 'Shifts', items: [
          { text: 'The rollout moved forward to August 1.', cites: [refs.q3, refs.standup] }
        ] },
        { title: 'Unresolved', items: [
          { text: 'The migration runbook still needs a clear owner.', cites: [refs.q3, refs.design] }
        ] }
      ]
    });
  })()`);
  await wait(400);
  await shot(win, '03-week.png');

  // -- 4. Action items --
  await $(`document.getElementById('btn-reminders').click()`);
  await wait(700);
  await shot(win, '04-actions.png');

  // -- 5. Search, with deterministic grounded prose over real search results --
  await $(`document.getElementById('btn-search-view').click()`);
  await wait(300);
  await $(`(async () => {
    const query = 'What did we decide about pricing?';
    document.getElementById('search-q').value = query;
    const res = await window.yapper.search(query, { limit: 20 });
    renderSearchResults(res);
    showSearchAnswer('The new price is $29 per month. [Q3 Planning]');
    document.getElementById('search-status').classList.add('hidden');
  })()`);
  await wait(300);
  await shot(win, '05-search.png');

  // -- 6. a meeting, notes rendered in sections --
  await $(`(async () => {
    const items = document.querySelectorAll('#meeting-list .m-item');
    for (const it of items) { if (it.textContent.includes('Q3 Planning')) { it.click(); break; } }
  })()`);
  await wait(1200);
  await shot(win, '06-meeting.png');

  // -- 7. the record view, options on show --
  await $(`document.getElementById('btn-new').click()`);
  await wait(500);
  win.setBounds({ x: 40, y: 40, width: 1100, height: 840 });
  await wait(400);
  await shot(win, '07-new-meeting.png');

  // -- 8. recording, with synthetic audio so the waveforms are honest --
  await $(`(() => {
    const gen = new AudioContext();
    const mk = freq => {
      const dest = gen.createMediaStreamDestination();
      const o = gen.createOscillator(); o.frequency.value = freq;
      const wob = gen.createOscillator(); wob.frequency.value = 0.7;
      const wobG = gen.createGain(); wobG.gain.value = 0.35;
      const g = gen.createGain(); g.gain.value = 0.4;
      wob.connect(wobG); wobG.connect(g.gain);
      o.connect(g); g.connect(dest); o.start(); wob.start();
      return dest.stream;
    };
    navigator.mediaDevices.getDisplayMedia = async () => mk(340);
    navigator.mediaDevices.getUserMedia = async () => mk(210);
  })()`);
  await $('startRecording()');
  await wait(2600);
  win.setBounds({ x: 40, y: 40, width: 1100, height: 840 });
  await wait(300);
  await shot(win, '08-recording.png');

  // -- 9. the capsule, resting and on hover --
  const bubble = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('bubble.html'));
  if (bubble) {
    await wait(600);
    await shot(bubble, '09-capsule.png');
    bubble.webContents.send('bubble-state', { hover: true });
    await wait(600);
    await shot(bubble, '10-capsule-open.png');
  } else {
    say('  (no bubble — bubbleEnabled off?)');
  }

  say('\nready in docs/img/');
  app.exit(0);
}).catch(e => { say('FAIL ' + (e.stack || e.message)); app.exit(1); });
