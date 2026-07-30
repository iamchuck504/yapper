// Finding something that was said in a meeting months ago.
//
// Two ways in, and they share one retrieval step:
//   · words and phrases — ranked passages, with the meeting and the timestamp
//   · a question in plain language — the same passages, then one model call that
//     may only answer from them
//
// The second is why retrieval matters more than phrasing: a question answered
// from a model's memory of a meeting is a made-up answer. It answers from
// passages or it says it does not know.
//
// The index is built in memory from library.js and rebuilt when the library
// changes. No new file format, and at a few megabytes of transcript it is
// milliseconds; if that stops being true the passages are already the unit to
// persist.

const PASSAGE_SECONDS = 45;       // enough context to read, short enough to cite
const MAX_PASSAGE_CHARS = 700;

// ---------------------------------------------------------------- tokens

const STOP = new Set(('the a an and or but if then than that this these those of in on at to for with '
  + 'from by about into over after before is are was were be been being am do does did doing have has '
  + 'had having will would shall should can could may might must i you he she it we they me him her us '
  + 'them my your his its our their what which who whom whose when where why how all any both each few '
  + 'more most other some such no nor not only own same so too very just also there here').split(' '));

function tokens(text) {
  return String(text || '').toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP.has(w));
}

/** Crude stemming, applied to both sides so it stays symmetric. */
const stem = w => w.replace(/(ing|ed|ies|es|s)$/, '');
const terms = text => tokens(text).map(stem).filter(Boolean);

// ---------------------------------------------------------------- passages

function stampToSeconds(stamp) {
  const p = String(stamp).split(':').map(Number);
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  if (p.length === 2) return p[0] * 60 + p[1];
  return 0;
}

function secondsToStamp(sec) {
  const p = n => String(n).padStart(2, '0');
  return `${p(Math.floor(sec / 3600))}:${p(Math.floor(sec / 60) % 60)}:${p(Math.round(sec) % 60)}`;
}

/**
 * A transcript, cut into passages of about PASSAGE_SECONDS. One line on its own
 * is usually too little to recognise, and a whole meeting is too much to read.
 */
function transcriptPassages(text, meeting) {
  const out = [];
  let start = null;
  let at = null;
  let buffer = [];

  const flush = () => {
    if (!buffer.length) return;
    out.push({
      kind: 'transcript',
      text: buffer.join(' ').slice(0, MAX_PASSAGE_CHARS),
      stamp: secondsToStamp(start),
      seconds: start,
      meeting
    });
    buffer = [];
  };

  for (const raw of String(text || '').split('\n')) {
    const m = raw.match(/^\[(\d+:\d\d(?::\d\d)?)\]\s*(.*)$/);
    if (!m) continue;
    const sec = stampToSeconds(m[1]);
    if (start === null) { start = sec; at = sec; }
    if (sec - start > PASSAGE_SECONDS || buffer.join(' ').length > MAX_PASSAGE_CHARS) {
      flush();
      start = sec;
    }
    at = sec;
    if (m[2].trim()) buffer.push(m[2].trim());
  }
  flush();
  return out;
}

/** The notes, one passage per section — that is already how they are written. */
function notePassages(sections, meeting) {
  return (sections || []).filter(s => s.body && s.body.trim()).map(s => ({
    kind: sectionKind(s.heading),
    heading: s.heading,
    text: s.body.trim().slice(0, MAX_PASSAGE_CHARS),
    stamp: '',
    seconds: 0,
    meeting
  }));
}

function sectionKind(heading) {
  const h = String(heading || '').toLowerCase();
  if (/decision|agreement/.test(h)) return 'decision';
  if (/action item|commitment|next step|what is needed/.test(h)) return 'action';
  if (/risk|blocker|concern/.test(h)) return 'risk';
  if (/question/.test(h)) return 'question';
  return 'notes';
}

/**
 * Build the searchable collection from indexed meetings. `read` is injected so
 * this stays testable without touching a disk: it returns a meeting's transcript.
 */
function buildIndex(meetings, read) {
  const passages = [];
  for (const m of meetings) {
    const meeting = {
      folder: m.folder,
      name: m.name,
      title: m.title || m.name,
      date: m.date,
      participants: m.participants || []
    };
    passages.push(...notePassages(m.sections, meeting));
    const transcript = read ? read(m) : '';
    if (transcript) passages.push(...transcriptPassages(transcript, meeting));
  }

  // document frequency, for BM25
  const df = new Map();
  for (const p of passages) {
    p.terms = terms(p.text);
    p.length = p.terms.length;
    for (const t of new Set(p.terms)) df.set(t, (df.get(t) || 0) + 1);
  }
  const avgLength = passages.reduce((s, p) => s + p.length, 0) / (passages.length || 1);

  return { passages, df, avgLength, meetings: meetings.length };
}

// ---------------------------------------------------------------- the query
//
// A search box gets asked all sorts of things. What can be understood without a
// model is understood without one: a name that matches a participant, a date, a
// word like "decided". The rest is just words to match.

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

function parseQuery(raw, { participants = [], today = null } = {}) {
  let text = String(raw || '').trim();
  const q = {
    raw: text,
    phrases: [],
    people: [],
    kinds: [],
    from: '',
    to: '',
    question: /\?|^(what|who|when|where|why|how|which|show me|tell me|did |was |were |qué|quien|quién|cuando|cuándo|dónde|donde|muestra|cual|cuál)/i.test(text)
  };

  // "exact phrases" first, so they are not broken up
  text = text.replace(/"([^"]+)"/g, (_, phrase) => { q.phrases.push(phrase.trim()); return ' '; });

  // a word that matches somebody who was in a meeting is probably about them
  const lower = text.toLowerCase();
  for (const person of new Set(participants)) {
    const first = person.split(/\s+/)[0];
    if (first.length > 2 && new RegExp(`\\b${escapeRe(first.toLowerCase())}\\b`).test(lower)) {
      q.people.push(person);
    }
  }

  if (/\bdecid|decision|agreed|agreement/i.test(text)) q.kinds.push('decision');
  if (/\baction item|pending|todo|to do|assigned|owe|owes|pendiente/i.test(text)) q.kinds.push('action');
  if (/\brisk|blocker|concern/i.test(text)) q.kinds.push('risk');

  Object.assign(q, parseDates(text, today));
  q.terms = terms(text);
  return q;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Only dates that are actually written or named. Nothing is inferred. */
function parseDates(text, todayStr) {
  const t = String(text).toLowerCase();
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return { from: iso[0], to: iso[0] };

  const monthName = MONTHS.findIndex(m => new RegExp(`\\b${m}\\b`).test(t));
  if (monthName >= 0) {
    const year = (text.match(/\b(20\d{2})\b/) || [])[1];
    const y = year ? Number(year) : (todayStr ? Number(todayStr.slice(0, 4)) : new Date().getFullYear());
    const last = new Date(y, monthName + 1, 0).getDate();
    const p = n => String(n).padStart(2, '0');
    return { from: `${y}-${p(monthName + 1)}-01`, to: `${y}-${p(monthName + 1)}-${p(last)}` };
  }

  if (!todayStr) return {};
  const [y, m, d] = todayStr.split('-').map(Number);
  const shift = days => {
    const at = new Date(y, m - 1, d + days);
    const p = n => String(n).padStart(2, '0');
    return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
  };
  if (/\btoday\b|\bhoy\b/.test(t)) return { from: todayStr, to: todayStr };
  if (/\byesterday\b|\bayer\b/.test(t)) return { from: shift(-1), to: shift(-1) };
  if (/\bthis week\b|\besta semana\b/.test(t)) return { from: shift(-7), to: todayStr };
  if (/\blast week\b|\bsemana pasada\b/.test(t)) return { from: shift(-14), to: shift(-7) };
  if (/\blast month\b|\bmes pasado\b/.test(t)) return { from: shift(-60), to: shift(-30) };
  return {};
}

// ---------------------------------------------------------------- ranking

const K1 = 1.4;
const B = 0.72;

/**
 * BM25, plus the things a person means but does not say: a passage from a
 * meeting they named, a section of the kind they asked about, an exact phrase.
 */
function score(passage, q, index) {
  let s = 0;
  const counts = new Map();
  for (const t of passage.terms) counts.set(t, (counts.get(t) || 0) + 1);

  for (const t of new Set(q.terms)) {
    const tf = counts.get(t);
    if (!tf) continue;
    const n = index.df.get(t) || 0;
    const idf = Math.log(1 + (index.passages.length - n + 0.5) / (n + 0.5));
    s += idf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * passage.length / index.avgLength));
  }

  const haystack = passage.text.toLowerCase();
  for (const phrase of q.phrases) {
    if (haystack.includes(phrase.toLowerCase())) s += 6;
    else return 0;                                  // a quoted phrase is a filter
  }

  if (q.kinds.length && q.kinds.includes(passage.kind)) s *= 1.6;
  if (q.people.length) {
    const inMeeting = q.people.some(p =>
      passage.meeting.participants.some(x => x.toLowerCase().includes(p.split(/\s+/)[0].toLowerCase())));
    const spoken = q.people.some(p => haystack.includes(p.split(/\s+/)[0].toLowerCase()));
    if (spoken) s *= 1.8;
    else if (inMeeting) s *= 1.15;
  }
  // a word in the meeting's own title is a strong signal about the whole meeting
  const title = passage.meeting.title.toLowerCase();
  if (q.terms.some(t => title.includes(t))) s += 1.5;

  return s;
}

/** Ranked results. Nothing is returned that does not actually match. */
function search(index, rawQuery, opts = {}) {
  const q = parseQuery(rawQuery, {
    participants: opts.participants || [...new Set(index.passages.flatMap(p => p.meeting.participants))],
    today: opts.today || null
  });
  if (!q.terms.length && !q.phrases.length && !q.people.length && !q.from) {
    return { query: q, results: [] };
  }

  const limit = opts.limit || 20;
  const inRange = p => !q.from || (p.meeting.date >= q.from && p.meeting.date <= q.to);

  let scored = [];
  for (const p of index.passages) {
    if (!inRange(p)) continue;
    const s = score(p, q, index);
    if (s > 0) scored.push({ ...withoutTerms(p), score: s });
  }

  // "What happened in June" is a period, not a word. When a query carries a date
  // range and nothing in it matches by wording, the meetings in that range are
  // the answer — listing them beats an empty page.
  if (!scored.length && q.from) {
    scored = index.passages
      .filter(p => inRange(p) && (p.kind === 'notes' || p.kind === 'decision'))
      .map(p => ({ ...withoutTerms(p), score: p.kind === 'notes' ? 1 : 0.5, byPeriod: true }));
  }

  // Asked what was decided, decisions come first. The kind is a stronger signal
  // than the wording: a transcript passage can easily out-score the very section
  // that records the answer.
  const kindFirst = a => (q.kinds.length && q.kinds.includes(a.kind) ? 0 : 1);
  scored.sort((a, b) =>
    kindFirst(a) - kindFirst(b)
    || b.score - a.score
    || b.meeting.date.localeCompare(a.meeting.date));

  // At most two passages from the same meeting, so one long meeting cannot fill
  // the page and hide everything else.
  const perMeeting = new Map();
  const results = [];
  for (const r of scored) {
    const n = perMeeting.get(r.meeting.folder) || 0;
    if (n >= (opts.perMeeting || 2)) continue;
    perMeeting.set(r.meeting.folder, n + 1);
    results.push(r);
    if (results.length >= limit) break;
  }
  return { query: q, results };
}

function withoutTerms(p) {
  const { terms: _t, length: _l, ...rest } = p;
  return rest;
}

// ---------------------------------------------------------------- answering

const ANSWER_PROMPT = `You answer questions about meetings, using only the passages provided.

Rules:
1. Use only what the passages say. If they do not answer the question, reply with exactly this and nothing else: I could not find that in your meetings.
2. Never guess a name, a date, a number or a decision that is not written in a passage.
3. Cite the meeting for every claim, in square brackets, exactly as the passage labels it — for example [Launch Planning, 24:05].
4. Two or three sentences. Write only the answer itself: no preamble, no heading, no restating the question, and never any commentary about the passages or your own process.
5. If the passages disagree or are unclear, say so rather than picking one.`;

/**
 * The model's answer, cleaned of self-narration. The observed failure: a first
 * paragraph declaring nothing was found, a "wait—" reversal, then the real
 * cited answer. The prompt forbids it; this makes it certain. When an early
 * paragraph refuses but a later one carries citations, the paragraphs before
 * the first cited one are the model talking to itself, and they are dropped.
 * A refusal with no cited answer after it is kept as-is — that is the honest
 * "nothing found" reply.
 */
function cleanAnswer(text) {
  const parts = String(text || '').trim().split(/\n\s*\n/);
  if (parts.length < 2) return String(text || '').trim();
  const firstCited = parts.findIndex(p => /\[[^\]]+\]/.test(p));
  if (firstCited < 1) return parts.join('\n\n');
  const preamble = parts.slice(0, firstCited).join(' ');
  if (/could not find|cannot find|no relevant|wait\b|actually\b/i.test(preamble)) {
    return parts.slice(firstCited).join('\n\n');
  }
  return parts.join('\n\n');
}

/** The retrieved passages, laid out for the model with their labels. */
function passagesForPrompt(results) {
  return results.map(r => {
    const label = r.stamp ? `${r.meeting.title}, ${r.stamp}` : `${r.meeting.title}${r.heading ? `, ${r.heading}` : ''}`;
    return `[${label}] (${r.meeting.date})\n${r.text}`;
  }).join('\n\n');
}

module.exports = {
  tokens, terms, transcriptPassages, notePassages, sectionKind, buildIndex,
  parseQuery, parseDates, score, search,
  ANSWER_PROMPT, passagesForPrompt,
  stampToSeconds, secondsToStamp, cleanAnswer, PASSAGE_SECONDS
};
