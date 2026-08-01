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
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const main = read('main.js');
const preload = read('preload.js');
const renderer = read('renderer/app.js');

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
const login = main.slice(main.indexOf('function applyOpenAtLogin'),
  main.indexOf('function initOpenAtLogin'));
check('on macOS the login item passes no path',
  /'darwin'[\s\S]*setLoginItemSettings\(\{\s*openAtLogin:\s*enabled\s*\}\)/.test(login),
  'it would register the inner binary instead of the bundle');
check('Windows still registers its path and arguments',
  /'win32'[\s\S]*process\.execPath[\s\S]*args:/.test(login), 'the Windows behaviour was lost');

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
