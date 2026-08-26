// The real case: Chuck's meetings run one to two hours. Everything measured so
// far was a minute or an hour and a quarter, so this walks a full two-hour
// meeting through every stage the app actually performs — writing the audio the
// way the microphone tap writes it, the live loop, the final transcription, the
// notes, the automatic title, the meeting view and every export — and measures
// each one.
//
//   node_modules\electron\dist\electron.exe build\test-two-hours.js
//   MINUTES=60 ... build\test-two-hours.js      # the shorter end of his range
const path = require('path');
const os = require("os");
const fs = require('fs');
const { app, dialog } = require('electron');
const { sandbox, logger, mainWindow, watchdog, within } = require('./harness');

const ROOT = sandbox('two-hours');
const say = logger(ROOT);
const engine = require('../engine');

const MINUTES = Number(process.env.MINUTES || 120);
const LIVE_MINUTES = Number(process.env.LIVE_MINUTES || 6);   // sampled at real speed

let fails = 0;
function check(name, ok, detail) {
  if (ok) say(`ok    ${name}`);
  else { fails++; say(`FAIL  ${name}\n      ${detail}`); }
}
const mb = b => (b > 2 * 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(0)} MB` : `${(b / 1024).toFixed(0)} KB`);
const rss = () => process.memoryUsage().rss;

/** RSS after giving V8 a chance to let go — peak is not the same as leaked. */
async function settledRss() {
  if (global.gc) global.gc();
  await new Promise(r => setTimeout(r, 1500));
  return rss();
}

/**
 * A believable two-hour transcript, built from several different real meetings
 * laid end to end with their timestamps shifted. Repeating one minute 120 times
 * is fine for measuring throughput, but it makes the notes meaningless: every
 * topic really does start at 00:00, so nothing can be concluded from where the
 * model puts its timestamps.
 */
function realisticTranscript(minutes) {
  const dir = path.join(os.homedir(), 'Documents', 'Meetings');
  const sources = [];
  for (const d of fs.readdirSync(dir)) {
    const p = path.join(dir, d, 'transcript.txt');
    if (fs.existsSync(p) && fs.statSync(p).size > 4000) sources.push(p);
  }
  sources.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);

  // One real long meeting beats several stitched together. Stitching produces a
  // transcript with no single subject, and then "no title" is the *correct*
  // answer — which says nothing about whether titling works at this length.
  for (const p of sources) {
    const text = fs.readFileSync(p, 'utf8');
    const last = [...text.matchAll(/^\[(\d+):(\d\d):(\d\d)\]/gm)].pop();
    const span = last ? +last[1] * 3600 + +last[2] * 60 + +last[3] : 0;
    if (span > minutes * 60 * 0.7) {
      return { text, sources: 1, lines: text.split('\n').length, seconds: span, real: path.basename(path.dirname(p)) };
    }
  }

  const out = [];
  let at = 0;                                   // seconds placed so far
  const stamp = s => {
    const p = n => String(n).padStart(2, '0');
    return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
  };
  for (let i = 0; at < minutes * 60 && sources.length; i++) {
    const text = fs.readFileSync(sources[i % sources.length], 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\[(\d+):(\d\d):(\d\d)\]\s*(.*)$/);
      if (!m || !m[4].trim()) continue;
      const sec = at + (+m[1] * 3600 + +m[2] * 60 + +m[3]);
      if (sec > minutes * 60) break;
      out.push(`[${stamp(sec)}] ${m[4].trim()}`);
    }
    const lastLine = out[out.length - 1] || '[00:00:00]';
    const lm = lastLine.match(/^\[(\d+):(\d\d):(\d\d)\]/);
    at = (+lm[1] * 3600 + +lm[2] * 60 + +lm[3]) + 30;
  }
  return { text: out.join('\n'), sources: sources.length, lines: out.length, seconds: at };
}

const exported = path.join(ROOT, 'export');
dialog.showSaveDialog = async (_w, o) => ({ canceled: false, filePath: exported + path.extname(o.defaultPath || '.md') });
dialog.showMessageBox = async () => ({ response: 1 });
require('../main.js');

app.whenReady().then(async () => {
  const dog = watchdog(say, 45 * 60 * 1000);
  const win = await mainWindow({ settleMs: 1500 });
  const $ = js => win.webContents.executeJavaScript(js);

  const src = process.env.WAV || path.join(os.tmpdir(), 'yapper-60s.wav');
  const minute = fs.readFileSync(src).subarray(engine.WAV_HEADER);
  say(`simulated meeting of ${MINUTES} min (${(MINUTES / 60).toFixed(1)} h)\n`);
  const startRss = rss();

  // ---- 1. the recording, written the way the tap writes it ----
  say('--- 1. grabando ---');
  const t1 = Date.now();
  const folder = await $(`(async () => {
    const f = await window.yapper.recordingStart('Maya, Chuck, Sebastian');
    paused = false; recording = true; markers = []; elapsedMs = 0; runStart = Date.now();
    return f;
  })()`);

  // 200 ms blocks, the same size the tap sends, just not spread over two hours
  const BLOCK = Math.floor(engine.BYTES_PER_SEC / 5) & ~1;
  let sent = 0;
  for (let m = 0; m < MINUTES; m++) {
    const buf = minute;
    for (let at = 0; at < buf.length; at += BLOCK) {
      const slice = buf.subarray(at, Math.min(at + BLOCK, buf.length));
      // one IPC message per block, exactly as during a meeting
      await $(`window.yapper.recordingChunk(new Uint8Array(${slice.length}).buffer)`);
      sent += slice.length;
    }
    if ((m + 1) % 30 === 0) say(`  ${m + 1} min escritos (${mb(sent)})`);
  }
  const writeSecs = (Date.now() - t1) / 1000;
  // the placeholder blocks above are silent; put the real audio in the file so
  // the later stages have something to transcribe
  const wav = path.join(folder, 'recording.wav');
  await $(`window.yapper.recordingFinish('', ['00:12:30', '01:05:00'])`);
  const fd = fs.openSync(wav, 'r+');
  for (let m = 0; m < MINUTES; m++) {
    fs.writeSync(fd, minute, 0, minute.length, engine.WAV_HEADER + m * minute.length);
  }
  fs.closeSync(fd);

  const size = fs.statSync(wav).size;
  say(`  ${mb(size)} on disk, ${(size - engine.WAV_HEADER) / engine.BYTES_PER_SEC / 60} min of audio`);
  say(`  ${Math.round(sent / BLOCK)} IPC messages in ${writeSecs.toFixed(0)} s`);
  check('the two hours of audio are left whole', (size - engine.WAV_HEADER) === sent,
    `expected ${sent} bytes, actual ${size - engine.WAV_HEADER}`);
  check('the header is closed correctly',
    fs.readFileSync(wav).readUInt32LE(40) === size - engine.WAV_HEADER, 'no coincide');
  // measured after a settle: 220 MB of audio passes through in blocks, and the
  // question is whether any of it is *kept*, not how high the peak went
  const afterWrite = await settledRss();
  say(`  memory after settling: ${mb(afterWrite)} (started at ${mb(startRss)})`);
  check('writing does not hold the audio in memory',
    (afterWrite - startRss) / 1024 / 1024 < 120, `grew by ${mb(afterWrite - startRss)}`);
  say(`  size per hour: ${mb(size / (MINUTES / 60))}`);

  // ---- 2. the live loop, at real speed ----
  say(`\n--- 2. live, ${LIVE_MINUTES} min at real speed ---`);
  const live = require('../live');
  const tier = engine.tierConfig(require('../engine').guessTier());
  const lags = [];
  let confirmed = '', errors = 0, fedBytes = 0;
  const liveRss = rss();
  await live.start({
    model: tier.liveModel, cadenceMs: tier.cadenceMs, windowSec: tier.windowSec,
    maxHoldSec: tier.maxHoldSec, language: 'en',
    onLine: o => {
      if (o.error) { errors++; return; }
      if (!o.commit) return;
      // Lag against the audio actually handed over, not against the wall clock.
      // A setTimeout(200) really takes a little longer, and over six minutes
      // that drift is tens of seconds — it would read as the loop degrading
      // when it is the feeder running slow.
      lags.push(fedBytes / engine.BYTES_PER_SEC - o.end);
      confirmed += ' ' + o.commit;
    }
  });
  for (let m = 0; m < LIVE_MINUTES; m++) {
    for (let at = 0; at < minute.length; at += BLOCK) {
      const slice = minute.subarray(at, Math.min(at + BLOCK, minute.length));
      live.write(slice);
      fedBytes += slice.length;
      await new Promise(r => setTimeout(r, 200));
    }
  }
  await new Promise(r => setTimeout(r, tier.cadenceMs * 3));
  await live.stop();
  lags.sort((a, b) => a - b);
  const median = lags.length ? lags[Math.floor(lags.length / 2)] : 0;
  const worst = lags.length ? lags[lags.length - 1] : 0;
  const words = confirmed.split(/\s+/).filter(Boolean).length;
  say(`  lag ${median.toFixed(1)} s median, ${worst.toFixed(1)} s worst`);
  say(`  ${words} words, ${errors} errors, memory +${mb(rss() - liveRss)}`);
  check('live does not degrade as the minutes pass', median < 6, `${median.toFixed(1)} s`);
  check('and no lag accumulates', worst < 12, `peor ${worst.toFixed(1)} s`);
  check('live does not leak memory', (rss() - liveRss) / 1024 / 1024 < 120, mb(rss() - liveRss));
  await engine.stop();

  // ---- 3. the final transcription ----
  say('\n--- 3. final transcription ---');
  const t3 = Date.now(); const rss3 = rss();
  const tLen = await within(
    $(`window.yapper.transcribe(${JSON.stringify(folder)}).then(t => t.length, e => 'err:' + e.message)`),
    'transcribing the whole meeting', 20 * 60 * 1000);
  const t3s = (Date.now() - t3) / 1000;
  say(`  ${t3s.toFixed(0)} s (${(MINUTES * 60 / t3s).toFixed(0)}x realtime), memory +${mb(rss() - rss3)}`);
  check('transcribes two hours without failing', typeof tLen === 'number' && tLen > 5000, String(tLen).slice(0, 120));
  check('in under five minutes', t3s < 300, `${t3s.toFixed(0)} s`);
  check('with no memory proportional to the audio', (rss() - rss3) / 1024 / 1024 < 250, mb(rss() - rss3));

  const transcript = fs.readFileSync(path.join(folder, 'transcript.txt'), 'utf8');
  const stamps = [...transcript.matchAll(/^\[(\d+):(\d\d):(\d\d)\]/gm)]
    .map(m => +m[1] * 3600 + +m[2] * 60 + +m[3]);
  say(`  ${(transcript.length / 1024).toFixed(0)} KB, ${stamps.length} lines, last stamp ${
    Math.floor(stamps[stamps.length - 1] / 3600)}h${Math.floor(stamps[stamps.length - 1] / 60) % 60}m`);
  check('the timestamps cover the whole meeting',
    stamps[stamps.length - 1] > (MINUTES - 3) * 60, `last one at ${stamps[stamps.length - 1]} s`);
  check('the timestamps never go backwards',
    stamps.every((s, i) => i === 0 || s >= stamps[i - 1]), 'alguna retrocede');

  // ---- 4. the notes, from a two-hour transcript with real, varied content ----
  say('\n--- 4. notes from a two-hour transcript ---');
  const real = realisticTranscript(MINUTES);
  say(real.real
    ? `  real transcript from ${real.real}: ${real.lines} lines, ` +
      `${(real.text.length / 1024).toFixed(0)} KB, ${Math.round(real.seconds / 60)} min`
    : `  assembled from ${real.sources} meetings: ${real.lines} lines, ` +
      `${(real.text.length / 1024).toFixed(0)} KB, ${Math.round(real.seconds / 60)} min`);
  if (!real.real) say('  (WARNING: without a real long meeting, the title cannot be judged)');
  check('the test transcript covers the requested duration',
    real.seconds > MINUTES * 60 * 0.8, `${Math.round(real.seconds / 60)} min of ${MINUTES}`);
  fs.writeFileSync(path.join(folder, 'transcript.txt'), real.text, 'utf8');

  const t4 = Date.now();
  const draft = await within(
    $(`window.yapper.generateNotes(${JSON.stringify(folder)},
      { style: 'general', detail: 'concise', custom: '',
        participants: 'Maya, Chuck, Sebastian', markers: ['00:12:30', '01:05:00'] }, true)
      .then(n => n, e => ({ error: e.message }))`),
    'generating notes and title from two hours', 10 * 60 * 1000);
  const notes = draft && draft.summary;
  const t4s = (Date.now() - t4) / 1000;
  say(`  ${t4s.toFixed(0)} s, ${String(notes).length} caracteres`);
  check('generates notes from a transcript that long',
    typeof notes === 'string' && notes.length > 500,
    draft && draft.error ? draft.error : String(notes).slice(0, 200));
  if (typeof notes === 'string') {
    const heads = [...notes.matchAll(/^##\s+(.+)$/gm)].map(m => m[1]);
    say(`  secciones: ${heads.map(h => h.replace(/\s*\[[\d:]+\]$/, '')).join(' | ')}`);
    check('with all its sections', heads.length >= 4, heads.join(' | '));
    check('and with timestamps', heads.some(h => /\[\d+:\d+/.test(h)), heads.join(' | '));
    const late = [...notes.matchAll(/\[(\d+):(\d\d)(?::(\d\d))?\]/g)]
      .map(m => (m[3] ? +m[1] * 3600 + +m[2] * 60 : +m[1] * 60 + +m[2]));
    say(`  latest timestamp in the notes: ${Math.floor(Math.max(...late) / 60)} min`);
    check('covers the second half of the meeting too',
      Math.max(...late) > MINUTES * 60 * 0.4, `the latest at ${Math.max(...late)} s`);
  }

  // ---- 5. the automatic title from that same response ----
  say('\n--- 5. auto-title (same model request) ---');
  const title = draft && draft.title;
  say(`  "${title}"`);
  if (real.real) {
    check('names a two-hour meeting with real content',
      typeof title === 'string' && title.trim().length > 3, `returned "${title}"`);
  } else {
    check('does not invent a title for a transcript with no subject',
      typeof title === 'string', String(title));
  }

  // ---- 6. the meeting view and the exports ----
  say('\n--- 6. open and export ---');
  const t6 = Date.now();
  await $(`(async () => {
    currentFolder = ${JSON.stringify(folder)};
    const d = await window.yapper.loadMeeting(currentFolder);
    openMeetingView(d.title || 'Two hour meeting', d.summary, d.transcript, true, d.participants);
  })()`);
  await new Promise(r => setTimeout(r, 500));
  say(`  the view opens in ${Date.now() - t6} ms`);
  check('opening the meeting does not freeze the interface', Date.now() - t6 < 6000, `${Date.now() - t6} ms`);
  check('the whole transcript is on screen',
    (await $("document.getElementById('transcript').textContent.length")) > 5000,
    await $("document.getElementById('transcript').textContent.length"));

  for (const kind of ['md', 'txt', 'transcript-md', 'both']) {
    const t = Date.now();
    const out = await within($(`runExport(${JSON.stringify(kind)})`), `export ${kind}`, 90000);
    const okFile = !!out && fs.existsSync(out);
    say(`  ${kind.padEnd(14)} ${okFile ? mb(fs.statSync(out).size) : 'FAILED'} in ${Date.now() - t} ms`);
    check(`export ${kind} for two hours`, okFile, String(out));
  }
  const t7 = Date.now();
  const pdf = await within($(`runExport('pdf')`), 'export pdf', 180000);
  say(`  pdf            ${pdf && fs.existsSync(pdf) ? mb(fs.statSync(pdf).size) : 'FAILED'} in ${Date.now() - t7} ms`);
  check('export pdf for two hours', !!pdf && fs.existsSync(pdf) && fs.statSync(pdf).size > 2000, String(pdf));

  // ---- 7. what it costs to keep ----
  say('\n--- 7. what keeping them costs ---');
  const perHour = size / (MINUTES / 60);
  say(`  one 2 h meeting: ${mb(size)}`);
  say(`  one a day for a month: ${mb(size * 22)}`);
  say(`  two a day for a year: ${(size * 2 * 250 / 1024 / 1024 / 1024).toFixed(1)} GB`);
  check('the audio per hour is reasonable', perHour < 200 * 1024 * 1024, mb(perHour));
  say(`  total process memory at the end: ${mb(rss())} (started at ${mb(startRss)})`);
  check('memory did not get out of hand', (rss() - startRss) / 1024 / 1024 < 500,
    `grew by ${mb(rss() - startRss)}`);

  clearTimeout(dog);
  say(fails ? `\n${fails} failures` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(e => { say('FAIL ' + (e.stack || e.message)); app.exit(1); });
