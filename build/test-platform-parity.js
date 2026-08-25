// The bugs this file guards against all have the same shape: code written for
// Windows that silently means something else on macOS, and that nobody notices
// until a Mac user hits it. All three were real.
//
//  1. Recording asked for getDisplayMedia first, for the Windows loopback. On
//     macOS that costs a Screen Recording permission and, if refused, rejects —
//     taking the whole recording down, microphone included.
//  2. openAtLogin registered process.execPath, which on macOS is the binary
//     inside the bundle rather than the bundle. The switch read as on and
//     nothing ever started.
//  3. A failed engine told every user to "run setup.ps1", a Windows script that
//     does not exist on a Mac, where the engine downloads itself instead.
//  4. Uninstalling meant dragging the bundle to the Trash, which cannot take
//     the login item with it — that record is the system's, and deleting the
//     app is exactly what puts it out of reach.
//
// The login-item rules moved to loginitem.js, where they are checked by
// behaviour rather than by pattern; what stays here is that main.js is wired to
// them and that Windows kept its own, different, working arrangement.
//
// Read as text on purpose: none of these files can be required without Electron.
const fs = require('fs');
const path = require('path');

let fails = 0;
function check(name, ok, detail) {
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      ${detail || ''}`); }
}

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const main = read('main.js');
const preload = read('preload.js');
const renderer = read('renderer/app.js');
const html = read('renderer/index.html');

// ---- the renderer has to know where it is running ----
check('preload exposes the platform', /platform:\s*process\.platform/.test(preload),
  'the renderer cannot tell macOS from Windows');

// ---- 1. system audio is not asked for on macOS ----
const gdmCalls = [...renderer.matchAll(/getDisplayMedia\(/g)];
check('the renderer asks for getDisplayMedia exactly once', gdmCalls.length === 1,
  `it asks ${gdmCalls.length} times; each one needs looking at`);

const startRec = renderer.slice(renderer.indexOf('async function startRecording'),
  renderer.indexOf('const sysAudio'));
check('and only off macOS',
  /platform\s*===\s*'darwin'\s*\?\s*null/.test(startRec),
  'macOS would end up asking for Screen Recording for nothing');
check('the rest of the flow tolerates there being no system audio',
  /if\s*\(sys\s*&&\s*sys\.getAudioTracks\(\)\.length\)/.test(renderer),
  'sys would be null and reading its tracks would blow up');

const sysUses = [...renderer.matchAll(/\bsys\.get(?:Audio|Video)Tracks\(\)/g)].length;
const sysGuards = [...renderer.matchAll(/sys\s*&&\s*sys\.getAudioTracks\(\)/g)].length;
check('no use of sys is left unguarded', sysUses - sysGuards <= 1,
  `${sysUses} usos, ${sysGuards} protegidos`);

// ---- 2. login item ----
// The rules themselves are in loginitem.js and are checked by behaviour in
// build/test-login-item.js, which is the only thing that can check them: a
// pattern over this file matches just as well when the predicate is inverted.
// What is left here is the wiring — that main.js goes through those rules
// rather than around them, and that Windows still does what it always did.
const login = main.slice(main.indexOf('const bundleIO'),
  main.indexOf("ipcMain.handle('get-bubble-corner'"));

check('macOS registers nothing from startup',
  !/'darwin'[\s\S]{0,400}setLoginItemSettings/.test(
    main.slice(main.indexOf('function applyOpenAtLogin'), main.indexOf('function initOpenAtLogin'))),
  'a launch would register whichever bundle it happens to be');
check('and startup goes through initMac, which only reads',
  /darwin[\s\S]{0,80}loginitem\.initMac/.test(login), 'the macOS path is doing its own thing');
check('Windows still registers its path and arguments',
  /'win32'[\s\S]*process\.execPath[\s\S]*args:/.test(login), 'the Windows behaviour was lost');
check('and Windows still keeps the answer in its settings file',
  /platform !== 'darwin'[\s\S]{0,160}readSettings\(\)\.openAtLogin/.test(login),
  'Windows was moved onto macOS semantics it has no API for');

// The classification needs the real filesystem, so the adapter is the part
// that can only be checked here. EROFS is a disk image; EACCES is /Applications
// on a Mac where this account is not an admin, and that is still an install.
check('a read-only filesystem is told apart from a directory we may not write to',
  /EROFS[\s\S]{0,80}'read-only'/.test(login) && /'denied'/.test(login),
  'an install on an external disk would be refused, or a dmg accepted');
check('the switch asks loginitem for the answer, and does not invent one',
  /set-open-at-login[\s\S]{0,200}loginitem\.setMac/.test(main),
  'the handler would answer with what was asked rather than what happened');
check('and the renderer paints the answer rather than the click',
  /showStartupState\(r\)/.test(renderer) && /startupToggle\.checked = state === 'enabled'/.test(renderer),
  'the switch would show on while nothing starts at login');
check('a slow answer cannot overwrite a newer one',
  /seq === startupSeq/.test(renderer), 'two quick clicks would leave the switch stale');
check('the explanation is attached to the switch, not just placed beside it',
  /id="opt-startup"[^>]*aria-describedby="startup-hint"/.test(html)
  && /id="startup-hint"[^>]*aria-live/.test(html),
  'a refusal would be invisible to a screen reader');
check('and a rejected call is handled',
  /\.catch\(e => \(\{ state: 'error'/.test(renderer), 'an unhandled rejection, and a stuck switch');

// ---- 2b. uninstalling ----
check('uninstalling goes through the checked sequence',
  /loginitem\.uninstall\(uninstallDeps\(\)\)/.test(main),
  'the order the login item depends on would be main.js\u2019s to get right again');
check('and is only offered where loginitem allows it',
  /function canUninstallSelf\(\)[\s\S]{0,120}loginitem\.canUninstall\(macRun\(\)\)/.test(main),
  'it would be offered from a dmg, where the bundle is not the one the user keeps');
check('the menu entry is gated on that',
  /canUninstallSelf\(\)\s*\?\s*\[\{ label: 'Uninstall Yapper/.test(main),
  'the entry would appear where it cannot work');
check('the Trash adapter reports "it was not there" as its own outcome',
  /existsSync\(p\)\)? return \{ ok: false, code: 'ENOENT' \}/.test(login),
  'a missing file and a refused one would be the same silence');
check('and the meetings folder is what the plan is measured against',
  /meetings: MEETINGS_DIR/.test(main), 'nothing would prove the target is not the meetings folder');

// ---- 3. no Windows-only advice on a Mac ----
const ps1 = main.slice(main.indexOf('function humanTranscribeError'),
  main.indexOf('function humanTranscribeError') + 1200);
check('the setup.ps1 advice depends on the platform',
  /'darwin'[\s\S]{0,200}setup\.ps1|setup\.ps1[\s\S]{0,200}darwin/.test(ps1)
  || /darwin[\s\S]{0,300}setup\.ps1/.test(ps1),
  'a Mac user would end up hunting for a PowerShell script');
check('and macOS gets one it can actually follow',
  /Restart Yapper to download it/.test(ps1), 'it is not told what to do');

console.log(fails ? `\n${fails} failures` : '\nPASS');
process.exit(fails ? 1 : 0);
