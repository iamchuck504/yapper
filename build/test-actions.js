// Action items are pulled out of the notes and shown as facts about a meeting,
// so the parsing must not invent an owner or a date that nobody wrote, and the
// duplicate detection must not merge two different tasks into one.
const a = require('../actions');

let fails = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      esperaba ${JSON.stringify(want)}\n      obtuve   ${JSON.stringify(got)}`); }
}

// ---------------------------------------------------------------- parsing

const NOTES = `## Summary [00:01]
It went fine.

## Action items [00:20]
- Maya: prepare the rollout plan by Friday
- **Chuck** — review the pricing deck
- Send the contract to legal
- Richard: sign off on the budget by March 3
- URGENT: fix the login bug

## Open questions [02:40]
- Nothing outstanding.
`;

const items = a.parseActionItems(NOTES, { folder: 'C:/M/2026-07-30_1000', title: 'Launch Sync', date: '2026-07-30' });
check('produces one item per bullet', items.length, 5);
check('reads the owner written with a colon', items[0].owner, 'Maya');
check('reads the owner in bold with a dash', items[1].owner, 'Chuck');
check('invents no owner when there is none', items[2].owner, '');
check('reads the date as written', items[0].due, 'Friday');
check('reads a date with month and day', items[3].due, 'March 3');
check('invents no date when there is none', items[1].due, '');
check('strips the date from the text', items[0].text, 'prepare the rollout plan');
check('flags priority only if it is stated', [items[4].priority, items[2].priority], ['high', 'normal']);
check('remembers which meeting it came from', items[0].meeting, 'Launch Sync');
check('strips the markdown from the text', items[1].text, 'review the pricing deck');

check('ignora "No action items recorded."',
  a.parseActionItems('## Action items\n- No action items recorded.\n').length, 0);
check('does not read from other sections',
  a.parseActionItems('## Key points\n- Maya: this is not a task\n').length, 0);
check('finds the section even under a different name',
  a.parseActionItems('## Commitments\n- Send the quote\n').length, 1);
check('"Next steps" too',
  a.parseActionItems('## Next steps\n- Book the room\n').length, 1);
check('notes with no sections yield no items', a.parseActionItems('just a paragraph').length, 0);
check('empty notes', a.parseActionItems('').length, 0);

// a sentence with a colon is not an owner
check('a sentence with a colon is not an owner',
  a.splitOwner('Decide the following: whether to ship').owner, '');
check('nor is a verb at the start',
  a.splitOwner('Review the deck: it needs work').owner, '');

// ---------------------------------------------------------------- duplicates

const same = (x, y) => a.isDuplicate({ text: x, owner: '' }, { text: y, owner: '' });

check('the same text is a duplicate',
  same('prepare the rollout plan', 'prepare the rollout plan'), true);
check('reworded too',
  same('prepare the rollout plan', 'prepare a rollout plan'), true);
check('with different filler words',
  same('send the contract to legal', 'send contract to legal team'), true);
check('two different tasks are NOT a duplicate',
  same('prepare the rollout plan', 'review the pricing deck'), false);
check('same verb but different object',
  same('send the contract to legal', 'send the invoice to finance'), false);

check('different owners are not merged',
  a.isDuplicate({ text: 'review the deck', owner: 'Maya' }, { text: 'review the deck', owner: 'Chuck' }), false);
check('if one has no owner, yes',
  a.isDuplicate({ text: 'review the deck', owner: '' }, { text: 'review the deck', owner: 'Chuck' }), true);
check('a full name matches the first name',
  a.isDuplicate({ text: 'review the deck', owner: 'Maya' }, { text: 'review the deck', owner: 'Maya Ursula' }), true);

// ---------------------------------------------------------------- merging

const first = a.mergeActionItems([], [
  { text: 'prepare the rollout plan', owner: 'Maya', due: '', folder: 'f1', meeting: 'Planning' }
], 1000);
check('the first one gets added', [first.added, first.merged], [1, 0]);
check('stores its source meeting', first.list[0].sources, ['f1']);

const second = a.mergeActionItems(first.list, [
  { text: 'prepare a rollout plan', owner: '', due: 'Friday', folder: 'f2', meeting: 'Standup' }
], 2000);
check('the same action item in another meeting is not duplicated', [second.added, second.merged], [0, 1]);
check('accumulates both meetings', second.list[0].sources, ['f1', 'f2']);
check('fills in the missing date', second.list[0].due, 'Friday');
check('keeps the owner it already had', second.list[0].owner, 'Maya');
check('there is still only one row', second.list.length, 1);

const third = a.mergeActionItems(second.list, [
  { text: 'review the pricing deck', owner: 'Chuck', due: '', folder: 'f2', meeting: 'Standup' }
], 3000);
check('a genuinely new task does get added', [third.added, third.merged], [1, 0]);
check('two remain', third.list.length, 2);

const urgent = a.mergeActionItems(third.list, [
  { text: 'prepare the rollout plan', owner: 'Maya', due: '', folder: 'f3', priority: 'high' }
], 4000);
check('if it is later marked urgent, it rises', urgent.list[0].priority, 'high');

// what is already checked off must not be resurrected as new
const done = a.mergeActionItems(
  [{ text: 'send the contract to legal', owner: '', done: true, sources: ['f1'] }],
  [{ text: 'send contract to legal', owner: '', folder: 'f9' }], 5000);
check('an action item already done does not reappear as new', [done.added, done.merged], [0, 1]);
check('and stays marked as done', done.list[0].done, true);

// the old reminders, which have none of the new fields, must survive contact
const legacy = a.mergeActionItems(
  [{ id: 'x', text: 'call the bank', done: false, source: '', createdAt: 1 }],
  [{ text: 'book the venue', owner: '', folder: 'f4' }], 6000);
check('an old reminder does not break', legacy.list.length, 2);
check('and stays as it was', legacy.list[0].text, 'call the bank');

console.log(fails ? `\n${fails} fallos` : '\nPASS');
process.exit(fails ? 1 : 0);
