// The transcript is the only record now, so it is worth knowing whether the
// current settings are the best available rather than the first that worked.
//
// There is no reference transcript to score against, so quality is measured the
// ways that do not need one:
//   · repetition — the same phrase twice in a row is always wrong
//   · words per minute — far below normal speech means dropped audio
//   · agreement with a larger model — where two independent models say the same
//     thing they are probably both right, and disagreement marks the passages
//     worth caring about
//
//   node_modules\electron\dist\electron.exe build\tune-transcript.js
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { sandbox, logger } = require('./harness');

const ROOT = sandbox('tune-transcript');
const say = logger(ROOT);
const engine = require('../engine');

const REAL = path.join(process.env.USERPROFILE, 'Documents', 'Meetings');
const SECONDS = Number(process.env.SECONDS || 180);

/**
 * Real recordings to test on. build/make-clips.js decodes the compressed ones
 * into WAV clips first, so this measures whatever Chuck actually recorded rather
 * than one convenient sample.
 */
function samples() {
  const out = [];
  const clips = path.join(process.env.TEMP, 'yapper-clips');
  if (fs.existsSync(clips)) {
    for (const f of fs.readdirSync(clips)) {
      const p = path.join(clips, f);
      if (fs.statSync(p).size > engine.WAV_HEADER + engine.BYTES_PER_SEC * 30) {
        out.push({ name: f.replace(/\.wav$/, ''), wav: p });
      }
    }
  }
  for (const d of fs.readdirSync(REAL)) {
    const wav = path.join(REAL, d, 'recording.wav');
    if (fs.existsSync(wav)
      && fs.statSync(wav).size > engine.WAV_HEADER + engine.BYTES_PER_SEC * 60) {
      out.push({ name: d, wav });
    }
  }
  const extra = path.join(process.env.TEMP, 'yapper-60s.wav');
  if (fs.existsSync(extra)) out.push({ name: 'yapper-60s', wav: extra });
  return out;
}

/** A trimmed copy, so every configuration is judged on the same audio. */
function clip(wav, seconds) {
  const buf = fs.readFileSync(wav);
  const want = Math.min(buf.length - engine.WAV_HEADER, seconds * engine.BYTES_PER_SEC);
  const out = path.join(ROOT, 'clip.wav');
  fs.writeFileSync(out, engine.wavFromPcm(buf.subarray(engine.WAV_HEADER, engine.WAV_HEADER + want)));
  return { file: out, seconds: want / engine.BYTES_PER_SEC };
}

// Apostrophes stay inside words. Stripping them turns "There's a" into three
// tokens, so a two-word stutter reads as a three-word one and the repetition
// rate comes out higher than it is — which is how the first version of this
// over-reported.
const norm = s => s.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim();
const words = s => norm(s).split(' ').filter(Boolean);

/**
 * Share of words inside a phrase that repeats itself back to back — always a
 * defect, never speech. Each word is counted once however many run lengths it
 * belongs to; counting per length made the rate exceed 100%, which is how the
 * first version of this gave 477%.
 */
function repetition(text) {
  const w = words(text);
  const flagged = new Set();
  for (let n = 8; n >= 3; n--) {
    for (let i = 0; i + 2 * n <= w.length; i++) {
      if (w.slice(i, i + n).join(' ') === w.slice(i + n, i + 2 * n).join(' ')) {
        for (let k = i; k < i + 2 * n; k++) flagged.add(k);
      }
    }
  }
  return { words: w.length, repeated: flagged.size, rate: w.length ? flagged.size / w.length : 0 };
}

/** Word error rate of `text` against a reference, the usual edit distance. */
function wer(reference, text) {
  const r = words(reference), h = words(text);
  if (!r.length) return 1;
  // banded Levenshtein, enough for a few thousand words
  let prev = new Array(h.length + 1);
  for (let j = 0; j <= h.length; j++) prev[j] = j;
  for (let i = 1; i <= r.length; i++) {
    const cur = new Array(h.length + 1);
    cur[0] = i;
    for (let j = 1; j <= h.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[h.length] / r.length;
}

const CONFIGS = (process.env.CONFIGS || 'small,medium,base').split(',').map(spec => {
  const [model, windowSec] = spec.split(':');
  return {
    label: windowSec ? `${model} ventana ${windowSec}s` : model,
    model, windowSec: Number(windowSec || 120)
  };
});
const RUNS = Number(process.env.RUNS || 1);

app.whenReady().then(async () => {
  const found = samples();
  if (!found.length) { say('FAIL  no hay grabaciones para medir'); return app.exit(1); }
  say(`grabaciones disponibles: ${found.map(f => f.name).join(', ')}\n`);

  const totals = new Map();          // label -> accumulated numbers
  const add = (label, k, v) => {
    const t = totals.get(label) || { words: 0, repeated: 0, secs: 0, took: 0, runs: 0 };
    t[k] += v;
    totals.set(label, t);
  };

  for (const sample of found.slice(0, Number(process.env.CLIPS || 6))) {
    const { file, seconds } = clip(sample.wav, SECONDS);
    say(`=== ${sample.name} — ${seconds.toFixed(0)} s ===`);

    const results = [];
    for (const cfg of CONFIGS) {
      if (!engine.hasModel(cfg.model)) { say(`  ${cfg.label.padEnd(20)} (modelo no descargado)`); continue; }
      for (let run = 1; run <= RUNS; run++) {
        const t0 = Date.now();
        let text = '';
        try {
          const lines = await engine.transcribeFile(file, {
            model: cfg.model, language: 'en', windowSec: cfg.windowSec
          });
          text = lines.map(l => l.replace(/^\[[\d:]+\]\s*/, '')).join(' ');
        } catch (err) {
          say(`  ${cfg.label.padEnd(20)} ERROR ${String(err.message).slice(0, 60)}`);
          continue;
        }
        await engine.stop();
        const took = (Date.now() - t0) / 1000;
        const rep = repetition(text);
        if (run === 1) results.push({ ...cfg, text, took, rep });
        add(cfg.label, 'words', rep.words);
        add(cfg.label, 'repeated', rep.repeated);
        add(cfg.label, 'secs', seconds);
        add(cfg.label, 'took', took);
        add(cfg.label, 'runs', 1);
        say(`  ${cfg.label.padEnd(20)}${RUNS > 1 ? ` #${run}` : '   '} `
          + `${String(rep.words).padStart(5)} palabras  `
          + `${(rep.words / (seconds / 60)).toFixed(0).padStart(3)} p/min  `
          + `repetición ${(rep.rate * 100).toFixed(1).padStart(5)}%  ${took.toFixed(0)}s`);
      }
    }

    // agreement against the largest model available, as a stand-in reference
    const ref = results.find(r => r.model === 'medium') || results[0];
    if (ref && results.length > 1) {
      const others = results.filter(r => r !== ref)
        .map(r => `${r.label} ${(wer(ref.text, r.text) * 100).toFixed(0)}%`);
      say(`  desacuerdo vs ${ref.label}: ${others.join(', ')}`);
    }
    say('');
  }

  // ---- the summary that the decision rests on ----
  say('=== TOTAL sobre todas las muestras ===');
  say('config              palabras/min   repetición   velocidad');
  for (const [label, t] of totals) {
    const wpm = t.words / (t.secs / 60);
    say(`${label.padEnd(20)} ${wpm.toFixed(0).padStart(6)}       `
      + `${(t.repeated / t.words * 100).toFixed(2).padStart(6)}%    `
      + `${(t.secs / t.took).toFixed(0).padStart(4)}x tiempo real`);
  }
  say('\nmás palabras por minuto = menos habla perdida, siempre que la repetición');
  say('siga en cero. El desacuerdo no es error: marca dónde mirar.');
  app.exit(0);
}).catch(e => { say('FAIL ' + (e.stack || e.message)); app.exit(1); });
