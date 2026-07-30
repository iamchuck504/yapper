// The two roll-ups that read across meetings: today, and the week.
//
// The split between them is what keeps them from saying the same thing twice,
// and it is structural rather than a matter of wording:
//
//   Daily   is ASSEMBLED. It collects what today's notes already say — the
//           meetings, the decisions recorded, the tasks that appeared, what is
//           still open. No model is called, so it is instant, it works before
//           any provider is configured, and there is no mechanism by which it
//           could state something that is not in a file.
//
//   Weekly  is WRITTEN. It is the one place a model is asked for something
//           assembly cannot produce: the threads that ran through several
//           meetings, where the week changed direction, and what was left
//           unresolved. It is never a list of meetings and never a list of
//           tasks — those are the daily digest's and the action list's job, and
//           the action sections are withheld from its input so that it cannot
//           re-list them even if asked to.
//
// Both are derived. Nothing here is a source of truth; a cached digest is
// thrown away as soon as any meeting it was built from changes.

const crypto = require('crypto');
const actions = require('./actions');
const { sectionKind } = require('./search');

const MAX_MEETING_CHARS = 3000;   // per meeting, in the weekly input
const MAX_INPUT_CHARS = 60000;    // the whole weekly input

// ---------------------------------------------------------------- the cache key
//
// A digest is valid exactly as long as every meeting behind it is untouched.
// The key is the folders and their fingerprints, so an edit to any one of them —
// or a new meeting on the same day — produces a different key and a regenerate.

function digestKey(meetings) {
  const h = crypto.createHash('sha1');
  for (const m of [...meetings].sort((a, b) => a.folder.localeCompare(b.folder))) {
    h.update(`${m.folder}|${m.stamp || ''}\n`);
  }
  return h.digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------- shared bits

/** Bullets out of one note section, in the same shape the action parser uses. */
const bullets = body => actions.bullets(body);

function sectionsOfKind(meeting, kind) {
  return (meeting.sections || []).filter(s => sectionKind(s.heading) === kind);
}

/** A meeting reduced to what any list needs to show and link to. */
function meetingRef(m) {
  return {
    folder: m.folder,
    title: m.title || m.name,
    date: m.date,
    time: timeOf(m.name),
    participants: m.participants || []
  };
}

function timeOf(name) {
  const m = String(name).match(/_(\d{2})(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : '';
}

/**
 * A due date resolved to a day, and only when a day was actually written.
 * "July 30" resolves; "Friday" and "end of week" do not, and are left to be
 * shown as the person wrote them. Turning a weekday into a date would be
 * picking one, and picking one is inventing it.
 */
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

function dueOn(text, todayStr) {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return '';
  const p = n => String(n).padStart(2, '0');
  const year = todayStr ? Number(todayStr.slice(0, 4)) : new Date().getFullYear();

  const iso = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return iso[0];

  const monthDay = t.match(new RegExp(`\\b(${MONTHS.join('|')})\\s+(\\d{1,2})\\b(?:,?\\s*(\\d{4}))?`));
  if (monthDay) {
    const y = monthDay[3] ? Number(monthDay[3]) : year;
    return `${y}-${p(MONTHS.indexOf(monthDay[1]) + 1)}-${p(Number(monthDay[2]))}`;
  }
  const dayMonth = t.match(new RegExp(`\\b(\\d{1,2})\\s+(${MONTHS.join('|')})\\b(?:,?\\s*(\\d{4}))?`));
  if (dayMonth) {
    const y = dayMonth[3] ? Number(dayMonth[3]) : year;
    return `${y}-${p(MONTHS.indexOf(dayMonth[2]) + 1)}-${p(Number(dayMonth[1]))}`;
  }
  // M/D or M/D/YY, read the way this app's users write it
  const slash = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (slash) {
    let y = year;
    if (slash[3]) y = slash[3].length === 2 ? 2000 + Number(slash[3]) : Number(slash[3]);
    return `${y}-${p(Number(slash[1]))}-${p(Number(slash[2]))}`;
  }
  return '';
}

// ---------------------------------------------------------------- daily
//
// Every field below is a copy of something in a file, with its source attached.

function dailyDigest({ meetings = [], items = [], day }) {
  const todays = meetings.filter(m => m.date === day)
    .sort((a, b) => timeOf(a.name).localeCompare(timeOf(b.name)));
  const folders = new Set(todays.map(m => m.folder));

  const decisions = [];
  for (const m of todays) {
    for (const section of sectionsOfKind(m, 'decision')) {
      for (const text of bullets(section.body)) decisions.push({ text, meeting: meetingRef(m) });
    }
  }

  const open = items.filter(i => !i.done);
  const from = i => [i.folder, ...(i.sources || [])].some(f => folders.has(f));

  // "New today" is decided by which meeting the task came from, not by when the
  // row was written — a library refresh can extract an old meeting's tasks today.
  const created = open.filter(from).map(i => withDue(i, day));

  const attention = [];
  for (const m of todays) {
    if (m.hasTranscript && !m.hasNotes) {
      attention.push({ kind: 'no-notes', text: 'Transcribed, but the notes were never generated', meeting: meetingRef(m) });
    }
  }
  for (const i of open) {
    const due = withDue(i, day);
    if (due.overdue) {
      attention.push({ kind: 'overdue', text: i.text, owner: i.owner, due: i.due, dueDate: due.dueDate, folder: i.folder, meeting: i.meeting });
    } else if (i.priority === 'high' && from(i)) {
      attention.push({ kind: 'urgent', text: i.text, owner: i.owner, due: i.due, folder: i.folder, meeting: i.meeting });
    }
  }

  return {
    day,
    meetings: todays.map(meetingRef),
    decisions,
    created,
    attention,
    counts: {
      meetings: todays.length,
      decisions: decisions.length,
      created: created.length,
      openTotal: open.length
    },
    empty: todays.length === 0 && attention.length === 0
  };
}

function withDue(item, day) {
  const dueDate = dueOn(item.due, day);
  return { ...item, dueDate, overdue: !!dueDate && !!day && dueDate < day && !item.done };
}

// ---------------------------------------------------------------- weekly
//
// The assembled half first. It is separate from the written half on purpose: if
// the model call fails, the view still has something true to show.

function weeklyFacts({ meetings = [], items = [], from, to, today = '' }) {
  const week = meetings.filter(m => m.date >= from && m.date <= to)
    .sort((a, b) => (a.date + timeOf(a.name)).localeCompare(b.date + timeOf(b.name)));

  const people = new Map();
  for (const m of week) for (const p of m.participants || []) {
    people.set(p.toLowerCase(), (people.get(p.toLowerCase()) || { name: p, count: 0 }));
    people.get(p.toLowerCase()).count++;
  }

  const days = new Map();
  for (const m of week) days.set(m.date, (days.get(m.date) || 0) + 1);

  const folders = new Set(week.map(m => m.folder));
  const open = items.filter(i => !i.done);
  const raised = open.filter(i => [i.folder, ...(i.sources || [])].some(f => folders.has(f)));

  return {
    from, to,
    meetings: week.map(meetingRef),
    days: [...days].map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date)),
    people: [...people.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    decisionCount: week.reduce((n, m) =>
      n + sectionsOfKind(m, 'decision').reduce((k, s) => k + bullets(s.body).length, 0), 0),
    openFromWeek: raised.length,
    overdue: open.map(i => withDue(i, today)).filter(i => i.overdue).length,
    missingNotes: week.filter(m => m.hasTranscript && !m.hasNotes).map(meetingRef),
    empty: week.length === 0,
    thin: week.filter(m => m.hasNotes).length < 2
  };
}

/**
 * The model's entire context: the notes, labelled so a claim can be traced back.
 * Transcripts are not included — the notes were already written from them under
 * a prompt that forbids inventing, and re-reading the raw transcript here would
 * be a second chance to make something up.
 *
 * Action sections are withheld too, so the summary cannot turn into a task list.
 */
function weeklyInput(meetings) {
  const parts = [];
  let chars = 0;
  let truncated = 0;

  for (const m of meetings) {
    if (!m.hasNotes) continue;
    const body = (m.sections || [])
      .filter(s => sectionKind(s.heading) !== 'action')
      .map(s => `## ${s.heading}\n${s.body}`.trim())
      .join('\n\n');
    if (!body.trim()) continue;

    let text = body;
    if (text.length > MAX_MEETING_CHARS) { text = text.slice(0, MAX_MEETING_CHARS) + '\n[…]'; truncated++; }
    const head = `=== ${m.title || m.name} | ${m.date}`
      + `${(m.participants || []).length ? ' | ' + m.participants.join(', ') : ''} ===`;
    const block = `${head}\n${text}`;

    if (chars + block.length > MAX_INPUT_CHARS) { truncated++; continue; }
    parts.push(block);
    chars += block.length;
  }
  return { text: parts.join('\n\n'), meetings: parts.length, truncated };
}

const WEEKLY_PROMPT = `You write a weekly review from meeting notes.

You will be given the notes from one week's meetings, each block headed by its
meeting title and date. Write only what those notes support.

Produce exactly these three sections, using these headings:

## Threads
Topics that appeared in more than one meeting, and where each one stands at the
end of the week. One bullet per thread.

## Shifts
Places where the week changed direction from what an earlier meeting had said.
One bullet each. If the notes show no change of direction, write "None".

## Unresolved
Questions, risks or blockers that were raised and not settled. One bullet each.
If there are none, write "None".

Rules:
1. Every bullet must end with its sources in square brackets, using the exact
   meeting titles you were given: [Pricing Review] or [Pricing Review, Standup].
2. A bullet in Threads must cite at least two different meetings. If a topic
   appeared in only one meeting, it is not a thread — leave it out.
3. Do not list the meetings, and do not list tasks or action items. Another part
   of the app does that.
4. Do not name an owner, a date, or a decision that is not written in the notes.
5. Do not add sections, preamble, or closing remarks.
6. If the notes do not support a section, write "None" under it rather than
   filling it.`;

/**
 * Parse the written summary, and throw away anything that cannot be traced.
 *
 * A bullet has to cite at least one meeting that exists in the week; one that
 * cites nothing, or cites a meeting that is not there, is dropped rather than
 * shown. That is the mechanical half of "nothing invented" — the prompt asks,
 * this enforces.
 */
function parseWeekly(text, meetings) {
  const known = new Map();
  for (const m of meetings) {
    const title = (m.title || m.name).trim();
    if (title) known.set(title.toLowerCase(), meetingRef(m));
  }

  const sections = [];
  let current = null;
  const push = () => { if (current) sections.push(current); };
  const dropped = [];

  for (const raw of String(text || '').split('\n')) {
    const heading = raw.match(/^#{1,4}\s+(.*)$/);
    if (heading) {
      push();
      current = { title: heading[1].replace(/[:*]+$/, '').trim(), items: [], none: false };
      continue;
    }
    if (!current) continue;

    const line = raw.trim().replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, '').trim();
    if (!line) continue;
    if (/^none\.?$/i.test(line)) { current.none = true; continue; }
    if (line.length < 8) continue;

    const { body, cites, unknown } = splitCites(line, known);
    if (!cites.length) { dropped.push({ line, why: unknown.length ? 'unknown meeting' : 'no source' }); continue; }
    if (unknown.length) { dropped.push({ line, why: `cites ${unknown.join(', ')}` }); continue; }
    current.items.push({ text: body, cites });
  }
  push();

  const wanted = ['Threads', 'Shifts', 'Unresolved'];
  const ordered = wanted
    .map(w => sections.find(s => s.title.toLowerCase().startsWith(w.toLowerCase())) || { title: w, items: [], none: true });

  return { sections: ordered, dropped, empty: ordered.every(s => !s.items.length) };
}

/** Split "text [A, B]" into the text and the meetings it points at. */
function splitCites(line, known) {
  const cites = [];
  const unknown = [];
  let body = line;

  for (const match of line.matchAll(/\[([^\]]+)\]/g)) {
    for (const name of match[1].split(/\s*[,;]\s*|\s+\/\s+/)) {
      const key = name.trim().toLowerCase().replace(/\s*\(.*\)$/, '');
      if (!key) continue;
      const hit = known.get(key) || [...known.entries()].find(([k]) => k.startsWith(key) || key.startsWith(k));
      if (hit) {
        const ref = Array.isArray(hit) ? hit[1] : hit;
        if (!cites.some(c => c.folder === ref.folder)) cites.push(ref);
      } else {
        unknown.push(name.trim());
      }
    }
    body = body.replace(match[0], '');
  }
  return { body: body.replace(/\s{2,}/g, ' ').replace(/\s+([.,;:])/g, '$1').trim(), cites, unknown };
}

module.exports = {
  digestKey, dailyDigest, weeklyFacts, weeklyInput, parseWeekly, splitCites,
  dueOn, meetingRef, timeOf, bullets,
  WEEKLY_PROMPT, MAX_MEETING_CHARS, MAX_INPUT_CHARS
};
