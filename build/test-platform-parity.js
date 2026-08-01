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
check('preload expone la plataforma', /platform:\s*process\.platform/.test(preload),
  'el renderer no puede distinguir macOS de Windows');

// ---- 1. system audio is not asked for on macOS ----
const gdmCalls = [...renderer.matchAll(/getDisplayMedia\(/g)];
check('el renderer pide getDisplayMedia una sola vez', gdmCalls.length === 1,
  `lo pide ${gdmCalls.length} veces; hay que revisar cada una`);

const startRec = renderer.slice(renderer.indexOf('async function startRecording'),
  renderer.indexOf('const sysAudio'));
check('y solo fuera de macOS',
  /platform\s*===\s*'darwin'\s*\?\s*null/.test(startRec),
  'macOS acabaría pidiendo permiso de Grabación de Pantalla para nada');
check('el resto del flujo tolera que no haya audio de sistema',
  /if\s*\(sys\s*&&\s*sys\.getAudioTracks\(\)\.length\)/.test(renderer),
  'sys sería null y reventaría al leer sus pistas');

const sysUses = [...renderer.matchAll(/\bsys\.get(?:Audio|Video)Tracks\(\)/g)].length;
const sysGuards = [...renderer.matchAll(/sys\s*&&\s*sys\.getAudioTracks\(\)/g)].length;
check('ningún uso de sys queda sin proteger', sysUses - sysGuards <= 1,
  `${sysUses} usos, ${sysGuards} protegidos`);

// ---- 2. login item ----
const login = main.slice(main.indexOf('function applyOpenAtLogin'),
  main.indexOf('function initOpenAtLogin'));
check('en macOS el login item no pasa una ruta',
  /'darwin'[\s\S]*setLoginItemSettings\(\{\s*openAtLogin:\s*enabled\s*\}\)/.test(login),
  'registraría el binario interno en vez del bundle');
check('Windows sigue registrando su ruta y argumentos',
  /'win32'[\s\S]*process\.execPath[\s\S]*args:/.test(login), 'se perdió el comportamiento de Windows');

// ---- 3. no Windows-only advice on a Mac ----
const ps1 = main.slice(main.indexOf('function humanTranscribeError'),
  main.indexOf('function humanTranscribeError') + 1200);
check('el consejo de setup.ps1 depende de la plataforma',
  /'darwin'[\s\S]{0,200}setup\.ps1|setup\.ps1[\s\S]{0,200}darwin/.test(ps1)
  || /darwin[\s\S]{0,300}setup\.ps1/.test(ps1),
  'un usuario de Mac acabaría buscando un script de PowerShell');
check('y macOS recibe uno que sí puede seguir',
  /Restart Yapper to download it/.test(ps1), 'no se le dice qué hacer');

console.log(fails ? `\n${fails} fallos` : '\nPASS');
process.exit(fails ? 1 : 0);
