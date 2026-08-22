// An index of the meetings, so that anything which has to look across all of
// them does not have to read all of them.
//
// A meeting is a folder of files, which is deliberate — the user can open it —
// but the weekly summary, the daily digest, the action items and the search all
// need to ask questions about every meeting at once. Reading twenty-eight
// folders on every launch is slow and gets slower; this keeps a derived index
// and only re-reads a meeting whose files have actually changed.
//
// It is a cache, never a source of truth. Deleting index.json costs one rebuild.

const fs = require('fs');
const path = require('path');
const { atomicWriteFileSync, readMeetingText } = require('./storage');
const actions = require('./actions');

const INDEX_VERSION = 1;

/** Everything known about one meeting, cheap to hold in memory. */
function readMeeting(folder) {
  const read = f => {
    try { return readMeetingText(folder, f); } catch { return ''; }
  };
  const name = path.basename(folder);
  const notes = read('notes.md');
  const transcript = read('transcript.txt');

  return {
    folder,
    name,
    date: dateOf(name),
    title: read('title.txt').trim(),
    participants: read('participants.txt').trim().split(/[,\n]/).map(s => s.trim()).filter(Boolean),
    hasNotes: !!notes.trim(),
    hasTranscript: !!transcript.trim(),
    transcriptBytes: transcript.length,
    sections: [...actions.noteSections(notes)].map(([heading, body]) => ({ heading, body })),
    items: actions.parseActionItems(notes, {
      folder, title: read('title.txt').trim() || name, date: dateOf(name)
    }),
    stamp: stampOf(folder)
  };
}

/** "2026-07-30_1415" -> "2026-07-30". The folder name is the meeting's date. */
function dateOf(name) {
  const m = String(name).match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

/** When the meeting started, as a timestamp, for ordering within a day. */
function startedAt(name) {
  const m = String(name).match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() : 0;
}

/** A cheap fingerprint of a folder: enough to notice any file changing. */
function stampOf(folder) {
  let stamp = '';
  try {
    for (const f of fs.readdirSync(folder).sort()) {
      const s = fs.lstatSync(path.join(folder, f));
      if (s.isSymbolicLink()) { stamp += `${f}:link;`; continue; }
      stamp += `${f}:${s.size}:${Math.round(s.mtimeMs)};`;
    }
  } catch { /* the folder went away mid-scan */ }
  return stamp;
}

/**
 * The index, refreshed. Meetings whose fingerprint is unchanged are reused from
 * the cache; anything new or edited is read again.
 *
 * Returns { meetings, changed } — `changed` lists what was re-read, which is
 * what the caller needs to decide whether a cached digest is still good.
 */
function refresh({ meetingsDir, indexFile }) {
  const cached = load(indexFile);
  const meetings = [];
  const changed = [];

  let names = [];
  try {
    names = fs.readdirSync(meetingsDir, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name);
  } catch {
    return { meetings: [], changed: [] };
  }

  for (const name of names) {
    const folder = path.join(meetingsDir, name);
    const stamp = stampOf(folder);
    const before = cached.get(folder);
    if (before && before.stamp === stamp) {
      meetings.push(before);
      continue;
    }
    const m = readMeeting(folder);
    meetings.push(m);
    changed.push(m);
  }

  meetings.sort((a, b) => startedAt(b.name) - startedAt(a.name));   // newest first
  save(indexFile, meetings);
  return { meetings, changed };
}

function load(indexFile) {
  try {
    const data = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    if (data.version !== INDEX_VERSION) return new Map();
    return new Map(data.meetings.map(m => [m.folder, m]));
  } catch {
    return new Map();
  }
}

function save(indexFile, meetings) {
  try {
    fs.mkdirSync(path.dirname(indexFile), { recursive: true });
    atomicWriteFileSync(indexFile, JSON.stringify({ version: INDEX_VERSION, meetings }));
  } catch (err) {
    console.log(`[library] could not save the index: ${err.message}`);
  }
}

// ---------------------------------------------------------------- selecting
//
// Dates are handled as local "YYYY-MM-DD" strings throughout. A meeting belongs
// to the day it started, which is what a person means by "today's meetings" even
// for one that ran past midnight.

function today(now = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** The Monday of a date's week, and the ISO week label, both local. */
function weekOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const at = new Date(y, m - 1, d);
  const weekday = (at.getDay() + 6) % 7;                 // Monday = 0
  const monday = new Date(y, m - 1, d - weekday);
  const sunday = new Date(y, m - 1, d - weekday + 6);

  // ISO week number, for a stable cache key
  const thursday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 3);
  const firstThursday = new Date(thursday.getFullYear(), 0, 4);
  const week = 1 + Math.round(
    ((thursday - firstThursday) / 86400000 - 3 + ((firstThursday.getDay() + 6) % 7)) / 7);

  return {
    from: today(monday),
    to: today(sunday),
    label: `${thursday.getFullYear()}-W${String(week).padStart(2, '0')}`
  };
}

const onDay = (meetings, day) => meetings.filter(m => m.date === day);
const inRange = (meetings, from, to) => meetings.filter(m => m.date >= from && m.date <= to);

/** Meetings worth summarising: something was actually transcribed. */
const withContent = meetings => meetings.filter(m => m.hasTranscript || m.hasNotes);

module.exports = {
  INDEX_VERSION, refresh, readMeeting, stampOf,
  dateOf, startedAt, today, weekOf, onDay, inRange, withContent
};
