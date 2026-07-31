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

    // ---- grabar se abre en cuanto está el motor + el primer modelo ----
    const iUsable = progressLog.findIndex(p => p.usable === true);
    const iSmallDone = progressLog.findIndex(p => /"small" model — done/.test(p.label || ''));
    check('avisa que ya se puede grabar', iUsable >= 0);
    check('y lo avisa antes de que small termine', iUsable < iSmallDone);
    check('una sola vez', progressLog.filter(p => p.usable === true).length, 1);

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
    // 646 MB que dan velocidad, no capacidad: van al final, detrás de todo lo
    // que hace falta para grabar
    check('el build GPU se baja después de los modelos',
      progressLog.findIndex(p => /GPU acceleration/.test(p.label || ''))
      > progressLog.findIndex(p => /"small" model — done/.test(p.label || '')));
    check('y grabar se habilitó antes que él',
      progressLog.findIndex(p => p.usable === true)
      < progressLog.findIndex(p => /GPU acceleration/.test(p.label || '')));

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
    progressLog = [];
    let result = null;
    try { result = await provision.run({ ...opts(D), gpu: false }); } catch { result = 'threw'; }
    check('una descarga cortada no se reporta como éxito', result === true, false);
    check('no quedó un modelo a medias',
      fs.existsSync(path.join(D, 'models', 'ggml-small.bin')), false);
    // The .part is now kept on purpose — it is what the next attempt resumes
    // from. What must never exist is the finished name.
    check('el fragmento se conserva para reanudar',
      fs.existsSync(path.join(D, 'models', 'ggml-small.bin.part')));
    check('y el que sí bajó quedó completo',
      fs.readFileSync(path.join(D, 'models', 'ggml-base.bin'), 'utf8'), 'fake base model weights');
    check('con base en su lugar, grabar ya estaba habilitado',
      progressLog.some(p => p.usable === true));
    corruptSmall = false;

    // ---- and the retry after the failure completes it ----
    check('reintentar completa lo que faltaba', await provision.run({ ...opts(D), gpu: false }));
    check('sin dejar el fragmento atrás',
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
    check('una conexión cortada falla', !!cut);
    check('pero deja exactamente lo que alcanzó a llegar', fs.statSync(`${R}.part`).size, 180);
    check('y guarda el validador para reanudar sin riesgo',
      fs.readFileSync(`${R}.part.etag`, 'utf8'), '"v1"');
    check('el archivo final no existe', fs.existsSync(R), false);

    cutAfter = 0;
    await provision.download(`${base}/ranged/big.bin`, R, null, { retries: 0 });
    check('el segundo intento lo completa', fs.readFileSync(R).equals(big));
    check('pidiendo sólo lo que faltaba, no todo de nuevo', servedBytes, big.length);
    check('y limpia el validador al terminar', fs.existsSync(`${R}.part.etag`), false);

    // ---- If-Range: un fragmento de otra versión no se pega al archivo nuevo ----
    const R2 = path.join(ROOT, 'changed.bin');
    servedBytes = 0;
    cutAfter = 200;
    try { await provision.download(`${base}/ranged/big.bin`, R2, null, { retries: 0 }); } catch { /* esperado */ }
    check('hay un fragmento de la versión vieja', fs.statSync(`${R2}.part`).size, 200);

    bigEtag = '"v2"';            // el archivo cambió en el servidor
    cutAfter = 0;
    await provision.download(`${base}/ranged/big.bin`, R2, null, { retries: 0 });
    check('el fragmento viejo se descarta en vez de empalmarse',
      fs.readFileSync(R2).equals(big));
    check('y para eso hubo que bajarlo entero', servedBytes, 200 + big.length);
    bigEtag = '"v1"';

    // ---- los reintentos son de la descarga, no del usuario ----
    servedBytes = 0;
    cutAfter = 120;
    const R3 = path.join(ROOT, 'retried.bin');
    const notes = [];
    // se corta tres veces seguidas: 120 bytes cada intento, y el cuarto cierra
    let left = 3;
    const stopCutting = setInterval(() => { if (--left <= 0) { cutAfter = 0; clearInterval(stopCutting); } }, 5);
    await provision.download(`${base}/ranged/big.bin`, R3, null,
      { retries: 5, backoff: [10], onRetry: n => notes.push(n) });
    clearInterval(stopCutting);
    check('reintenta solo y termina el archivo', fs.readFileSync(R3).equals(big));
    check('y avisa de cada reintento en vez de callarlo', notes.length > 0);

    // ---- cerrar la app a media descarga y reabrirla ----
    // El caso de verdad, extremo a extremo: no download() suelto, sino la
    // instalación entera cortada y retomada en una segunda corrida, que es lo
    // que pasa cuando alguien cierra Yapper con la barra a la mitad.
    const Q = path.join(ROOT, 'homeQ');
    const qOpts = { ...opts(Q), gpu: false, modelBase: `${base}/rmodels`, retries: 0 };
    servedBytes = 0;
    cutAfter = 120;                       // muere dentro del primer modelo
    let first = null;
    try { first = await provision.run(qOpts); } catch { first = 'threw'; }
    check('una instalación cortada no dice que terminó', first === true, false);
    const partQ = path.join(Q, 'models', 'ggml-base.bin.part');
    check('y deja el fragmento del modelo en curso', fs.existsSync(partQ));
    const heldQ = fs.statSync(partQ).size;

    cutAfter = 0;                         // la red vuelve
    check('reabrir la completa', await provision.run(qOpts));
    check('los dos modelos quedaron enteros', ['base', 'small'].every(m =>
      fs.readFileSync(path.join(Q, 'models', `ggml-${m}.bin`)).equals(big)));
    check('sin fragmentos abandonados',
      fs.readdirSync(path.join(Q, 'models')).filter(f => f.includes('.part')).length, 0);
    // Lo exacto, no una cota: 120 B antes del corte, 380 B al reanudar, 500 B
    // del segundo modelo. Que el total sea el tamaño de los dos archivos
    // significa que ningún byte viajó dos veces.
    check('y ningún byte viajó dos veces', servedBytes, big.length * 2);
    check('el fragmento retenido era el punto de corte', heldQ, 120);

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
