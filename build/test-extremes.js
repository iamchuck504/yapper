// Another lens: extremes. Long meetings, absurd inputs, awkward text, and a
// sidebar with hundreds of entries. All of it is real — a two-hour meeting is a
// Tuesday, and names have accents in them.
const path = require('path');
const fs = require('fs');
const { app, dialog } = require('electron');
const { sandbox, logger, mainWindow, within } = require('./harness');

const ROOT = sandbox('extremes');
const say = logger(ROOT);
const engine = require('../engine');

let fails = 0;
function check(name, ok, detail) {
  if (ok) say(`ok    ${name}`);
  else { fails++; say(`FAIL  ${name}\n      ${detail}`); }
}

const saved = path.join(ROOT, 'out');
dialog.showSaveDialog = async (_w, o) => ({ canceled: false, filePath: saved + path.extname(o.defaultPath || '.md') });
dialog.showMessageBox = async () => ({ response: 1 });
require('../main.js');

function meeting(name, files) {
  const folder = path.join(ROOT, 'Meetings', name);
  fs.mkdirSync(folder, { recursive: true });
  for (const [f, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(folder, f), content, 'utf8');
  }
  return folder;
}

app.whenReady().then(async () => {
  const win = await mainWindow({ settleMs: 1500 });
  const $ = js => win.webContents.executeJavaScript(js, true);

  // ---- 1. the clock past an hour ----
  say('--- 1. the timer in long meetings ---');
  const stamps = await $(`[0, 59000, 60000, 3599000, 3600000, 7261000, 36000000, 359999000]
    .map(ms => stamp(ms))`);
  say(`  ${JSON.stringify(stamps)}`);
  check('under a minute', stamps[0] === '00:00', stamps[0]);
  check('just before the hour', stamps[3] === '59:59', stamps[3]);
  check('crossing the hour mark adds the field', stamps[4] === '01:00:00', stamps[4]);
  check('two hours and a minute', stamps[5] === '02:01:01', stamps[5]);
  check('diez horas', stamps[6] === '10:00:00', stamps[6]);
  check('a hundred hours does not overflow', /^\d{2,3}:\d\d:\d\d$/.test(stamps[7]), stamps[7]);

  // splitStamp is handed a heading with the "## " already stripped by
  // parseSections, so that is what it gets here too
  const parsed = await $(`['Decisions [24:05]', 'Decisions [1:24:05]',
    'Decisions [01:24:05]', 'No stamp here', 'Weird [99:99:99]']
    .map(t => splitStamp(t))`);
  say(`  ${JSON.stringify(parsed)}`);
  check('lee mm:ss', parsed[0].at === '24:05' && parsed[0].title === 'Decisions', JSON.stringify(parsed[0]));
  check('lee h:mm:ss', parsed[1].at === '1:24:05', JSON.stringify(parsed[1]));
  check('reads hh:mm:ss from a long meeting', parsed[2].at === '01:24:05', JSON.stringify(parsed[2]));
  check('with no timestamp it invents none', parsed[3].at === '' && parsed[3].title === 'No stamp here',
    JSON.stringify(parsed[3]));

  // ---- 2. a long meeting, transcribed for real ----
  say('\n--- 2. a genuinely long meeting ---');
  const src = process.env.WAV || path.join(process.env.TEMP, 'yapper-60s.wav');
  const minute = fs.readFileSync(src).subarray(engine.WAV_HEADER);
  const LONG_MIN = Number(process.env.MINUTES || 75);
  const long = meeting('2026-07-29_1900', {});
  const out = fs.openSync(path.join(long, 'recording.wav'), 'w');
  fs.writeSync(out, engine.wavFromPcm(Buffer.alloc(0)), 0, engine.WAV_HEADER, 0);
  for (let i = 0; i < LONG_MIN; i++) {
    fs.writeSync(out, minute, 0, minute.length, engine.WAV_HEADER + i * minute.length);
  }
  fs.closeSync(out);
  const bytes = fs.statSync(path.join(long, 'recording.wav')).size;
  say(`  ${LONG_MIN} min, ${(bytes / 1024 / 1024).toFixed(0)} MB`);
  check('the header repairs itself in a file that size',
    engine.repairWav(path.join(long, 'recording.wav')) === true, 'no repair was needed');

  const before = process.memoryUsage().rss;
  const t0 = Date.now();
  const tr = await within(
    $(`window.yapper.transcribe(${JSON.stringify(long)}).then(t => t.length, e => 'err:' + e.message)`),
    'transcribir 75 min', 600000).catch(e => 'colgado:' + e.message);
  const took = (Date.now() - t0) / 1000;
  const grew = (process.memoryUsage().rss - before) / 1024 / 1024;
  say(`  ${took.toFixed(0)} s (${(LONG_MIN * 60 / took).toFixed(0)}x realtime), memory +${grew.toFixed(0)} MB`);
  check('transcribes a meeting longer than an hour', typeof tr === 'number' && tr > 1000, String(tr).slice(0, 120));
  check('memory does not blow up', grew < 400, `grew by ${grew.toFixed(0)} MB`);

  const text = fs.readFileSync(path.join(long, 'transcript.txt'), 'utf8');
  const last = text.trim().split('\n').pop();
  say(`  last line: ${last.slice(0, 70)}`);
  check('the timestamps go past an hour', /^\[0[1-9]:/.test(last), last.slice(0, 40));
  check('the timestamps are in order',
    (() => {
      const secs = [...text.matchAll(/^\[(\d+):(\d\d):(\d\d)\]/gm)]
        .map(m => +m[1] * 3600 + +m[2] * 60 + +m[3]);
      return secs.every((s, i) => i === 0 || s >= secs[i - 1]);
    })(), 'some timestamp goes backwards');

  // ---- 3. awkward text ----
  say('\n--- 3. awkward text ---');
  const odd = meeting('2026-07-29_1901', {
    'title.txt': 'Review with Maya Ürsula & Chuck — "the 100%" <urgent> #1',
    'participants.txt': 'Maya Ürsula, Chuck O\'Brien, 田中さん',
    'transcript.txt': '[00:00:01] We talked about 50% and *this* and _that_.\n[00:00:09] 田中さん said yes. 🎉',
    'notes.md': '## Summary [00:01]\nWent well — 100% agreement.\n\n## Action items [00:09]\n- Maya Ürsula: review *the report*\n'
  });
  const loaded = await $(`window.yapper.loadMeeting(${JSON.stringify(odd)})`);
  check('reads a title with accents, quotes and symbols',
    loaded.title.includes('Maya') && loaded.title.includes('100%'), loaded.title);
  check('reads participants with non-Latin characters',
    loaded.participants.includes('田中'), loaded.participants);

  await $(`(async () => {
    currentFolder = ${JSON.stringify(odd)};
    const d = await window.yapper.loadMeeting(currentFolder);
    openMeetingView(d.title, d.summary, d.transcript, d.hasRecording, d.participants);
  })()`);
  await new Promise(r => setTimeout(r, 400));
  const shown = await $(`({
    title: document.getElementById('result-title').textContent,
    notes: document.getElementById('notes').textContent,
    escaped: document.getElementById('notes').innerHTML.includes('<urgent>')
  })`);
  check('the title is shown verbatim', shown.title.includes('<urgent>'), shown.title);
  check('does not interpret the text as HTML', !shown.escaped, 'injected raw tags into the DOM');
  check('the notes keep the emoji and the accents',
    shown.notes.includes('Ürsula'), shown.notes.slice(0, 80));

  const exp = await $(`runExport('md')`);
  check('exports a title with forbidden filename characters',
    !!exp && fs.existsSync(exp), String(exp));
  if (exp && fs.existsSync(exp)) {
    check('the export preserves the text',
      fs.readFileSync(exp, 'utf8').includes('Ürsula'), 'something was lost');
  }

  // ---- 4. empty and absurd ----
  say('\n--- 4. empties and absurdities ---');
  const empty = meeting('2026-07-29_1902', { 'recording.wav': '' });
  fs.writeFileSync(path.join(empty, 'recording.wav'), engine.wavFromPcm(Buffer.alloc(0)));
  const r4 = await within(
    $(`window.yapper.transcribe(${JSON.stringify(empty)}).then(t => 'ok:' + t.length, e => 'err:' + e.message)`),
    'transcribing an empty wav', 60000).catch(e => 'colgado:' + e.message);
  say(`  empty wav: ${String(r4).slice(0, 90)}`);
  check('an empty wav neither hangs nor blows up ugly', !String(r4).startsWith('colgado'), String(r4));

  const noHead = meeting('2026-07-29_1903', { 'notes.md': 'Just a paragraph, no headings at all.' });
  await $(`(async () => {
    currentFolder = ${JSON.stringify(noHead)};
    const d = await window.yapper.loadMeeting(currentFolder);
    openMeetingView('Sin secciones', d.summary, d.transcript, false, '');
  })()`);
  await new Promise(r => setTimeout(r, 300));
  check('notes with no sections still render',
    (await $("document.getElementById('notes').textContent")).includes('Just a paragraph'),
    await $("document.getElementById('notes').textContent"));

  // ---- 5. many meetings in the sidebar ----
  say('\n--- 5. the sidebar with many meetings ---');
  for (let i = 0; i < 300; i++) {
    const d = String(i % 28 + 1).padStart(2, '0');
    const m = String(i % 12 + 1).padStart(2, '0');
    meeting(`2025-${m}-${d}_${String(i % 24).padStart(2, '0')}${String(i % 60).padStart(2, '0')}_${i}`,
      { 'title.txt': `Meeting number ${i}`, 'notes.md': '## Summary [00:01]\nok' });
  }
  const t5 = Date.now();
  await $('refreshMeetingList()');
  await new Promise(r => setTimeout(r, 600));
  const rows = await $("document.querySelectorAll('#meeting-list .m-item').length");
  say(`  ${rows} filas en ${Date.now() - t5} ms`);
  check('lists hundreds of meetings', rows >= 300, `${rows} filas`);
  check('and it does not take forever', Date.now() - t5 < 8000, `${Date.now() - t5} ms`);

  const t6 = Date.now();
  await $(`(() => { const s = document.getElementById('search'); s.value = 'number 42';
    s.dispatchEvent(new Event('input')); })()`);
  await new Promise(r => setTimeout(r, 300));
  const found = await $("document.querySelectorAll('#meeting-list .m-item').length");
  check('search is still instant', Date.now() - t6 < 2000, `${Date.now() - t6} ms`);
  check('and it finds the meeting', found >= 1 && found <= 3, `${found} resultados`);

  // ---- 6. the live loop over a long session ----
  // Its rolling buffer is the one thing in the app that could grow without
  // bound, and a two-hour meeting is where that would show.
  say('\n--- 6. live in a long session ---');
  const live = require('../live');
  const tier = engine.tierConfig('fast');
  let confirmed = 0, errors = 0;
  const started = await live.start({
    model: tier.liveModel, cadenceMs: tier.cadenceMs, windowSec: tier.windowSec,
    maxHoldSec: tier.maxHoldSec, language: 'en',
    onLine: o => { if (o.error) errors++; else if (o.commit) confirmed += o.commit.split(/\s+/).length; }
  });
  check('live starts', started === true, String(started));

  if (started) {
    // feed 20 minutes of audio as fast as it will take it
    const rssBefore = process.memoryUsage().rss;
    const block = Math.floor(engine.BYTES_PER_SEC / 5) & ~1;
    const MINUTES = 20;
    for (let m = 0; m < MINUTES; m++) {
      for (let at = 0; at < minute.length; at += block) {
        live.write(minute.subarray(at, Math.min(at + block, minute.length)));
      }
      await new Promise(r => setTimeout(r, 40));
    }
    // give it long enough to do several passes on whatever it kept
    await new Promise(r => setTimeout(r, 15000));
    const rssAfter = process.memoryUsage().rss;
    const grewLive = (rssAfter - rssBefore) / 1024 / 1024;
    say(`  ${MINUTES} min pushed in at once: +${grewLive.toFixed(0)} MB, ${confirmed} words, ${errors} errors`);
    // The window is 12 s, so once the audio stops arriving there is only ever
    // 12 s of speech left to confirm — around 30-40 words. What is being checked
    // is that it caught up to the present at all: before the buffer was capped
    // it tried to decode all 20 minutes at once and confirmed nothing.
    check('the live buffer does not grow without bound', grewLive < 60, `grew by ${grewLive.toFixed(0)} MB`);
    check('catches up and confirms the current window', confirmed >= 20, `${confirmed} palabras`);
    check('with no errors along the way', errors === 0, `${errors} errores`);
    await live.stop();
    await engine.stop();
    check('stops cleanly', true, '');
  }

  say(fails ? `\n${fails} fallos` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(e => { say('FAIL ' + (e.stack || e.message)); app.exit(1); });
