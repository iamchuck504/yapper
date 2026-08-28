'use strict';

// Build the Windows speaker bundle from two pinned official sherpa-onnx
// archives. The model archive supplies the exact ONNX models and the native
// Windows archive supplies the multithreaded runner. Large generated files stay
// out of git; both downloads and every installed file are SHA-256 verified.

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
const { spawnSync } = require('child_process');

const VERSION = '1.13.6';
const RELEASE = `https://github.com/k2-fsa/sherpa-onnx/releases/download/v${VERSION}`;
const MODEL_ARCHIVE = {
  name: `sherpa-onnx-wasm-simd-v${VERSION}-speaker-diarization.tar.bz2`,
  sha256: '8a40359109275ca8948fcc079658a1adaf6b0046808b5287aaccda0dba5c3aa6',
  root: `sherpa-onnx-wasm-simd-v${VERSION}-speaker-diarization`,
  maxBytes: 64 * 1024 * 1024
};
const NATIVE_ARCHIVE = {
  name: `sherpa-onnx-v${VERSION}-win-x64-shared-MD-Release-no-tts.tar.bz2`,
  sha256: '071d6641efd737a1f60de48c9c4cd596f78d5b0980815e8ad3798c95785d2b26',
  root: `sherpa-onnx-v${VERSION}-win-x64-shared-MD-Release-no-tts`,
  maxBytes: 32 * 1024 * 1024
};
for (const archive of [MODEL_ARCHIVE, NATIVE_ARCHIVE]) archive.url = `${RELEASE}/${archive.name}`;

// These offsets come from the pinned Emscripten package metadata. The hashes
// below make any upstream layout change fail closed instead of shipping a
// partial model.
const MODEL_SLICES = {
  'embedding.onnx': { start: 1011, end: 39594772 },
  'segmentation.onnx': { start: 39594772, end: 45587685 }
};
const NATIVE_FILES = [
  'sherpa-onnx-offline-speaker-diarization.exe',
  'onnxruntime.dll',
  'onnxruntime_providers_shared.dll'
];
const VENDOR_FILES = [...Object.keys(MODEL_SLICES), ...NATIVE_FILES];
const EXPECTED_FILES = {
  'embedding.onnx': '1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b',
  'segmentation.onnx': '220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079',
  'sherpa-onnx-offline-speaker-diarization.exe': 'fe47524ce0e1bb2abe37f0598273770ae0a5cdf6235ecfe76f98e23aca7315ba',
  'onnxruntime.dll': '4ee0ae76cbf51bde6999f36829939b2b06d340ab57867ef82b61a0b674111efa',
  'onnxruntime_providers_shared.dll': 'cd7245821ad7054d1904ac221ca3d6b913c0e8977f0b408787f3bc2c430a5403'
};
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
  if (manifest.version !== VERSION
      || manifest.modelArchiveSha256 !== MODEL_ARCHIVE.sha256
      || manifest.nativeArchiveSha256 !== NATIVE_ARCHIVE.sha256) return false;
  for (const name of VENDOR_FILES) {
    const file = path.join(destination, name);
    if (!fs.existsSync(file) || await sha256(file) !== EXPECTED_FILES[name]) return false;
  }
  return true;
}

function request(url, maxBytes, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error('too many download redirects'));
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': `Yapper-build/${require(path.join(root, 'package.json')).version}` },
      timeout: 30000
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        return resolve(request(new URL(response.headers.location, url).href, maxBytes, redirects + 1));
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`download returned HTTP ${response.statusCode}`));
      }
      const announced = Number(response.headers['content-length'] || 0);
      if (announced > maxBytes) {
        response.destroy();
        return reject(new Error(`diarizer archive is unexpectedly large (${announced} bytes)`));
      }
      let received = 0;
      response.on('data', chunk => {
        received += chunk.length;
        if (received > maxBytes) response.destroy(new Error('diarizer archive exceeded size limit'));
      });
      resolve(response);
    });
    req.on('timeout', () => req.destroy(new Error('download timed out')));
    req.on('error', reject);
  });
}

async function downloadArchive(file, archive) {
  const part = `${file}.${process.pid}.part`;
  await fs.promises.rm(part, { force: true });
  try {
    await pipeline(await request(archive.url, archive.maxBytes), fs.createWriteStream(part, { flags: 'wx' }));
    const actual = await sha256(part);
    if (actual !== archive.sha256) throw new Error(`diarizer SHA-256 mismatch: ${actual}`);
    await fs.promises.rename(part, file);
  } finally {
    await fs.promises.rm(part, { force: true });
  }
}

async function cachedArchive(cache, archive) {
  const file = path.join(cache, archive.name);
  if (!fs.existsSync(file) || await sha256(file) !== archive.sha256) {
    await fs.promises.rm(file, { force: true });
    console.log(`Downloading pinned Windows speaker component ${archive.name}...`);
    await downloadArchive(file, archive);
  }
  return file;
}

function unpack(archive, folder) {
  const result = spawnSync('tar', ['-xjf', archive, '-C', folder], {
    encoding: 'utf8', timeout: 120000, windowsHide: true
  });
  if (result.error || result.status !== 0) {
    throw new Error(`could not extract diarizer: ${result.error?.message || result.stderr || result.status}`);
  }
}

async function copySlice(source, target, { start, end }) {
  await pipeline(fs.createReadStream(source, { start, end: end - 1 }),
    fs.createWriteStream(target, { flags: 'wx' }));
}

async function prepare() {
  if (await completeInstall()) {
    console.log(`Windows native speaker diarizer v${VERSION} verified.`);
    return;
  }

  const cache = path.join(os.tmpdir(), 'yapper-build-cache');
  await fs.promises.mkdir(cache, { recursive: true });
  const modelArchive = await cachedArchive(cache, MODEL_ARCHIVE);
  const nativeArchive = await cachedArchive(cache, NATIVE_ARCHIVE);

  // GitHub keeps TEMP and the checkout on different drives. Stage beside the
  // destination so the final rename is an atomic same-volume hand-off.
  const staging = await fs.promises.mkdtemp(path.join(path.dirname(destination), '.yapper-diarizer-'));
  try {
    const modelsUnpack = path.join(staging, 'models');
    const nativeUnpack = path.join(staging, 'native');
    const ready = path.join(staging, 'ready');
    await Promise.all([modelsUnpack, nativeUnpack, ready].map(folder => fs.promises.mkdir(folder)));
    unpack(modelArchive, modelsUnpack);
    unpack(nativeArchive, nativeUnpack);

    const packedModels = path.join(modelsUnpack, MODEL_ARCHIVE.root,
      'sherpa-onnx-wasm-main-speaker-diarization.data');
    if (!fs.existsSync(packedModels)) throw new Error('model archive is missing its data package');
    for (const [name, range] of Object.entries(MODEL_SLICES)) {
      await copySlice(packedModels, path.join(ready, name), range);
    }

    const nativeBin = path.join(nativeUnpack, NATIVE_ARCHIVE.root, 'bin');
    for (const name of NATIVE_FILES) {
      const source = path.join(nativeBin, name);
      if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
        throw new Error(`native diarizer archive is missing ${name}`);
      }
      await fs.promises.copyFile(source, path.join(ready, name));
    }

    const files = {};
    for (const name of VENDOR_FILES) {
      files[name] = await sha256(path.join(ready, name));
      if (files[name] !== EXPECTED_FILES[name]) throw new Error(`${name} SHA-256 mismatch: ${files[name]}`);
    }
    await fs.promises.writeFile(path.join(ready, 'manifest.json'), JSON.stringify({
      version: VERSION,
      sources: [MODEL_ARCHIVE.url, NATIVE_ARCHIVE.url],
      modelArchiveSha256: MODEL_ARCHIVE.sha256,
      nativeArchiveSha256: NATIVE_ARCHIVE.sha256,
      files
    }, null, 2) + '\n');

    await fs.promises.rm(destination, { recursive: true, force: true });
    await fs.promises.rename(ready, destination);
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true });
  }
  if (!await completeInstall()) throw new Error('Windows speaker diarizer failed post-install verification');
  console.log(`Windows native speaker diarizer v${VERSION} prepared and verified.`);
}

async function beforePack(context) {
  if (context && context.electronPlatformName && context.electronPlatformName !== 'win32') return;
  await prepare();
}

module.exports = beforePack;
module.exports.prepare = prepare;
module.exports.constants = { VERSION, MODEL_ARCHIVE, NATIVE_ARCHIVE, VENDOR_FILES, EXPECTED_FILES };

if (require.main === module) {
  prepare().catch(err => {
    console.error(`Failed to prepare Windows diarizer: ${err.message}`);
    process.exit(1);
  });
}
