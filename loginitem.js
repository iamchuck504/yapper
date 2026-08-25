// Everything about "open at login" that can be decided rather than asked,
// kept out of main.js so it can be tested without Electron — the same reason
// bounds.js exists.
//
// macOS 13+ registers through SMAppService, and SMAppService takes no path: it
// registers whichever bundle is running. That is the whole difficulty. A
// registration naming a bundle that will not be there at the next login is
// worse than none — it is an entry System Settings lists with nothing behind
// it — and the bundles that will not be there are exactly the ones somebody
// meets first: a dev run out of a checkout, a copy started from inside the
// mounted dmg, and the read-only copy macOS makes of a quarantined app opened
// outside /Applications.
//
// So nothing here registers anything on its own. Startup reads the system and
// reports it; only the switch asks for a change, and only from a copy that
// will still be at the same path tomorrow.
const path = require('path');

/** How this copy of the app is running. */
const KIND = Object.freeze({
  OTHER_OS: 'other-os',
  DEVELOPMENT: 'development',      // node_modules/electron's bundle, in a checkout
  PERMANENT: 'permanent',          // an install that will be at this path tomorrow
  TRANSLOCATED: 'translocated',    // the read-only copy macOS makes of a quarantined app
  READ_ONLY: 'read-only',          // a mounted disk image, or any read-only mount
  TEMPORARY: 'temporary',          // unpacked into a temp directory
  UNKNOWN: 'unknown'               // not a bundle layout we recognise: fail closed
});

/** Bumped when the meaning of the stored preference changes. */
const MIGRATION = 2;

const TRANSLOCATION = '/AppTranslocation/';

// Kept short: it is shown beside the switch, in a settings row.
const MOVE_FIRST = 'Move Yapper to Applications to change this.';

const WHY = Object.freeze({
  [KIND.DEVELOPMENT]: 'A development build cannot open at login: it would register the copy of Electron in the checkout.',
  [KIND.TRANSLOCATED]: `macOS is running this copy from a temporary read-only location. ${MOVE_FIRST}`,
  [KIND.READ_ONLY]: `This copy is running from a disk image. ${MOVE_FIRST}`,
  [KIND.TEMPORARY]: `This copy is running from a temporary folder. ${MOVE_FIRST}`,
  [KIND.UNKNOWN]: `Yapper cannot tell where this copy is installed. ${MOVE_FIRST}`
});

// ---------- which bundle is running ----------

/**
 * The bundle an executable belongs to, by layout alone:
 * `Foo.app/Contents/MacOS/foo` — three levels up. Nothing here trusts the
 * bundle's name; a renamed or relocated app is still an app.
 * @returns {string|null} null when the layout is not that, so callers fail closed
 */
function bundleOfExecutable(exe) {
  if (typeof exe !== 'string' || !path.isAbsolute(exe)) return null;
  const macos = path.dirname(exe);
  const contents = path.dirname(macos);
  const bundle = path.dirname(contents);
  if (path.basename(macos) !== 'MacOS') return null;
  if (path.basename(contents) !== 'Contents') return null;
  // macOS will happily run Foo.APP, so the extension is matched the way the
  // filesystem compares it rather than the way this file is written.
  if (!/\.app$/i.test(bundle)) return null;
  if (path.dirname(bundle) === bundle) return null;      // a bundle at / is not one
  return bundle;
}

/**
 * The bundle to act on, checked both ways round. The path as given says what
 * the user thinks is running; the canonical path says what would actually be
 * deleted. A symlink that makes those two disagree about the layout — the exe
 * is inside a `.app` lexically but not really, or the other way round — is
 * refused rather than resolved in somebody's favour.
 * @returns {string|null} the canonical bundle, or null
 */
function bundleFromExecutable(exe, io) {
  const lexical = bundleOfExecutable(exe);
  if (!lexical) return null;
  const real = io.realpath(exe);
  if (!real) return null;                                // gone, or unreadable
  const canonical = bundleOfExecutable(real);
  if (!canonical) return null;
  if (!io.isDirectory(canonical)) return null;
  return canonical;
}

/** `child` is `parent` or sits under it. Both must already be canonical. */
function contains(parent, child) {
  if (!parent || !child) return false;
  if (parent === child) return true;
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/**
 * Where this copy is running from.
 *
 * `io.writeStatus` is what separates a disk image from an external disk the
 * user genuinely installed to, and `/Volumes/` cannot: plenty of people keep
 * /Applications on an external SSD, and that is a real installation. A
 * read-only *filesystem* answers EROFS, while a directory the user simply may
 * not write to answers EACCES or EPERM — /Applications on a Mac where this
 * account is not an admin, which is still a permanent install.
 *
 * @param {{platform:string, isPackaged:boolean, exe:string, tempDirs?:string[], io:object}} o
 * @returns {{kind:string, bundle:string|null, why?:string}}
 */
function classifyRun({ platform, isPackaged, exe, tempDirs = [], io }) {
  if (platform !== 'darwin') return { kind: KIND.OTHER_OS, bundle: null };
  if (!isPackaged) return { kind: KIND.DEVELOPMENT, bundle: null, why: WHY[KIND.DEVELOPMENT] };

  const bundle = bundleFromExecutable(exe, io);
  if (!bundle) return { kind: KIND.UNKNOWN, bundle: null, why: WHY[KIND.UNKNOWN] };

  // First, because a translocated copy is also read-only and also in a temp
  // directory, and this is the one worth naming.
  if (bundle.includes(TRANSLOCATION) || String(exe).includes(TRANSLOCATION)) {
    return { kind: KIND.TRANSLOCATED, bundle, why: WHY[KIND.TRANSLOCATED] };
  }

  const status = io.writeStatus(path.dirname(bundle));
  if (status === 'missing') return { kind: KIND.UNKNOWN, bundle, why: WHY[KIND.UNKNOWN] };
  if (status === 'read-only') return { kind: KIND.READ_ONLY, bundle, why: WHY[KIND.READ_ONLY] };

  const temp = tempDirs.map(d => io.realpath(d) || d).filter(Boolean);
  if (temp.some(d => contains(d, bundle))) {
    return { kind: KIND.TEMPORARY, bundle, why: WHY[KIND.TEMPORARY] };
  }
  return { kind: KIND.PERMANENT, bundle };
}

/** Only a permanent install may be registered, and only it may remove itself. */
function canRegister(run) { return !!run && run.kind === KIND.PERMANENT; }
function canUninstall(run) { return !!run && run.kind === KIND.PERMANENT && !!run.bundle; }

// ---------- what macOS says ----------

/**
 * Electron hands back macOS's own answer: not-registered, enabled,
 * requires-approval or not-found. Reduced to what the switch has to show,
 * because "on" and "waiting for the user to approve it in System Settings" are
 * different answers and only one of them starts the app.
 */
function readState(settings) {
  if (!settings || typeof settings !== 'object') {
    return { state: 'error', message: 'macOS did not answer whether Yapper opens at login.' };
  }
  switch (settings.status) {
    case 'enabled':
      return { state: 'enabled' };
    case 'requires-approval':
      return {
        state: 'requires-approval',
        message: 'macOS is waiting for this to be allowed in System Settings › General › Login Items.'
      };
    case 'not-registered':
      return { state: 'disabled' };
    case 'not-found':
      return { state: 'error', message: 'macOS has no record of this copy of Yapper.' };
    default:
      // Windows, which has no status field and where the settings file is the
      // record.
      return { state: settings.openAtLogin ? 'enabled' : 'disabled' };
  }
}

// ---------- startup ----------

/**
 * What the switch should say, and what to write down. It registers nothing:
 * reconciling at startup is precisely what turns a revocation made in System
 * Settings into something that comes back on the next launch, and what lets a
 * `true` stored by an older version register a bundle nobody asked about.
 *
 * A first run therefore starts off. There is no first-launch default to
 * inherit any more, because inheriting one meant registering without being
 * asked.
 *
 * Nothing is lost by not reconciling. macOS keeps the record against the app's
 * identity, not against a path, and re-points it to whichever copy with that
 * identity it sees run — measured: a registration made from a copy that was
 * then deleted resolved, with no call of ours, to another copy of the same app
 * the next time that one was launched. So a record left naming a disk image
 * repairs itself when the real copy next opens, and the old habit of
 * re-registering on every launch was buying nothing that macOS was not already
 * doing — while costing a revoked setting that came back.
 *
 * @param {{run:function, getLoginItem:function, setLoginItem:function,
 *          readSettings:function, writeSettings:function}} deps
 */
function initMac(deps) {
  const run = deps.run();
  if (run.kind === KIND.DEVELOPMENT) {
    // The only write startup is allowed. The dev bundle is a different app as
    // far as macOS is concerned — com.github.Electron, not com.yapper.* — so
    // this cannot reach the real install, and it is what clears the stray
    // "Electron" login item an older build left behind.
    deps.setLoginItem(false);
    return { state: 'disabled', kind: run.kind, why: run.why, devCleared: true };
  }

  const now = readState(deps.getLoginItem());
  const on = now.state === 'enabled';
  const s = deps.readSettings() || {};
  // The system is the record; the file follows it. Writing it down keeps the
  // two from disagreeing, and the marker says the stored value means "what
  // macOS was doing" rather than "what an old default wanted".
  if (s.openAtLogin !== on || s.openAtLoginMigration !== MIGRATION) {
    deps.writeSettings({ ...s, openAtLogin: on, openAtLoginMigration: MIGRATION });
  }
  return { ...now, kind: run.kind, why: run.why };
}

// ---------- the switch ----------

/**
 * The only place a registration is asked for or withdrawn. Answers with what
 * macOS did, not with what was asked: it can refuse, and it can decide the
 * user has to approve it first.
 *
 * From a copy that is not a permanent install this changes nothing at all —
 * not even to turn it off. A translocated or disk-image copy carries the same
 * bundle identifier as the one in /Applications, so unregistering from it
 * would withdraw the real install's registration.
 */
function setMac(deps, enabled) {
  const run = deps.run();
  if (!canRegister(run)) {
    return { state: 'unavailable', kind: run.kind, why: run.why || WHY[KIND.UNKNOWN] };
  }
  deps.setLoginItem(!!enabled);
  const now = readState(deps.getLoginItem());
  const s = deps.readSettings() || {};
  deps.writeSettings({
    ...s,
    openAtLogin: now.state === 'enabled',
    openAtLoginMigration: MIGRATION,
    openAtLoginUserSet: true
  });
  if (enabled && now.state === 'disabled') {
    return { ...now, refused: true, message: 'macOS refused to register Yapper to open at login.' };
  }
  return { ...now, kind: run.kind };
}

// ---------- what the uninstaller may delete ----------

/**
 * The paths behind "also delete settings and the downloaded engine", and the
 * ones that were left out and why. Meetings are ordinary folders in the
 * user's Documents and are never anybody's to delete here, so a target that
 * *is* the meetings folder, contains it, or sits inside it is refused rather
 * than trusted to be somewhere else. YAPPER_HOME puts the two side by side —
 * `<home>/user` and `<home>/Meetings` — which is exactly the arrangement that
 * an ancestor check has to get right.
 */
function dataPlan({ userData, engineHome, meetings, io }) {
  const real = p => (p ? io.realpath(p) || p : null);
  const meetingsReal = real(meetings);
  const targets = [];
  const skipped = [];

  const consider = (label, raw) => {
    const p = real(raw);
    if (!p) return;
    if (path.dirname(p) === p) {
      return skipped.push({ label, path: raw, why: 'it is the root of a volume' });
    }
    if (meetingsReal && (contains(p, meetingsReal) || contains(meetingsReal, p))) {
      return skipped.push({ label, path: raw, why: 'it is not separate from the meetings folder' });
    }
    if (targets.some(t => contains(t.path, p))) return;          // already covered
    for (let i = targets.length - 1; i >= 0; i--) {
      if (contains(p, targets[i].path)) targets.splice(i, 1);    // this one covers it
    }
    targets.push({ label, path: p });
  };

  consider('settings', userData);
  // Normally inside userData and already covered. It can be moved out from the
  // environment, and then the checkbox's promise is only kept by removing it
  // separately.
  consider('engine', engineHome);
  return { targets, skipped };
}

// ---------- uninstalling ----------

/**
 * Removing the app has to remove the login item, and only the app can: the
 * registration is a record of the system's, so by the time the bundle is in
 * the Trash there is nothing left to withdraw it.
 *
 * The order is the point, and each step is checked before the next one can do
 * damage. Withdrawing is confirmed by reading macOS back rather than by the
 * call not throwing — `setLoginItemSettings` returns void, and Electron logs
 * SMAppService's error itself, so "no exception" says nothing.
 *
 * @param {{run:function, confirm:function, setLoginItem:function,
 *          getLoginItem:function, trash:function, dataPlan:function,
 *          report:function, quit:function}} deps
 * @returns {Promise<{done:boolean, step:string, residue?:Array}>}
 */
async function uninstall(deps) {
  const run = deps.run();
  if (!canUninstall(run)) return { done: false, step: 'unavailable' };

  const choice = await deps.confirm();
  if (!choice || !choice.proceed) return { done: false, step: 'cancelled' };

  // B, then C. Asking is not the same as it having happened.
  deps.setLoginItem(false);
  const after = readState(deps.getLoginItem());
  if (after.state !== 'disabled') {
    await deps.report({
      step: 'login-item',
      message: 'Yapper could not stop itself opening at login.',
      detail: `${after.message || `macOS still reports it as ${after.state}.`}\n\n`
        + 'Nothing has been removed. Turning "Start at login" off in System '
        + 'Settings › General › Login Items and trying again is the way round it.'
    });
    return { done: false, step: 'login-item' };
  }

  // D. The step that can be refused — a copy installed for every user is
  // owned by root — and if it is, nothing has been thrown away yet.
  const moved = await deps.trash(run.bundle);
  if (!moved.ok) {
    await deps.report({
      step: 'bundle',
      message: 'Yapper could not move itself to the Trash.',
      detail: `${moved.message || 'The Trash refused it.'}\n\n`
        + 'Nothing else has been removed, and it no longer opens at login. '
        + `Dragging ${run.bundle} to the Trash finishes it.`
    });
    return { done: false, step: 'bundle' };
  }

  // E. Only now, and only if it was asked for.
  const residue = [];
  if (choice.alsoData) {
    const plan = deps.dataPlan();
    for (const skip of plan.skipped) residue.push({ ...skip, kept: true });
    for (const target of plan.targets) {
      const r = await deps.trash(target.path);
      // Not there is the outcome that was wanted. Anything else is a leftover
      // the user should be told about rather than a silence.
      if (!r.ok && r.code !== 'ENOENT') {
        residue.push({ ...target, why: r.message || 'the Trash refused it' });
      }
    }
  }

  // F before G: the bundle is in the Trash, but this process is still alive
  // and is the only thing that knows what was left behind.
  if (residue.length) {
    await deps.report({
      step: 'data',
      message: 'Yapper was removed, but some of its files are still there.',
      detail: residue.map(r => `${r.path} — ${r.why}`).join('\n')
    });
  }
  deps.quit();
  return { done: true, step: 'done', residue };
}

module.exports = {
  KIND, MIGRATION, WHY, MOVE_FIRST,
  bundleOfExecutable, bundleFromExecutable, contains,
  classifyRun, canRegister, canUninstall,
  readState, initMac, setMac, dataPlan, uninstall
};
