// Action items, offered from the notes and kept only when the user selects one.
//
// The notes already have an "Action items" section, written from the transcript
// by a prompt that forbids inventing anything. So these are read from there
// rather than asked for again: a second pass over the transcript is a second
// chance to make something up, and the whole point is that a pending task can be
// traced back to a meeting where it was actually said.
//
// Everything here is a pure function over plain objects, so the parsing and the
// duplicate detection can be tested without a model or a window.

// ---------------------------------------------------------------- parsing

/** The sections of a notes.md, by heading. */
function noteSections(md) {
  const out = new Map();
  let title = '';
  let body = [];
  const push = () => { if (title) out.set(title, body.join('\n').trim()); };
  for (const line of String(md || '').split('\n')) {
    const m = line.match(/^##\s+(.*)$/);
    if (m) {
      push();
      title = m[1].replace(/\s*\[[\d:]+\]\s*$/, '').trim();
      body = [];
    } else if (title) {
      body.push(line);
    }
  }
  push();
  return out;
}

/** The heading that holds tasks, whatever the note style called it. */
function actionSection(md) {
  for (const [heading, body] of noteSections(md)) {
    if (/action item|commitment|next step|what is needed/i.test(heading)) return body;
  }
  return '';
}

// English and Spanish, now that the notes can come out in either.
const NOTHING_TO_DO = /^(no (action items|commitments|decisions)|none|nothing|no hay|no se (registraron|registró|acordaron|acordó|tomaron|tomó)|ninguna|ningún|ninguno|sin (acciones|compromisos|decisiones|pendientes))\b/i;

/**
 * The lines of a note section that are statements, with their bullet markers
 * removed. Headings, blanks, fragments and "None" are not statements.
 *
 * The daily digest reads the decisions section the same way, so this is shared:
 * whatever counts as one written item here counts as one there too.
 */
function bullets(body) {
  const out = [];
  for (const raw of String(body || '').split('\n')) {
    const line = raw.trim().replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, '').trim();
    if (!line || line.length < 4) continue;
    if (NOTHING_TO_DO.test(line)) continue;
    if (/^#{1,6}\s/.test(raw)) continue;
    out.push(line);
  }
  return out;
}

/**
 * One task per bullet. Whatever the model wrote is kept as the description —
 * only the owner and the date are lifted out of it, and only when they are
 * unambiguous.
 */
function parseActionItems(md, meeting = {}) {
  const body = actionSection(md);
  if (!body) return [];

  const items = [];
  for (const line of bullets(body)) {
    const { owner, rest } = splitOwner(line);
    const { due, text } = splitDue(rest);
    if (!text || text.length < 4) continue;

    items.push({
      text: stripMarkdown(text),
      owner,
      due,
      folder: meeting.folder || '',
      meeting: meeting.title || '',
      meetingDate: meeting.date || '',
      priority: priorityOf(line)
    });
  }
  return items;
}

/**
 * "Maya: prepare the rollout" and "**Maya** — prepare the rollout" both name
 * an owner. A sentence with a colon in the middle does not, so the candidate has
 * to look like a name: short, and no verbs pretending to be one.
 */
// Labels people write before a task, which are not people. "URGENT: fix the
// login bug" used to make URGENT the owner — and then it showed up on screen as
// though someone by that name owed the work.
const NOT_A_NAME = /^(urgent|asap|todo|to do|note|important|critical|blocker|blocked|risk|decision|action|follow[- ]?up|reminder|deadline|due|next|priority|high|low|medium|new|open|done|fyi|nb|optional|owner|unassigned|tbd|everyone|all|team|we|us)$/i;

function splitOwner(line) {
  const m = line.match(/^\s*\*{0,2}([^:—–-]{2,40}?)\*{0,2}\s*[:—–]\s+(.*)$/);
  if (!m) return { owner: '', rest: line };
  const candidate = m[1].replace(/\*/g, '').trim();
  const words = candidate.split(/\s+/);

  const looksLikeName = words.length <= 4
    && !NOT_A_NAME.test(candidate)
    // ALL CAPS is a label, not a name: nobody writes Maya: in their notes
    && candidate !== candidate.toUpperCase()
    && !/\b(and|the|to|for|with|about|review|send|write|check|prepare|follow|decide|discuss)\b/i.test(candidate)
    && /^[\p{Lu}\p{L}]/u.test(candidate);

  // A label still tells us the priority, so it is dropped from the text rather
  // than left to be read as part of the task.
  if (!looksLikeName && NOT_A_NAME.test(candidate)) {
    return { owner: '', rest: `${candidate} ${m[2].trim()}` };
  }
  return looksLikeName ? { owner: candidate, rest: m[2].trim() } : { owner: '', rest: line };
}

const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december';

/** A date only when it is written as one. Nothing is guessed from context. */
function splitDue(line) {
  const patterns = [
    new RegExp(`\\b(?:by|before|due|on)\\s+((?:${MONTHS})\\s+\\d{1,2}(?:,\\s*\\d{4})?)`, 'i'),
    new RegExp(`\\b(?:by|before|due|on)\\s+(\\d{1,2}\\s+(?:${MONTHS})(?:,?\\s*\\d{4})?)`, 'i'),
    /\b(?:by|before|due|on)\s+(\d{4}-\d{2}-\d{2})\b/i,
    /\b(?:by|before|due|on)\s+(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/,
    /\b(?:by|before|due)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
    /\b(?:by|before|due)\s+(today|tomorrow|end of (?:the )?(?:day|week|month|quarter)|next week|this week)\b/i
  ];
  for (const re of patterns) {
    const m = line.match(re);
    if (m) return { due: m[1].trim(), text: line.replace(m[0], '').replace(/\s{2,}/g, ' ').trim() };
  }
  return { due: '', text: line };
}

function priorityOf(line) {
  if (/\b(urgent|asap|critical|blocker|high priority|immediately)\b/i.test(line)) return 'high';
  if (/\b(when there is time|eventually|low priority|nice to have)\b/i.test(line)) return 'low';
  return 'normal';
}

function stripMarkdown(s) {
  return s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1').replace(/\s{2,}/g, ' ').trim();
}

// ---------------------------------------------------------------- duplicates
//
// The same task gets mentioned in several meetings — a standup restates what
// last week's planning agreed. Those should be one entry with several sources,
// not three rows saying the same thing.

const STOPWORDS = new Set(('a an the and or but to for of in on at by with from about into over after '
  + 'before is are was were be been being do does did will would should could can may might must '
  + 'we i he she they it that this these those his her their our your my me us them then than as so '
  + 'need needs needed have has had get gets got make makes made also just still now next').split(' '));

/** The words that carry the meaning, for comparing two tasks. */
function contentWords(text) {
  return String(text || '').toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w))
    .map(w => w.replace(/(ing|ed|es|s)$/, ''))     // crude, but symmetric
    .filter(Boolean);
}

/** A stable key for a task, so the same wording always lands on the same one. */
function actionKey(text) {
  return [...new Set(contentWords(text))].sort().join(' ');
}

function similarity(a, b) {
  const A = new Set(contentWords(a));
  const B = new Set(contentWords(b));
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / (A.size + B.size - shared);          // Jaccard
}

const SAME_TASK = 0.7;

/** Two owners are compatible if they agree, or one of them was never named. */
function sameOwner(a, b) {
  const x = String(a || '').trim().toLowerCase();
  const y = String(b || '').trim().toLowerCase();
  if (!x || !y) return true;
  return x === y || x.startsWith(y) || y.startsWith(x);
}

function isDuplicate(a, b) {
  if (!sameOwner(a.owner, b.owner)) return false;
  if (actionKey(a.text) === actionKey(b.text)) return true;
  return similarity(a.text, b.text) >= SAME_TASK;
}

/**
 * Fold new items into the list already stored. The earliest entry survives and
 * collects the extra meetings in `sources`; an owner or a due date the earlier
 * one lacked gets filled in from the later one, since that is new information
 * rather than a contradiction.
 *
 * Returns { list, added, merged } so the caller can say what happened.
 */
function mergeActionItems(existing, incoming, now = 0) {
  const list = existing.map(x => ({ ...x }));
  let added = 0;
  let merged = 0;

  for (const item of incoming) {
    const match = list.find(x => isDuplicate(x, item));
    if (match) {
      const sources = new Set([...(match.sources || []), match.folder, item.folder].filter(Boolean));
      match.sources = [...sources];
      if (!match.owner && item.owner) match.owner = item.owner;
      if (!match.due && item.due) match.due = item.due;
      if (match.priority !== 'high' && item.priority === 'high') match.priority = 'high';
      match.updatedAt = now;
      merged++;
      continue;
    }
    list.push({
      id: null,                       // the caller assigns one; keeps this pure
      text: item.text,
      owner: item.owner || '',
      due: item.due || '',
      priority: item.priority || 'normal',
      done: false,
      folder: item.folder || '',
      meeting: item.meeting || '',
      meetingDate: item.meetingDate || '',
      sources: item.folder ? [item.folder] : [],
      source: item.meeting || '',      // what the old reminders UI reads
      createdAt: now,
      updatedAt: now
    });
    added++;
  }
  return { list, added, merged };
}

module.exports = {
  noteSections, actionSection, bullets, parseActionItems,
  splitOwner, splitDue, priorityOf,
  contentWords, actionKey, similarity, sameOwner, isDuplicate, mergeActionItems
};
