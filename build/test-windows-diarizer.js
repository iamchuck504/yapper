'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
const speakers = require('../speaker-diarizer');

const FIXTURE_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/1-two-speakers-en.wav';
const FIXTURE_SHA256 = 'f1c877dc01595e28be7147bf2fe38e5268147a868bf3fdb5c37b97f5940e21f3';
const MAX_FIXTURE_BYTES = 1024 * 1024;

function digest(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(file);
    input.on('error', reject);
    input.on('data', chunk => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many fixture redirects'));
    const request = https.get(url, {
      headers: { 'User-Agent': 'Yapper-Windows-sanity' }, timeout: 30000
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        return resolve(get(new URL(response.headers.location, url).href, redirects + 1));
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`fixture download returned HTTP ${response.statusCode}`));
      }
      const announced = Number(response.headers['content-length'] || 0);
      if (announced > MAX_FIXTURE_BYTES) {
        response.destroy();
        return reject(new Error(`fixture is unexpectedly large (${announced} bytes)`));
      }
      let received = 0;
      response.on('data', chunk => {
        received += chunk.length;
        if (received > MAX_FIXTURE_BYTES) response.destroy(new Error('fixture exceeded size limit'));
      });
      resolve(response);
    });
    request.on('timeout', () => request.destroy(new Error('fixture download timed out')));
    request.on('error', reject);
  });
}

async function fixture() {
  const dir = path.join(os.tmpdir(), 'yapper-build-cache');
  const file = path.join(dir, 'sherpa-onnx-1-two-speakers-en.wav');
  await fs.promises.mkdir(dir, { recursive: true });
  if (fs.existsSync(file) && await digest(file) === FIXTURE_SHA256) return file;
  await fs.promises.rm(file, { force: true });
  const part = `${file}.${process.pid}.part`;
  await fs.promises.rm(part, { force: true });
  try {
    await pipeline(await get(FIXTURE_URL), fs.createWriteStream(part, { flags: 'wx' }));
    const actual = await digest(part);
    if (actual !== FIXTURE_SHA256) throw new Error(`fixture SHA-256 mismatch: ${actual}`);
    await fs.promises.rename(part, file);
    return file;
  } finally {
    await fs.promises.rm(part, { force: true });
  }
}

(async () => {
  if (process.platform !== 'win32') {
    console.log('skip  Windows WebAssembly diarizer test');
    return;
  }
  const audio = await fixture();
  const packaged = process.argv[2] ? path.resolve(process.argv[2]) : '';
  const unpacked = packaged ? path.join(packaged, 'resources', 'app.asar.unpacked') : '';
  const assets = packaged
    ? path.join(unpacked, 'build', 'speaker-diarizer-windows')
    : path.join(__dirname, 'speaker-diarizer-windows');
  const workerFile = packaged
    ? path.join(unpacked, 'speaker-diarize-worker.js')
    : path.join(__dirname, '..', 'speaker-diarize-worker.js');
  const helperHint = path.join(path.dirname(assets), 'speaker-diarize');
  let progress = 0;
  const run = speakers.diarizeWindowsFile(helperHint, audio, {
    timeoutMs: 120000,
    windowsAssets: assets,
    workerFile,
    onProgress: (done, total) => { if (total > 0 && done >= 0) progress++; }
  });
  const result = await run;
  const identities = new Set(result.segments.map(segment => segment.speaker));
  if (!result.available || result.segments.length < 2 || identities.size !== 2 || !progress) {
    throw new Error(`expected two local speakers and progress, got ${JSON.stringify({
      available: result.available,
      reason: result.reason,
      segments: result.segments.length,
      identities: identities.size,
      progress
    })}`);
  }
  console.log(`ok    ${packaged ? 'packaged ' : ''}Windows local diarizer found ${identities.size} speakers in ${result.segments.length} segments`);
  console.log('PASS');
  process.exit(0);
})().catch(err => {
  console.error(`FAIL  Windows local diarizer\n      ${err.stack || err.message}`);
  process.exit(1);
});
