// Build the installer and publish it as a GitHub release on the public feed.
//
// electron-builder's own publisher wants the tag to exist before a non-draft
// release can be created, which a feed-only repo never has. The gh CLI creates
// tag, release and assets in one step and uses its own auth, so this drives the
// build and hands publishing to gh:
//
//   npm run release
//
// A Mac often creates the version first. In that case Windows must add its
// three real assets to the existing release rather than failing or creating a
// second tag. Publishing from a non-Windows host is refused: cross-packaging an
// NSIS file is not Windows runtime sign-off.
//
// electron-updater ALWAYS reads the feed's most recent release, and it writes
// one manifest per platform: latest.yml here, latest-mac.yml on a Mac. A
// release cut from Windows therefore has to carry the previous release's mac
// assets forward, or every installed Mac loses its manifest and quietly stops
// seeing updates — the mirror image of what mac/build-app.sh does with the
// Windows assets when the Mac cuts one.
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const version = require('../package.json').version;
const repo = 'iamchuck504/yapper-releases';

if (process.platform !== 'win32') {
  console.error('Windows releases must be built and exercised on Windows.');
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: true, ...opts });
  if (r.status !== 0 && !opts.soft) process.exit(r.status || 1);
  return r.status === 0;
}

function ghQuiet(args) {
  return spawnSync('gh', args, { cwd: root, shell: true, windowsHide: true });
}

const assets = [
  `dist/Yapper-Setup-${version}.exe`,
  `dist/Yapper-Setup-${version}.exe.blockmap`,
  'dist/latest.yml'
];

// This is deliberately the long path: it drives the real renderer, both audio
// tracks, the local diarizer, package inspection, installer metadata and the
// exact install/update/uninstall lifecycle before anything reaches GitHub.
run('npm', ['run', 'test:windows:package']);
run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
  '-File', 'build/test-windows-installer.ps1',
  '-SetupExe', `dist/Yapper-Setup-${version}.exe`]);

for (const a of assets) {
  if (!fs.existsSync(path.join(root, a))) {
    console.error(`missing ${a} — the build did not produce it`);
    process.exit(1);
  }
}

const tag = `v${version}`;
const releaseExists = ghQuiet(['release', 'view', tag, '--repo', repo]).status === 0;
if (releaseExists) {
  console.log(`\n${tag} already exists; replacing its Windows assets.`);
  for (const asset of assets) {
    run('gh', ['release', 'upload', tag, asset, '--repo', repo, '--clobber']);
  }
} else {
  // shell: true re-joins these into one command line, so anything with a space
  // has to carry its own quotes or gh reads the second word as a file name.
  run('gh', ['release', 'create', tag,
    '--repo', repo,
    '--title', `"Yapper ${version}"`,
    '--notes', `"Yapper ${version}. Windows installer below; installed copies update themselves from this feed."`,
    ...assets]);
}

// Carry the previous release's mac assets forward, so the Macs already
// installed keep a manifest to read on the release electron-updater actually
// looks at. Their latest-mac.yml still names the version those copies run, so
// nobody is offered a dmg that does not exist.
const list = ghQuiet(['release', 'list', '--repo', repo, '--limit', '30',
  '--json', 'tagName', '--jq', '.[].tagName']);
const prev = String(list.stdout || '').split(/\r?\n/)
  .filter(t => t && t !== tag && !t.startsWith('engine-'))[0];

if (!releaseExists && prev) {
  const carry = fs.mkdtempSync(path.join(os.tmpdir(), 'yapper-carry-'));
  const dl = ghQuiet(['release', 'download', prev, '--repo', repo, '--dir', carry,
    '--pattern', 'latest-mac.yml', '--pattern', 'Yapper-*-arm64*', '--pattern', 'install.sh']);
  const carried = dl.status === 0 ? fs.readdirSync(carry) : [];
  if (carried.length) {
    for (const f of carried) {
      run('gh', ['release', 'upload', tag, path.join(carry, f),
        '--repo', repo, '--clobber'], { soft: true });
    }
    console.log(`\nmac assets inherited from ${prev}: ${carried.join(' ')}`);
  } else {
    console.log(`\nWARNING: ${prev} carried no mac assets — installed Macs will not`);
    console.log('         see this feed until a release is cut from the Mac');
  }
  fs.rmSync(carry, { recursive: true, force: true });
}

let inventory = ghQuiet(['release', 'view', tag, '--repo', repo, '--json', 'assets']);
if (inventory.status !== 0) {
  console.error(`could not verify the published asset inventory for ${tag}`);
  process.exit(1);
}
let releaseAssets = JSON.parse(String(inventory.stdout || '{}')).assets || [];
const expectedNames = new Set(assets.map(a => path.basename(a)));
for (const asset of releaseAssets) {
  if (/^Yapper-Setup-.*\.(?:exe|exe\.blockmap)$/.test(asset.name)
      && !expectedNames.has(asset.name)) {
    run('gh', ['release', 'delete-asset', tag, asset.name, '--repo', repo, '--yes']);
  }
}

inventory = ghQuiet(['release', 'view', tag, '--repo', repo, '--json', 'assets']);
if (inventory.status !== 0) {
  console.error(`could not re-read the published asset inventory for ${tag}`);
  process.exit(1);
}
releaseAssets = JSON.parse(String(inventory.stdout || '{}')).assets || [];
for (const file of assets) {
  const name = path.basename(file);
  const remote = releaseAssets.find(a => a.name === name);
  const bytes = fs.readFileSync(path.join(root, file));
  const digest = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
  if (!remote || remote.size !== bytes.length || remote.digest !== digest) {
    console.error(`published release does not match local ${name}`);
    process.exit(1);
  }
}
console.log(`\nverified Windows assets on ${tag}: ${assets.map(a => path.basename(a)).join(', ')}`);
console.log(`\ndone: https://github.com/${repo}/releases/tag/v${version}`);
