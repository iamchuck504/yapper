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
// reports it; only the switch asks for a change, and only from a copy that is
// installed where installations go.
//
// Two rules run through the file, and both are about not being clever:
//
//   Prove, do not infer. "This does not look temporary" is a different claim
//   from "this is installed", and a path that cannot be canonicalised is not a
//   path that can be compared. Anything unproven lands in a kind that may not
//   register and may not delete.
//
//   Fail closed. Every question the filesystem can refuse to answer — realpath,
//   stat, access — has an outcome here that blocks. None has one that shrugs
//   and carries on with the path it was handed.
const path = require('path');

/** How this copy of the app is running. */
const KIND = Object.freeze({
  OTHER_OS: 'other-os',
  DEVELOPMENT: 'development',      // node_modules/electron's bundle, in a checkout
  PERMANENT: 'permanent',          // installed directly under an approved root
  TRANSLOCATED: 'translocated',    // the read-only copy macOS makes of a quarantined app
  READ_ONLY: 'read-only',          // a read-only filesystem: a mounted image, or anything else
  TEMPORARY: 'temporary',          // unpacked into a temp directory
  UNAPPROVED: 'unapproved',        // a real place, but not one apps are installed in
  UNKNOWN: 'unknown'               // a question the filesystem would not answer
});

/** Bumped when the meaning of the stored preference changes. */
const MIGRATION = 2;

const TRANSLOCATION = '/AppTranslocation/';

// Kept short: it is shown beside the switch, in a settings row.
const MOVE_FIRST = 'Move Yapper to your Applications folder to change this.';

const WHY = Object.freeze({
  [KIND.DEVELOPMENT]: 'A development build cannot open at login: it would register the copy of Electron in the checkout.',
  [KIND.TRANSLOCATED]: `macOS is running this copy from a temporary read-only location it made for it. ${MOVE_FIRST}`,
  // Not "a disk image": a read-only filesystem is what was measured, and that
  // is as much as can honestly be said about it.
  [KIND.READ_ONLY]: `This copy is on a read-only disk — most likely a mounted disk image. ${MOVE_FIRST}`,
  [KIND.TEMPORARY]: `This copy is running from a temporary folder. ${MOVE_FIRST}`,
  [KIND.UNAPPROVED]: `Yapper is not in an Applications folder, so it cannot register a location that will still mean this copy tomorrow. ${MOVE_FIRST}`,
  [KIND.UNKNOWN]: `Yapper cannot make out where this copy is installed, and will not guess. ${MOVE_FIRST}`
});

// ---------- paths, proved rather than assumed ----------

/**
 * A canonical path, or a reason there is none. `io.realpath` answers `{path}`
 * or `{code}`, and a code is never swallowed: comparing a canonical path
 * against one that merely looks like it is not a weaker check, it is the check
 * quietly turning itself off.
 *
 * A path that does not exist yet still gets a canonical form — the deepest
 * ancestor that does exist is resolved and the rest re-attached, marked
 * `missing`. That is what lets a data directory nobody has created be compared
 * honestly against the meetings folder.
 *
 * @returns {{path:string, missing?:boolean}|{code:string}}
 */
function canonical(p, io) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return { code: 'EINVAL' };
  const r = io.realpath(p);
  if (r && typeof r.path === 'string') return { path: r.path };
  const code = (r && r.code) || 'EIO';
  if (code !== 'ENOENT') return { code };
  const parent = path.dirname(p);
  if (parent === p) return { code: 'ENOENT' };
  const up = canonical(parent, io);
  if (up.code) return up;
  return { path: path.join(up.path, path.basename(p)), missing: true };
}

/** `child` is `parent` or sits under it. Both must already be canonical. */
function contains(parent, child) {
  if (!parent || !child) return false;
  if (parent === child) return true;
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/** Either path is the other, or one is inside the other. */
function overlaps(a, b) {
  return !!a && !!b && (a === b || contains(a, b) || contains(b, a));
}

/**
 * The same directory, decided the way the filesystem decides it. Two canonical
 * paths that differ can still be one directory across a firmlink; identity
 * settles that, and a refusal to answer settles it the safe way.
 */
function sameDirectory(a, b, io) {
  if (a === b) return true;
  const ia = io.identity(a);
  const ib = io.identity(b);
  if (!ia || !ib || ia.code || ib.code) return false;
  return ia.dev === ib.dev && ia.ino === ib.ino;
}

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
 * The bundle to act on: the one the user is looking at and the one that would
 * actually be deleted, proved to be the same directory.
 *
 * Checking the layout on the path as given and on its canonical form is not
 * enough by itself. A real directory named `decoy.app`, laid out correctly,
 * whose `Contents/MacOS/Yapper` is a symlink into another perfectly valid
 * bundle, satisfies both — and they are two different bundles, so the name
 * shown and the directory trashed would not be the same thing. The bundle
 * derived lexically is therefore canonicalised too, and has to *be* the
 * directory derived from the canonical executable. An alias of a whole bundle
 * passes that; a link between two bundles does not.
 *
 * @returns {{path:string}|{code:string}}
 */
function bundleFromExecutable(exe, io) {
  const lexical = bundleOfExecutable(exe);
  if (!lexical) return { code: 'ELAYOUT' };

  const realExe = io.realpath(exe);
  if (!realExe || typeof realExe.path !== 'string') {
    return { code: (realExe && realExe.code) || 'EIO' };
  }
  const fromExe = bundleOfExecutable(realExe.path);
  if (!fromExe) return { code: 'ELAYOUT' };

  const fromLexical = canonical(lexical, io);
  if (fromLexical.code) return { code: fromLexical.code };
  if (fromLexical.missing) return { code: 'ENOENT' };

  if (!sameDirectory(fromLexical.path, fromExe, io)) return { code: 'EMISMATCH' };
  if (!io.isDirectory(fromExe)) return { code: 'ENOTDIR' };
  return { path: fromExe };
}

// ---------- where this copy is running from ----------

/**
 * Which kind of copy this is.
 *
 * The policy is a list of install roots, not an absence of red flags. An
 * earlier version called anything that was not translocated, not on a
 * read-only filesystem and not under a temp directory "permanent", which let
 * through ~/Downloads, a read-write disk image and any writable scratch volume
 * — all writable, none of them installations. Writability is not permanence.
 * So a copy has to sit directly under an approved root before it may register
 * itself or remove itself; everything else is told to move to Applications.
 *
 * The cost is deliberate and documented: an Applications folder kept on an
 * external disk is not an approved root, so open at login is refused there
 * rather than registered and hoped for. What counts as installed is a decision
 * about the product, not something to read off the shape of a path.
 *
 * @param {{platform:string, isPackaged:boolean, exe:string, tempDirs?:string[],
 *          installRoots?:string[], io:object}} o
 * @returns {{kind:string, bundle:string|null, why?:string}}
 */
function classifyRun({ platform, isPackaged, exe, tempDirs = [], installRoots = [], io }) {
  if (platform !== 'darwin') return { kind: KIND.OTHER_OS, bundle: null };
  if (!isPackaged) return { kind: KIND.DEVELOPMENT, bundle: null, why: WHY[KIND.DEVELOPMENT] };

  const found = bundleFromExecutable(exe, io);
  if (found.code) return { kind: KIND.UNKNOWN, bundle: null, why: WHY[KIND.UNKNOWN] };
  const bundle = found.path;

  // First, because a translocated copy is also read-only and also under a temp
  // directory, and this is the one worth naming.
  if (bundle.includes(TRANSLOCATION) || String(exe).includes(TRANSLOCATION)) {
    return { kind: KIND.TRANSLOCATED, bundle, why: WHY[KIND.TRANSLOCATED] };
  }

  // A read-only filesystem answers EROFS. A directory this account may not
  // write to answers EACCES or EPERM, which is what /Applications says on a
  // Mac where the user is not an admin and is still an install. Anything else
  // is a question that did not get answered, and is not guessed at.
  const status = io.writeStatus(path.dirname(bundle));
  if (status === 'read-only') return { kind: KIND.READ_ONLY, bundle, why: WHY[KIND.READ_ONLY] };
  if (status !== 'writable' && status !== 'denied') {
    return { kind: KIND.UNKNOWN, bundle, why: WHY[KIND.UNKNOWN] };
  }

  for (const dir of tempDirs) {
    const t = canonical(dir, io);
    if (!t.code && contains(t.path, bundle)) {
      return { kind: KIND.TEMPORARY, bundle, why: WHY[KIND.TEMPORARY] };
    }
  }

  for (const root of installRoots) {
    const r = canonical(root, io);
    if (r.code || r.missing) continue;
    // Directly under the root. A bundle further down is inside somebody's
    // folder of things, which is not the same as being installed.
    if (path.dirname(bundle) === r.path) return { kind: KIND.PERMANENT, bundle };
  }
  return { kind: KIND.UNAPPROVED, bundle, why: WHY[KIND.UNAPPROVED] };
}

/** Only an approved install may be registered, and only it may remove itself. */
function canRegister(run) { return !!run && run.kind === KIND.PERMANENT; }
function canUninstall(run) { return !!run && run.kind === KIND.PERMANENT && !!run.bundle; }

// ---------- what macOS says ----------

/**
 * Electron hands back macOS's own answer: not-registered, enabled,
 * requires-approval or not-found. Reduced to what the switch has to show,
 * because "on" and "registered, waiting to be allowed in System Settings" are
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
        message: 'Yapper is registered, but macOS is waiting for it to be allowed in System'
          + ' Settings › General › Login Items. Switching this off withdraws it instead.'
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

/**
 * What the switch looks like: the contract the renderer paints, decided once,
 * here, where it can be tested.
 *
 * `requires-approval` is the case to be careful with, because a registration
 * exists. Showing the switch off would make the next click ask for it *again*,
 * and no click would ever withdraw it — the user would be left with an entry
 * they cannot take back from inside Yapper. So it shows on, and switching it
 * off withdraws it.
 */
function switchView(result) {
  const state = (result && result.state) || 'error';
  return {
    state,
    checked: state === 'enabled' || state === 'requires-approval',
    // Only a copy that genuinely cannot change anything is left unusable. An
    // error is recoverable, so the click stays available.
    disabled: state === 'unavailable',
    hint: (result && (result.why || result.message)) || ''
  };
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
 * user has to allow it first.
 *
 * From a copy that is not an approved install this changes nothing at all —
 * not even to turn it off. A translocated or disk-image copy carries the same
 * bundle identifier as the one in Applications, so unregistering from it would
 * withdraw the real install's registration.
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
 * ones left out and why. Meetings are ordinary folders in the user's Documents
 * and are never anybody's to delete here, so a target that is the meetings
 * folder, contains it, or sits inside it is refused. YAPPER_HOME puts the two
 * side by side — `<home>/user` and `<home>/Meetings` — which is exactly the
 * arrangement an ancestor check has to get right in both directions.
 *
 * `meetings` must already be canonical: this answers with an error rather than
 * comparing against something that is not.
 */
function dataPlan({ userData, engineHome, meetings, io }) {
  const targets = [];
  const skipped = [];
  if (typeof meetings !== 'string' || !meetings) {
    return { targets, skipped, error: 'the meetings folder was not resolved first' };
  }

  const consider = (label, raw) => {
    if (!raw) return;
    const c = canonical(raw, io);
    if (c.code) {
      // Not knowing where something really is is a reason to leave it, and to
      // say so. It is never a reason to delete the path as written.
      return skipped.push({ label, path: raw, why: `its real location could not be read (${c.code})` });
    }
    const p = c.path;
    if (path.dirname(p) === p) {
      return skipped.push({ label, path: raw, why: 'it is the root of a volume' });
    }
    if (overlaps(p, meetings)) {
      return skipped.push({ label, path: raw, why: 'it is not separate from the meetings folder' });
    }
    if (targets.some(t => contains(t.path, p))) return;          // already covered
    for (let i = targets.length - 1; i >= 0; i--) {
      if (contains(p, targets[i].path)) targets.splice(i, 1);    // this one covers it
    }
    targets.push({ label, path: p, missing: !!c.missing });
  };

  consider('settings', userData);
  // Normally inside userData and already covered. It can be moved out from the
  // environment, and then the checkbox's promise is only kept by removing it
  // separately.
  consider('engine', engineHome);
  return { targets, skipped };
}

/**
 * Everything the uninstaller would touch, worked out and proved separate
 * before anything is touched at all — the login item included, since
 * withdrawing it is the one step that cannot be taken back.
 *
 * The bundle is checked against the meetings folder too, not only the data
 * directories. That is not a hypothetical: `YAPPER_HOME` pointed inside
 * `Yapper.app` puts `<home>/Meetings` *inside the bundle*, and moving the
 * bundle to the Trash would take every meeting with it without deleting a
 * single thing the data plan knows about.
 *
 * @returns {{ok:true, bundle:string, targets:Array, skipped:Array}|{ok:false, why:string}}
 */
function uninstallPreflight({ bundle, userData, engineHome, meetings, alsoData, io }) {
  const m = canonical(meetings, io);
  if (m.code) {
    return {
      ok: false,
      why: `Yapper could not work out where your meetings really are (${meetings}: ${m.code}),`
        + ' so it has removed nothing.'
    };
  }
  const b = canonical(bundle, io);
  if (b.code || b.missing) {
    return {
      ok: false,
      why: `Yapper could not work out where it is installed (${bundle}: ${b.code || 'ENOENT'}),`
        + ' so it has removed nothing.'
    };
  }
  if (overlaps(b.path, m.path)) {
    return {
      ok: false,
      why: `Yapper is not separate from your meetings: ${b.path} and ${m.path} are the same`
        + ' place, or one is inside the other. Moving the app to the Trash would take the'
        + ' meetings with it, so nothing has been removed.'
    };
  }
  if (!alsoData) return { ok: true, bundle: b.path, targets: [], skipped: [] };

  const plan = dataPlan({ userData, engineHome, meetings: m.path, io });
  if (plan.error) return { ok: false, why: `Yapper has removed nothing: ${plan.error}.` };
  return { ok: true, bundle: b.path, targets: plan.targets, skipped: plan.skipped };
}

// ---------- uninstalling ----------

/**
 * Removing the app has to remove the login item, and only the app can: the
 * registration is a record of the system's, so by the time the bundle is in
 * the Trash there is nothing left to withdraw it.
 *
 * The order is the point, and nothing is touched until the whole of it has
 * been worked out: preflight, then withdraw, then confirm the withdrawal by
 * reading macOS back — `setLoginItemSettings` returns void and Electron logs
 * SMAppService's error itself, so "no exception" says nothing — then the
 * bundle, then the data, then whatever is left over, then quit.
 *
 * @param {{run:function, confirm:function, preflight:function, setLoginItem:function,
 *          getLoginItem:function, trash:function, report:function, quit:function}} deps
 * @returns {Promise<{done:boolean, step:string, residue?:Array}>}
 */
async function uninstall(deps) {
  const run = deps.run();
  if (!canUninstall(run)) return { done: false, step: 'unavailable' };

  // Before the question, so a copy that cannot be removed safely is never
  // asked about. This pass covers the bundle, which moves either way.
  const first = deps.preflight(false);
  if (!first.ok) {
    await deps.report({ step: 'preflight', message: 'Yapper cannot remove itself safely.', detail: first.why });
    return { done: false, step: 'preflight' };
  }

  const choice = await deps.confirm();
  if (!choice || !choice.proceed) return { done: false, step: 'cancelled' };

  // Again with the answer, so the data half is proved before the login item —
  // the step that cannot be undone — is touched.
  const plan = choice.alsoData ? deps.preflight(true) : first;
  if (!plan.ok) {
    await deps.report({ step: 'preflight', message: 'Yapper cannot remove itself safely.', detail: plan.why });
    return { done: false, step: 'preflight' };
  }

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

  // The step that can be refused — a copy installed for every user is owned by
  // root — and if it is, nothing has been thrown away yet.
  const moved = await deps.trash(plan.bundle);
  if (!moved.ok) {
    await deps.report({
      step: 'bundle',
      message: 'Yapper could not move itself to the Trash.',
      detail: `${moved.message || 'The Trash refused it.'}\n\n`
        + 'Your settings and your meetings have not been touched. Yapper no longer opens '
        + `at login — that part is done — so dragging ${plan.bundle} to the Trash finishes it.`
    });
    return { done: false, step: 'bundle' };
  }

  const residue = [];
  for (const skip of plan.skipped) residue.push({ ...skip, kept: true });
  for (const target of plan.targets) {
    const r = await deps.trash(target.path);
    // Not there is the outcome that was wanted. Anything else is a leftover
    // the user should be told about rather than a silence.
    if (!r.ok && r.code !== 'ENOENT') {
      residue.push({ ...target, why: r.message || 'the Trash refused it' });
    }
  }

  // Before quitting: the bundle is in the Trash, but this process is still
  // alive and is the only thing that knows what was left behind.
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
  canonical, contains, overlaps, sameDirectory,
  bundleOfExecutable, bundleFromExecutable,
  classifyRun, canRegister, canUninstall,
  readState, switchView, initMac, setMac,
  dataPlan, uninstallPreflight, uninstall
};
