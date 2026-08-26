// Search has to find the thing that was actually said and rank it above the
// thing that merely shares a word. And it must return nothing rather than
// something wrong: an empty result is a fine answer, a confident irrelevant one
// is not.
const s = require('../search');

let fails = 0;
function check(name, ok, detail) {
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      ${detail}`); }
}
/** For assertions about a value rather than a condition — including zero. */
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want),
    `esperaba ${JSON.stringify(want)}, obtuve ${JSON.stringify(got)}`);
}

// ---------------------------------------------------------------- passages

const transcript = `[00:00:01] Right, let us talk about the new pricing.
[00:00:12] I think twenty nine dollars is the number.
[00:00:24] Maya said the enterprise tier should stay custom.
[00:01:40] Moving on to project Atlas and the migration.
[00:02:05] Atlas slips two weeks because of the vendor.
[00:03:30] Anything else? No. Good.`;

const cut = s.transcriptPassages(transcript, { title: 'Pricing Review', date: '2026-07-13', participants: ['Maya'] });
check('splits the transcript into passages', cut.length >= 3, `${cut.length} pasajes`);
check('every passage keeps its timestamp', cut.every(p => /^\d\d:\d\d:\d\d$/.test(p.stamp)),
  JSON.stringify(cut.map(p => p.stamp)));
eq('the first one starts where the audio starts', cut[0].stamp, '00:00:01');
check('groups several consecutive lines', cut[0].text.includes('twenty nine'), cut[0].text);
check('does not put distant lines in the same passage', !cut[0].text.includes('Atlas'), cut[0].text);

eq('the note sections, classified',
  ['Decisions', 'Action items', 'Risks & concerns', 'Open questions', 'Summary'].map(s.sectionKind),
  ['decision', 'action', 'risk', 'question', 'notes']);

// ---------------------------------------------------------------- the corpus

const MEETINGS = [
  {
    folder: 'f1', name: '2026-07-13_1000', title: 'Pricing Review', date: '2026-07-13',
    participants: ['Maya', 'Chuck'],
    sections: [
      { heading: 'Decisions', body: '- Pricing moves to twenty nine dollars a month.\n- Enterprise stays custom.' },
      { heading: 'Action items', body: '- Maya: write the pricing page copy' }
    ]
  },
  {
    folder: 'f2', name: '2026-07-20_1400', title: 'Atlas Migration', date: '2026-07-20',
    participants: ['Robert', 'Chuck'],
    sections: [
      { heading: 'Decisions', body: '- Atlas migration is pushed two weeks.' },
      { heading: 'Action items', body: '- Robert: talk to the vendor about the delay' }
    ]
  },
  {
    folder: 'f3', name: '2026-06-02_0900', title: 'Launch Retro', date: '2026-06-02',
    participants: ['Maya', 'Chuck'],
    sections: [
      { heading: 'Summary', body: 'Maya walked through how the launch went.' },
      { heading: 'Decisions', body: '- No changes to the launch process.' }
    ]
  }
];

const TRANSCRIPTS = {
  f1: transcript,
  f2: `[00:00:05] Robert here. The Atlas vendor cannot deliver until August.
[00:00:40] So Atlas slips two weeks, we agreed.
[00:02:00] Pricing is not in scope for this one.`,
  f3: `[00:00:03] Maya: the launch went better than we expected.
[00:00:30] Maya said the onboarding emails were the weak part.`
};

const index = s.buildIndex(MEETINGS, m => TRANSCRIPTS[m.folder] || '');
eq('the index covers all three meetings', index.meetings, 3);
check('and includes notes and transcript',
  index.passages.some(p => p.kind === 'decision') && index.passages.some(p => p.kind === 'transcript'),
  JSON.stringify([...new Set(index.passages.map(p => p.kind))]));

const find = (q, opts) => s.search(index, q, { today: '2026-07-30', ...opts });
const titles = r => r.results.map(x => x.meeting.title);

// ---------------------------------------------------------------- words

let r = find('pricing');
eq('finds by word', titles(r)[0], 'Pricing Review');
check('and does not return the meeting that only mentions it in passing first',
  titles(r)[0] === 'Pricing Review', JSON.stringify(titles(r)));

r = find('"enterprise tier should stay custom"');
check('an exact phrase finds its passage', r.results.length >= 1, `${r.results.length}`);
check('and only passages that contain it',
  r.results.every(x => /enterprise tier should stay custom/i.test(x.text)), JSON.stringify(r.results.map(x => x.text)));

r = find('"nobody ever said this"');
eq('a phrase that does not exist returns nothing', r.results.length, 0);

r = find('');
eq('an empty search returns nothing', find('').results.length, 0);
eq('and one of pure filler words does not either', find('the and of').results.length, 0);

// ---------------------------------------------------------------- people

r = find('what did Maya say about the launch');
eq('a question about a person finds it', titles(r)[0], 'Launch Retro');
eq('and it detects it as a question', r.query.question, true);
check('recognising the name', r.query.people.includes('Maya'), JSON.stringify(r.query.people));

r = find('show me the pending items assigned to Robert');
check('a person action items come from their meeting',
  r.results.some(x => x.meeting.title === 'Atlas Migration'), JSON.stringify(titles(r)));
check('and it prioritises the action items section',
  r.query.kinds.includes('action'), JSON.stringify(r.query.kinds));

// ---------------------------------------------------------------- topics, decisions

r = find('when did we talk about project Atlas');
eq('finds the project', titles(r)[0], 'Atlas Migration');

r = find('what did we decide about the new pricing');
check('a question about a decision finds it',
  r.results[0].meeting.title === 'Pricing Review', JSON.stringify(titles(r)));
eq('and it prefers the decisions section', r.results[0].kind, 'decision');

// ---------------------------------------------------------------- dates

check('a specific date filters', find('pricing 2026-07-20').results.every(x => x.meeting.date === '2026-07-20'), 'colaron otras');
r = find('what happened in June');
check('a month filters', r.results.length && r.results.every(x => x.meeting.date.startsWith('2026-06')),
  JSON.stringify(r.results.map(x => x.meeting.date)));
eq('reads the month range', [r.query.from, r.query.to], ['2026-06-01', '2026-06-30']);
eq('"last week" is computed from today',
  s.parseQuery('last week', { today: '2026-07-30' }).from, '2026-07-16');
eq('"today" tambien',
  s.parseQuery('meetings today', { today: '2026-07-30' }).from, '2026-07-30');
eq('with no dates in the query, it does not filter by date',
  s.parseQuery('pricing').from, '');

// ---------------------------------------------------------------- shape

r = find('Atlas');
check('every result carries its meeting and its date',
  r.results.every(x => x.meeting.title && x.meeting.date), JSON.stringify(r.results[0]));
check('transcript hits carry a timestamp',
  r.results.filter(x => x.kind === 'transcript').every(x => x.stamp), 'one of them has no stamp');
check('and the meeting participants',
  r.results.every(x => Array.isArray(x.meeting.participants)), 'faltan');
check('one meeting cannot fill the page',
  Math.max(...Object.values(r.results.reduce((acc, x) => {
    acc[x.meeting.folder] = (acc[x.meeting.folder] || 0) + 1; return acc;
  }, {}))) <= 2, JSON.stringify(titles(r)));

// ---------------------------------------------------------------- the prompt

const forModel = s.passagesForPrompt(find('pricing').results.slice(0, 3));
check('the passages are labelled for the model', /\[Pricing Review/.test(forModel), forModel.slice(0, 80));
check('with the date', /\(2026-07-13\)/.test(forModel), forModel.slice(0, 120));
check('the prompt forbids inventing',
  /only what the passages say/i.test(s.ANSWER_PROMPT) && /could not find that/i.test(s.ANSWER_PROMPT),
  'does not say so');
check('and it requires citing', /cite the meeting/i.test(s.ANSWER_PROMPT), 'does not require it');

// -- the answer is stripped of self-narration --
// The failure seen live: "found nothing… wait, yes" and then the real answer.
// Everything before the first citation is dropped; a lone refusal is respected.
check('the monologue before the cited answer is trimmed',
  s.cleanAnswer('I could not find that in your meetings.\n\nWait—the passages do answer this.\n\nPricing is $29 [Q3 Planning, Decisions].'),
  'Pricing is $29 [Q3 Planning, Decisions].');
check('a clean answer passes through intact',
  s.cleanAnswer('Pricing is $29 [Q3 Planning].\n\nEnterprise stays custom [Q3 Planning].'),
  'Pricing is $29 [Q3 Planning].\n\nEnterprise stays custom [Q3 Planning].');
check('an honest refusal is left as is',
  s.cleanAnswer('I could not find that in your meetings.'),
  'I could not find that in your meetings.');
check('two paragraphs where the first is not a refusal are kept',
  s.cleanAnswer('The rollout moved to August 1 [Standup].\n\nIt had been planned for the second week [Q3 Planning].'),
  'The rollout moved to August 1 [Standup].\n\nIt had been planned for the second week [Q3 Planning].');

console.log(fails ? `\n${fails} failures` : '\nPASS');
process.exit(fails ? 1 : 0);
