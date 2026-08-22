// Security boundary tests use real directories and symlinks so they exercise
// the same filesystem semantics as the app, not a copy of its path formula.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveDirectChild, resolveRegularFile, resolveDirectFile,
  resolveDirectFileForWrite } = require('../security');
const { atomicWriteFileSync, readMeetingText, writeMeetingText,
  meetingFileExists } = require('../storage');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yapper-security-'));
const root = path.join(tmp, 'Meetings');
const meeting = path.join(root, '2026-08-21_1200');
const nested = path.join(meeting, 'nested');
const outside = path.join(tmp, 'outside');
fs.mkdirSync(nested, { recursive: true });
fs.mkdirSync(outside);
const audio = path.join(meeting, 'recording.wav');
const outsideFile = path.join(outside, 'secret.txt');
fs.writeFileSync(audio, 'audio');
fs.writeFileSync(outsideFile, 'secret');
fs.symlinkSync(outside, path.join(root, 'linked-meeting'));
fs.symlinkSync(outsideFile, path.join(meeting, 'linked-audio.wav'));

let fails = 0;
function check(name, fn, expected = true) {
  let ok = false;
  try { ok = !!fn(); } catch { ok = false; }
  if (ok === expected) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}`); }
}
function rejects(name, fn) {
  let rejected = false;
  try { fn(); } catch { rejected = true; }
  check(name, () => rejected);
}

check('accepts a real direct meeting child', () => resolveDirectChild(root, meeting) === fs.realpathSync(meeting));
check('accepts the canonical spelling of an aliased root child',
  () => resolveDirectChild(root, fs.realpathSync(meeting)) === fs.realpathSync(meeting));
rejects('rejects the meetings root', () => resolveDirectChild(root, root));
rejects('rejects an outside directory', () => resolveDirectChild(root, outside));
rejects('rejects a nested directory', () => resolveDirectChild(root, nested));
rejects('rejects a symlinked meeting', () => resolveDirectChild(root, path.join(root, 'linked-meeting')));
rejects('rejects an empty path', () => resolveDirectChild(root, ''));

check('accepts a user-selected regular file', () => resolveRegularFile(outsideFile) === fs.realpathSync(outsideFile));
check('accepts a direct regular meeting file', () => resolveDirectFile(meeting, audio) === fs.realpathSync(audio));
rejects('rejects a meeting-file symlink', () => resolveDirectFile(meeting, path.join(meeting, 'linked-audio.wav')));
rejects('rejects a file outside the meeting', () => resolveDirectFile(meeting, outsideFile));
check('returns a safe canonical path for a new meeting file',
  () => resolveDirectFileForWrite(meeting, path.join(meeting, 'new.txt'))
    === path.join(fs.realpathSync(meeting), 'new.txt'));

rejects('bounded meeting reads reject an internal symlink',
  () => readMeetingText(meeting, 'linked-audio.wav', { required: true }));
rejects('bounded meeting writes reject an internal symlink',
  () => writeMeetingText(meeting, 'linked-audio.wav', 'replacement'));
check('rejected write leaves the outside target untouched',
  () => fs.readFileSync(outsideFile, 'utf8') === 'secret');
check('missing optional meeting text reads as empty',
  () => readMeetingText(meeting, 'missing.txt') === '');
check('missing meeting file is reported absent',
  () => meetingFileExists(meeting, 'missing.txt') === false);
writeMeetingText(meeting, 'notes.md', 'safe notes');
check('meeting text round-trips through bounded helpers',
  () => readMeetingText(meeting, 'notes.md', { required: true }) === 'safe notes');
rejects('oversized meeting text is rejected before reading',
  () => readMeetingText(meeting, 'notes.md', { required: true, maxBytes: 2 }));
rejects('oversized meeting text is rejected before writing',
  () => writeMeetingText(meeting, 'notes.md', 'too large', { maxBytes: 2 }));

const settings = path.join(tmp, 'user', 'settings.json');
atomicWriteFileSync(settings, '{"theme":"dark"}');
atomicWriteFileSync(settings, '{"theme":"light"}');
check('atomic replacement leaves the complete new file',
  () => fs.readFileSync(settings, 'utf8') === '{"theme":"light"}');
check('atomic replacement leaves no temporary file',
  () => fs.readdirSync(path.dirname(settings)).every(name => !name.endsWith('.tmp')));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `\n${fails} failures` : '\nPASS');
process.exit(fails ? 1 : 0);
