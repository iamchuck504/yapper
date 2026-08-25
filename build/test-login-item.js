// Behaviour, not text. The rules in loginitem.js decide whether a login item
// gets registered and whether the uninstaller is allowed to delete anything, so
// what has to be checked is what they do — with the filesystem and Electron
// replaced by fakes that record every call and can refuse to answer the way a
// real filesystem refuses.
//
// A regex over main.js cannot do that: invert the classification and the source
// still matches. Every case here fails if a predicate is flipped, if the result
// of withdrawing the login item is ignored, if a canonicalisation failure is
// swallowed, or if a step runs out of order.
const L = require('../loginitem');

let fails = 0;
function check(name, ok, detail) {
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      ${detail || ''}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- fakes ----------

/**
 * A filesystem that can say no. `links` maps a path to its real path, to an
 * `{code}` refusal, or to null for "not there"; anything unlisted resolves to
 * itself. `ids` gives device/inode identity, defaulting to one per path so
 * different paths are different directories.
 */
function fakeIO({ dirs = [], links = {}, write = {}, ids = {} } = {}) {
  const has = Object.prototype.hasOwnProperty;
  return {
    isDirectory: p => dirs.includes(p),
    realpath(p) {
      if (!has.call(links, p)) return { path: p };
      const v = links[p];
      if (v === null) return { code: 'ENOENT' };
      if (typeof v === 'object') return v;              // {code} or {path}
      return { path: v };
    },
    identity(p) {
      if (has.call(ids, p)) return ids[p];
      return { dev: 1, ino: `ino:${p}` };
    },
    writeStatus: p => write[p] || 'writable'
  };
}

/** An Electron whose every answer is scripted and every call recorded. */
function fakeSystem({ status = 'not-registered', after = null, settings = {} } = {}) {
  const calls = [];
  let now = status;
  return {
    calls,
    settings,
    getLoginItem: () => { calls.push(['get']); return { status: now, openAtLogin: now === 'enabled' }; },
    setLoginItem: on => {
      calls.push(['set', on]);
      // What macOS decides, which is not always what was asked. Withdrawing
      // always lands on not-registered — including from requires-approval,
      // which is a registration that exists and can be taken back.
      if (!on) now = 'not-registered';
      else now = after !== null ? after : 'enabled';
    },
    readSettings: () => ({ ...settings }),
    writeSettings: s => { Object.assign(settings, s); calls.push(['write', { ...s }]); }
  };
}

const setCalls = sys => sys.calls.filter(c => c[0] === 'set');

// ---------- 1. where is this copy running from ----------

const ROOTS = ['/Applications', '/Users/ana/Applications'];
const TEMPS = ['/private/var/folders', '/private/tmp', '/tmp'];
// The startup disk, as a device. fakeIO gives every path device 1 unless `ids`
// says otherwise, so a case only leaves the startup disk when it says so.
const ANCHORS = ['/System/Volumes/Data'];
const OTHER_DISK = { dev: 42, ino: 1 };
const APPS = '/Applications/Yapper.app';
const APPS_EXE = `${APPS}/Contents/MacOS/Yapper`;

const runs = [
  ['a normal install in /Applications', {
    exe: APPS_EXE, io: fakeIO({ dirs: [APPS] })
  }, L.KIND.PERMANENT, APPS],

  ['an install in the user\'s own Applications folder', {
    exe: '/Users/ana/Applications/Yapper.app/Contents/MacOS/Yapper',
    io: fakeIO({ dirs: ['/Users/ana/Applications/Yapper.app'] })
  }, L.KIND.PERMANENT, '/Users/ana/Applications/Yapper.app'],

  ['/Applications on a Mac where this account is not an admin', {
    exe: APPS_EXE, io: fakeIO({ dirs: [APPS], write: { '/Applications': 'denied' } })
  }, L.KIND.PERMANENT, APPS],

  ['a translocated first launch', {
    exe: '/private/var/folders/qb/x/AppTranslocation/9F1-UUID/d/Yapper.app/Contents/MacOS/Yapper',
    io: fakeIO({ dirs: ['/private/var/folders/qb/x/AppTranslocation/9F1-UUID/d/Yapper.app'] })
  }, L.KIND.TRANSLOCATED, '/private/var/folders/qb/x/AppTranslocation/9F1-UUID/d/Yapper.app'],

  ['a copy started from inside the mounted dmg', {
    exe: '/Volumes/Yapper 1.4.0/Yapper.app/Contents/MacOS/Yapper',
    io: fakeIO({
      dirs: ['/Volumes/Yapper 1.4.0/Yapper.app'],
      write: { '/Volumes/Yapper 1.4.0': 'read-only' }
    })
  }, L.KIND.READ_ONLY, '/Volumes/Yapper 1.4.0/Yapper.app'],

  // The one the old rule got wrong: writable, not temporary, and still not an
  // installation.
  ['a read-write disk image, which is writable and still not an install', {
    exe: '/Volumes/Yapper RW/Yapper.app/Contents/MacOS/Yapper',
    io: fakeIO({ dirs: ['/Volumes/Yapper RW/Yapper.app'] })
  }, L.KIND.UNAPPROVED, '/Volumes/Yapper RW/Yapper.app'],

  ['a copy left in Downloads', {
    exe: '/Users/ana/Downloads/Yapper.app/Contents/MacOS/Yapper',
    io: fakeIO({ dirs: ['/Users/ana/Downloads/Yapper.app'] })
  }, L.KIND.UNAPPROVED, '/Users/ana/Downloads/Yapper.app'],

  ['an Applications folder on an external disk — refused, deliberately', {
    exe: '/Volumes/Samsung T7/Applications/Yapper.app/Contents/MacOS/Yapper',
    io: fakeIO({
      dirs: ['/Volumes/Samsung T7/Applications/Yapper.app'],
      ids: { '/Volumes/Samsung T7/Applications/Yapper.app': OTHER_DISK,
        '/Volumes/Samsung T7/Applications': OTHER_DISK }
    })
  }, L.KIND.UNAPPROVED, '/Volumes/Samsung T7/Applications/Yapper.app'],

  // The bypass a name-only policy cannot see: the root is called
  // ~/Applications and is somewhere else entirely.
  ['~/Applications symlinked onto an external disk', {
    exe: '/Users/ana/Applications/Yapper.app/Contents/MacOS/Yapper',
    io: fakeIO({
      dirs: ['/Volumes/External/Applications/Yapper.app'],
      links: {
        '/Users/ana/Applications': '/Volumes/External/Applications',
        '/Users/ana/Applications/Yapper.app': '/Volumes/External/Applications/Yapper.app',
        '/Users/ana/Applications/Yapper.app/Contents/MacOS/Yapper':
          '/Volumes/External/Applications/Yapper.app/Contents/MacOS/Yapper'
      },
      ids: { '/Volumes/External/Applications/Yapper.app': OTHER_DISK,
        '/Volumes/External/Applications': OTHER_DISK }
    })
  }, L.KIND.UNAPPROVED, '/Volumes/External/Applications/Yapper.app'],

  // A read-write image mounted straight over an approved root. Identical by
  // path to a real install; a different device.
  ['a read-write image mounted over an approved root', {
    exe: '/Applications/Yapper.app/Contents/MacOS/Yapper',
    io: fakeIO({ dirs: [APPS], ids: { [APPS]: OTHER_DISK, '/Applications': OTHER_DISK } })
  }, L.KIND.UNAPPROVED, APPS],

  // hdiutil attach -mountpoint /Applications/Yapper.app: the folder above it is
  // the real /Applications, on the startup disk, and the bundle is a disk
  // image. Only the bundle's own volume tells them apart.
  ['a read-write image mounted at the bundle itself, under a genuine root', {
    exe: '/Applications/Yapper.app/Contents/MacOS/Yapper',
    io: fakeIO({ dirs: [APPS], ids: { [APPS]: OTHER_DISK } })
  }, L.KIND.UNAPPROVED, APPS],

  ['a bundle whose volume cannot be identified at all', {
    exe: APPS_EXE,
    io: fakeIO({ dirs: [APPS], ids: { [APPS]: { code: 'EIO' } } })
  }, L.KIND.UNKNOWN, APPS],

  ['an alias of a bundle that really is installed locally', {
    exe: '/Users/ana/Desktop/Yapper.app/Contents/MacOS/Yapper',
    io: fakeIO({
      dirs: [APPS],
      links: {
        '/Users/ana/Desktop/Yapper.app': APPS,
        '/Users/ana/Desktop/Yapper.app/Contents/MacOS/Yapper': APPS_EXE
      }
    })
  }, L.KIND.PERMANENT, APPS],

  ['a bundle buried inside a folder under an approved root', {
    exe: '/Applications/Utilities extra/Yapper.app/Contents/MacOS/Yapper',
    io: fakeIO({ dirs: ['/Applications/Utilities extra/Yapper.app'] })
  }, L.KIND.UNAPPROVED, '/Applications/Utilities extra/Yapper.app'],

  ['unpacked into a temp folder', {
    exe: '/private/tmp/dl/Yapper.app/Contents/MacOS/Yapper',
    io: fakeIO({ dirs: ['/private/tmp/dl/Yapper.app'] })
  }, L.KIND.TEMPORARY, '/private/tmp/dl/Yapper.app'],

  ['renamed, but still installed', {
    exe: '/Applications/Notes Recorder.app/Contents/MacOS/Yapper',
    io: fakeIO({ dirs: ['/Applications/Notes Recorder.app'] })
  }, L.KIND.PERMANENT, '/Applications/Notes Recorder.app'],

  ['an upper-case extension, which macOS will still run', {
    exe: '/Applications/YAPPER.APP/Contents/MacOS/Yapper',
    io: fakeIO({ dirs: ['/Applications/YAPPER.APP'] })
  }, L.KIND.PERMANENT, '/Applications/YAPPER.APP'],

  ['an alias of the whole bundle, which lands on the same directory', {
    exe: '/Volumes/Data/Applications/Yapper.app/Contents/MacOS/Yapper',
    io: fakeIO({
      dirs: [APPS],
      links: {
        '/Volumes/Data/Applications/Yapper.app/Contents/MacOS/Yapper': APPS_EXE,
        '/Volumes/Data/Applications/Yapper.app': APPS
      }
    })
  }, L.KIND.PERMANENT, APPS],

  // Both ends are real, valid bundles. Only comparing the two canonical
  // bundles catches it; checking each layout separately does not.
  ['a real decoy.app whose executable links into another valid bundle', {
    exe: '/Applications/decoy.app/Contents/MacOS/Yapper',
    io: fakeIO({
      dirs: [APPS, '/Applications/decoy.app'],
      links: { '/Applications/decoy.app/Contents/MacOS/Yapper': APPS_EXE }
    })
  }, L.KIND.UNKNOWN, null],

  ['a symlink that only looks like a bundle', {
    exe: '/tmp/decoy.app/Contents/MacOS/Yapper',
    io: fakeIO({
      dirs: ['/Applications'],
      links: { '/tmp/decoy.app/Contents/MacOS/Yapper': '/Applications/Contents/MacOS/Yapper' }
    })
  }, L.KIND.UNKNOWN, null],

  ['an executable that is not in Contents/MacOS', {
    exe: '/Applications/Yapper.app/Yapper', io: fakeIO({ dirs: [APPS] })
  }, L.KIND.UNKNOWN, null],

  ['a bundle that is not a directory any more', {
    exe: APPS_EXE, io: fakeIO({ dirs: [] })
  }, L.KIND.UNKNOWN, null],

  ['an executable whose real path cannot be read', {
    exe: APPS_EXE, io: fakeIO({ dirs: [APPS], links: { [APPS_EXE]: { code: 'EACCES' } } })
  }, L.KIND.UNKNOWN, null],

  ['a bundle whose own real path cannot be read', {
    exe: APPS_EXE, io: fakeIO({ dirs: [APPS], links: { [APPS]: { code: 'EIO' } } })
  }, L.KIND.UNKNOWN, null],

  ['a location that no longer exists', {
    exe: '/Volumes/gone/Yapper.app/Contents/MacOS/Yapper',
    io: fakeIO({ dirs: ['/Volumes/gone/Yapper.app'], write: { '/Volumes/gone': 'missing' } })
  }, L.KIND.UNKNOWN, '/Volumes/gone/Yapper.app'],

  ['a filesystem that answered with an I/O error', {
    exe: APPS_EXE, io: fakeIO({ dirs: [APPS], write: { '/Applications': 'error' } })
  }, L.KIND.UNKNOWN, APPS],

  ['a relative path, which is not an install at all', {
    exe: 'Yapper.app/Contents/MacOS/Yapper', io: fakeIO({})
  }, L.KIND.UNKNOWN, null]
];

for (const [name, o, kind, bundle] of runs) {
  const run = L.classifyRun({
    platform: 'darwin', isPackaged: true, exe: o.exe,
    tempDirs: TEMPS, installRoots: ROOTS, approvedVolumeAnchors: ANCHORS, io: o.io
  });
  check(name, run.kind === kind && run.bundle === bundle,
    `kind=${run.kind} bundle=${run.bundle}\n      wanted kind=${kind} bundle=${bundle}`);
}

check('a read-only location is not called a disk image as though we knew',
  /read-only disk/.test(L.WHY[L.KIND.READ_ONLY]) && !/^This copy is running from a disk image/.test(L.WHY[L.KIND.READ_ONLY]),
  L.WHY[L.KIND.READ_ONLY]);
check('and an unapproved location says what is actually wrong with it',
  /Applications folder/.test(L.WHY[L.KIND.UNAPPROVED]), L.WHY[L.KIND.UNAPPROVED]);

check('a dev run is its own case, before any path is looked at',
  L.classifyRun({ platform: 'darwin', isPackaged: false, exe: APPS_EXE, io: fakeIO() }).kind
  === L.KIND.DEVELOPMENT, 'a checkout would be treated as an install');
check('Windows is none of this',
  L.classifyRun({ platform: 'win32', isPackaged: true, exe: 'C:\\x\\Yapper.exe', io: fakeIO() }).kind
  === L.KIND.OTHER_OS, 'the macOS rules would be applied to Windows');

for (const kind of Object.values(L.KIND)) {
  const want = kind === L.KIND.PERMANENT;
  check(`${kind}: register ${want ? 'allowed' : 'refused'}`,
    L.canRegister({ kind, bundle: APPS }) === want);
  check(`${kind}: uninstall ${want ? 'allowed' : 'refused'}`,
    L.canUninstall({ kind, bundle: APPS }) === want);
}
check('uninstalling needs a bundle, not just a permanent verdict',
  !L.canUninstall({ kind: L.KIND.PERMANENT, bundle: null }), 'it would trash undefined');

// ---------- 2. startup reads, it does not register ----------

const permanent = () => ({ kind: L.KIND.PERMANENT, bundle: APPS });
const transient = () => ({ kind: L.KIND.READ_ONLY, bundle: '/Volumes/dmg/Yapper.app', why: 'nope' });

{
  const sys = fakeSystem({ status: 'not-registered' });
  const r = L.initMac({ run: permanent, ...sys });
  check('a fresh install starts off', r.state === 'disabled', `got ${r.state}`);
  check('and registers nothing on the way', setCalls(sys).length === 0,
    `${setCalls(sys).length} calls to setLoginItemSettings`);
  check('and writes down what the system said, with the marker',
    sys.settings.openAtLogin === false && sys.settings.openAtLoginMigration === L.MIGRATION,
    JSON.stringify(sys.settings));
}
{
  const sys = fakeSystem({ status: 'enabled', settings: {} });
  const r = L.initMac({ run: permanent, ...sys });
  check('an install the user turned on reads as on', r.state === 'enabled', `got ${r.state}`);
  check('still without touching the registration', setCalls(sys).length === 0);
}
{
  const sys = fakeSystem({ status: 'not-registered', settings: { openAtLogin: true } });
  const r = L.initMac({ run: permanent, ...sys });
  check('a revocation made in System Settings is not reverted',
    r.state === 'disabled' && setCalls(sys).length === 0, `${r.state}, ${setCalls(sys).length} sets`);
  check('and the stored wish that contradicted it is gone',
    sys.settings.openAtLogin === false && sys.settings.openAtLoginMigration === L.MIGRATION,
    JSON.stringify(sys.settings));
}
{
  const sys = fakeSystem({ status: 'requires-approval', settings: { openAtLogin: true } });
  const r = L.initMac({ run: permanent, ...sys });
  check('waiting to be allowed is its own answer, not "on"',
    r.state === 'requires-approval' && !!r.message, JSON.stringify(r));
  check('and it is not persisted as a true to retry later',
    sys.settings.openAtLogin === false, JSON.stringify(sys.settings));
}
{
  const sys = fakeSystem({ status: 'enabled', settings: { openAtLogin: true, openAtLoginMigration: L.MIGRATION } });
  L.initMac({ run: permanent, ...sys });
  check('a settled install is not rewritten on every launch',
    sys.calls.every(c => c[0] !== 'write'), JSON.stringify(sys.calls));
}
{
  const sys = fakeSystem({ status: 'enabled' });
  const r = L.initMac({ run: () => ({ kind: L.KIND.DEVELOPMENT }), ...sys });
  check('a dev run withdraws, exactly once, and only ever false',
    eq(setCalls(sys), [['set', false]]), JSON.stringify(setCalls(sys)));
  check('and reports itself off', r.state === 'disabled' && r.devCleared === true, JSON.stringify(r));
}
{
  const sys = fakeSystem({ status: 'not-registered' });
  L.initMac({ run: transient, ...sys });
  check('a copy on a read-only disk changes nothing at startup', setCalls(sys).length === 0,
    JSON.stringify(setCalls(sys)));
}

// ---------- 3. the switch, and what it looks like ----------

{
  const sys = fakeSystem({ status: 'not-registered' });
  const r = L.setMac({ run: permanent, ...sys }, true);
  check('turning it on from an install works',
    r.state === 'enabled' && eq(setCalls(sys), [['set', true]]), JSON.stringify(r));
  check('and records that this was the user asking',
    sys.settings.openAtLoginUserSet === true && sys.settings.openAtLogin === true,
    JSON.stringify(sys.settings));
}
{
  const sys = fakeSystem({ status: 'not-registered', after: 'not-registered' });
  const r = L.setMac({ run: permanent, ...sys }, true);
  check('a refusal is reported as a refusal, not as success',
    r.state === 'disabled' && r.refused === true, JSON.stringify(r));
  check('and nothing is stored as on', sys.settings.openAtLogin === false, JSON.stringify(sys.settings));
}
{
  const sys = fakeSystem({ status: 'not-registered', after: 'requires-approval' });
  const r = L.setMac({ run: permanent, ...sys }, true);
  check('needing approval is passed through with its explanation',
    r.state === 'requires-approval' && /System Settings/.test(r.message), JSON.stringify(r));
}
{
  // The trap: a registration that exists and is waiting. It has to be possible
  // to take it back from inside Yapper.
  const sys = fakeSystem({ status: 'requires-approval' });
  const shown = L.switchView(L.readState(sys.getLoginItem()));
  check('waiting-for-approval shows as on, so the next click means "withdraw"',
    shown.checked === true && shown.disabled === false, JSON.stringify(shown));
  const r = L.setMac({ run: permanent, ...sys }, !shown.checked);
  check('and that click really withdraws it',
    r.state === 'disabled' && eq(setCalls(sys), [['set', false]]), JSON.stringify(r));
  check('leaving nothing registered',
    sys.getLoginItem().status === 'not-registered' && sys.settings.openAtLogin === false,
    JSON.stringify(sys.settings));
}
{
  const sys = fakeSystem({ status: 'enabled' });
  const r = L.setMac({ run: permanent, ...sys }, false);
  check('turning it off works', r.state === 'disabled' && eq(setCalls(sys), [['set', false]]),
    JSON.stringify(r));
}
for (const [name, run] of [
  ['a read-only disk', transient],
  ['a translocated copy', () => ({ kind: L.KIND.TRANSLOCATED, bundle: '/x/Yapper.app', why: 'no' })],
  ['a copy in Downloads', () => ({ kind: L.KIND.UNAPPROVED, bundle: '/d/Yapper.app', why: 'no' })],
  ['a dev run', () => ({ kind: L.KIND.DEVELOPMENT, why: 'no' })]]) {
  for (const wanted of [true, false]) {
    const sys = fakeSystem({ status: 'enabled' });
    const r = L.setMac({ run, ...sys }, wanted);
    check(`${name} cannot turn it ${wanted ? 'on' : 'off'}, and does not try`,
      r.state === 'unavailable' && setCalls(sys).length === 0 && !!r.why,
      `${JSON.stringify(r)} · ${JSON.stringify(setCalls(sys))}`);
  }
}

const views = [
  ['enabled', { checked: true, disabled: false }],
  ['disabled', { checked: false, disabled: false }],
  ['requires-approval', { checked: true, disabled: false }],
  ['unavailable', { checked: false, disabled: true }],
  ['error', { checked: false, disabled: false }]
];
for (const [state, want] of views) {
  const v = L.switchView({ state });
  check(`the switch for "${state}" is ${want.checked ? 'on' : 'off'}${want.disabled ? ', disabled' : ', usable'}`,
    v.checked === want.checked && v.disabled === want.disabled, JSON.stringify(v));
}
check('an explanation comes through to the switch',
  L.switchView({ state: 'unavailable', why: 'move it' }).hint === 'move it');
check('and so does an error message',
  L.switchView({ state: 'error', message: 'no answer' }).hint === 'no answer');

// ---------- 4. what the uninstaller may delete ----------

const MEET = '/Users/ana/Documents/Meetings';
const DATA = '/Users/ana/Library/Application Support/yapper';

{
  const plan = L.dataPlan({ userData: DATA, engineHome: `${DATA}/Yapper/engine`, meetings: MEET, io: fakeIO() });
  check('the normal layout deletes the data directory once',
    eq(plan.targets.map(t => t.path), [DATA]), JSON.stringify(plan));
}
{
  const home = '/tmp/scratch';
  const plan = L.dataPlan({
    userData: `${home}/user`, engineHome: `${home}/user/Yapper/engine`,
    meetings: `${home}/Meetings`, io: fakeIO()
  });
  check('YAPPER_HOME keeps them apart and only takes the data half',
    eq(plan.targets.map(t => t.path), [`${home}/user`]), JSON.stringify(plan));
}
{
  const plan = L.dataPlan({
    userData: DATA, engineHome: '/Users/ana/Library/Caches/yapper-engine', meetings: MEET, io: fakeIO()
  });
  check('an engine moved out of the data directory is removed as well',
    plan.targets.length === 2, JSON.stringify(plan.targets));
}
const refusals = [
  ['the meetings folder itself', MEET, MEET],
  ['a parent of the meetings folder', '/Users/ana/Documents', MEET],
  ['the home directory', '/Users/ana', MEET],
  ['a directory inside the meetings folder', `${MEET}/data`, MEET],
  ['the root of a volume', '/', MEET]
];
for (const [name, userData, meetings] of refusals) {
  const plan = L.dataPlan({ userData, engineHome: null, meetings, io: fakeIO() });
  check(`refuses ${name}`, plan.targets.length === 0 && plan.skipped.length === 1, JSON.stringify(plan));
}
{
  const plan = L.dataPlan({
    userData: DATA, engineHome: null, meetings: `${DATA}/Meetings`,
    io: fakeIO({ links: { [MEET]: `${DATA}/Meetings` } })
  });
  check('refuses a meetings folder that resolves into the data directory',
    plan.targets.length === 0 && plan.skipped.length === 1, JSON.stringify(plan));
}
for (const code of ['EACCES', 'EIO', 'ESTALE', 'EPERM']) {
  const plan = L.dataPlan({
    userData: DATA, engineHome: null, meetings: MEET, io: fakeIO({ links: { [DATA]: { code } } })
  });
  check(`a data directory whose real path answers ${code} is kept, not deleted`,
    plan.targets.length === 0 && plan.skipped.length === 1 && plan.skipped[0].why.includes(code),
    JSON.stringify(plan));
}
{
  const plan = L.dataPlan({
    userData: DATA, engineHome: '/Users/ana/Library/Caches/eng', meetings: MEET,
    io: fakeIO({ links: { '/Users/ana/Library/Caches/eng': { code: 'EIO' } } })
  });
  check('one unreadable target does not stop the other from being removed',
    eq(plan.targets.map(t => t.path), [DATA]) && plan.skipped.length === 1, JSON.stringify(plan));
}
{
  // Not there yet is not the same as unreadable: it stays a target, and the
  // Trash reporting ENOENT is what makes it a non-event.
  const plan = L.dataPlan({
    userData: DATA, engineHome: null, meetings: MEET, io: fakeIO({ links: { [DATA]: null } })
  });
  check('a data directory that does not exist is still a target, marked missing',
    plan.targets.length === 1 && plan.targets[0].missing === true, JSON.stringify(plan));
}
{
  const plan = L.dataPlan({ userData: DATA, engineHome: null, meetings: '', io: fakeIO() });
  check('an unresolved meetings path is an error, not an empty comparison',
    !!plan.error && plan.targets.length === 0, JSON.stringify(plan));
}

// ---------- 5. the preflight, before anything is touched ----------

const pf = o => L.uninstallPreflight({
  bundle: APPS, userData: DATA, engineHome: `${DATA}/Yapper/engine`,
  meetings: MEET, alsoData: true, io: fakeIO(), ...o
});

check('a normal install passes the preflight', pf({}).ok === true, JSON.stringify(pf({})));

{
  // YAPPER_HOME inside the bundle: <home>/Meetings is inside Yapper.app, and
  // trashing the bundle would take every meeting with it — without the data
  // plan ever being asked.
  const r = pf({
    meetings: `${APPS}/home/Meetings`, userData: `${APPS}/home/user`,
    engineHome: null, alsoData: false
  });
  check('a bundle that contains the meetings folder is refused outright',
    r.ok === false && /not separate/.test(r.why), JSON.stringify(r));
}
{
  const r = pf({ bundle: '/Users/ana/Documents/Meetings/Yapper.app', alsoData: false,
    io: fakeIO({ dirs: ['/Users/ana/Documents/Meetings/Yapper.app'] }) });
  check('a bundle installed inside the meetings folder is refused',
    r.ok === false && /not separate/.test(r.why), JSON.stringify(r));
}
{
  const r = pf({ bundle: MEET, alsoData: false });
  check('a bundle that is the meetings folder is refused', r.ok === false, JSON.stringify(r));
}
{
  const r = pf({ bundle: '/Applications/Alias.app', alsoData: false,
    io: fakeIO({ links: { '/Applications/Alias.app': `${MEET}/Yapper.app` } }) });
  check('and so is one that only reaches the meetings folder through a symlink',
    r.ok === false && /not separate/.test(r.why), JSON.stringify(r));
}
{
  const r = pf({ io: fakeIO({ links: { [MEET]: `${DATA}/Meetings` } }) });
  const overlapping = r.targets.filter(t => L.overlaps(t.path, `${DATA}/Meetings`));
  check('a meetings folder symlinked into the data directory is caught by the preflight',
    r.ok === true && overlapping.length === 0
    && r.skipped.some(k => k.label === 'settings' && /not separate/.test(k.why)),
    JSON.stringify(r));
}
for (const code of ['EACCES', 'EIO']) {
  const r = pf({ io: fakeIO({ links: { [MEET]: { code } } }) });
  check(`meetings that cannot be canonicalised (${code}) stops the whole uninstall`,
    r.ok === false && r.why.includes(code), JSON.stringify(r));
}
{
  const r = pf({ io: fakeIO({ links: { [APPS]: { code: 'EIO' } } }) });
  check('a bundle that cannot be canonicalised stops it too',
    r.ok === false && r.why.includes('EIO'), JSON.stringify(r));
}
{
  const r = pf({ io: fakeIO({ links: { [APPS]: null } }) });
  check('and so does a bundle that is not there', r.ok === false, JSON.stringify(r));
}
// The bundle moves whether or not the box is ticked, so the data has to be
// shown to be outside it either way. An earlier version returned before even
// looking, which is how "do not delete my settings" could still delete them.
{
  const r = pf({ alsoData: false, io: fakeIO({ links: { [DATA]: { code: 'EACCES' } } }) });
  check('without the checkbox, a data directory whose location cannot be read still stops it',
    r.ok === false && /EACCES/.test(r.why), JSON.stringify(r));
}
{
  const r = pf({ userData: `${APPS}/private/user`, alsoData: false });
  check('settings inside the bundle stop the uninstall even with the box unticked',
    r.ok === false && /inside the app itself/.test(r.why), JSON.stringify(r));
}
{
  const r = pf({ engineHome: `${APPS}/private/engine`, alsoData: false });
  check('an engine inside the bundle does too — LOCALAPPDATA reaches here on macOS',
    r.ok === false && /inside the app itself/.test(r.why), JSON.stringify(r));
}
{
  const r = pf({ userData: '/tmp/yhome/user', engineHome: null, meetings: '/tmp/yhome/Meetings',
    alsoData: false, io: fakeIO({ links: { '/tmp/yhome/user': `${APPS}/private/user` } }) });
  check('and so does a symlink that only reaches inside the bundle',
    r.ok === false && /inside the app itself/.test(r.why), JSON.stringify(r));
}
{
  const r = pf({ userData: `${APPS}/private/user`, alsoData: true });
  check('with the box ticked it is refused too, rather than trashed twice or called "kept"',
    r.ok === false, JSON.stringify(r));
}
{
  const r = pf({ engineHome: `${DATA}/Yapper/engine`, alsoData: true });
  check('a normal layout still passes with the box ticked',
    r.ok === true && r.targets.length === 1, JSON.stringify(r));
}

// ---------- volume roots ----------
// path.dirname(p) === p finds only "/". A mounted volume's root has an
// ordinary parent and is still a whole disk.
const mounted = extra => fakeIO({
  ids: { '/Volumes/Work': { dev: 9, ino: 2 }, '/Volumes': { dev: 1, ino: 3 } }, ...extra
});
{
  const plan = L.dataPlan({ userData: '/Volumes/Work', engineHome: null, meetings: MEET, io: mounted() });
  check('the root of a mounted volume is refused, not trashed',
    plan.targets.length === 0 && /root of a volume/.test(plan.skipped[0].why), JSON.stringify(plan));
}
{
  const plan = L.dataPlan({
    userData: '/tmp/yhome/user', engineHome: null, meetings: MEET,
    io: fakeIO({
      links: { '/tmp/yhome/user': '/Volumes/Work' },
      ids: { '/Volumes/Work': { dev: 9, ino: 2 }, '/Volumes': { dev: 1, ino: 3 } }
    })
  });
  check('and so is a path that only canonicalises to one', plan.targets.length === 0, JSON.stringify(plan));
}
{
  const plan = L.dataPlan({
    userData: DATA, engineHome: '/Volumes/Work', meetings: MEET, io: mounted()
  });
  check('an engine that is a volume root is left, and the settings still go',
    plan.targets.length === 1 && plan.targets[0].path === DATA && plan.skipped.length === 1,
    JSON.stringify(plan));
}
{
  const plan = L.dataPlan({
    userData: '/Volumes/Work/YapperData', engineHome: null, meetings: MEET,
    io: fakeIO({ ids: { '/Volumes/Work/YapperData': { dev: 9, ino: 5 },
      '/Volumes/Work': { dev: 9, ino: 2 } } })
  });
  check('an ordinary folder on that volume is still fine',
    plan.targets.length === 1, JSON.stringify(plan));
}
{
  const plan = L.dataPlan({
    userData: '/Volumes/Work/Data', engineHome: null, meetings: MEET,
    io: fakeIO({ ids: { '/Volumes/Work/Data': { code: 'EIO' } } })
  });
  check('and if it cannot be told whether it is a volume root, it is left alone',
    plan.targets.length === 0 && /could not be determined/.test(plan.skipped[0].why),
    JSON.stringify(plan));
}

// ---------- 6. uninstalling, step by step ----------

async function uninstallChecks() {
  function fakeUninstall({ kind = L.KIND.PERMANENT, proceed = true, alsoData = false,
    afterWithdraw = 'not-registered', trashFails = {}, preflight = null } = {}) {
    const log = [];
    const deps = {
      run: () => ({ kind, bundle: APPS }),
      preflight: also => {
        log.push(['preflight', !!also]);
        if (preflight) return preflight;
        return { ok: true, bundle: APPS, targets: also ? [{ label: 'settings', path: DATA }] : [], skipped: [] };
      },
      confirm: async () => { log.push(['confirm']); return { proceed, alsoData }; },
      setLoginItem: on => log.push(['set', on]),
      getLoginItem: () => { log.push(['get']); return { status: afterWithdraw }; },
      trash: async p => {
        log.push(['trash', p]);
        const f = trashFails[p];
        return f ? { ok: false, code: f.code, message: f.message } : { ok: true };
      },
      report: async r => { log.push(['report', r.step]); },
      quit: () => log.push(['quit'])
    };
    return { deps, log };
  }
  const steps = log => log.map(e => e[0]);
  const trashed = log => log.filter(e => e[0] === 'trash').map(e => e[1]);

  {
    const { deps, log } = fakeUninstall({ alsoData: true });
    const r = await L.uninstall(deps);
    check('the whole sequence runs in order, preflight first',
      eq(steps(log), ['preflight', 'confirm', 'preflight', 'set', 'get', 'trash', 'trash', 'quit']),
      JSON.stringify(steps(log)));
    check('nothing is touched before the preflight',
      steps(log)[0] === 'preflight' && steps(log).indexOf('set') > steps(log).indexOf('confirm'),
      JSON.stringify(steps(log)));
    check('the bundle goes before the data', eq(trashed(log), [APPS, DATA]), JSON.stringify(trashed(log)));
    check('and it finishes', r.done === true, JSON.stringify(r));
  }
  {
    const { deps, log } = fakeUninstall({ alsoData: false });
    await L.uninstall(deps);
    check('without the checkbox only the bundle is touched', eq(trashed(log), [APPS]), JSON.stringify(log));
  }
  {
    const { deps, log } = fakeUninstall({ proceed: false, alsoData: true });
    const r = await L.uninstall(deps);
    check('cancelling changes nothing at all',
      eq(steps(log), ['preflight', 'confirm']) && r.step === 'cancelled', JSON.stringify(steps(log)));
  }
  {
    const { deps, log } = fakeUninstall({
      alsoData: true, preflight: { ok: false, why: 'not separate from the meetings folder' }
    });
    const r = await L.uninstall(deps);
    check('a refused preflight asks nothing and touches nothing',
      eq(steps(log), ['preflight', 'report']) && r.step === 'preflight', JSON.stringify(steps(log)));
    check('so the login item, the bundle, the data and the meetings are all untouched',
      !steps(log).includes('set') && !steps(log).includes('trash') && !steps(log).includes('quit'),
      JSON.stringify(steps(log)));
  }
  for (const status of ['enabled', 'requires-approval', 'not-found']) {
    const { deps, log } = fakeUninstall({ afterWithdraw: status, alsoData: true });
    const r = await L.uninstall(deps);
    check(`a withdrawal that leaves macOS reporting "${status}" stops everything`,
      trashed(log).length === 0 && !steps(log).includes('quit') && r.step === 'login-item',
      JSON.stringify(log));
    check(`and says so ("${status}")`, steps(log).includes('report'), JSON.stringify(steps(log)));
  }
  {
    const { deps, log } = fakeUninstall({
      alsoData: true, trashFails: { [APPS]: { code: 'EPERM', message: 'not permitted' } }
    });
    const r = await L.uninstall(deps);
    check('a bundle the Trash refuses leaves the data alone and the app installed',
      eq(trashed(log), [APPS]) && !steps(log).includes('quit') && r.step === 'bundle',
      JSON.stringify(log));
    check('and reports it', steps(log).includes('report'), JSON.stringify(steps(log)));
  }
  {
    const { deps, log } = fakeUninstall({
      alsoData: true, trashFails: { [DATA]: { code: 'EPERM', message: 'not permitted' } }
    });
    const r = await L.uninstall(deps);
    check('data that could not be removed is reported, with the path, before quitting',
      steps(log).indexOf('report') < steps(log).indexOf('quit')
      && r.residue.length === 1 && r.residue[0].path === DATA, JSON.stringify(log));
  }
  {
    const { deps, log } = fakeUninstall({ alsoData: true, trashFails: { [DATA]: { code: 'ENOENT' } } });
    const r = await L.uninstall(deps);
    check('data that was already gone is not reported as a problem',
      !steps(log).includes('report') && r.residue.length === 0 && steps(log).includes('quit'),
      JSON.stringify(log));
  }
  {
    const { deps, log } = fakeUninstall({
      alsoData: true,
      preflight: { ok: true, bundle: APPS, targets: [],
        skipped: [{ label: 'settings', path: DATA, why: 'its real location could not be read (EACCES)' }] }
    });
    const r = await L.uninstall(deps);
    check('a target that could not be proved safe is kept and reported',
      r.residue.length === 1 && r.residue[0].kept === true && steps(log).includes('report'),
      JSON.stringify(r));
  }
  for (const kind of [L.KIND.DEVELOPMENT, L.KIND.TRANSLOCATED, L.KIND.READ_ONLY,
    L.KIND.TEMPORARY, L.KIND.UNAPPROVED, L.KIND.UNKNOWN]) {
    const { deps, log } = fakeUninstall({ kind, alsoData: true });
    const r = await L.uninstall(deps);
    check(`${kind} cannot uninstall, and is not even asked`,
      log.length === 0 && r.step === 'unavailable', JSON.stringify(log));
  }
  {
    // Across every path: the meetings folder is never handed to the Trash.
    const seen = [];
    for (const opts of [{ alsoData: true }, { alsoData: false },
      { alsoData: true, afterWithdraw: 'enabled' },
      { alsoData: true, trashFails: { [APPS]: { code: 'EPERM' } } },
      { alsoData: true, preflight: { ok: false, why: 'no' } }]) {
      const { deps, log } = fakeUninstall(opts);
      await L.uninstall(deps);
      seen.push(...trashed(log));
    }
    check('the meetings folder is never a target, on any path',
      seen.every(p => !L.overlaps(p, MEET)), JSON.stringify(seen));
  }
}

uninstallChecks().then(() => {
  console.log(fails ? `\n${fails} failures` : '\nPASS');
  process.exit(fails ? 1 : 0);
}, e => {
  console.log('FAIL  the uninstall checks threw\n      ' + ((e && e.stack) || e));
  process.exit(1);
});
