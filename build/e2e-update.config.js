// Build config for the auto-update E2E only: same app, but the release feed
// points at a local server so the whole update loop can be proven without
// publishing anything. Version and output dir come from the environment.
const base = require('../package.json').build;

module.exports = {
  ...base,
  directories: { ...base.directories, output: process.env.UP_OUT || 'dist-up' },
  extraMetadata: { version: process.env.UP_VERSION || '0.1.0' },
  publish: [{ provider: 'generic', url: 'http://127.0.0.1:8123' }]
};
