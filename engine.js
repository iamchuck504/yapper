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

// Where bin/ and models/ live. In development that is the repo itself; an
// installed copy cannot write next to its own code (the app ships inside a
// read-only asar), so main.js points this at a per-machine folder instead and
// the first run downloads the engine there.
let ROOT = __dirname;
function setHome(dir) { ROOT = dir; }
const binRoot = () => path.join(ROOT, 'bin');

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
  const gpu = path.join(binRoot(), `${key}-gpu`);
  const cpu = path.join(binRoot(), key);
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

function modelPath(name) {
  return path.join(ROOT, 'models', `ggml-${name}.bin`);
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
  // A laptop's `fast`. Same model, same window, more room between passes. On
  // an M4 Pro a `small` pass over 12 s costs ~300 ms, so at 700 ms the GPU was
  // busy 40% of the meeting: the fans came on, the battery menu said the app
  // was using significant energy, and a call had to be stopped because the
  // machine got hot. At 1.5 s the confirmed text lands about a second later
  // and the GPU works a fifth of the time. The head start still runs — the
  // models agree — and battery power stretches this cadence further (main.js).
  balanced: {
    live: true, liveModel: 'small', finalModel: 'small',
    cadenceMs: 1500, windowSec: 12, maxHoldSec: 2
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
  if (hasNvidiaGpu()) return 'fast';
  if (isAppleSilicon()) return 'balanced';
  return os.cpus().length >= 8 ? 'steady' : 'modest';
}

/**
 * The tier this machine should actually run, given what it measured or has
 * stored. The benchmark only says how fast a pass is; it does not know that
 * the fast machine is a laptop sitting on someone's knees. Apple Silicon
 * measures well inside `fast` and should not run it: `balanced` is the same
 * promise at a sustainable pace. Settings written before `balanced` existed
 * say `fast` for these machines, so this is applied on the way out of
 * storage as well, not only after a calibration.
 */
function forThisMachine(name) {
  return name === 'fast' && isAppleSilicon() ? 'balanced' : name;
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

/**
 * Can transcription run ahead of the meeting on this tier?
 *
 * Only where it would not fight the live transcript over the model. The two
 * share one server and asking it for a different model restarts it — a model
 * reload, hundreds of megabytes off disk, every time they alternate. On
 * `steady`, where live runs `base` and the final pass runs `small`, that is a
 * reload every few seconds: the live transcript collapses and the machine
 * spends the meeting loading models instead of transcribing.
 *
 * `fast` wants the same model for both, and `modest` has no live transcript to
 * interrupt, so both get the head start. `steady` waits until the end, which
 * is what it did before any of this existed.
 */
function canGetAhead(name) {
  const t = tierConfig(name);
  return !t.live || t.liveModel === t.finalModel;
}

// Eleven seconds of a public-domain JFK speech, the sample that ships with
// whisper.cpp. It has to be real speech: most of a pass is the decoder emitting
// tokens, so a synthetic tone measures 25 ms where actual talking measures 185,
// and a laptop calibrated on a tone would be promised a tier it cannot hold.
//
// It ships with the app code, not with the downloaded engine — but an installed
// app's copy sits inside the asar, where this process can read it and the
// whisper server cannot, so main.js repoints it at the unpacked copy.
let CALIBRATION_WAV = path.join(__dirname, 'build', 'calibration.wav');
function setCalibrationWav(p) { CALIBRATION_WAV = p; }

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
    // Through the queue like everything else. Calibration used to reach the
    // server directly, which was harmless while it only ran at startup — but
    // it reruns whenever the engine's binary flavour changes, and that can now
    // happen mid-session, when the background half of the first-run download
    // finishes.
    await serialize(() => transcribeWav(wav, { language: 'en' }));
    times.push(Date.now() - t);
  }
  await stop();

  times.sort((a, b) => a - b);
  const msPerPass = times[Math.floor(times.length / 2)];
  setPace(msPerPass);
  return { tier: tierFromBenchmark(msPerPass), msPerPass };
}

// ---------------------------------------------------------------- server

let proc = null;
let reaped = false;       // orphan sweep: once per run, see start()
let port = 0;
let ready = null;
let loadedModel = null;
let forceCpu = false;       // Metal failed in this run; subsequent starts use -ng

function freePort() {
  // whisper-server binds what we give it; pick something unlikely to collide
  return 8710 + Math.floor(process.pid % 200);
}

function waitForPort(p, child, fatalError, timeoutMs = 90000) {
  const net = require('net');
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      fn(value);
    };
    const onExit = (code, signal) => finish(reject,
      fatalError() || new Error(`whisper-server exited before starting (${signal || code})`));
    const onError = err => finish(reject, err);
    child.once('exit', onExit);
    child.once('error', onError);
    const attempt = () => {
      if (settled) return;
      if (fatalError()) return finish(reject, fatalError());
      const sock = net.connect(p, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); finish(resolve); });
      sock.once('error', () => {
        sock.destroy();
        if (fatalError()) return finish(reject, fatalError());
        if (Date.now() - started > timeoutMs) {
          return finish(reject, new Error('whisper-server did not start'));
        }
        setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

/** Start (or reuse) the server for a given model. */
/**
 * Kill whisper-servers left over from a run that died without cleaning up.
 *
 * The server is a child process, and a child outlives a parent that is killed
 * rather than closed — a crash, a Force Quit, a `kill -9`. It keeps its model
 * resident the whole time, which is hundreds of megabytes each, and they stack
 * up: measured at 802 MB across four of them after an afternoon of testing.
 *
 * Only called when this process has no server of its own, so anything matching
 * our own binary path is by definition abandoned. The app is single-instance,
 * so there is no sibling whose server this could be.
 */
function reapOrphans() {
  const exe = serverPath();
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('taskkill', ['/F', '/IM', path.basename(exe)], { windowsHide: true });
      return r.status === 0 ? 1 : 0;
    }
    const found = spawnSync('pgrep', ['-f', exe], { encoding: 'utf8' });
    const pids = String(found.stdout || '').split('\n')
      .map(s => Number(s.trim())).filter(pid => pid && pid !== process.pid);
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    return pids.length;
  } catch {
    return 0;                 // best effort: never block a recording over this
  }
}

async function start(model, { threads } = {}) {
  if (proc && loadedModel === model) return ready;
  const hadServer = !!proc;
  await stop();

  if (!isInstalled()) throw new Error('whisper.cpp is not installed for this platform');
  if (!hasModel(model)) throw new Error(`model ${model} is missing`);

  // Once per run, and only before the first server exists. Orphans belong to
  // *previous* executions, so one sweep finds all of them — and repeating it
  // would be actively harmful: two transcriptions starting at the same moment
  // both see `proc` as null while the first is still in stop(), and the second
  // sweep would kill the server the first had just spawned.
  if (!hadServer && !reaped) {
    reaped = true;
    const killed = reapOrphans();
    if (killed) console.log(`[engine] cleaned up ${killed} whisper-server(s) from a previous run`);
  }

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
    '-sns',                     // drop [BLANK_AUDIO] / [INAUDIBLE] style tokens
    // verbose_json otherwise runs a separate language-detection pass on every
    // request just to fill `language_probabilities`, which nothing here reads.
    // Measured on an M4 Pro: 84 ms of every live window — a quarter of the
    // pass at the balanced cadence — and the text comes back byte-identical.
    '-nlp'
  ];
  if (process.env.YAPPER_WHISPER_ARGS) {
    args.push(...process.env.YAPPER_WHISPER_ARGS.split(' ').filter(Boolean));
  }
  if (forceCpu && !args.includes('-ng') && !args.includes('--no-gpu')) args.push('-ng');
  const child = spawn(serverPath(), args, { cwd: binDir() });
  proc = child;
  let startupFatal = null;
  let metalFailed = false;
  // whisper-server narrates its system info on every request; only surface the
  // lines that would actually help when something is wrong.
  child.stderr.on('data', d => {
    for (const line of d.toString().split('\n')) {
      const t = line.trim();
      if (!t) continue;
      if (/ggml_metal_.*(?:error|failed)|metal.*(?:failed|cannot|unable|error)/i.test(t)) {
        metalFailed = true;
        startupFatal = new Error('Metal could not initialize');
        try { child.kill(); } catch { /* it already exited */ }
      }
      if (/error|failed|cannot|unable|no GPU found|using .*backend|device \d+:/i.test(t)) {
        console.log('[whisper]', t.slice(0, 200));
      }
    }
  });
  child.on('exit', () => {
    if (proc === child) {
      proc = null;
      loadedModel = null;
    }
  });

  loadedModel = model;
  ready = waitForPort(port, child, () => startupFatal);
  try {
    await ready;
  } catch (err) {
    if (isAppleSilicon() && !forceCpu && metalFailed) {
      forceCpu = true;
      console.log('[engine] Metal unavailable; retrying with the CPU backend');
      await stop();
      return start(model, { threads });
    }
    throw err;
  }
  return ready;
}

async function stop() {
  if (!proc) return;
  const p = proc;
  proc = null;
  loadedModel = null;
  answeredOnce = false;      // the next server is cold again
  try { p.kill(); } catch { /* already gone */ }
  await new Promise(r => setTimeout(r, 120));
}

/**
 * Transcribe a WAV buffer (16 kHz mono PCM) through the running server.
 * Returns whisper.cpp's verbose JSON so callers can use segment timestamps.
 */
// A request that never answers is what this path is most exposed to:
// whisper-server accepts an /inference and then wedges — sockets open, no CPU,
// no reply, ever. Twice in one day, and both times the app waited forever with
// "Transcribing…" on screen, because nothing here had a deadline. The lock
// that caused those is fixed; a server can still wedge for reasons of its own,
// and the app must not wait out the heat death of the universe for it.
//
// The budget is proportional to the audio — a 10-second live window and a
// two-minute final window are not the same wait — with a floor for short ones.
// Four times real time is about a thirteen-fold margin over the slowest
// machine the tier table admits, so nothing healthy trips it.
let testDeadlineMs = 0;      // see __setDeadline in the exports

// What this machine measured at calibration: milliseconds for one pass over a
// 10-second window with CALIBRATION_MODEL. main.js hands it over from settings
// at startup, and calibrate() sets it when it reruns.
let measuredPace = 0;
function setPace(ms) { measuredPace = Number(ms) > 0 ? Number(ms) : 0; }

// `small` costs roughly two and a half times `base` on the same audio —
// measured across both anchor machines in the tier table.
const SMALL_VS_BASE = 2.5;

// Enough for a cold model load, which is the one legitimately slow moment in a
// run — and it is only the first request after a server starts that pays it.
// Charging it to every window would keep the deadline a third wider than it
// needs to be for the whole of a long meeting.
const STARTUP_ALLOWANCE_MS = 12000;
let answeredOnce = false;

// Eight times the measured cost. Wide enough that thermal throttling, a busy
// GPU or a laptop on battery never trip it; narrow enough to be useful, which
// the first version of this was not.
const PACE_MARGIN = 8;

/**
 * How long to wait for one request before calling the server dead.
 *
 * The first version gave every request four times real time, which sounded
 * cautious and was useless: a two-minute window takes about three seconds on a
 * calibrated machine, and it was being handed eight minutes. A wedge is meant
 * to cost seconds.
 *
 * So the budget comes from what this machine actually measured rather than
 * from the length of the audio alone. With no measurement yet — a first run,
 * before calibration — it falls back to the old proportional guess, since a
 * loose deadline still beats none.
 */
function deadlineFor(wavBuffer, model) {
  if (testDeadlineMs) return testDeadlineMs;
  const seconds = Math.max(0, (wavBuffer.length - WAV_HEADER) / BYTES_PER_SEC);
  if (!measuredPace) return Math.max(60000, Math.round(seconds * 4000));

  const perTenSeconds = measuredPace * (model === CALIBRATION_MODEL ? 1 : SMALL_VS_BASE);
  const expected = (seconds / 10) * perTenSeconds;
  const cold = answeredOnce ? 0 : STARTUP_ALLOWANCE_MS;
  return Math.round(cold + expected * PACE_MARGIN);
}

function transcribeWav(wavBuffer, { language = 'auto', prompt = '', model = null } = {}) {
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

    let timer = null;
    const done = fn => (...args) => { clearTimeout(timer); fn(...args); };
    const ok = done(resolve);
    const fail = done(reject);

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
        answeredOnce = true;
        try { ok(JSON.parse(out)); }
        catch { fail(new Error(`whisper-server replied with: ${out.slice(0, 200)}`)); }
      });
    });
    req.on('error', fail);

    const budget = deadlineFor(wavBuffer, model || loadedModel);
    timer = setTimeout(() => {
      // A server that did not answer this one will not answer the next either,
      // so it goes. Every caller's recovery path starts a fresh one — the
      // file transcription retries the window outright, and the live loop
      // takes its model back on its next pass.
      req.destroy(new Error(`whisper-server timed out after ${Math.round(budget / 1000)}s`));
      stop().catch(() => { /* it is already gone, which is the goal */ });
    }, budget);

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
/**
 * Transcription that runs *while* the meeting does.
 *
 * The wait at the end of a long meeting is almost all transcription — 50
 * seconds for 36 minutes here — and none of that work needs the meeting to be
 * over. Windows are independent, the audio for minute 5 is final while minute
 * 50 is still being spoken, and the machine is nearly idle: the live loop uses
 * about a sixth of a fast Mac. So the windows are done as the audio arrives,
 * and stopping leaves only the tail.
 *
 * The rule that makes the result *identical* rather than merely similar: a
 * window is only taken early when there is a full window plus its overlap of
 * audio after it. That guarantees it is not the last window, which is the one
 * fact the segment-dropping depends on — and "not last now" stays true, since
 * recordings only grow.
 *
 * Each window goes through the queue on its own, so the live transcript
 * interleaves between them rather than waiting behind the lot. In steady state
 * this costs live about 2% of its passes: one 2.6-second window per 120
 * seconds of meeting.
 */
/**
 * What a run of windows was produced under. A head start is only reusable by a
 * final pass that would have made the same windows the same way — mix a `base`
 * head start into a `small` pass and the transcript is silently half one and
 * half the other, which is worse than either and invisible. Not reachable
 * today, since every tier finishes with `small`, but it is one edit to the
 * tier table away and nothing would have complained.
 */
function fingerprintOf(o) {
  return [o.model, o.language, o.prompt, o.windowSec, o.overlapSec].join('\u0000');
}

function progressive(file, opts = {}) {
  const o = {
    language: 'auto', model: undefined, prompt: '', windowSec: 120, overlapSec: 2, ...opts
  };
  const lines = [];
  let at = 0;
  let working = null;      // the promise of the pass currently running
  let cancelled = false;

  return {
    get consumedSec() { return at; },
    get windows() { return lines.length ? at / o.windowSec : 0; },
    /** What transcribeFile needs to finish the job. */
    snapshot() { return { at, lines: lines.slice(), fingerprint: fingerprintOf(o) }; },

    /**
     * Take whatever windows are now safe. Resolves when it runs out of them,
     * and never throws: this is work brought forward, so failing it should
     * cost time at the end, not the meeting.
     */
    advance() {
      if (working || cancelled || !fs.existsSync(file)) return working || Promise.resolve();
      const run = (async () => {
        try {
          while (!cancelled) {
            const available = audioSecondsIn(file);
            if (available < at + o.windowSec + o.overlapSec) return;
            await start(o.model);
            const fd = fs.openSync(file, 'r');
            try {
              const done = await serialize(() =>
                transcribeWindow(fd, at, o.windowSec, false, o));
              lines.push(...done);
              at += o.windowSec;
            } finally {
              fs.closeSync(fd);
            }
          }
        } catch (err) {
          console.log('[transcribe] the head start stalled, will finish at the end:', err.message);
        }
      })();
      working = run;
      // Cleared out here, not in the body's `finally`. When there is nothing to
      // do the body returns before its first await — so its finally ran before
      // `working = run` had happened, and the flag stayed set on a promise that
      // was already settled. Nothing advanced again after that.
      const clear = () => { if (working === run) working = null; };
      run.then(clear, clear);
      return run;
    },

    /**
     * Stop getting ahead, and resolve once the window in flight has landed.
     *
     * Both halves matter at the moment someone presses stop. Left running, a
     * head start with a backlog keeps feeding windows into the same queue the
     * final pass needs — so the wait this was built to remove comes back,
     * behind work nobody is waiting for. And snapshotting while a window is
     * still in flight would leave that window out, so the final pass would do
     * it a second time.
     */
    async settle() {
      cancelled = true;
      if (working) await working.catch(() => { });
    }
  };
}

function transcribeFile(file, opts = {}) {
  // One server, one job at a time. Two of these at once used to fight over it:
  // the second one's start() killed the first one's server mid-request, and the
  // user was shown "read ECONNRESET". Queueing costs a wait; colliding costs a
  // transcript.
  return serialize(() => transcribeFileNow(file, opts));
}

// ---------------------------------------------------------------- one server
//
// whisper-server decodes one request at a time, and a second /inference sent
// while the first is in flight does not queue — it wedges. Seen on a real
// 24-minute meeting: two sockets ESTABLISHED from the app, both idle, the
// server burning 1 second of CPU across five minutes and never answering
// anything again. The recording survived because it was already on disk, but
// the transcript never arrived and the app sat there looking slow.
//
// It got there through a check-then-act race. `busy()` said false, the live
// loop went on to await a model switch and build its window, and a full-file
// transcription started in that gap. Both then had a request in flight.
//
// So the claim is taken here, synchronously, and there are two ways to take
// it. `serialize` waits its turn — for work that must not be dropped.
// `tryExclusive` refuses instead of waiting, which is what the live loop
// wants: a window decoded thirty seconds late is not a live transcript.

let jobs = Promise.resolve();
let running = 0;      // 1 while a request is actually in flight
let claimed = 0;      // queued *or* in flight, counted the instant work is asked for

function serialize(fn) {
  claimed++;
  // runs whether or not the previous job succeeded
  const start = () => { running++; return fn(); };
  const done = v => { running--; claimed--; return v; };
  const failed = e => { running--; claimed--; throw e; };
  const run = jobs.then(start, start).then(done, failed);
  jobs = run.then(() => {}, () => {});
  return run;
}

/**
 * Run `fn` only if the server is free this instant; otherwise return null
 * without waiting. The check and the claim are one synchronous step, which is
 * the whole point — `busy()` was two, and the gap between them is where the
 * wedged server came from.
 *
 * null means "not now, try later". A real inference always resolves an object.
 */
async function tryExclusive(fn) {
  if (claimed > 0) return null;
  claimed++;
  running++;
  const run = (async () => {
    try {
      return await fn();
    } finally {
      running--;
      claimed--;
    }
  })();
  // And it joins the queue. Claiming alone was not enough: `serialize` waits
  // its turn on `jobs`, which knew nothing about a try-claim, so a live pass
  // already in flight left the queue looking empty and the next full-file
  // transcription started straight into it. Two requests, and the server
  // wedges — the same failure this was written to prevent, reached from the
  // other direction. The first version of the test only drove one order.
  jobs = jobs.then(() => run, () => run).then(() => { }, () => { });
  return run;
}

/**
 * True while anything holds the server, queued or running. The live loop reads
 * it to bail out early and cheaply — but it is an optimisation now, not the
 * guard. `tryExclusive` is the guard.
 */
function busy() {
  return claimed > 0;
}

/** Which model the running server has loaded, if any. */
function loaded() {
  return proc ? loadedModel : null;
}

/**
 * One window, transcribed and turned into stamped lines.
 *
 * Shared by the pass that runs after a meeting and the one that runs during
 * it, because the two must agree exactly. The subtle part is the last
 * argument: a window drops any segment that begins inside its overlap, since
 * the next window owns that audio — unless there is no next window, in which
 * case dropping it would lose the end of the meeting.
 */
async function transcribeWindow(fd, at, len, isLast, o) {
  const from = Math.floor(at * BYTES_PER_SEC);
  const size = Math.ceil((len + (isLast ? 0 : o.overlapSec)) * BYTES_PER_SEC);
  const pcm = Buffer.alloc(size);
  const read = fs.readSync(fd, pcm, 0, size, WAV_HEADER + from);
  // A window with nothing in it is not worth an inference — Whisper handed
  // pure silence tends to hallucinate a polite "Thank you." rather than say
  // nothing. Per-side call tracks are exactly this most of the time: the far
  // side's file is digital silence whenever nobody remote is speaking.
  //
  // And a window that *begins* with silence gets it trimmed off, because
  // Whisper stamps sloppily across leading silence: handed 5 s of nothing and
  // then speech, it reports the speech at second 0, and the transcript's
  // timestamps — which order the two sides of a call against each other —
  // inherit the lie. The trim is whole seconds, keeping up to a second of
  // pre-roll so no word loses its onset, and the stamps get the offset back.
  const trimSec = leadingSilentSeconds(pcm.subarray(0, read));
  if (trimSec === null) return [];
  const wav = wavFromPcm(pcm.subarray(trimSec * BYTES_PER_SEC, read));

  let res;
  try {
    res = await transcribeWav(wav, { language: o.language, prompt: o.prompt, model: o.model });
  } catch (err) {
    // The server can be killed under us — antivirus, an out-of-memory kill,
    // the user ending the task. One retry with a fresh one costs a few
    // seconds; failing outright costs the whole transcript.
    if (!/ECONNRESET|ECONNREFUSED|socket hang up|not running|timed out/i.test(err.message)) throw err;
    await stop();
    await start(o.model);
    res = await transcribeWav(wav, { language: o.language, prompt: o.prompt, model: o.model })
      .catch(() => { throw new Error('The transcriber stopped unexpectedly. Try again.'); });
  }

  const out = [];
  const data = pcm.subarray(0, read);
  for (const seg of res.segments || []) {
    const relStart = typeof seg.start === 'number'
      ? seg.start
      : parseOffset(seg.offsets && seg.offsets.from);
    const relEnd = typeof seg.end === 'number'
      ? seg.end
      : parseOffset(seg.offsets && seg.offsets.to);
    const startSec = trimSec + relStart;
    if (startSec >= len && !isLast) continue;
    const text = (seg.text || '').trim();
    if (!text) continue;
    // Trimming the window's head is not enough: handed twenty seconds of
    // speech and then silence to the end, Whisper still conjures a word out
    // of the dead air. So each segment is held against the audio it claims to
    // transcribe — widened by a second each way, since Whisper's stamps can
    // sit slightly off the speech they belong to — and a segment whose whole
    // region is digital silence is a hallucination, not a quiet word.
    if (relEnd > relStart) {
      const a = Math.max(0, Math.floor((trimSec + relStart - 1) * BYTES_PER_SEC)) & ~1;
      const b = Math.min(data.length, Math.ceil((trimSec + relEnd + 1) * BYTES_PER_SEC));
      if (isSilentPcm(data.subarray(a, b))) continue;
    }
    out.push(`[${fmtStamp(at + startSec)}] ${text}`);
  }
  return out;
}

function audioSecondsIn(file) {
  return Math.max(0, fs.statSync(file).size - WAV_HEADER) / BYTES_PER_SEC;
}

// At or below ≈ -60 dBFS. Real speech, however quiet, sits far above this; the
// padding a track writes while its side is silent is exact zeros. The scan
// bails on the first loud sample, so a window with speech at its start costs
// almost nothing to check.
const SILENCE_PEAK = 32;

function isSilentPcm(pcm) {
  return leadingSilentSeconds(pcm) === null;
}

/**
 * Whole seconds of silence before the first sound, floored — so up to a second
 * of pre-roll survives ahead of the first word. null when the whole buffer is
 * silent.
 */
function leadingSilentSeconds(pcm) {
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const v = pcm.readInt16LE(i);
    if (v > SILENCE_PEAK || v < -SILENCE_PEAK) {
      return Math.floor(i / BYTES_PER_SEC);
    }
  }
  return null;
}

async function transcribeFileNow(file, { language = 'auto', model, prompt = '', windowSec = 120,
  overlapSec = 2, onProgress, from = null } = {}) {
  if (!fs.existsSync(file)) {
    throw new Error('The recording for that meeting is no longer there.');
  }
  repairWav(file);
  const totalSec = audioSecondsIn(file);
  if (totalSec < 0.5) return [];

  await start(model);

  const o = { language, model, prompt, windowSec, overlapSec };

  // `from` is a run that was already under way while the meeting was still
  // going: its windows are finished and identical to what this pass would have
  // produced for them, so only the tail is left. Two things have to hold for
  // that to be true, and both are cheaper to check than to debug — a head
  // start made under different settings would splice two different
  // transcriptions together, and one reaching past the end of the file would
  // contribute lines for audio that is no longer there. Either way it is
  // dropped and the file is done in full, which is only slower.
  let usable = from;
  if (from && from.fingerprint !== fingerprintOf(o)) {
    console.log('[transcribe] the head start was made under other settings; doing the file in full');
    usable = null;
  } else if (from && from.at > totalSec) {
    console.log('[transcribe] the head start runs past the end of the recording; doing the file in full');
    usable = null;
  }

  const lines = usable ? usable.lines.slice() : [];
  let at = usable ? usable.at : 0;
  const fd = fs.openSync(file, 'r');
  try {
    while (at < totalSec) {
      const len = Math.min(windowSec, totalSec - at);
      lines.push(...await transcribeWindow(fd, at, len, at + len >= totalSec, o));
      at += len;
      if (onProgress) onProgress({ done: Math.min(at, totalSec), total: totalSec });
    }
  } finally {
    fs.closeSync(fd);
  }
  return deduplicate(lines);
}

/** whisper.cpp reports either seconds or millisecond offsets, depending on build. */
function parseOffset(ms) {
  return typeof ms === 'number' ? ms / 1000 : 0;
}

// ---------------------------------------------------------------- cleanup
//
// Every Whisper model sometimes stutters — it emits a phrase and then emits it
// again. Measured across seven of Chuck's own recordings, `small` repeated 0.95%
// of its words this way and `medium` 0.79%: it is not a property of one model,
// so it is fixed here rather than avoided by choosing differently. The transcript
// is the only record of a meeting now, and a record that says things twice is a
// worse record.
//
// Only exact, back-to-back repeats of three or more words are touched. Real
// speech does repeat — "no, no, no", "very very good" — but those are one-word
// runs, and nobody says the same three words twice in a row by accident.

const MIN_REPEAT_WORDS = 3;

/** Remove a phrase that immediately repeats itself inside one line. */
function undoStutter(text) {
  const parts = text.split(/(\s+)/);                    // keep the spacing
  const words = [];
  for (let i = 0; i < parts.length; i += 2) words.push({ word: parts[i], sep: parts[i + 1] || '' });
  const key = w => w.word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

  for (let n = Math.floor(words.length / 2); n >= MIN_REPEAT_WORDS; n--) {
    for (let i = 0; i + 2 * n <= words.length; i++) {
      const a = words.slice(i, i + n).map(key).join(' ');
      const b = words.slice(i + n, i + 2 * n).map(key).join(' ');
      if (!a.trim() || a !== b) continue;
      words.splice(i + n, n);                           // drop the second copy
      return undoStutter(words.map(w => w.word + w.sep).join('').trim());
    }
  }
  return text;
}

// Two words is enough at a seam. Inside a line "very good very good" could be
// something a person said; across a segment boundary the same words with
// adjacent timestamps are the decoder emitting them twice, and even when it is
// not, dropping a duplicated "he's like" changes no meaning.
const MIN_SEAM_WORDS = 2;

// And only when the two lines are close in time. A window seam re-emits words
// within a second or two; the same phrase half a minute later is a person
// actually restating it, and that belongs in the record.
const MAX_SEAM_GAP_SEC = 6;

function stampSeconds(line) {
  const m = line.match(/^\[(\d+):(\d\d):(\d\d)\]/);
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null;
}

/** Words of a line, without the timestamp, comparable but reconstructible. */
function lineWords(line) {
  const text = line.replace(/^\[[\d:]+\]\s*/, '');
  const parts = text.split(/(\s+)/);
  const words = [];
  for (let i = 0; i < parts.length; i += 2) {
    if (parts[i]) words.push({ word: parts[i], sep: parts[i + 1] || ' ' });
  }
  return words;
}

const wordKey = w => w.word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

/**
 * Clean a whole transcript:
 *  · a phrase that repeats itself inside one line loses the second copy
 *  · a line that repeats the previous one entirely is dropped
 *  · a line that *begins* with the words the previous one ended with loses that
 *    opening — the seam artifact, which is the common one in practice
 *
 * Timestamps are kept as they are. The surviving copy is always the first, which
 * is where the words were actually said.
 */
function deduplicate(lines) {
  const out = [];
  const bare = s => s.replace(/^\[[\d:]+\]\s*/, '');
  const key = s => bare(s).toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, '').replace(/\s+/g, ' ').trim();

  // The gap is measured against the previous *input* line, not the last one
  // kept. In a run of six identical segments five seconds apart, dropping the
  // second would otherwise put the third ten seconds from its reference, then
  // fifteen, and the chain would escape the rule it was caught by.
  let prevStamp = null;

  for (const line of lines) {
    const stamp = line.slice(0, line.indexOf(']') + 1);
    const thisStamp = stampSeconds(line);
    const gap = prevStamp === null || thisStamp === null ? null : thisStamp - prevStamp;
    prevStamp = thisStamp;

    let cleaned = undoStutter(bare(line));
    if (!cleaned.trim()) continue;

    const prevLine = out[out.length - 1];
    if (out.length && (gap === null || Number.isNaN(gap) || gap <= MAX_SEAM_GAP_SEC)) {
      const prev = lineWords(prevLine).map(wordKey).filter(Boolean);
      let words = lineWords(`${stamp} ${cleaned}`);
      const cur = words.map(wordKey);
      const most = Math.min(prev.length, cur.filter(Boolean).length - 1);
      for (let n = most; n >= MIN_SEAM_WORDS; n--) {
        if (prev.slice(-n).join(' ') === cur.slice(0, n).join(' ')) {
          words = words.slice(n);
          cleaned = words.map(w => w.word + w.sep).join('').trim();
          break;
        }
      }
      if (!cleaned) continue;
    }

    const candidate = `${stamp} ${cleaned}`;
    // Same rule for a wholly identical line: close together it is the decoder
    // stuttering, far apart it is someone saying it again.
    const near = out.length && (gap === null || Number.isNaN(gap) || gap <= MAX_SEAM_GAP_SEC);
    if (near && key(candidate) === key(prevLine)) continue;
    out.push(candidate);
  }
  return out;
}

// ---------------------------------------------------------------- two tracks
//
// The two sides of a call, interleaved by time and labelled by which file the
// words came from. "Me" is the microphone — the person recording — and "Them"
// is the system audio, which may be several different people. Physical
// separation, not inference: a word is labelled by which stream carried it.
//
// When the far side produced no text the labels would say nothing worth
// reading into the transcript: a silent far side makes this the same
// one-sided recording it always was, so it comes back unlabelled.

function mergeSpeakerTracks(micLines, sysLines) {
  if (!sysLines.length) return micLines;
  const tag = (lines, who) => lines.map(line => {
    const m = line.match(/^(\[[\d:]+\])\s*(.*)$/);
    // The remote track may already have been split by the native diarizer.
    // Preserve that stronger label instead of producing "Them: Speaker 1".
    if (who === 'Them' && /^(?:Speaker [1-9]\d*|Them):\s/.test(m ? m[2] : line)) {
      return { sec: stampSeconds(line) || 0, line };
    }
    return {
      sec: stampSeconds(line) || 0,
      line: m ? `${m[1]} ${who}: ${m[2]}` : `${who}: ${line}`
    };
  });
  return [...tag(micLines, 'Me'), ...tag(sysLines, 'Them')]
    .sort((a, b) => a.sec - b.sec)          // stable: ties keep mic first
    .map(e => e.line);
}

module.exports = {
  platformKey, binDir, serverPath, isInstalled, setHome, setCalibrationWav,
  modelPath, hasModel,
  TIERS, tierConfig, canGetAhead, guessTier, tierFromBenchmark, forThisMachine, hasNvidiaGpu,
  isAppleSilicon,
  CALIBRATION_MODEL, calibrate,
  start, stop, busy, serialize, tryExclusive, loaded, transcribeWav, transcribeFile,
  deduplicate, undoStutter, deadlineFor, setPace, progressive, isSilentPcm,
  mergeSpeakerTracks,
  wavFromPcm, openWav, finishWav, repairWav, WAV_HEADER, BYTES_PER_SEC,

  // Test seam, and the only one in this file. A wedged server — the failure
  // that cost a meeting its transcript twice in one day — cannot be summoned
  // from a real whisper: it has to be played by a socket that accepts a
  // request and says nothing. This points the client at that socket, and
  // shortens the deadline so proving a timeout does not take a real minute.
  __pointAtServer(p, aPort) { proc = p; port = aPort; loadedModel = p ? 'test' : null; },
  __setDeadline(ms) { testDeadlineMs = ms; }
};
