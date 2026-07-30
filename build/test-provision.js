// The first-run engine download, against a local server with tiny fixtures —
// the same flow a fresh install runs, without 1.3 GB of real downloads. What
// matters most: a killed or corrupted download must never leave something that
// looks installed, and a GPU failure must not block the CPU install.
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
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

// ---- the server, with a hit counter and switchable failures ----
const hits = {};
let failGpu = false;
let corruptSmall = false;

const server = http.createServer((req, res) => {
  hits[req.url] = (hits[req.url] || 0) + 1;

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
      res.write('tiny');
      res.destroy();
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
    engineBase: `${base}/engine`,
    modelBase: `${base}/models`,
    progress: p => progressLog.push(p)
  });
  let progressLog = [];

  try {
    // ---- a clean install, CPU only ----
    const A = path.join(ROOT, 'homeA');
    check('installs CPU + models', await provision.run({ ...opts(A), gpu: false }));
    check('the server landed where the engine looks for it',
      fs.readFileSync(path.join(A, 'bin', 'win-x64', 'whisper-server.exe'), 'utf8'), 'fake cpu server');
    check('the dll came with it',
      fs.existsSync(path.join(A, 'bin', 'win-x64', 'whisper.dll')));
    check('both models', ['base', 'small'].every(m =>
      fs.existsSync(path.join(A, 'models', `ggml-${m}.bin`))));
    check('the CDN redirect was followed', hits['/cdn/ggml-base.bin'], 1);
    check('did not download the GPU build without a GPU', hits['/engine/whisper-cublas-12.4.0-bin-x64.zip'] || 0, 0);
    check('the temp folder was not left behind', fs.existsSync(path.join(A, 'tmp')), false);
    check('progress reached "ready"',
      progressLog.some(p => /engine ready/i.test(p.label)));
    check('and it carries step and total', progressLog.every(p => p.steps === 3 && p.step >= 0 && p.step <= 3));

    // ---- run it again: nothing re-downloads ----
    const before = { ...hits };
    check('running it again is instant', await provision.run({ ...opts(A), gpu: false }));
    check('and it downloads nothing again', hits, before);

    // ---- with GPU: the nested zip lands in the gpu dir ----
    const B = path.join(ROOT, 'homeB');
    progressLog = [];
    check('with a GPU it installs both builds', await provision.run({ ...opts(B), gpu: true }));
    check('the GPU binary landed in place, even though the zip nests it',
      fs.readFileSync(path.join(B, 'bin', 'win-x64-gpu', 'whisper-server.exe'), 'utf8'), 'fake gpu server');

    // ---- a GPU failure does not block the install ----
    const C = path.join(ROOT, 'homeC');
    failGpu = true;
    progressLog = [];
    check('if the GPU build fails, the CPU one still lands', await provision.run({ ...opts(C), gpu: true }));
    check('no GPU binary', fs.existsSync(path.join(C, 'bin', 'win-x64-gpu', 'whisper-server.exe')), false);
    check('and progress says so instead of hiding it',
      progressLog.some(p => /GPU build skipped/i.test(p.label)));
    failGpu = false;

    // ---- a download that dies mid-file never looks installed ----
    const D = path.join(ROOT, 'homeD');
    corruptSmall = true;
    let result = null;
    try { result = await provision.run({ ...opts(D), gpu: false }); } catch { result = 'threw'; }
    check('a truncated download is not reported as success', result === true, false);
    check('no half-written model was left',
      fs.existsSync(path.join(D, 'models', 'ggml-small.bin')), false);
    check('not a single stray .part',
      fs.existsSync(path.join(D, 'models', 'ggml-small.bin.part')), false);
    corruptSmall = false;

    // ---- and the retry after the failure completes it ----
    check('retrying completes what was missing', await provision.run({ ...opts(D), gpu: false }));

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
    check('mac installs from our feed', await provision.run({
      ...opts(E), platform: 'mac-arm64', gpu: false,
      macZip: `${base}/engine/whisper-mac-arm64.zip`
    }));
    check('the mac binary landed where engine.binDir() looks for it',
      fs.readFileSync(path.join(E, 'bin', 'mac-arm64', 'whisper-server'), 'utf8'), 'fake mac server');
    check('no -gpu variant on mac',
      fs.existsSync(path.join(E, 'bin', 'mac-arm64-gpu')), false);
    check('on mac it is 3 steps (engine + 2 models)',
      progressLog.every(p => p.steps === 3));
  } catch (err) {
    fails++;
    console.log('FAIL  ' + (err.stack || err.message));
  }

  server.close();
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* locked */ }
  console.log(fails ? `\n${fails} fallos` : '\nPASS');
  process.exit(fails ? 1 : 0);
});
