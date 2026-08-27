'use strict';

// Fetch the official, self-contained sherpa-onnx WebAssembly diarizer only
// when a Windows package is built. Keeping the large generated runtime out of
// git makes source checkouts small; the pinned release and SHA-256 make the
// resulting installer reproducible and fail closed if the download changes.

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
const { spawnSync } = require('child_process');

const VERSION = '1.13.6';
const ARCHIVE_NAME = `sherpa-onnx-wasm-simd-v${VERSION}-speaker-diarization.tar.bz2`;
const ARCHIVE_SHA256 = '8a40359109275ca8948fcc079658a1adaf6b0046808b5287aaccda0dba5c3aa6';
const ARCHIVE_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/v${VERSION}/${ARCHIVE_NAME}`;
const ARCHIVE_ROOT = `sherpa-onnx-wasm-simd-v${VERSION}-speaker-diarization`;
const VENDOR_FILES = [
  'sherpa-onnx-speaker-diarization.js',
  'sherpa-onnx-wasm-main-speaker-diarization.js',
  'sherpa-onnx-wasm-main-speaker-diarization.wasm',
  'sherpa-onnx-wasm-main-speaker-diarization.data'
];
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const root = path.join(__dirname, '..');
const destination = path.join(__dirname, 'speaker-diarizer-windows');

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(file);
    input.on('error', reject);
    hash.on('error', reject);
    input.on('data', chunk => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

async function completeInstall() {
  const manifestFile = path.join(destination, 'manifest.json');
  let manifest;
  try { manifest = JSON.parse(await fs.promises.readFile(manifestFile, 'utf8')); } catch { return false; }
  if (manifest.version !== VERSION || manifest.archiveSha256 !== ARCHIVE_SHA256) return false;
  for (const name of VENDOR_FILES) {
    const file = path.join(destination, name);
    if (!fs.existsSync(file) || await sha256(file) !== manifest.files[name]) return false;
  }
  return true;
}

function request(url, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error('too many download redirects'));
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': `Yapper-build/${require(path.join(root, 'package.json')).version}` },
      timeout: 30000
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        return resolve(request(new URL(response.headers.location, url).href, redirects + 1));
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`download returned HTTP ${response.statusCode}`));
      }
      resolve(response);
    });
    req.on('timeout', () => req.destroy(new Error('download timed out')));
    req.on('error', reject);
  });
}

async function downloadArchive(file) {
  const part = `${file}.${process.pid}.part`;
  await fs.promises.rm(part, { force: true });
  const response = await request(ARCHIVE_URL);
  const announced = Number(response.headers['content-length'] || 0);
  if (announced > MAX_DOWNLOAD_BYTES) {
    response.destroy();
    throw new Error(`diarizer archive is unexpectedly large (${announced} bytes)`);
  }
  let received = 0;
  response.on('data', chunk => {
    received += chunk.length;
    if (received > MAX_DOWNLOAD_BYTES) response.destroy(new Error('diarizer archive exceeded size limit'));
  });
  try {
    await pipeline(response, fs.createWriteStream(part, { flags: 'wx' }));
    const actual = await sha256(part);
    if (actual !== ARCHIVE_SHA256) throw new Error(`diarizer SHA-256 mismatch: ${actual}`);
    await fs.promises.rename(part, file);
  } finally {
    await fs.promises.rm(part, { force: true });
  }
}

function patchNodeDataPath(source) {
  const needle = 'var REMOTE_PACKAGE_NAME=Module["locateFile"]?Module["locateFile"](REMOTE_PACKAGE_BASE,""):REMOTE_PACKAGE_BASE;';
  const replacement = 'var REMOTE_PACKAGE_NAME=isNode?__dirname+"/"+REMOTE_PACKAGE_BASE:Module["locateFile"]?Module["locateFile"](REMOTE_PACKAGE_BASE,""):REMOTE_PACKAGE_BASE;';
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error('the pinned sherpa-onnx loader no longer has the expected data path');
  }
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

async function prepare() {
  if (await completeInstall()) {
    console.log(`Windows speaker diarizer v${VERSION} verified.`);
    return;
  }

  const cache = path.join(os.tmpdir(), 'yapper-build-cache');
  await fs.promises.mkdir(cache, { recursive: true });
  const archive = path.join(cache, ARCHIVE_NAME);
  if (!fs.existsSync(archive) || await sha256(archive) !== ARCHIVE_SHA256) {
    await fs.promises.rm(archive, { force: true });
    console.log(`Downloading pinned Windows speaker diarizer v${VERSION}...`);
    await downloadArchive(archive);
  }

  // The GitHub Windows runner keeps TEMP on C: and the checkout on D:.
  // rename() is the atomic hand-off below, so stage beside the destination;
  // a temp directory on another volume makes that hand-off fail with EXDEV.
  const staging = await fs.promises.mkdtemp(path.join(path.dirname(destination), '.yapper-diarizer-'));
  try {
    const unpack = path.join(staging, 'unpack');
    const ready = path.join(staging, 'ready');
    await fs.promises.mkdir(unpack);
    await fs.promises.mkdir(ready);
    const result = spawnSync('tar', ['-xjf', archive, '-C', unpack], {
      encoding: 'utf8', timeout: 120000, windowsHide: true
    });
    if (result.error || result.status !== 0) {
      throw new Error(`could not extract diarizer: ${result.error?.message || result.stderr || result.status}`);
    }

    const sourceDir = path.join(unpack, ARCHIVE_ROOT);
    for (const name of VENDOR_FILES) {
      const source = path.join(sourceDir, name);
      if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
        throw new Error(`diarizer archive is missing ${name}`);
      }
      const target = path.join(ready, name);
      if (name === 'sherpa-onnx-wasm-main-speaker-diarization.js') {
        const code = patchNodeDataPath(await fs.promises.readFile(source, 'utf8'));
        await fs.promises.writeFile(target, code, 'utf8');
      } else {
        await fs.promises.copyFile(source, target);
      }
    }

    const files = {};
    for (const name of VENDOR_FILES) files[name] = await sha256(path.join(ready, name));
    await fs.promises.writeFile(path.join(ready, 'manifest.json'), JSON.stringify({
      version: VERSION,
      source: ARCHIVE_URL,
      archiveSha256: ARCHIVE_SHA256,
      loaderModification: 'Resolve the preloaded data file beside the Node worker module.',
      files
    }, null, 2) + '\n');

    await fs.promises.rm(destination, { recursive: true, force: true });
    await fs.promises.rename(ready, destination);
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true });
  }
  if (!await completeInstall()) throw new Error('Windows speaker diarizer failed post-install verification');
  console.log(`Windows speaker diarizer v${VERSION} prepared and verified.`);
}

async function beforePack(context) {
  if (context && context.electronPlatformName && context.electronPlatformName !== 'win32') return;
  await prepare();
}

module.exports = beforePack;
module.exports.prepare = prepare;
module.exports.constants = { VERSION, ARCHIVE_NAME, ARCHIVE_SHA256, ARCHIVE_URL, VENDOR_FILES };

if (require.main === module) {
  prepare().catch(err => {
    console.error(`Failed to prepare Windows speaker diarizer: ${err.message}`);
    process.exit(1);
  });
}
