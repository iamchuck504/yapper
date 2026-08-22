'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveDirectFile, resolveDirectFileForWrite } = require('./security');

const DEFAULT_TEXT_LIMIT = 8 * 1024 * 1024;

/** Write a complete replacement without ever exposing a truncated JSON file. */
function atomicWriteFileSync(file, data, encoding = 'utf8') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { encoding, mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* never created, or already renamed */ }
    throw err;
  }
}

function directMeetingName(folder, name, forWrite) {
  if (typeof name !== 'string' || !name || path.basename(name) !== name || name.includes('\0')) {
    throw new Error('Invalid meeting file name.');
  }
  const candidate = path.join(folder, name);
  return forWrite
    ? resolveDirectFileForWrite(folder, candidate)
    : resolveDirectFile(folder, candidate);
}

/** Read a bounded UTF-8 text file without following meeting-internal links. */
function readMeetingText(folder, name, options = {}) {
  const { required = false, maxBytes = DEFAULT_TEXT_LIMIT } = options;
  let file;
  try {
    file = directMeetingName(folder, name, false);
  } catch (err) {
    if (!required && err && /no longer there/i.test(err.message)) return '';
    throw err;
  }
  const size = fs.statSync(file).size;
  if (size > maxBytes) throw new Error(`${name} is too large to open safely.`);
  return fs.readFileSync(file, 'utf8');
}

/** Atomically replace a bounded meeting text file without following links. */
function writeMeetingText(folder, name, data, options = {}) {
  const { maxBytes = DEFAULT_TEXT_LIMIT } = options;
  data = String(data == null ? '' : data);
  if (Buffer.byteLength(data, 'utf8') > maxBytes) {
    throw new Error(`${name} is too large to save safely.`);
  }
  const file = directMeetingName(folder, name, true);
  atomicWriteFileSync(file, data, 'utf8');
  return file;
}

function meetingFileExists(folder, name) {
  try {
    directMeetingName(folder, name, false);
    return true;
  } catch (err) {
    if (err && /no longer there/i.test(err.message)) return false;
    throw err;
  }
}

module.exports = {
  atomicWriteFileSync,
  readMeetingText,
  writeMeetingText,
  meetingFileExists,
  DEFAULT_TEXT_LIMIT
};
