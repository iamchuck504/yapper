// Build the installer and publish it as a GitHub release on the public feed.
//
// electron-builder's own publisher wants the tag to exist before a non-draft
// release can be created, which a feed-only repo never has. The gh CLI creates
// tag, release and assets in one step and uses its own auth, so this drives the
// build and hands publishing to gh:
//
//   npm run release
//
// Publishing the same version twice fails on purpose — bump package.json first.
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

const root = path.join(__dirname, '..');
const version = require('../package.json').version;
const repo = 'iamchuck504/yapper-releases';

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

run('npx', ['electron-builder', '--win']);

for (const a of assets) {
  if (!fs.existsSync(path.join(root, a))) {
    console.error(`missing ${a} — the build did not produce it`);
    process.exit(1);
  }
}

// shell: true re-joins these into one command line, so anything with a space
// has to carry its own quotes or gh reads the second word as a file name.
run('gh', ['release', 'create', `v${version}`,
  '--repo', repo,
  '--title', `"Yapper ${version}"`,
  '--notes', `"Yapper ${version}. Installer below; installed copies update themselves from this feed."`,
  ...assets]);

// Carry the previous release's mac assets forward, so the Macs already
// installed keep a manifest to read on the release electron-updater actually
// looks at. Their latest-mac.yml still names the version those copies run, so
// nobody is offered a dmg that does not exist.
const list = ghQuiet(['release', 'list', '--repo', repo, '--limit', '30',
  '--json', 'tagName', '--jq', '.[].tagName']);
const prev = String(list.stdout || '').split(/\r?\n/)
  .filter(t => t && t !== `v${version}` && !t.startsWith('engine-'))[0];

if (prev) {
  const carry = fs.mkdtempSync(path.join(os.tmpdir(), 'yapper-carry-'));
  const dl = ghQuiet(['release', 'download', prev, '--repo', repo, '--dir', carry,
    '--pattern', 'latest-mac.yml', '--pattern', 'Yapper-*-arm64*', '--pattern', 'install.sh']);
  const carried = dl.status === 0 ? fs.readdirSync(carry) : [];
  if (carried.length) {
    for (const f of carried) {
      run('gh', ['release', 'upload', `v${version}`, path.join(carry, f),
        '--repo', repo, '--clobber'], { soft: true });
    }
    console.log(`\nmac assets inherited from ${prev}: ${carried.join(' ')}`);
  } else {
    console.log(`\nWARNING: ${prev} carried no mac assets — installed Macs will not`);
    console.log('         see this feed until a release is cut from the Mac');
  }
  fs.rmSync(carry, { recursive: true, force: true });
}

console.log(`\ndone: https://github.com/${repo}/releases/tag/v${version}`);
