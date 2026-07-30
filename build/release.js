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
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const version = require('../package.json').version;
const repo = 'iamchuck504/yapper-releases';

function run(cmd, args) {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: true });
  if (r.status !== 0) process.exit(r.status || 1);
}

const assets = [
  `dist/Yapper-Setup-${version}.exe`,
  `dist/Yapper-Setup-${version}.exe.blockmap`,
  'dist/latest.yml'
];

run('npx', ['electron-builder', '--win']);

for (const a of assets) {
  if (!fs.existsSync(path.join(root, a))) {
    console.error(`falta ${a} — el build no lo produjo`);
    process.exit(1);
  }
}

run('gh', ['release', 'create', `v${version}`,
  '--repo', repo,
  '--title', `Yapper ${version}`,
  '--notes', `Yapper ${version}. Installer below; installed copies update themselves from this feed.`,
  ...assets]);

console.log(`\nlisto: https://github.com/${repo}/releases/tag/v${version}`);
