// Behaviour, not text. The rules in loginitem.js decide whether a login item
// gets registered and whether the uninstaller is allowed to delete anything, so
// what has to be checked is what they do — with the filesystem and Electron
// replaced by fakes that record every call.
//
// A regex over main.js cannot do that: invert the classification and the source
// still matches. Every case here fails if the predicate is flipped, if the
// result of withdrawing the login item is ignored, or if a step runs out of
// order.
const path = require('path');
const L = require('../loginitem');

let fails = 0;
function check(name, ok, detail) {
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      ${detail || ''}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- fakes ----------

/** @param {{dirs?:string[], links?:object, write?:object}} o */
function fakeIO({ dirs = [], links = {}, write = {} } = {}) {
  return {
    isDirectory: p => dirs.includes(p),
    // `null` means realpath failed — the path is gone.
    realpath: p => (Object.prototype.hasOwnProperty.call(links, p) ? links[p] : p),
    writeStatus: p => write[p] || 'writable'
  };
}

/** An Electron whose every answer is scripted and every call is recorded. */
function fakeSystem({ status = 'not-registered', after = null, settings = {} } = {}) {
  const calls = [];
  let now = status;
  return {
    calls,
    settings,
    getLoginItem: () => { calls.push(['get']); return { status: now, openAtLogin: now === 'enabled' }; },
    setLoginItem: on => {
      calls.push(['set', on]);
      // `after` is what macOS decides, which is not always what was asked.
      now = after !== null ? after : (on ? 'enabled' : 'not-registered');
    },
    readSettings: () => ({ ...settings }),
    writeSettings: s => { Object.assign(settings, s); calls.push(['write', { ...s }]); }
  };
}

const setCalls = sys => sys.calls.filter(c => c[0] === 'set');

// ---------- 1. where is this copy running from ----------

const APPS = '/Applications/Yapper.app';
const APPS_EXE = `${APPS}/Contents/MacOS/Yapper`;

const runs = [
  ['a normal install in /Applications', {
    exe: APPS_EXE, io: fakeIO({ dirs: [APPS] })
  }, L.KIND.PERMANENT, APPS],

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

  ['a real install on an external disk, which /Volumes alone would have condemned', {
    exe: '/Volumes/Samsung T7/Applications/Yapper.app/Contents/MacOS/Yapper',
    io: fakeIO({ dirs: ['/Volumes/Samsung T7/Applications/Yapper.app'] })
  }, L.KIND.PERMANENT, '/Volumes/Samsung T7/Applications/Yapper.app'],

  ['unpacked into a temp folder', {
    exe: '/private/tmp/dl/Yapper.app/Contents/MacOS/Yapper',
    io: fakeIO({ dirs: ['/private/tmp/dl/Yapper.app'] })
  }, L.KIND.TEMPORARY, '/private/tmp/dl/Yapper.app'],

  ['renamed and kept somewhere else', {
    exe: '/Users/ana/Applications/Notes Recorder.app/Contents/MacOS/Yapper',
    io: fakeIO({ dirs: ['/Users/ana/Applications/Notes Recorder.app'] })
  }, L.KIND.PERMANENT, '/Users/ana/Applications/Notes Recorder.app'],

  ['an upper-case extension, which macOS will still run', {
    exe: '/Applications/YAPPER.APP/Contents/MacOS/Yapper',
    io: fakeIO({ dirs: ['/Applications/YAPPER.APP'] })
  }, L.KIND.PERMANENT, '/Applications/YAPPER.APP'],

  ['a symlinked path that still lands in a bundle', {
    exe: '/Volumes/Data/Applications/Yapper.app/Contents/MacOS/Yapper',
    io: fakeIO({
      dirs: ['/System/Volumes/Data/Applications/Yapper.app'],
      links: {
        '/Volumes/Data/Applications/Yapper.app/Contents/MacOS/Yapper':
          '/System/Volumes/Data/Applications/Yapper.app/Contents/MacOS/Yapper'
      }
    })
  }, L.KIND.PERMANENT, '/System/Volumes/Data/Applications/Yapper.app'],

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

  ['a bundle that is not there any more', {
    exe: APPS_EXE, io: fakeIO({ dirs: [] })
  }, L.KIND.UNKNOWN, null],

  ['an executable whose real path cannot be read', {
    exe: APPS_EXE, io: fakeIO({ dirs: [APPS], links: { [APPS_EXE]: null } })
  }, L.KIND.UNKNOWN, null],

  ['a location that no longer exists', {
    exe: '/Volumes/gone/Yapper.app/Contents/MacOS/Yapper',
    io: fakeIO({ dirs: ['/Volumes/gone/Yapper.app'], write: { '/Volumes/gone': 'missing' } })
  }, L.KIND.UNKNOWN, '/Volumes/gone/Yapper.app'],

  ['a relative path, which is not an install at all', {
    exe: 'Yapper.app/Contents/MacOS/Yapper', io: fakeIO({})
  }, L.KIND.UNKNOWN, null]
];

for (const [name, o, kind, bundle] of runs) {
  const run = L.classifyRun({
    platform: 'darwin', isPackaged: true, exe: o.exe,
    tempDirs: ['/private/var/folders', '/private/tmp', '/tmp'], io: o.io
  });
  check(name, run.kind === kind && run.bundle === bundle,
    `kind=${run.kind} bundle=${run.bundle}\n      wanted kind=${kind} bundle=${bundle}`);
}

check('a dev run is its own case, before any path is looked at',
  L.classifyRun({ platform: 'darwin', isPackaged: false, exe: APPS_EXE, io: fakeIO() }).kind
  === L.KIND.DEVELOPMENT, 'a checkout would be treated as an install');
check('Windows is none of this',
  L.classifyRun({ platform: 'win32', isPackaged: true, exe: 'C:\\\\x\\\\Yapper.exe', io: fakeIO() }).kind
  === L.KIND.OTHER_OS, 'the macOS rules would be applied to Windows');

// Only one of them may be registered, and only one may delete itself.
for (const kind of Object.values(L.KIND)) {
  const run = { kind, bundle: kind === L.KIND.PERMANENT ? APPS : APPS };
  const want = kind === L.KIND.PERMANENT;
  check(`${kind}: register ${want ? 'allowed' : 'refused'}`, L.canRegister(run) === want);
  check(`${kind}: uninstall ${want ? 'allowed' : 'refused'}`, L.canUninstall(run) === want);
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
  // The old default wrote true. The user has since revoked it in System
  // Settings. Startup must not undo that.
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
  check('a copy on a disk image changes nothing at startup', setCalls(sys).length === 0,
    JSON.stringify(setCalls(sys)));
}

// ---------- 3. the switch ----------

{
  const sys = fakeSystem({ status: 'not-registered' });
  const r = L.setMac({ run: permanent, ...sys }, true);
  check('turning it on from a permanent install works',
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
  check('and nothing is stored as on',
    sys.settings.openAtLogin === false, JSON.stringify(sys.settings));
}
{
  const sys = fakeSystem({ status: 'not-registered', after: 'requires-approval' });
  const r = L.setMac({ run: permanent, ...sys }, true);
  check('needing approval is passed through with its explanation',
    r.state === 'requires-approval' && /System Settings/.test(r.message), JSON.stringify(r));
}
{
  const sys = fakeSystem({ status: 'enabled' });
  const r = L.setMac({ run: permanent, ...sys }, false);
  check('turning it off works', r.state === 'disabled' && eq(setCalls(sys), [['set', false]]),
    JSON.stringify(r));
}
for (const [name, run] of [['a disk image', transient],
  ['a translocated copy', () => ({ kind: L.KIND.TRANSLOCATED, bundle: '/x/Yapper.app', why: 'no' })],
  ['a dev run', () => ({ kind: L.KIND.DEVELOPMENT, why: 'no' })]]) {
  for (const wanted of [true, false]) {
    const sys = fakeSystem({ status: 'enabled' });
    const r = L.setMac({ run, ...sys }, wanted);
    check(`${name} cannot turn it ${wanted ? 'on' : 'off'}, and does not try`,
      r.state === 'unavailable' && setCalls(sys).length === 0 && !!r.why,
      `${JSON.stringify(r)} · ${JSON.stringify(setCalls(sys))}`);
  }
}

// ---------- 4. what the checkbox may delete ----------

const MEET = '/Users/ana/Documents/Meetings';
const DATA = '/Users/ana/Library/Application Support/yapper';

{
  const plan = L.dataPlan({
    userData: DATA, engineHome: `${DATA}/Yapper/engine`, meetings: MEET, io: fakeIO()
  });
  check('the normal layout deletes the data directory once',
    eq(plan.targets.map(t => t.path), [DATA]), JSON.stringify(plan));
}
{
  // YAPPER_HOME puts them side by side: <home>/user and <home>/Meetings.
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
  check(`refuses ${name}`, plan.targets.length === 0 && plan.skipped.length === 1,
    JSON.stringify(plan));
}
{
  // A symlinked Documents folder that lands inside the data directory: only
  // the canonical paths show that they are the same place.
  const plan = L.dataPlan({
    userData: DATA, engineHome: null, meetings: '/Users/ana/Documents/Meetings',
    io: fakeIO({ links: { '/Users/ana/Documents/Meetings': `${DATA}/Meetings` } })
  });
  check('refuses a meetings folder that is a symlink into the data directory',
    plan.targets.length === 0, JSON.stringify(plan));
}

// ---------- 5. uninstalling, step by step ----------

async function uninstallChecks() {

function fakeUninstall({ kind = L.KIND.PERMANENT, proceed = true, alsoData = false,
  afterWithdraw = 'not-registered', trashFails = {}, plan = null } = {}) {
  const log = [];
  const deps = {
    run: () => ({ kind, bundle: APPS }),
    confirm: async () => { log.push(['confirm']); return { proceed, alsoData }; },
    setLoginItem: on => log.push(['set', on]),
    getLoginItem: () => { log.push(['get']); return { status: afterWithdraw }; },
    trash: async p => {
      log.push(['trash', p]);
      const f = trashFails[p];
      return f ? { ok: false, code: f.code, message: f.message } : { ok: true };
    },
    dataPlan: () => { log.push(['plan']); return plan || { targets: [{ label: 'settings', path: DATA }], skipped: [] }; },
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
  check('the whole sequence runs in order',
    eq(steps(log), ['confirm', 'set', 'get', 'trash', 'plan', 'trash', 'quit']),
    JSON.stringify(steps(log)));
  check('the bundle goes before the data', trashed(log)[0] === APPS && trashed(log)[1] === DATA,
    JSON.stringify(trashed(log)));
  check('and it finishes', r.done === true, JSON.stringify(r));
}
{
  const { deps, log } = fakeUninstall({ alsoData: false });
  await L.uninstall(deps);
  check('without the checkbox nothing but the bundle is touched',
    eq(trashed(log), [APPS]) && !steps(log).includes('plan'), JSON.stringify(log));
}
{
  const { deps, log } = fakeUninstall({ proceed: false, alsoData: true });
  const r = await L.uninstall(deps);
  check('cancelling changes nothing at all',
    eq(steps(log), ['confirm']) && r.step === 'cancelled', JSON.stringify(steps(log)));
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
  const { deps, log } = fakeUninstall({
    alsoData: true, trashFails: { [DATA]: { code: 'ENOENT' } }
  });
  const r = await L.uninstall(deps);
  check('data that was already gone is not reported as a problem',
    !steps(log).includes('report') && r.residue.length === 0 && steps(log).includes('quit'),
    JSON.stringify(log));
}
{
  const { deps, log } = fakeUninstall({
    alsoData: true,
    plan: { targets: [], skipped: [{ label: 'settings', path: DATA, why: 'it is not separate from the meetings folder' }] }
  });
  const r = await L.uninstall(deps);
  check('a target that could not be proved safe is kept and reported',
    r.residue.length === 1 && r.residue[0].kept === true && steps(log).includes('report'),
    JSON.stringify(r));
}
for (const kind of [L.KIND.DEVELOPMENT, L.KIND.TRANSLOCATED, L.KIND.READ_ONLY,
  L.KIND.TEMPORARY, L.KIND.UNKNOWN]) {
  const { deps, log } = fakeUninstall({ kind, alsoData: true });
  const r = await L.uninstall(deps);
  check(`${kind} cannot uninstall, and is not even asked`,
    log.length === 0 && r.step === 'unavailable', JSON.stringify(log));
}
{
  // The one that matters most: across every path above, the meetings folder is
  // never handed to the Trash.
  const seen = [];
  for (const opts of [{ alsoData: true }, { alsoData: false }, { alsoData: true, afterWithdraw: 'enabled' },
    { alsoData: true, trashFails: { [APPS]: { code: 'EPERM' } } }]) {
    const { deps, log } = fakeUninstall(opts);
    await L.uninstall(deps);
    seen.push(...trashed(log));
  }
  check('the meetings folder is never a target, on any path',
    seen.every(p => !L.contains(p, MEET) && p !== MEET), JSON.stringify(seen));
}

}

uninstallChecks().then(() => {
  console.log(fails ? `\n${fails} failures` : '\nPASS');
  process.exit(fails ? 1 : 0);
}, e => {
  console.log('FAIL  the uninstall checks threw\n      ' + (e && e.stack || e));
  process.exit(1);
});
