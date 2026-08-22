// The first-run engine download, against a local server with tiny fixtures —
// the same flow a fresh install runs, without 1.3 GB of real downloads. What
// matters most: a killed or corrupted download must never leave something that
// looks installed, and a GPU failure must not block the CPU install.
//
// Two things it also pins, because both are about what a real install feels
// like rather than what it produces: a broken connection must *resume* instead
// of starting a 490 MB model over, and recording must open as soon as the
// engine and the first model are down, not when the last byte arrives.
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const provision = require('../provision');

let fails = 0;
function check(name, got, want = true) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      esperaba ${JSON.stringify(want)}\n      obtuve   ${JSON.stringify(got)}`); }
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'yapper-provision-'));

// ---- fixtures: a real zip (tar.exe both writes and reads them) ----
function makeZip(name, layout) {
  const stage = path.join(ROOT, `stage-${name}`);
  for (const [rel, content] of Object.entries(layout)) {
    const full = path.join(stage, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  const zip = path.join(ROOT, name);
  const r = spawnSync('tar', ['-a', '-cf', zip, '-C', stage, '.'], { windowsHide: true });
  if (r.status !== 0) throw new Error('tar could not build the fixture: ' + r.stderr);
  return fs.readFileSync(zip);
}

const cpuZip = makeZip('cpu.zip', {
  'Release/whisper-server.exe': 'fake cpu server',
  'Release/whisper.dll': 'fake dll'
});
const gpuZip = makeZip('gpu.zip', {
  'deep/nested/Release/whisper-server.exe': 'fake gpu server',
  'deep/nested/Release/cublas64.dll': 'fake cublas'
});
const macZip = makeZip('mac.zip', {
  'bin/whisper-server': 'fake mac server'
});
const model = name => Buffer.from(`fake ${name} model weights`);
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const fixtureHashes = {
  cpuZip: sha256(cpuZip),
  gpuZip: sha256(gpuZip),
  macZip: sha256(macZip),
  models: { base: sha256(model('base')), small: sha256(model('small')) }
};

// A file big enough to cut in half, served by a route that honours Range the
// way GitHub and HuggingFace do — that is the behaviour resume depends on.
const big = Buffer.from('0123456789'.repeat(50));      // 500 bytes

// ---- the server, with a hit counter and switchable failures ----
const hits = {};
let failGpu = false;
let corruptSmall = false;
let cutAfter = 0;         // kill the socket after this many body bytes; 0 = behave
let servedBytes = 0;      // body bytes actually sent, which is how resume is proven
let bigEtag = '"v1"';

const server = http.createServer((req, res) => {
  hits[req.url] = (hits[req.url] || 0) + 1;

  // Models served the way the real CDN serves them, so resume can be exercised
  // through provision.run() and not only through download() on its own — the
  // scenario being reproduced is quitting mid-download and reopening.
  if (req.url.startsWith('/rmodels/')) req.url = '/ranged/big.bin';

  if (req.url === '/ranged/big.bin') {
    const range = /^bytes=(\d+)-/.exec(req.headers.range || '');
    const ifRange = req.headers['if-range'];
    // a validator that no longer matches means the client's fragment came from
    // a different file: answer with the whole thing, exactly as RFC 9110 says
    const whole = !range || (ifRange && ifRange !== bigEtag);
    const from = whole ? 0 : Number(range[1]);
    if (from >= big.length) { res.writeHead(416); return res.end(); }

    const body = big.subarray(from);
    const head = { etag: bigEtag, 'accept-ranges': 'bytes', 'content-length': body.length };
    if (whole) res.writeHead(200, head);
    else res.writeHead(206, { ...head, 'content-range': `bytes ${from}-${big.length - 1}/${big.length}` });

    if (cutAfter && cutAfter < body.length) {
      servedBytes += cutAfter;
      // flush, *then* cut: destroying the socket outright would take the
      // headers with it, which is a connection that never happened rather than
      // one that died mid-file
      return res.write(body.subarray(0, cutAfter), () => res.destroy());
    }
    servedBytes += body.length;
    return res.end(body);
  }

  // models go through a redirect, like HuggingFace's CDN does
  if (req.url === '/models/ggml-base.bin') {
    res.writeHead(302, { location: '/cdn/ggml-base.bin' });
    return res.end();
  }

  const routes = {
    '/engine/whisper-bin-x64.zip': () => cpuZip,
    '/engine/whisper-mac-arm64.zip': () => macZip,
    '/engine/whisper-cublas-12.4.0-bin-x64.zip': () => {
      if (failGpu) { res.writeHead(500); res.end(); return null; }
      return gpuZip;
    },
    '/cdn/ggml-base.bin': () => model('base'),
    '/models/ggml-small.bin': () => {
      if (!corruptSmall) return model('small');
      // lie about the length: the body stops short of the promised bytes
      res.writeHead(200, { 'content-length': 999999 });
      res.write('tiny', () => res.destroy());
      return null;
    }
  };
  const body = routes[req.url] ? routes[req.url]() : undefined;
  if (body === null) return;                       // the route already answered
  if (!body) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-length': body.length });
  res.end(body);
});

server.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const opts = home => ({
    home,
    // pinned: the default follows the host, so on a Mac these Windows cases
    // would silently switch to mac-arm64 and reach for the real feed
    platform: 'win-x64',
    engineBase: `${base}/engine`,
    modelBase: `${base}/models`,
    hashes: fixtureHashes,
    // the retry pauses are real seconds in production and pure waiting here
    retries: 1,
    backoff: [0],
    progress: p => progressLog.push(p)
  });
  let progressLog = [];

  try {
    // ---- a clean install, CPU only ----
    const A = path.join(ROOT, 'homeA');
    check('instala CPU + modelos', await provision.run({ ...opts(A), gpu: false }));
    check('the server landed where the engine looks for it',
      fs.readFileSync(path.join(A, 'bin', 'win-x64', 'whisper-server.exe'), 'utf8'), 'fake cpu server');
    check('the dll came with it',
      fs.existsSync(path.join(A, 'bin', 'win-x64', 'whisper.dll')));
    check('both models', ['base', 'small'].every(m =>
      fs.existsSync(path.join(A, 'models', `ggml-${m}.bin`))));
    check('the CDN redirect was followed', hits['/cdn/ggml-base.bin'], 1);
    check('did not download the GPU build with no GPU', hits['/engine/whisper-cublas-12.4.0-bin-x64.zip'] || 0, 0);
    check('the temp folder was not left behind', fs.existsSync(path.join(A, 'tmp')), false);
    check('progress reached "ready"',
      progressLog.some(p => /engine ready/i.test(p.label)));
    check('and carries step and total', progressLog.every(p => p.steps === 3 && p.step >= 0 && p.step <= 3));

    // ---- recording opens as soon as the engine and the first model are in ----
    const iUsable = progressLog.findIndex(p => p.usable === true);
    const iSmallDone = progressLog.findIndex(p => /"small" model — done/.test(p.label || ''));
    check('says recording is possible', iUsable >= 0);
    check('and says it before small finishes', iUsable < iSmallDone);
    check('exactly once', progressLog.filter(p => p.usable === true).length, 1);

    // ---- run it again: nothing re-downloads ----
    const before = { ...hits };
    check('running it again is instant', await provision.run({ ...opts(A), gpu: false }));
    check('and downloads nothing a second time', hits, before);

    // ---- with GPU: the nested zip lands in the gpu dir ----
    const B = path.join(ROOT, 'homeB');
    progressLog = [];
    check('with a GPU it installs both builds', await provision.run({ ...opts(B), gpu: true }));
    check('the GPU binary landed in place, however the zip nests it',
      fs.readFileSync(path.join(B, 'bin', 'win-x64-gpu', 'whisper-server.exe'), 'utf8'), 'fake gpu server');
    // 646 MB that buy speed, not capability: they go last, behind everything
    // needed to record at all
    check('the GPU build downloads after the models',
      progressLog.findIndex(p => /GPU acceleration/.test(p.label || ''))
      > progressLog.findIndex(p => /"small" model — done/.test(p.label || '')));
    check('and recording was enabled before it',
      progressLog.findIndex(p => p.usable === true)
      < progressLog.findIndex(p => /GPU acceleration/.test(p.label || '')));

    // ---- a GPU failure does not block the install ----
    const C = path.join(ROOT, 'homeC');
    failGpu = true;
    progressLog = [];
    check('if the GPU build fails, the CPU one still stands', await provision.run({ ...opts(C), gpu: true }));
    check('no GPU binary', fs.existsSync(path.join(C, 'bin', 'win-x64-gpu', 'whisper-server.exe')), false);
    check('and progress says so instead of hiding it',
      progressLog.some(p => /GPU build skipped/i.test(p.label)));
    failGpu = false;

    // ---- a download that dies mid-file never looks installed ----
    const D = path.join(ROOT, 'homeD');
    corruptSmall = true;
    progressLog = [];
    let result = null;
    try { result = await provision.run({ ...opts(D), gpu: false }); } catch { result = 'threw'; }
    check('a cut download is not reported as success', result === true, false);
    check('no half-written model was left',
      fs.existsSync(path.join(D, 'models', 'ggml-small.bin')), false);
    // The .part is now kept on purpose — it is what the next attempt resumes
    // from. What must never exist is the finished name.
    check('the fragment is kept, to resume from',
      fs.existsSync(path.join(D, 'models', 'ggml-small.bin.part')));
    check('and the one that did arrive is complete',
      fs.readFileSync(path.join(D, 'models', 'ggml-base.bin'), 'utf8'), 'fake base model weights');
    check('with base in place, recording was already enabled',
      progressLog.some(p => p.usable === true));
    corruptSmall = false;

    // ---- and the retry after the failure completes it ----
    check('retrying completes what was missing', await provision.run({ ...opts(D), gpu: false }));
    check('without leaving the fragment behind',
      fs.existsSync(path.join(D, 'models', 'ggml-small.bin.part')), false);

    // ---- resume: the reason any of this exists ----
    // 490 MB dying at 95% used to mean 490 MB again. What is asserted here is
    // not "it eventually worked" but that the second attempt asked only for
    // the bytes it was missing.
    const R = path.join(ROOT, 'resumed.bin');
    servedBytes = 0;
    cutAfter = 180;
    let cut = null;
    try { await provision.download(`${base}/ranged/big.bin`, R, null, { retries: 0 }); }
    catch (err) { cut = err; }
    check('a cut connection fails', !!cut);
    check('but leaves exactly what did arrive', fs.statSync(`${R}.part`).size, 180);
    check('and stores the validator, to resume without risk',
      fs.readFileSync(`${R}.part.etag`, 'utf8'), '"v1"');
    check('the final file does not exist', fs.existsSync(R), false);

    cutAfter = 0;
    await provision.download(`${base}/ranged/big.bin`, R, null, { retries: 0 });
    check('the second attempt completes it', fs.readFileSync(R).equals(big));
    check('asking only for what was missing, not all of it again', servedBytes, big.length);
    check('and clears the validator when it is done', fs.existsSync(`${R}.part.etag`), false);

    // ---- If-Range: a fragment of another version is not glued onto the new file ----
    const R2 = path.join(ROOT, 'changed.bin');
    servedBytes = 0;
    cutAfter = 200;
    try { await provision.download(`${base}/ranged/big.bin`, R2, null, { retries: 0 }); } catch { /* esperado */ }
    check('there is a fragment of the old version', fs.statSync(`${R2}.part`).size, 200);

    bigEtag = '"v2"';            // the file changed on the server
    cutAfter = 0;
    await provision.download(`${base}/ranged/big.bin`, R2, null, { retries: 0 });
    check('the stale fragment is discarded rather than spliced in',
      fs.readFileSync(R2).equals(big));
    check('and that meant downloading the whole thing', servedBytes, 200 + big.length);
    bigEtag = '"v1"';

    // ---- downloaded bytes are not trusted until their digest matches ----
    const verified = path.join(ROOT, 'verified.bin');
    await provision.download(`${base}/ranged/big.bin`, verified, null,
      { retries: 0, sha256: sha256(big), maxBytes: big.length });
    check('a matching SHA-256 promotes the download', fs.readFileSync(verified).equals(big));

    const tampered = path.join(ROOT, 'tampered.bin');
    let integrityError = null;
    try {
      await provision.download(`${base}/ranged/big.bin`, tampered, null,
        { retries: 0, sha256: '0'.repeat(64) });
    } catch (err) { integrityError = err; }
    check('a wrong SHA-256 is rejected', /integrity/i.test(integrityError && integrityError.message));
    check('and is never left under the final name', fs.existsSync(tampered), false);

    const oversized = path.join(ROOT, 'oversized.bin');
    let sizeError = null;
    try {
      await provision.download(`${base}/ranged/big.bin`, oversized, null,
        { retries: 0, maxBytes: 100 });
    } catch (err) { sizeError = err; }
    check('an oversized response is stopped', /allowed download size/i.test(sizeError && sizeError.message));
    check('and leaves no installable file', fs.existsSync(oversized), false);

    let insecureError = null;
    try {
      await provision.download('http://example.com/file.bin', path.join(ROOT, 'insecure.bin'), null,
        { retries: 0 });
    } catch (err) { insecureError = err; }
    check('plain HTTP is refused away from localhost', /unencrypted/i.test(insecureError && insecureError.message));

    // ---- the retries belong to the download, not to the user ----
    servedBytes = 0;
    cutAfter = 120;
    const R3 = path.join(ROOT, 'retried.bin');
    const notes = [];
    // cut three times running: 120 bytes each attempt, and the fourth closes
    let left = 3;
    const stopCutting = setInterval(() => { if (--left <= 0) { cutAfter = 0; clearInterval(stopCutting); } }, 5);
    await provision.download(`${base}/ranged/big.bin`, R3, null,
      { retries: 5, backoff: [10], onRetry: n => notes.push(n) });
    clearInterval(stopCutting);
    check('retries on its own and finishes the file', fs.readFileSync(R3).equals(big));
    check('and reports each retry instead of swallowing it', notes.length > 0);

    // ---- closing the app mid-download and reopening it ----
    // The real case, end to end: not a bare download() but the whole install
    // cut and picked up in a second run, which is what happens when someone
    // closes Yapper with the bar halfway across.
    const Q = path.join(ROOT, 'homeQ');
    const qOpts = {
      ...opts(Q), gpu: false, modelBase: `${base}/rmodels`, retries: 0,
      hashes: { ...fixtureHashes, models: { base: sha256(big), small: sha256(big) } }
    };
    servedBytes = 0;
    cutAfter = 120;                       // dies inside the first model
    let first = null;
    try { first = await provision.run(qOpts); } catch { first = 'threw'; }
    check('a cut install does not claim it finished', first === true, false);
    const partQ = path.join(Q, 'models', 'ggml-base.bin.part');
    check('and leaves the fragment of the model in flight', fs.existsSync(partQ));
    const heldQ = fs.statSync(partQ).size;

    cutAfter = 0;                         // the network comes back
    check('reopening completes it', await provision.run(qOpts));
    check('both models came out whole', ['base', 'small'].every(m =>
      fs.readFileSync(path.join(Q, 'models', `ggml-${m}.bin`)).equals(big)));
    check('with no fragments abandoned',
      fs.readdirSync(path.join(Q, 'models')).filter(f => f.includes('.part')).length, 0);
    // Exact, not a bound: 120 B before the cut, 380 B on resume, 500 B for
    // the second model. The total being the size of the two files means no
    // byte travelled twice.
    check('and no byte travelled twice', servedBytes, big.length * 2);
    check('the fragment held was the cut point', heldQ, 120);

    // ---- version comparison, what the mac update notice hangs on ----
    check('0.1.1 is newer than 0.1.0', provision.newerVersion('0.1.1', '0.1.0'));
    check('0.2.0 gana a 0.1.9', provision.newerVersion('0.2.0', '0.1.9'));
    check('0.1.10 beats 0.1.9 (numeric, not alphabetic)', provision.newerVersion('0.1.10', '0.1.9'));
    check('the same version is not newer', provision.newerVersion('0.1.0', '0.1.0'), false);
    check('an older one is not newer', provision.newerVersion('0.1.0', '0.1.1'), false);
    check('1.0 contra 1.0.1 pierde', provision.newerVersion('1.0', '1.0.1'), false);

    // ---- macOS: one Metal build from our own feed, no gpu variant ----
    const E = path.join(ROOT, 'homeE');
    progressLog = [];
    check('mac installs from our own feed', await provision.run({
      ...opts(E), platform: 'mac-arm64', gpu: false,
      macZip: `${base}/engine/whisper-mac-arm64.zip`
    }));
    check('the mac binary landed where engine.binDir() looks for it',
      fs.readFileSync(path.join(E, 'bin', 'mac-arm64', 'whisper-server'), 'utf8'), 'fake mac server');
    check('no -gpu variant on mac',
      fs.existsSync(path.join(E, 'bin', 'mac-arm64-gpu')), false);
    check('en mac son 3 pasos (motor + 2 modelos)',
      progressLog.every(p => p.steps === 3));
  } catch (err) {
    fails++;
    console.log('FAIL  ' + (err.stack || err.message));
  }

  server.close();
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* locked */ }
  console.log(fails ? `\n${fails} failures` : '\nPASS');
  process.exit(fails ? 1 : 0);
});
