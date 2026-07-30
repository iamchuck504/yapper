// First-run download of the transcription engine, for installed copies.
//
// The installer ships the app shell (~100 MB) and nothing else: bundling the
// engine would make it a 1.4 GB download for everyone, including machines that
// will never use the CUDA build. So the first launch downloads exactly what
// this machine needs — the same files setup.ps1 fetches for a development
// checkout, into whatever home main.js points the engine at.
//
// Everything is injectable (URLs, the GPU probe) so the whole flow can be
// tested against a local server with tiny fixtures instead of 1.3 GB of real
// downloads. Extraction uses tar.exe, which ships with Windows 10+ and reads
// zip files — no unzip dependency.

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawnSync } = require('child_process');

const WHISPER_TAG = 'v1.9.1';

const DEFAULTS = {
  engineBase: `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_TAG}`,
  modelBase: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main',
  cpuZip: 'whisper-bin-x64.zip',
  gpuZip: 'whisper-cublas-12.4.0-bin-x64.zip',
  // ggml-org publishes no macOS binary at all, so the mac engine is our own:
  // compiled once on Apple hardware by mac/build-engine.sh (Metal, static) and
  // hosted on the public release feed next to the installers.
  macZip: `https://github.com/iamchuck504/yapper-releases/releases/download/engine-${WHISPER_TAG}/whisper-mac-arm64.zip`,
  // `medium` is deliberately absent: measured against `small` on real meeting
  // audio it loops (see ARCHITECTURE §8), so it would be 1.5 GB of worse output.
  models: ['base', 'small']
};

/** One file, followed through redirects (GitHub → S3, HuggingFace → CDN). */
function download(url, dest, onPct, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (!redirectsLeft) return reject(new Error(`too many redirects for ${url}`));
        return resolve(download(new URL(res.headers.location, url).href, dest, onPct, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }

      const total = Number(res.headers['content-length']) || 0;
      let got = 0;
      // .part until it is whole, so a killed download never looks installed
      const part = `${dest}.part`;
      const out = fs.createWriteStream(part);
      res.on('data', chunk => {
        got += chunk.length;
        if (total && onPct) onPct(Math.min(100, (got / total) * 100));
      });
      res.pipe(out);
      out.on('finish', () => {
        out.close(() => {
          try {
            if (total && got < total) throw new Error(`incomplete: ${got} of ${total} bytes`);
            fs.renameSync(part, dest);
            resolve();
          } catch (err) {
            try { fs.unlinkSync(part); } catch { /* already gone */ }
            reject(err);
          }
        });
      });
      out.on('error', err => { try { fs.unlinkSync(part); } catch { } reject(err); });
      res.on('error', err => { out.destroy(); try { fs.unlinkSync(part); } catch { } reject(err); });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error(`timed out fetching ${url}`)));
  });
}

/** tar.exe reads zips on Windows 10+; nothing has to be bundled to unzip. */
function extractZip(zip, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const r = spawnSync('tar', ['-xf', zip, '-C', outDir], { windowsHide: true });
  if (r.status !== 0) {
    throw new Error(`could not extract ${path.basename(zip)}: ${String(r.stderr || r.error || 'tar failed').slice(0, 200)}`);
  }
}

/** The release zips nest the binaries (Release\...); find them wherever they are. */
function findServerDir(root, exe) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.toLowerCase() === exe) return dir;
    }
  }
  return null;
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const f of fs.readdirSync(from)) {
    fs.copyFileSync(path.join(from, f), path.join(to, f));
  }
}

function hasNvidia() {
  try { return spawnSync('nvidia-smi', [], { windowsHide: true }).status === 0; }
  catch { return false; }
}

/**
 * Install the engine under `home`, reporting progress. Resolves true when a
 * server binary and both models are in place.
 *
 * On Windows the CPU build and the models are mandatory and the CUDA build is
 * best-effort on top — a machine that fails to fetch it still works, just at
 * CPU speed, exactly as setup.ps1 behaves. On macOS there is one build (Metal
 * is inside it) from our own feed, since ggml-org publishes none.
 */
async function run(opts) {
  const o = {
    ...DEFAULTS,
    platform: process.platform === 'darwin' ? 'mac-arm64' : 'win-x64',
    gpu: hasNvidia(),
    progress: () => { },
    ...opts
  };
  if (!o.home) throw new Error('provision.run needs a home directory');
  const mac = o.platform === 'mac-arm64';
  const exe = mac ? 'whisper-server' : 'whisper-server.exe';

  const tmp = path.join(o.home, 'tmp');
  const binMain = path.join(o.home, 'bin', o.platform);
  const binGpu = path.join(o.home, 'bin', `${o.platform}-gpu`);
  const models = path.join(o.home, 'models');
  fs.mkdirSync(tmp, { recursive: true });
  fs.mkdirSync(models, { recursive: true });

  const steps = 1 + (!mac && o.gpu ? 1 : 0) + o.models.length;
  let step = 0;
  const tell = (label, pct) => o.progress({ step, steps, label, pct });

  const engineZip = async (url, target, label) => {
    step++;
    if (fs.existsSync(path.join(target, exe))) { tell(`${label} — already here`, 100); return; }
    tell(label, 0);
    const zip = path.join(tmp, path.basename(new URL(url, 'http://x').pathname));
    await download(url, zip, pct => tell(label, pct));
    const out = path.join(tmp, path.basename(zip, '.zip'));
    extractZip(zip, out);
    const src = findServerDir(out, exe);
    if (!src) throw new Error(`${path.basename(zip)} did not contain ${exe}`);
    copyDir(src, target);
    // zip extraction does not reliably keep the executable bit
    if (process.platform !== 'win32') {
      for (const f of fs.readdirSync(target)) {
        try { fs.chmodSync(path.join(target, f), 0o755); } catch { /* best effort */ }
      }
    }
    tell(`${label} — done`, 100);
  };

  try {
    if (mac) {
      await engineZip(o.macZip, binMain, 'Transcription engine (Metal)');
    } else {
      await engineZip(`${o.engineBase}/${o.cpuZip}`, binMain, 'Transcription engine (8 MB)');
      if (o.gpu) {
        try {
          await engineZip(`${o.engineBase}/${o.gpuZip}`, binGpu, 'GPU acceleration (646 MB)');
        } catch (err) {
          // CPU still transcribes; a failed GPU download must not block install
          tell(`GPU build skipped: ${err.message}`, 100);
        }
      }
    }

    for (const name of o.models) {
      step++;
      const dest = path.join(models, `ggml-${name}.bin`);
      const label = `"${name}" model`;
      if (fs.existsSync(dest)) { tell(`${label} — already here`, 100); continue; }
      tell(label, 0);
      await download(`${o.modelBase}/ggml-${name}.bin`, dest, pct => tell(label, pct));
      tell(`${label} — done`, 100);
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* next run */ }
  }

  const ready = fs.existsSync(path.join(binMain, exe))
    && o.models.every(name => fs.existsSync(path.join(models, `ggml-${name}.bin`)));
  if (ready) tell('Engine ready', 100);
  return ready;
}

/** "0.1.2" newer than "0.1.0"? Plain numeric fields, no prerelease games. */
function newerVersion(a, b) {
  const A = String(a).split('.').map(Number);
  const B = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) > (B[i] || 0);
  }
  return false;
}

module.exports = { run, hasNvidia, download, extractZip, newerVersion, WHISPER_TAG, DEFAULTS };
