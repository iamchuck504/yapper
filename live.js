// Live transcription: what you read while the meeting is still happening.
//
// The hard part is not speed, it is that a transcript which rewrites itself is
// unreadable. So a word is only shown as final once two consecutive passes
// agree on it at the same position (LocalAgreement-2). Confirmed text never
// changes; only the greyed-out tail does.
//
// Latency comes from the cadence between passes, not from block size, so the
// text trails speech by roughly one to two seconds.

const engine = require('./engine');

const SAMPLE_RATE = 16000;
const BYTES_PER_SEC = SAMPLE_RATE * 2;

const PARAGRAPH_GAP = 1.4;   // a pause longer than this reads as a new paragraph
const MIN_AUDIO_SEC = 1.0;   // don't infer on less audio than this
const EDGE_GUARD = 0.35;     // never confirm words this close to the live edge
const TRIM_KEEP = 12.0;      // fallback: keep this much when nothing is confirmed
const SILENCE_RMS = 0.004;   // below this the window is silence, so skip the pass
const MAX_WORDS_PER_SEC = 6; // denser than this is invented text, not speech
const TAIL_WORDS = 16;       // how much confirmed text to keep for repeat checks

const DEBUG = !!process.env.YAPPER_LIVE_DEBUG;

// ---------------------------------------------------------------- helpers

function normalize(word) {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * The words that carry text, with a map back to their position. Whisper emits
 * punctuation as its own token and moves it around between passes; comparing
 * those would make two otherwise identical passes look like they disagree.
 */
function contentTokens(words) {
  const norm = [], at = [];
  words.forEach((w, i) => {
    const n = normalize(w.text);
    if (n) { norm.push(n); at.push(i); }
  });
  return { norm, at };
}

/** How far two passes say the same thing, as a count of `a`'s entries. */
function commonPrefix(a, b) {
  const A = contentTokens(a), B = contentTokens(b);
  let k = 0;
  while (k < A.norm.length && k < B.norm.length && A.norm[k] === B.norm[k]) k++;
  return k ? A.at[k - 1] + 1 : 0;
}

/**
 * How many of `fresh`'s first entries repeat the end of what was already said.
 * Timestamps alone cannot catch this: when the model re-segments, words it has
 * already given us come back shifted slightly later, and committing them again
 * is what produces "that that said, with that though".
 */
function overlapWith(tail, fresh) {
  const F = contentTokens(fresh);
  for (let k = Math.min(tail.length, F.norm.length); k > 0; k--) {
    let same = true;
    for (let i = 0; i < k; i++) {
      if (tail[tail.length - k + i] !== F.norm[i]) { same = false; break; }
    }
    if (same) return F.at[k - 1] + 1;
  }
  return 0;
}

/**
 * Whisper's repetition loops — drop the pass, not the meeting. Two shapes show
 * up: the same word over and over, and a burst of invented text far denser than
 * anyone can speak (nobody says nine words a second).
 */
function isDegenerate(words, bufSec = 0) {
  const norm = words.map(w => normalize(w.text)).filter(Boolean);
  if (norm.length < 6) return false;
  if (bufSec > 2 && norm.length / bufSec > MAX_WORDS_PER_SEC) return true;
  let run = 1, best = 1;
  for (let i = 1; i < norm.length; i++) {
    run = norm[i] === norm[i - 1] ? run + 1 : 1;
    if (run > best) best = run;
  }
  if (best >= 5) return true;
  const counts = new Map();
  for (const w of norm) counts.set(w, (counts.get(w) || 0) + 1);
  return norm.length >= 12 && Math.max(...counts.values()) / norm.length > 0.5;
}

/** Root-mean-square level of the last `sec` seconds, as a 0..1 amplitude. */
function tailRms(pcm, sec) {
  const want = Math.floor(sec * BYTES_PER_SEC);
  const from = Math.max(0, pcm.length - want) & ~1;
  const n = (pcm.length - from) >> 1;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(from + i * 2) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

// ---------------------------------------------------------------- session

let session = null;

/**
 * Start streaming. `onLine` receives one object per pass:
 *   { status: 'ready' } | { commit, tentative, gap } | { error }
 * Returns false when this machine's tier has no live transcript.
 */
async function start({ model, cadenceMs, windowSec, maxHoldSec = 3,
  language = 'auto', prompt = '', onLine }) {
  await stop();
  if (!model || !cadenceMs) return false;

  const s = {
    chunks: [],          // pending PCM, newest last
    bytes: 0,
    offsetSec: 0,        // absolute time of the buffer's first sample
    commitEnd: 0,        // absolute end time of the last confirmed word
    committedTail: [],   // last few confirmed words, normalized, to catch repeats
    prevHyp: [],         // last pass's unconfirmed words
    stopped: false,
    timer: null,
    recent: [],          // recent pass costs, to notice this machine slowing down
    maxCadenceMs: cadenceMs * 4,
    model, cadenceMs, windowSec, maxHoldSec, language, prompt, onLine
  };
  session = s;

  await engine.start(model);
  if (s.stopped) return false;
  onLine({ status: 'ready' });
  s.timer = setTimeout(() => pass(s), cadenceMs);
  return true;
}

function write(buf) {
  if (!session || session.stopped) return;
  session.chunks.push(buf);
  session.bytes += buf.length;
}

async function stop() {
  const s = session;
  session = null;
  if (!s) return;
  s.stopped = true;
  if (s.timer) clearTimeout(s.timer);
  s.chunks = [];
}

function dropFront(s, bytes) {
  let left = Math.min(bytes, s.bytes) & ~1;
  s.bytes -= left;
  s.offsetSec += left / BYTES_PER_SEC;
  while (left > 0 && s.chunks.length) {
    const head = s.chunks[0];
    if (head.length <= left) { left -= head.length; s.chunks.shift(); }
    else { s.chunks[0] = head.subarray(left); left = 0; }
  }
}

async function pass(s) {
  if (s.stopped) return;
  const again = () => { if (!s.stopped) s.timer = setTimeout(() => pass(s), s.cadenceMs); };

  // A full-file transcription — someone hitting "Transcribe now" on an older
  // meeting mid-recording — holds the same single server. Step aside rather
  // than fight over it: the buffer is capped below, so the wait costs the
  // skipped seconds and nothing else.
  if (engine.busy()) return again();

  // And it may have left the server on a different model. Take ours back.
  if (engine.loaded() !== s.model) {
    try {
      await engine.start(s.model);
      if (s.stopped) return;
    } catch (err) {
      if (!s.stopped) s.onLine({ error: err.message });
      return again();
    }
  }

  if (s.bytes < MIN_AUDIO_SEC * BYTES_PER_SEC) return again();

  // Never decode more than the window. The buffer was only trimmed *after* a
  // pass, which is fine while audio arrives in real time — but if it piles up,
  // because a pass was slow or the machine came back from sleep, one pass would
  // try to decode minutes of audio, take minutes to do it, and fall further
  // behind while more arrived. The live view is a preview: skipping ahead to the
  // present beats reading the past. The file on disk still has all of it.
  const maxBytes = Math.floor(s.windowSec * BYTES_PER_SEC);
  if (s.bytes > maxBytes) {
    const skipped = (s.bytes - maxBytes) / BYTES_PER_SEC;
    dropFront(s, s.bytes - maxBytes);
    if (DEBUG) console.log(`[live] backlog: skipped ${skipped.toFixed(1)} s to stop falling further behind`);
  }

  const pcm = Buffer.concat(s.chunks, s.bytes);

  // Re-decoding silence changes nothing and is the main trigger for
  // hallucinated text, so a quiet window is skipped outright.
  if (tailRms(pcm, 1.5) < SILENCE_RMS) return again();

  let words;
  const t0 = Date.now();
  try {
    const res = await engine.transcribeWav(engine.wavFromPcm(pcm),
      { language: s.language, prompt: s.prompt });
    if (s.stopped) return;
    words = [];
    for (const seg of res.segments || []) {
      for (const w of seg.words || []) {
        const text = (w.word || '').trim();
        if (text) words.push({ text, start: w.start + s.offsetSec, end: w.end + s.offsetSec });
      }
    }
  } catch (err) {
    if (!s.stopped) s.onLine({ error: err.message });
    return again();
  }

  const bufSec = pcm.length / BYTES_PER_SEC;
  const edgeAbs = s.offsetSec + bufSec;
  let fresh = words.filter(w => w.end > s.commitEnd + 0.02);
  fresh = fresh.slice(overlapWith(s.committedTail, fresh));

  // A bad decode is thrown away rather than confirmed; the next pass recovers.
  if (isDegenerate(words, bufSec)) {
    s.prevHyp = [];
    if (bufSec > s.windowSec) dropFront(s, (bufSec - TRIM_KEEP) * BYTES_PER_SEC);
    return again();
  }

  // Confirm the prefix this pass shares with the previous one, holding back
  // anything still touching the live edge — those words are still being said.
  let n = commonPrefix(fresh, s.prevHyp);
  const agreed = n;
  while (n > 0 && fresh[n - 1].end > edgeAbs - EDGE_GUARD) n--;

  // Safety valve. Agreement is the ideal, but on hard audio two passes can
  // disagree for a long time, and a transcript that shows nothing for fifteen
  // seconds is worse than one that occasionally settles on the wrong word. So
  // anything that has sat unconfirmed longer than maxHoldSec is committed.
  let forced = 0;
  while (forced < fresh.length && fresh[forced].end < edgeAbs - s.maxHoldSec) forced++;
  if (forced > n) n = forced;

  // Self-defence: a machine can be slower than it measured — a busy CPU, a
  // laptop on battery, another app on the GPU. Rather than let every pass
  // arrive later than the last, give the loop more room between them.
  s.recent.push(Date.now() - t0);
  if (s.recent.length > 5) s.recent.shift();
  if (s.recent.length === 5 && s.cadenceMs < s.maxCadenceMs) {
    const sorted = [...s.recent].sort((a, b) => a - b);
    if (sorted[2] > s.cadenceMs) {
      s.cadenceMs = Math.min(s.maxCadenceMs, s.cadenceMs * 2);
      s.recent = [];
      console.log(`[live] passes cost ~${sorted[2]} ms; slowing the cadence to ${s.cadenceMs} ms`);
    }
  }

  if (DEBUG) {
    console.log(`[live] ${Date.now() - t0} ms  buffer ${bufSec.toFixed(1)}s  `
      + `palabras ${words.length}  nuevas ${fresh.length}  coinciden ${agreed}  confirmo ${n}`);
  }

  if (n) {
    const confirmed = fresh.slice(0, n);
    const gap = s.commitEnd > 0 && (confirmed[0].start - s.commitEnd) > PARAGRAPH_GAP;
    s.commitEnd = confirmed[n - 1].end;
    s.committedTail = s.committedTail
      .concat(confirmed.map(w => normalize(w.text)).filter(Boolean))
      .slice(-TAIL_WORDS);
    s.onLine({
      commit: confirmed.map(w => w.text).join(' '),
      tentative: fresh.slice(n).map(w => w.text).join(' '),
      end: s.commitEnd,
      gap
    });
  } else {
    s.onLine({ commit: '', tentative: fresh.map(w => w.text).join(' ') });
  }
  s.prevHyp = fresh.slice(n);

  // Keep the window bounded: drop everything already confirmed.
  if (bufSec > s.windowSec) {
    let cut = s.commitEnd - s.offsetSec - 0.3;
    if (cut <= 0) cut = bufSec - TRIM_KEEP;
    if (cut > 0) dropFront(s, cut * BYTES_PER_SEC);
  }
  again();
}

module.exports = {
  start, write, stop,
  isDegenerate, commonPrefix, overlapWith, contentTokens, normalize, tailRms
};
