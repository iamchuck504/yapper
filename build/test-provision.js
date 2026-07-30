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
    check('instala CPU + modelos', await provision.run({ ...opts(A), gpu: false }));
    check('el server quedó donde el engine lo busca',
      fs.readFileSync(path.join(A, 'bin', 'win-x64', 'whisper-server.exe'), 'utf8'), 'fake cpu server');
    check('la dll vino con él',
      fs.existsSync(path.join(A, 'bin', 'win-x64', 'whisper.dll')));
    check('los dos modelos', ['base', 'small'].every(m =>
      fs.existsSync(path.join(A, 'models', `ggml-${m}.bin`))));
    check('el redirect del CDN se siguió', hits['/cdn/ggml-base.bin'], 1);
    check('no descargó el build GPU sin GPU', hits['/engine/whisper-cublas-12.4.0-bin-x64.zip'] || 0, 0);
    check('la carpeta temporal no quedó tirada', fs.existsSync(path.join(A, 'tmp')), false);
    check('el progreso llegó a "listo"',
      progressLog.some(p => /engine ready/i.test(p.label)));
    check('y trae paso y total', progressLog.every(p => p.steps === 3 && p.step >= 0 && p.step <= 3));

    // ---- run it again: nothing re-downloads ----
    const before = { ...hits };
    check('correrlo de nuevo es instantáneo', await provision.run({ ...opts(A), gpu: false }));
    check('y no vuelve a bajar nada', hits, before);

    // ---- with GPU: the nested zip lands in the gpu dir ----
    const B = path.join(ROOT, 'homeB');
    progressLog = [];
    check('con GPU instala ambos builds', await provision.run({ ...opts(B), gpu: true }));
    check('el binario GPU quedó en su lugar, aunque el zip lo anide',
      fs.readFileSync(path.join(B, 'bin', 'win-x64-gpu', 'whisper-server.exe'), 'utf8'), 'fake gpu server');

    // ---- a GPU failure does not block the install ----
    const C = path.join(ROOT, 'homeC');
    failGpu = true;
    progressLog = [];
    check('si el build GPU falla, el CPU igual queda', await provision.run({ ...opts(C), gpu: true }));
    check('sin binario GPU', fs.existsSync(path.join(C, 'bin', 'win-x64-gpu', 'whisper-server.exe')), false);
    check('y el progreso lo dice en vez de esconderlo',
      progressLog.some(p => /GPU build skipped/i.test(p.label)));
    failGpu = false;

    // ---- a download that dies mid-file never looks installed ----
    const D = path.join(ROOT, 'homeD');
    corruptSmall = true;
    let result = null;
    try { result = await provision.run({ ...opts(D), gpu: false }); } catch { result = 'threw'; }
    check('una descarga cortada no se reporta como éxito', result === true, false);
    check('no quedó un modelo a medias',
      fs.existsSync(path.join(D, 'models', 'ggml-small.bin')), false);
    check('ni un .part suelto',
      fs.existsSync(path.join(D, 'models', 'ggml-small.bin.part')), false);
    corruptSmall = false;

    // ---- and the retry after the failure completes it ----
    check('reintentar completa lo que faltaba', await provision.run({ ...opts(D), gpu: false }));

    // ---- version comparison, what the mac update notice hangs on ----
    check('0.1.1 es más nueva que 0.1.0', provision.newerVersion('0.1.1', '0.1.0'));
    check('0.2.0 gana a 0.1.9', provision.newerVersion('0.2.0', '0.1.9'));
    check('0.1.10 gana a 0.1.9 (numérico, no alfabético)', provision.newerVersion('0.1.10', '0.1.9'));
    check('la misma versión no es más nueva', provision.newerVersion('0.1.0', '0.1.0'), false);
    check('una vieja no es más nueva', provision.newerVersion('0.1.0', '0.1.1'), false);
    check('1.0 contra 1.0.1 pierde', provision.newerVersion('1.0', '1.0.1'), false);

    // ---- macOS: one Metal build from our own feed, no gpu variant ----
    const E = path.join(ROOT, 'homeE');
    progressLog = [];
    check('mac instala desde nuestro feed', await provision.run({
      ...opts(E), platform: 'mac-arm64', gpu: false,
      macZip: `${base}/engine/whisper-mac-arm64.zip`
    }));
    check('el binario mac quedó donde engine.binDir() lo busca',
      fs.readFileSync(path.join(E, 'bin', 'mac-arm64', 'whisper-server'), 'utf8'), 'fake mac server');
    check('sin variante -gpu en mac',
      fs.existsSync(path.join(E, 'bin', 'mac-arm64-gpu')), false);
    check('en mac son 3 pasos (motor + 2 modelos)',
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
