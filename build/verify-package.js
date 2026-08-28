'use strict';

// Release gate for the two failures a source-only test cannot see: a runtime
// module left out of app.asar, and an Electron binary shipped with dangerous
// default fuses. With no argument it validates package.json; with an unpacked
// app path it inspects the actual artefact too.
const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');
const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
function runtimeGraph(entries) {
  const seen = new Set();
  const visit = relative => {
    relative = relative.replace(/\\/g, '/');
    if (seen.has(relative)) return;
    seen.add(relative);
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    const parent = path.posix.dirname(relative);
    for (const match of source.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
      let target = path.posix.normalize(path.posix.join(parent, match[1]));
      if (!path.posix.extname(target)) target += '.js';
      if (!fs.existsSync(path.join(root, target))) {
        throw new Error(`${relative} requires missing local module ${match[1]}`);
      }
      visit(target);
    }
  };
  for (const entry of entries) visit(entry);
  return [...seen].sort();
}

const runtimeFiles = runtimeGraph(['main.js', 'preload.js']);
const rendererFiles = [
  'renderer/index.html', 'renderer/app.js', 'renderer/startup-switch.js', 'renderer/style.css',
  'renderer/bubble.html', 'renderer/splash.html'
];

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`ok    ${name}`);
  else {
    failures++;
    console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

const configured = new Set(pkg.build && pkg.build.files || []);
for (const file of runtimeFiles) {
  check(`package config includes ${file}`, configured.has(file));
}
check('package config includes renderer assets', configured.has('renderer/**/*'));
check('package config includes pinned Windows diarization assets',
  configured.has('build/speaker-diarizer-windows/**/*'));
check('package config includes third-party notices', configured.has('THIRD-PARTY-NOTICES.md'));

const wantedFuses = {
  runAsNode: false,
  enableCookieEncryption: true,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
  // Off: this fuse makes the browser process load a browser_v8_context_snapshot
  // nobody generates, and 0.1.9 died at launch on every Mac with "Error loading
  // V8 startup snapshot file". build/packaged-launch-check.sh is what catches it.
  loadBrowserProcessSpecificV8Snapshot: false,
  grantFileProtocolExtraPrivileges: false
};
for (const [name, wanted] of Object.entries(wantedFuses)) {
  check(`package config sets ${name}=${wanted}`,
    pkg.build && pkg.build.electronFuses && pkg.build.electronFuses[name] === wanted);
}

function pathsForApp(appPath) {
  if (process.platform === 'darwin' || appPath.endsWith('.app')) {
    const name = path.basename(appPath, '.app');
    return {
      asarPath: path.join(appPath, 'Contents', 'Resources', 'app.asar'),
      executable: path.join(appPath, 'Contents', 'MacOS', name)
    };
  }
  const exe = fs.readdirSync(appPath).find(name => /\.exe$/i.test(name) && !/uninstall/i.test(name));
  return {
    asarPath: path.join(appPath, 'resources', 'app.asar'),
    executable: exe ? path.join(appPath, exe) : ''
  };
}

async function inspectApp(appPath) {
  const { asarPath, executable } = pathsForApp(path.resolve(appPath));
  check('packaged app contains app.asar', fs.existsSync(asarPath), asarPath);
  check('packaged app contains its executable', !!executable && fs.existsSync(executable), executable);
  if (!fs.existsSync(asarPath) || !executable || !fs.existsSync(executable)) return;

  const entries = new Set(asar.listPackage(asarPath).map(name => name.replace(/^[/\\]+/, '').replace(/\\/g, '/')));
  for (const file of [...runtimeFiles, ...rendererFiles]) {
    check(`app.asar contains ${file}`, entries.has(file));
  }

  if (appPath.endsWith('.app')) {
    const unpacked = path.join(path.dirname(asarPath), 'app.asar.unpacked', 'build');
    for (const helper of ['mic-probe', 'system-audio', 'speaker-diarize']) {
      const file = path.join(unpacked, helper);
      check(`packaged app contains executable ${helper}`,
        fs.existsSync(file) && (fs.statSync(file).mode & 0o111) !== 0, file);
    }
  } else {
    const unpackedRoot = path.join(path.dirname(asarPath), 'app.asar.unpacked');
    const assets = path.join(unpackedRoot, 'build', 'speaker-diarizer-windows');
    for (const file of [
      'sherpa-onnx-offline-speaker-diarization.exe',
      'onnxruntime.dll',
      'onnxruntime_providers_shared.dll',
      'embedding.onnx',
      'segmentation.onnx',
      'manifest.json'
    ]) {
      const bundled = path.join(assets, file);
      check(`packaged Windows app contains ${file}`, fs.existsSync(bundled), bundled);
    }
  }

  const wire = await getCurrentFuseWire(executable);
  const fuseChecks = [
    [FuseV1Options.RunAsNode, false],
    [FuseV1Options.EnableCookieEncryption, true],
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable, false],
    [FuseV1Options.EnableNodeCliInspectArguments, false],
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, true],
    [FuseV1Options.OnlyLoadAppFromAsar, true],
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, false],
    [FuseV1Options.GrantFileProtocolExtraPrivileges, false]
  ];
  for (const [index, wanted] of fuseChecks) {
    const enabled = String.fromCharCode(wire[index]) === '1';
    check(`binary fuse ${FuseV1Options[index]}=${wanted}`, enabled === wanted,
      `actual: ${enabled}`);
  }
}

(async () => {
  if (process.argv[2]) await inspectApp(process.argv[2]);
  console.log(failures ? `\n${failures} failures` : '\nPASS');
  process.exit(failures ? 1 : 0);
})().catch(err => {
  console.error(`FAIL  package inspection crashed\n      ${err.stack || err.message}`);
  process.exit(1);
});
