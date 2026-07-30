// Transcription engine: whisper.cpp behind a persistent local HTTP server.
//
// Why a server rather than the CLI: the live transcript re-decodes a rolling
// window every second or so, and loading the model per pass would cost more
// than the inference. whisper-server loads once and answers requests, which
// also avoids native Node modules — those would have to be rebuilt per
// platform and per Electron ABI, and that is exactly the pain we are removing.
//
// Binaries live in bin/<platform>/ and are chosen by what the machine can
// actually run. Nothing here assumes a GPU.

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = __dirname;
const BIN_ROOT = path.join(ROOT, 'bin');

// ---------------------------------------------------------------- platform

function platformKey() {
  if (process.platform === 'win32') return 'win-x64';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
}

function exeName(base) {
  return process.platform === 'win32' ? `${base}.exe` : base;
}

/**
 * Where the whisper.cpp binaries live for this machine. A "gpu" flavour is
 * used when present (cuBLAS on Windows/Linux, Metal is built into the mac
 * binary), otherwise the portable CPU build.
 */
function binDir() {
  const key = platformKey();
  const gpu = path.join(BIN_ROOT, `${key}-gpu`);
  const cpu = path.join(BIN_ROOT, key);
  if (fs.existsSync(path.join(gpu, exeName('whisper-server')))) return gpu;
  return cpu;
}

function serverPath() {
  return path.join(binDir(), exeName('whisper-server'));
}

function isInstalled() {
  return fs.existsSync(serverPath());
}

// ---------------------------------------------------------------- models

const MODELS_DIR = path.join(ROOT, 'models');

function modelPath(name) {
  return path.join(MODELS_DIR, `ggml-${name}.bin`);
}

function hasModel(name) {
  return fs.existsSync(modelPath(name));
}

// ---------------------------------------------------------------- tiers
//
// A tier is a promise about what this machine can do, not a guess about its
// brand. It is decided by a measured benchmark the first time (see calibrate)
// and then remembered.

// These numbers were measured, not guessed. On an RTX 4080 SUPER (cuBLAS), one
// pass over a 10 s window: base 175 ms, small 142 ms, medium 392 ms; the same
// machine's CPU needs ~1000 ms for base.
//
// Then a minute of a real (noisy) meeting was replayed through the live loop at
// wall-clock speed, measuring how far behind the speaker the confirmed text
// actually lands:
//     model    cadence  window  hold    median lag   worst
//     small     700 ms    12 s   1.5 s      2.6 s     4.8 s
//     small     500 ms    12 s   1.5 s      2.8 s     5.7 s
//     medium    700 ms    12 s   1.5 s      3.0 s     7.1 s
//     small     700 ms    12 s   2.5 s      3.6 s     5.3 s
// A short window matters more than a fast model: re-decoding 26 s of audio
// every pass makes the model resegment the whole thing, and two passes that
// disagree confirm nothing.
//
// `medium` is not used anywhere, in spite of being the better transcriber on
// paper. Live, its passes are slow enough that consecutive windows drift apart.
// And on the final pass it falls into repetition loops on real meeting audio —
// on a noisy minute of a huddle it returned "I'm not asking you to do it. I
// actually very much" six times in a row, with or without beam search, where
// `small` transcribed the same minute cleanly. Both handle clean speech fine;
// meetings are not clean speech, so `small` is what ships.
const TIERS = {
  // live text ~2.6 s behind speech, with the unstable tail visible sooner
  fast: {
    live: true, liveModel: 'small', finalModel: 'small',
    cadenceMs: 700, windowSec: 12, maxHoldSec: 1.5
  },
  // live works, but it has to breathe: smaller model, longer cadence. Measured
  // on this machine's CPU with the GPU build hidden (i7-12700K): 4.2 s median,
  // 6.3 s worst, and it does not drift further behind as the meeting runs.
  steady: {
    live: true, liveModel: 'base', finalModel: 'small',
    cadenceMs: 2000, windowSec: 12, maxHoldSec: 2.5
  },
  // no live transcript; the final pass still runs fine, just after the meeting
  modest: {
    live: false, liveModel: null, finalModel: 'small',
    cadenceMs: 0, windowSec: 0, maxHoldSec: 0
  }
};

function hasNvidiaGpu() {
  try {
    const r = spawnSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'],
      { encoding: 'utf8', timeout: 4000 });
    return r.status === 0 && !!r.stdout.trim();
  } catch {
    return false;
  }
}

function isAppleSilicon() {
  return process.platform === 'darwin' && process.arch === 'arm64';
}

/** A first guess, used before any measurement exists. */
function guessTier() {
  if (hasNvidiaGpu() || isAppleSilicon()) return 'fast';
  return os.cpus().length >= 8 ? 'steady' : 'modest';
}

/** The model calibration always measures with, so the numbers are comparable. */
const CALIBRATION_MODEL = 'base';

/**
 * Turn a measured pass cost into a tier. `msPerPass` is what CALIBRATION_MODEL
 * cost on the calibration sample. Two anchors, both measured on the same PC:
 *
 *     RTX 4080 SUPER, cuBLAS build ....  75 ms
 *     i7-12700K, CPU build only ....... 736 ms
 *
 * The thresholds sit between them and are checked against what each tier
 * actually asks for. `fast` runs `small` live, roughly 2.5x the cost of `base`:
 * at the 250 ms limit that is ~625 ms against a 700 ms cadence, which just
 * fits. `steady` runs `base` at a 2 s cadence, so 1200 ms still leaves room.
 * Past that the live loop cannot keep up and the tier says so instead of
 * falling further behind every minute.
 */
function tierFromBenchmark(msPerPass) {
  if (msPerPass <= 250) return 'fast';
  if (msPerPass <= 1200) return 'steady';
  return 'modest';
}

function tierConfig(name) {
  return TIERS[name] || TIERS.modest;
}

// Eleven seconds of a public-domain JFK speech, the sample that ships with
// whisper.cpp. It has to be real speech: most of a pass is the decoder emitting
// tokens, so a synthetic tone measures 25 ms where actual talking measures 185,
// and a laptop calibrated on a tone would be promised a tier it cannot hold.
const CALIBRATION_WAV = path.join(ROOT, 'build', 'calibration.wav');

/**
 * Measure this machine instead of guessing at it: run the sample a few times
 * and see what a pass costs. Returns { tier, msPerPass }, or null when the
 * engine or the sample is missing — in which case the caller should keep
 * guessing rather than trust an unmeasured number.
 */
async function calibrate({ passes = 3 } = {}) {
  if (!isInstalled() || !hasModel(CALIBRATION_MODEL)) return null;
  if (!fs.existsSync(CALIBRATION_WAV)) return null;

  const wav = fs.readFileSync(CALIBRATION_WAV);

  await start(CALIBRATION_MODEL);
  const times = [];
  for (let i = 0; i < passes; i++) {
    const t = Date.now();
    await transcribeWav(wav, { language: 'en' });
    times.push(Date.now() - t);
  }
  await stop();

  times.sort((a, b) => a - b);
  const msPerPass = times[Math.floor(times.length / 2)];
  return { tier: tierFromBenchmark(msPerPass), msPerPass };
}

// ---------------------------------------------------------------- server

let proc = null;
let port = 0;
let ready = null;
let loadedModel = null;

function freePort() {
  // whisper-server binds what we give it; pick something unlikely to collide
  return 8710 + Math.floor(process.pid % 200);
}

function waitForPort(p, timeoutMs = 90000) {
  const net = require('net');
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect(p, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() - started > timeoutMs) return reject(new Error('whisper-server did not start'));
        setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

/** Start (or reuse) the server for a given model. */
async function start(model, { threads } = {}) {
  if (proc && loadedModel === model) return ready;
  await stop();

  if (!isInstalled()) throw new Error('whisper.cpp is not installed for this platform');
  if (!hasModel(model)) throw new Error(`model ${model} is missing`);

  port = freePort();
  const args = [
    '-m', modelPath(model),
    '--host', '127.0.0.1',
    '--port', String(port),
    '-t', String(threads || Math.max(4, Math.min(8, os.cpus().length - 2))),
    // Each request is an independent window: carrying text context across them
    // makes the model continue its own previous output and drift.
    '-mc', '0',
    // a request longer than 30 s is decoded in chunks; without this the name
    // biasing would only apply to the first half-minute of each window
    '--carry-initial-prompt',
    '-sns'                      // drop [BLANK_AUDIO] / [INAUDIBLE] style tokens
  ];
  if (process.env.YAPPER_WHISPER_ARGS) {
    args.push(...process.env.YAPPER_WHISPER_ARGS.split(' ').filter(Boolean));
  }
  proc = spawn(serverPath(), args, { cwd: binDir() });
  // whisper-server narrates its system info on every request; only surface the
  // lines that would actually help when something is wrong.
  proc.stderr.on('data', d => {
    for (const line of d.toString().split('\n')) {
      const t = line.trim();
      if (!t) continue;
      if (/error|failed|cannot|unable|no GPU found|using .*backend|device \d+:/i.test(t)) {
        console.log('[whisper]', t.slice(0, 200));
      }
    }
  });
  proc.on('exit', () => { proc = null; loadedModel = null; });

  loadedModel = model;
  ready = waitForPort(port);
  await ready;
  return ready;
}

async function stop() {
  if (!proc) return;
  const p = proc;
  proc = null;
  loadedModel = null;
  try { p.kill(); } catch { /* already gone */ }
  await new Promise(r => setTimeout(r, 120));
}

/**
 * Transcribe a WAV buffer (16 kHz mono PCM) through the running server.
 * Returns whisper.cpp's verbose JSON so callers can use segment timestamps.
 */
function transcribeWav(wavBuffer, { language = 'auto', prompt = '' } = {}) {
  return new Promise((resolve, reject) => {
    if (!proc) return reject(new Error('whisper-server is not running'));
    const boundary = '----yapper' + Date.now().toString(16);
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\n`
      + 'Content-Type: audio/wav\r\n\r\n');
    const field = (name, value) =>
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}`;
    // The prompt is how names get spelled right: it biases the decoder toward
    // the words it lists without putting them in the transcript.
    const tail = Buffer.from(
      field('response_format', 'verbose_json')
      + field('language', language)
      + (prompt ? field('prompt', prompt.replace(/[\r\n]+/g, ' ')) : '')
      + `\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, wavBuffer, tail]);

    const req = http.request({
      host: '127.0.0.1', port, path: '/inference', method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      }
    }, res => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', c => { out += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(out)); }
        catch { reject(new Error(`whisper-server replied with: ${out.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------- wav

const WAV_HEADER = 44;

/** Write a WAV header whose sizes are filled in later (see finishWav). */
function openWav(file) {
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, wavHeader(0), 0, WAV_HEADER, 0);
  return fd;
}

/** Patch the header with the real sizes once the recording ends. */
function finishWav(fd, dataBytes) {
  fs.writeSync(fd, wavHeader(dataBytes), 0, WAV_HEADER, 0);
  fs.closeSync(fd);
}

/**
 * A recording cut short by a crash keeps the placeholder header, which says the
 * file is empty. Rewrite it from the real file size so the audio is usable.
 * Returns true when it had to repair.
 */
function repairWav(file) {
  const size = fs.statSync(file).size;
  if (size <= WAV_HEADER) return false;
  const head = Buffer.alloc(8);
  const fd = fs.openSync(file, 'r+');
  fs.readSync(fd, head, 0, 8, 40);          // data chunk size lives at byte 40
  const declared = head.readUInt32LE(0);
  const actual = size - WAV_HEADER;
  if (declared === actual) { fs.closeSync(fd); return false; }
  fs.writeSync(fd, wavHeader(actual), 0, WAV_HEADER, 0);
  fs.closeSync(fd);
  return true;
}

function wavHeader(dataBytes) {
  const h = Buffer.alloc(WAV_HEADER);
  const rate = 16000, channels = 1, bits = 16;
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * bits / 8, 28);
  h.writeUInt16LE(channels * bits / 8, 32);
  h.writeUInt16LE(bits, 34);
  h.write('data', 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

/** Wrap raw 16 kHz mono 16-bit PCM in a WAV container. */
function wavFromPcm(pcm) {
  const header = Buffer.alloc(44);
  const rate = 16000, channels = 1, bits = 16;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * bits / 8, 28);
  header.writeUInt16LE(channels * bits / 8, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// ---------------------------------------------------------------- full pass

const SAMPLE_RATE = 16000;
const BYTES_PER_SEC = SAMPLE_RATE * 2;

function fmtStamp(sec) {
  const s = Math.max(0, Math.floor(sec));
  const p = n => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
}

/**
 * Transcribe a whole WAV file in windows, so memory stays flat on a two-hour
 * meeting and the caller can show progress. Windows overlap slightly and
 * segments landing in the overlap are dropped, which avoids both a repeated
 * phrase and a word lost on the seam.
 *
 * onProgress({ done, total }) is called after each window.
 * Returns lines of "[hh:mm:ss] text".
 */
function transcribeFile(file, opts = {}) {
  // One server, one job at a time. Two of these at once used to fight over it:
  // the second one's start() killed the first one's server mid-request, and the
  // user was shown "read ECONNRESET". Queueing costs a wait; colliding costs a
  // transcript.
  return serialize(() => transcribeFileNow(file, opts));
}

let jobs = Promise.resolve();

function serialize(fn) {
  // runs whether or not the previous job succeeded
  const run = jobs.then(fn, fn);
  jobs = run.then(() => {}, () => {});
  return run;
}

async function transcribeFileNow(file, { language = 'auto', model, prompt = '', windowSec = 120,
  overlapSec = 2, onProgress } = {}) {
  if (!fs.existsSync(file)) {
    throw new Error('The recording for that meeting is no longer there.');
  }
  repairWav(file);
  const total = Math.max(0, fs.statSync(file).size - WAV_HEADER);
  const totalSec = total / BYTES_PER_SEC;
  if (totalSec < 0.5) return [];

  await start(model);

  const lines = [];
  const fd = fs.openSync(file, 'r');
  try {
    let at = 0;                       // seconds consumed so far
    while (at < totalSec) {
      const len = Math.min(windowSec, totalSec - at);
      const from = Math.floor(at * BYTES_PER_SEC);
      const size = Math.ceil(Math.min(len + overlapSec, totalSec - at) * BYTES_PER_SEC);
      const pcm = Buffer.alloc(size);
      const read = fs.readSync(fd, pcm, 0, size, WAV_HEADER + from);

      let res;
      try {
        res = await transcribeWav(wavFromPcm(pcm.subarray(0, read)), { language, prompt });
      } catch (err) {
        // The server can be killed under us — antivirus, an out-of-memory kill,
        // the user ending the task. One retry with a fresh one costs a few
        // seconds; failing outright costs the whole transcript.
        if (!/ECONNRESET|ECONNREFUSED|socket hang up|not running/i.test(err.message)) throw err;
        await stop();
        await start(model);
        res = await transcribeWav(wavFromPcm(pcm.subarray(0, read)), { language, prompt })
          .catch(() => { throw new Error('The transcriber stopped unexpectedly. Try again.'); });
      }
      for (const seg of res.segments || []) {
        const startSec = typeof seg.start === 'number'
          ? seg.start
          : parseOffset(seg.offsets && seg.offsets.from);
        // drop anything that begins inside the overlap: the next window owns it
        if (startSec >= len && at + len < totalSec) continue;
        const text = (seg.text || '').trim();
        if (text) lines.push(`[${fmtStamp(at + startSec)}] ${text}`);
      }

      at += len;
      if (onProgress) onProgress({ done: Math.min(at, totalSec), total: totalSec });
    }
  } finally {
    fs.closeSync(fd);
  }
  return lines;
}

/** whisper.cpp reports either seconds or millisecond offsets, depending on build. */
function parseOffset(ms) {
  return typeof ms === 'number' ? ms / 1000 : 0;
}

module.exports = {
  platformKey, binDir, serverPath, isInstalled,
  modelPath, hasModel, MODELS_DIR,
  TIERS, tierConfig, guessTier, tierFromBenchmark, hasNvidiaGpu, isAppleSilicon,
  CALIBRATION_MODEL, calibrate,
  start, stop, transcribeWav, transcribeFile,
  wavFromPcm, openWav, finishWav, repairWav, WAV_HEADER, BYTES_PER_SEC
};
