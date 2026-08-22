'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Resolve an existing, real directory that is one direct child of `root`.
 *
 * Meeting paths cross the renderer/main-process boundary, so they cannot be
 * trusted just because they originally came from list-meetings. Requiring a
 * direct, non-symlink child keeps every meeting operation inside the one
 * directory Yapper owns and closes both `..` and symlink escapes.
 */
function resolveDirectChild(root, candidate) {
  if (typeof candidate !== 'string' || !candidate || candidate.includes('\0')) {
    throw new Error('Invalid meeting folder.');
  }

  const rootPath = path.resolve(root);
  const targetPath = path.resolve(candidate);
  let rootReal;
  let stat;
  try {
    rootReal = fs.realpathSync(rootPath);
    stat = fs.lstatSync(targetPath);
  } catch {
    throw new Error('That meeting is no longer there.');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('That meeting folder is not valid.');
  }

  const targetReal = fs.realpathSync(targetPath);
  // macOS exposes /var as /private/var. A native picker or mkdir can return the
  // canonical spelling even when app.getPath() returned the alias, so compare
  // canonical paths before deciding whether this is a direct child.
  if (path.dirname(targetReal) !== rootReal) {
    throw new Error('That meeting folder resolves outside the meetings library.');
  }
  return targetReal;
}

/** Resolve a real, regular file selected by the user. */
function resolveRegularFile(candidate) {
  if (typeof candidate !== 'string' || !candidate || candidate.includes('\0')) {
    throw new Error('Invalid file.');
  }
  let real;
  let stat;
  try {
    real = fs.realpathSync(candidate);
    stat = fs.statSync(real);
  } catch {
    throw new Error('That file is no longer there.');
  }
  if (!stat.isFile()) throw new Error('That selection is not a file.');
  return real;
}

/** Resolve a regular, non-symlink file directly inside a trusted directory. */
function resolveDirectFile(folder, candidate) {
  return resolveDirectFilePath(folder, candidate, true);
}

/**
 * Resolve a direct meeting file for creation or replacement. Existing paths
 * must be regular non-symlink files; missing paths are returned inside the
 * canonical folder, ready for an atomic write.
 */
function resolveDirectFileForWrite(folder, candidate) {
  return resolveDirectFilePath(folder, candidate, false);
}

function resolveDirectFilePath(folder, candidate, mustExist) {
  let folderReal;
  try { folderReal = fs.realpathSync(folder); } catch { throw new Error('That meeting is no longer there.'); }
  if (typeof candidate !== 'string' || !candidate || candidate.includes('\0')) {
    throw new Error('Invalid file.');
  }
  const target = path.resolve(candidate);
  const folderPath = path.resolve(folder);
  if (path.dirname(target) !== folderPath && path.dirname(target) !== folderReal) {
    throw new Error('That file is outside the meeting folder.');
  }
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (err) {
    if (!mustExist && err && err.code === 'ENOENT') return path.join(folderReal, path.basename(target));
    throw new Error('That file is no longer there.');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('That meeting file is not valid.');
  const real = fs.realpathSync(target);
  if (path.dirname(real) !== folderReal) throw new Error('That file resolves outside the meeting folder.');
  return real;
}

module.exports = { resolveDirectChild, resolveRegularFile, resolveDirectFile, resolveDirectFileForWrite };
