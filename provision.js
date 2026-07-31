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

// ------------------------------------------------------------- downloading
//
// Retries and resume live here because the files are large and home wifi is
// not: `small` is ~490 MB, and losing it at 95% used to mean starting from
// zero. So the bytes accumulate in `<dest>.part` and that file now *survives*
// a failure on purpose — the next attempt asks for the rest with a Range
// header instead of the whole thing again. It survives a quit too: the part
// is next to the final file, so closing the app mid-download costs nothing.
//
// The invariant that matters is unchanged. `<dest>` itself only ever appears
// complete, by rename, so a killed download still never looks installed.
//
// `If-Range` guards the one real hazard: if what the server holds is not the
// file our fragment came from, it answers 200 with the whole body rather than
// 206, and we start clean instead of splicing two different files together.
// The validator (ETag, or Last-Modified) is kept beside the .part.

const RETRIES = 3;
const BACKOFF_MS = [1000, 4000, 10000];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const partOf = dest => `${dest}.part`;
const tagOf = dest => `${dest}.part.etag`;

function sizeOf(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

function dropPart(dest) {
  for (const f of [partOf(dest), tagOf(dest)]) {
    try { fs.unlinkSync(f); } catch { /* never existed */ }
  }
}

/**
 * One pass over the wire. Resolves when `dest` is whole.
 *
 * The care around closing the write stream is the whole point of the file: a
 * dropped connection has to leave the bytes that *did* arrive on disk, so an
 * abandoned stream is never enough — it has to be ended and flushed. That is
 * why every outcome after the first byte is delivered through the stream's
 * `close`, and nothing rejects out from under it.
 */
function attempt(url, dest, onPct, resume, redirectsLeft = 5, headers = null) {
  return new Promise((resolve, reject) => {
    const part = partOf(dest);
    if (!resume) dropPart(dest);
    let have = resume ? sizeOf(part) : 0;

    let out = null;         // the write stream, once there is a body to write
    let failure = null;     // what went wrong, delivered after the flush
    let settled = false;

    const settle = err => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve();
    };

    // Something broke. If bytes are already landing, close the file first —
    // what is in it is exactly what the next attempt resumes from.
    const abandon = err => {
      failure = failure || err;
      if (out) out.end();
      else settle(failure);
    };

    // built once and carried through the redirect chain: the CDN at the end of
    // it is the host that actually has to honour the range
    if (!headers) {
      headers = {};
      if (have) {
        headers.Range = `bytes=${have}-`;
        try {
          const tag = fs.readFileSync(tagOf(dest), 'utf8').trim();
          if (tag) headers['If-Range'] = tag;
        } catch { /* no validator kept; a plain Range is still worth asking */ }
      }
    }

    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { headers }, res => {
      const code = res.statusCode;

      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        if (!redirectsLeft) return settle(fatal(`too many redirects for ${url}`));
        settled = true;       // the recursive attempt owns the outcome now
        return attempt(new URL(res.headers.location, url).href, dest,
          onPct, resume, redirectsLeft - 1, headers).then(resolve, reject);
      }

      // 416: what we hold is already as long as the file. A truncated remote,
      // or a .part left by a different build. Throw it away and start over.
      if (code === 416) {
        res.resume();
        dropPart(dest);
        return settle(new Error(`stale partial download for ${path.basename(dest)}`));
      }

      if (code !== 200 && code !== 206) {
        res.resume();
        const err = new Error(`HTTP ${code} for ${url}`);
        // anything but "slow down" in the 4xx range will say the same next time
        if (code >= 400 && code < 500 && code !== 408 && code !== 429) err.fatal = true;
        return settle(err);
      }

      // 200 answering a ranged request means either the server ignores ranges
      // or If-Range decided the file moved on. What we hold is not a prefix of
      // what is arriving, so it goes.
      if (code === 200 && have) { dropPart(dest); have = 0; }

      const len = Number(res.headers['content-length']) || 0;
      const total = code === 206 ? have + len : len;
      const tag = res.headers.etag || res.headers['last-modified'];
      if (tag) { try { fs.writeFileSync(tagOf(dest), tag, 'utf8'); } catch { /* best effort */ } }

      let got = 0;
      out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });

      // The single verdict, once the bytes are safely on disk either way.
      out.on('close', () => {
        if (failure) return settle(failure);
        try {
          if (total && have + got < total) {
            throw new Error(`incomplete: ${have + got} of ${total} bytes`);
          }
          fs.renameSync(part, dest);
          try { fs.unlinkSync(tagOf(dest)); } catch { /* never written */ }
          settle();
        } catch (err) {
          settle(err);        // the .part stays; the next attempt continues it
        }
      });
      out.on('error', err => settle(err));

      res.on('data', chunk => {
        got += chunk.length;
        if (total && onPct) onPct(Math.min(100, ((have + got) / total) * 100));
      });
      res.on('aborted', () => abandon(new Error(`connection dropped fetching ${path.basename(dest)}`)));
      res.on('error', abandon);
      res.pipe(out);          // ends the stream itself when the body finishes
    });
    req.on('error', abandon);
    req.setTimeout(60000, () => req.destroy(new Error(`timed out fetching ${url}`)));
  });
}

function fatal(message) {
  const err = new Error(message);
  err.fatal = true;
  return err;
}

/**
 * One file, followed through redirects, resumed across attempts and retried
 * with a growing pause. `opts.resume: false` is for small throwaway fetches
 * (the update manifest) that should leave nothing behind.
 */
async function download(url, dest, onPct, opts = {}) {
  const retries = opts.retries === undefined ? RETRIES : opts.retries;
  const backoff = opts.backoff || BACKOFF_MS;
  const resume = opts.resume !== false;
  let last;
  for (let i = 0; i <= retries; i++) {
    if (i) {
      const wait = backoff[Math.min(i - 1, backoff.length - 1)];
      if (opts.onRetry) opts.onRetry({ attempt: i, of: retries, wait, error: last.message });
      await sleep(wait);
    }
    try {
      await attempt(url, dest, onPct, resume);
      return;
    } catch (err) {
      last = err;
      if (err.fatal) break;
    }
  }
  if (!resume) dropPart(dest);
  throw last;
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
 *
 * The order is what the user feels. Everything needed to *record* comes first
 * — the server binary and the first model — and progress says so with a
 * `usable: true` event, which is what main.js opens the app on. `small` and
 * the CUDA build are large and arrive behind it, while the app already works.
 * Recording is the part that cannot be done later; transcription can.
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
  const tell = (label, pct, extra) => o.progress({ step, steps, label, pct, ...extra });

  // Announced once, the moment the app stops being a download screen: the
  // server binary plus the model live transcription and calibration use.
  const starter = o.models[0];
  let announced = false;
  const announceUsable = () => {
    if (announced) return;
    if (!fs.existsSync(path.join(binMain, exe))) return;
    if (!fs.existsSync(path.join(models, `ggml-${starter}.bin`))) return;
    announced = true;
    tell('Ready to record — still fetching the rest', 100, { usable: true });
  };

  const retryNote = label => ({ attempt, of, error }) =>
    tell(`${label} — connection lost, retrying (${attempt}/${of})`, null, { warning: error });

  const engineZip = async (url, target, label) => {
    step++;
    if (fs.existsSync(path.join(target, exe))) { tell(`${label} — already here`, 100); return; }
    tell(label, 0);
    const zip = path.join(tmp, path.basename(new URL(url, 'http://x').pathname));
    await download(url, zip, pct => tell(label, pct),
      { onRetry: retryNote(label), retries: o.retries, backoff: o.backoff });
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

  if (mac) {
    await engineZip(o.macZip, binMain, 'Transcription engine (Metal)');
  } else {
    await engineZip(`${o.engineBase}/${o.cpuZip}`, binMain, 'Transcription engine (8 MB)');
  }

  for (const name of o.models) {
    step++;
    const dest = path.join(models, `ggml-${name}.bin`);
    const label = `"${name}" model`;
    if (fs.existsSync(dest)) { tell(`${label} — already here`, 100); announceUsable(); continue; }
    tell(label, 0);
    await download(`${o.modelBase}/ggml-${name}.bin`, dest,
      pct => tell(label, pct), { onRetry: retryNote(label), retries: o.retries, backoff: o.backoff });
    tell(`${label} — done`, 100);
    announceUsable();
  }

  // Last, and only on Windows: 646 MB that buys speed, not capability. It used
  // to run before the models, which meant a CUDA machine stared at a download
  // bar for the better part of an hour before it could record anything.
  if (!mac && o.gpu) {
    try {
      await engineZip(`${o.engineBase}/${o.gpuZip}`, binGpu, 'GPU acceleration (646 MB)');
    } catch (err) {
      // CPU still transcribes; a failed GPU download must not block install
      tell(`GPU build skipped: ${err.message}`, 100);
    }
  }

  const ready = fs.existsSync(path.join(binMain, exe))
    && o.models.every(name => fs.existsSync(path.join(models, `ggml-${name}.bin`)));
  if (ready) {
    tell('Engine ready', 100);
    // Only now: a half-downloaded zip in here is worth keeping, since the .part
    // beside it is what the next attempt resumes from.
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* next run */ }
  }
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
