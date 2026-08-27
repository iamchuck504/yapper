// The bugs this file guards against all have the same shape: code written for
// one desktop that silently means something else on the other, and that nobody
// notices until someone hits it. All were real.
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

// Every check below matches against source with the comments taken out. A
// pattern that a comment can satisfy is not a check — this file's whole job is
// to notice when the code stopped doing something, and the code is what has to
// say so. Crude on purpose: `//` inside a string would be stripped too, which
// costs nothing here and cannot produce a false pass.
const code = f => read(f)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n').map(l => l.replace(/(^|[^:'"`])\/\/.*$/, '$1')).join('\n');
const main = read('main.js');
const mainCode = code('main.js');
const preload = read('preload.js');
const renderer = read('renderer/app.js');
const rendererCode = code('renderer/app.js');
const workletCode = code('renderer/pcm-worklet.js');
const html = read('renderer/index.html');
const pkg = JSON.parse(read('package.json'));
const windowsInstaller = read('build/installer.nsh');

// ---- the renderer has to know where it is running ----
check('preload exposes the platform', /platform:\s*process\.platform/.test(preload),
  'the renderer cannot tell macOS from Windows');
check('platform-neutral HTML does not ship macOS labels to Windows',
  !/⌘|Measured locally on this Mac/.test(html),
  'a title is hard-coded for macOS before the renderer knows the platform');
check('the renderer paints shortcuts and machine labels for the current platform',
  /const onMac = window\.yapper\.platform === 'darwin'/.test(rendererCode)
  && /Settings \(\$\{shortcut\(','\)\}\)/.test(rendererCode)
  && /Flag this moment \(\$\{shortcut\('Shift\+M'\)\}/.test(rendererCode)
  && /Rename this meeting \(\$\{shortcut\('Shift\+R'\)\}\)/.test(rendererCode)
  && /onMac \? 'Mac' : 'PC'/.test(rendererCode),
  'Windows would show Mac keys or call the machine a Mac');

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
// The rules are in loginitem.js and are checked by behaviour in
// build/test-login-item.js, which is the only thing that can check them: a
// pattern over this file matches just as well when a predicate is inverted.
// What is left here is the wiring — that main.js goes through those rules
// rather than around them, and that Windows still does what it always did.
const login = mainCode.slice(mainCode.indexOf('const bundleIO'),
  mainCode.indexOf("ipcMain.handle('get-bubble-corner'"));

// Weak on purpose, and labelled so: a literal is all this can see. A variable
// that happens to be true would walk straight past it, which is why what may
// register is decided in loginitem.js and checked by behaviour there.
check('no literal registration is written into main.js',
  !/openAtLogin:\s*true/.test(mainCode),
  'a literal openAtLogin: true is a registration nobody asked for');
check('startup does not register',
  !/'darwin'[\s\S]{0,400}setLoginItemSettings/.test(
    mainCode.slice(mainCode.indexOf('function applyOpenAtLogin'),
      mainCode.indexOf('function initOpenAtLogin'))),
  'a launch would register whichever bundle it happens to be');
check('and goes through initMac, which only reads',
  /darwin[\s\S]{0,80}loginitem\.initMac/.test(login), 'the macOS path is doing its own thing');
check('the switch goes through setMac',
  /set-open-at-login[\s\S]{0,200}loginitem\.setMac/.test(mainCode),
  'the handler would answer with what was asked rather than what happened');
// A count is not reachability — three calls could all be wrong. What it does
// catch is a fourth appearing, which is the shape a bypass takes.
check('and no fourth call to setLoginItemSettings has appeared',
  (mainCode.match(/setLoginItemSettings/g) || []).length === 3,
  'one for the deps, one for the uninstaller, one for Windows — more wants looking at');

check('Windows still registers its path and arguments',
  /'win32'[\s\S]*process\.execPath[\s\S]*args:/.test(login), 'the Windows behaviour was lost');
check('and Windows still keeps the answer in its settings file',
  /platform !== 'darwin'[\s\S]{0,160}readSettings\(\)\.openAtLogin/.test(login),
  'Windows was moved onto macOS semantics it has no API for');
const sourceAppId = mainCode.match(/const APP_ID\s*=\s*'([^']+)'/)?.[1];
check('the Windows login value and packaged app share one app ID',
  sourceAppId === pkg.build.appId,
  `main.js uses ${sourceAppId || 'no app ID'}; electron-builder uses ${pkg.build.appId}`);
check('the Windows uninstaller removes both login-item registry values',
  (windowsInstaller.match(/DeleteRegValue HKCU/g) || []).length === 2
  && /CurrentVersion\\Run" "\$\{APP_ID\}"/.test(windowsInstaller)
  && /Explorer\\StartupApproved\\Run" "\$\{APP_ID\}"/.test(windowsInstaller),
  'uninstall would leave either the active Run value or its Windows approval metadata behind');

// The filesystem adapter is the half that cannot be tested without a
// filesystem, so its mapping is checked here.
check('the adapter tells a read-only disk from a directory we may not write to',
  /EROFS[\s\S]{0,60}'read-only'/.test(login)
  && /EACCES[\s\S]{0,80}'denied'/.test(login),
  'an install would be refused, or a disk image accepted');
check('and an unexpected error is not folded into "denied"',
  /return 'error'/.test(login), 'an I/O failure would read as a permission and pass as an install');
check('realpath answers with a code rather than the path it was given',
  /realpath\([\s\S]{0,160}code: e\.code/.test(login),
  'a failed canonicalisation would silently become a lexical comparison');
check('and identity is available for the same-directory proof',
  /identity\([\s\S]{0,120}ino: st\.ino/.test(login), 'two different bundles could pass as one');
check('install roots are a list, not an inference',
  /function installRoots\(\)[\s\S]{0,200}'\/Applications'/.test(mainCode)
  && /installRoots: installRoots\(\)/.test(mainCode),
  'anything writable would count as an installation again');
check('and the volume they have to be on is passed in too',
  /approvedVolumeMounts: \[/.test(mainCode),
  'a root symlinked onto an external disk would pass by its name');
check('the home directory is not one of them',
  !/approvedVolumeMounts:[^\]]*getPath\('home'\)/.test(mainCode),
  'a home on an external or network volume would approve its own volume');
check('and the volume question asks about the exact path, without a process-wide cache',
  /mountPoint\(p\)/.test(login)
  && /execFileSync\('\/bin\/df',[\s\S]{0,120}'--libxo', 'json',[\s\S]{0,60}'-P', p/.test(login)
  && /timeout:\s*2000/.test(login) && /killSignal:\s*'SIGKILL'/.test(login)
  && !/mountPointCache/.test(login),
  'a stale or partially parsed mount table would approve an external path as root');
check('a cached startup classification is revalidated before controls use it',
  /function currentMacRun\(\)[\s\S]{0,280}loginitem\.refreshUnknownRun\(macRun\(\), classifyMacRun\)/.test(mainCode)
  && /function currentMacRun\(\)[\s\S]{0,360}loginitem\.revalidateRun\(macRun\(\), bundleIO\)/.test(mainCode)
  && /run: currentMacRun/.test(login),
  'a temporary failure would stick forever, or a replacement would retain permission to mutate');

check('the renderer paints what the main process decided',
  /render: view =>/.test(rendererCode) && /startupToggle\.checked = !!view\.checked/.test(rendererCode),
  'the page would reason about macOS answers on its own');
check('and the main process attaches that view to both replies',
  (mainCode.match(/openAtLoginReply\(/g) || []).length >= 4,
  'one reply would arrive without the contract the renderer paints');
// The recovery itself — a rejected write, a stale answer, a first read that
// fails — is behaviour, and is checked by running the controller in
// build/test-startup-switch.js. This only checks the page uses it.
check('the switch is driven by the controller, not by an inline handler',
  /createStartupSwitch\(\{/.test(rendererCode)
  && /startupSwitch\.toggle\(startupToggle\.checked\)/.test(rendererCode),
  'the recovery behaviour would live somewhere nothing can run');
check('and the controller ships with the app',
  /<script src="startup-switch\.js">/.test(html), 'the page would fail to define it');
check('the explanation is attached to the switch, not just placed beside it',
  /id="opt-startup"[^>]*aria-describedby="startup-hint"/.test(html)
  && /id="startup-hint"[^>]*aria-live/.test(html),
  'a refusal would be invisible to a screen reader');

// ---- 2b. uninstalling ----
check('uninstalling goes through the checked sequence',
  /const deps = uninstallDeps\(\)[\s\S]{0,100}loginitem\.uninstall\(deps\)/.test(mainCode),
  'the order the login item depends on would be main.js\u2019s to get right again');
check('and works from a plan built before anything is touched',
  /preflight:\s*alsoData => \{[\s\S]{0,160}loginitem\.uninstallPreflight\(/.test(mainCode),
  'the login item would be withdrawn before knowing whether the rest is safe');
check('the preflight is given the bundle and the meetings folder together',
  /uninstallPreflight\(\{[\s\S]{0,160}bundle: run\.bundle[\s\S]{0,320}meetings: MEETINGS_DIR/.test(mainCode),
  'the bundle would never be compared against the meetings folder');
check('and it is only offered where loginitem allows it',
  /function canUninstallSelf\(\)[\s\S]{0,120}loginitem\.canUninstall\(currentMacRun\(\)\)/.test(mainCode),
  'it would be offered from a disk image, where the bundle is not the one the user keeps');
check('the menu entry is gated on that',
  /canUninstallSelf\(\)\s*\?\s*\[\{ label: 'Uninstall Yapper/.test(mainCode),
  'the entry would appear where it cannot work');
check('the Trash adapter reports "it was not there" as its own outcome',
  /catch \(e\)[\s\S]{0,260}if \(!fs\.existsSync\(proof\.path\)\) return \{ ok: false, code: 'ENOENT' \}/.test(login),
  'a missing file and a refused one would be the same silence');
check('and revalidates the final proof immediately before Trash',
  /trash: async \(p, proof\)[\s\S]{0,300}verifyPathProof\(proof, bundleIO\)/.test(login),
  'a bundle or mount replaced after preflight would be removed unchecked');
check('the Trash receives the proved path, not a parallel argument',
  /shell\.trashItem\(proof\.path\)/.test(login) && /p !== proof\.path/.test(login),
  'a caller could prove one path and hand another one to the Trash');
check('an absent target returns without a second filesystem lookup',
  /if \(safe\.missing\) return \{ ok: false, code: 'ENOENT' \}/.test(login),
  'a path that appeared between proof and existsSync would be trashed without a proof');

// ---- 3. no Windows-only advice on a Mac ----
const ps1 = main.slice(main.indexOf('function humanTranscribeError'),
  main.indexOf('function humanTranscribeError') + 1200);
check('the setup.ps1 advice depends on the platform',
  /'darwin'[\s\S]{0,200}setup\.ps1|setup\.ps1[\s\S]{0,200}darwin/.test(ps1)
  || /darwin[\s\S]{0,300}setup\.ps1/.test(ps1),
  'a Mac user would end up hunting for a PowerShell script');
check('and macOS gets one it can actually follow',
  /Restart Yapper to download it/.test(ps1), 'it is not told what to do');

// ---- 4. Windows keeps the source identity macOS already had ----
check('Windows opens the same two per-side recording files as macOS',
  /platform === 'darwin' \|\| process\.platform === 'win32'/.test(mainCode)
  && /micFd:\s*engine\.openWav/.test(mainCode) && /sysFd:\s*engine\.openWav/.test(mainCode),
  'Windows would fall back to a mixed transcript with no reliable speaker side');
check('the audio-thread tap has separate mic and system inputs',
  /numberOfInputs:\s*2/.test(rendererCode)
  && /micLP\.connect\(pcmNode,\s*0,\s*0\)/.test(rendererCode)
  && /sysGainNode\.connect\(pcmNode,\s*0,\s*1\)/.test(rendererCode),
  'the two sources would be mixed before their identity reaches main.js');
check('the worklet returns mixed, microphone and system blocks together',
  /parts\s*=\s*\{\s*mixed:\s*\[\],\s*mic:\s*\[\],\s*sys:\s*\[\]\s*\}/.test(workletCode)
  && /postMessage\(packet/.test(workletCode),
  'independent callbacks could drift and put words on the wrong side');
check('Windows writes the separated blocks while keeping the mixed recording',
  /rendererTracks[\s\S]{0,120}writeTracks\(rendererTracks\.mic,\s*rendererTracks\.sys\)/.test(mainCode)
  && /writeRecorded\(buf\)/.test(mainCode),
  'the live/recovery mix or the final Me/Them tracks would be missing');
const diarizerCode = code('speaker-diarizer.js');
const diarizerWorkerCode = code('speaker-diarize-worker.js');
check('Windows sends its remote track to an isolated local diarization worker',
  /platform === 'win32'/.test(diarizerCode)
  && /new Worker\(workerFile/.test(diarizerCode)
  && /createOfflineSpeakerDiarization/.test(diarizerWorkerCode),
  'Windows would collapse every remote voice back to Them');
check('the Windows diarizer has the same failure-safe transcript fallback as macOS',
  /segments:\s*\[\],\s*available:\s*false/.test(diarizerCode)
  && /speaker detection timed out/.test(diarizerCode),
  'a model failure could prevent the transcript from finishing');

console.log(fails ? `\n${fails} failures` : '\nPASS');
process.exit(fails ? 1 : 0);
