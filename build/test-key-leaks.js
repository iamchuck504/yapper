// Adversarial pass over the key path: can a stored key be made to go somewhere
// it was not issued for, or come back out to the renderer?
//
// The renderer is the untrusted half by design, so the checks below treat it as
// hostile even though it is our own code. Two of them started out as real
// leaks: `test-llm` merged a caller-supplied provider with the stored key, so
// naming a different provider sent one service's key to another; and provider
// rejection messages were shown verbatim, and some providers quote the
// Authorization header back at you.
const path = require('path');
const fs = require('fs');
const http = require('http');
const { app } = require('electron');
const { sandbox, mainWindow } = require('./harness');

const ROOT = sandbox('key-leaks');
const KEY = 'sk-secret-DO-NOT-LEAK-9999';

// a server standing in for "somewhere the key should never arrive"
const seen = [];
const trap = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    seen.push({ url: req.url, auth: req.headers.authorization || '', body });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
  });
});

require('../main.js');

app.whenReady().then(async () => {
  await new Promise(r => trap.listen(0, '127.0.0.1', r));
  const TRAP = `http://127.0.0.1:${trap.address().port}/v1`;
  console.log(`trap listening on ${TRAP}\n`);

  const win = await mainWindow({ settleMs: 1800 });
  const $ = js => win.webContents.executeJavaScript(js);

  // store a key for anthropic, the provider that talks to api.anthropic.com
  await $(`window.yapper.setLlmSettings({ provider: 'anthropic', apiKey: ${JSON.stringify(KEY)} })`);
  await new Promise(r => setTimeout(r, 400));

  const check = (name, ok, detail) => {
    if (ok) console.log(`ok    ${name}`);
    else { console.log(`FUGA  ${name}\n      ${detail}`); process.exitCode = 1; }
  };

  // --- 1. does anything hand the key back to the renderer? ---
  const s = await $('window.yapper.getLlmSettings()');
  check('getLlmSettings does not return the key', !JSON.stringify(s).includes(KEY), JSON.stringify(s));
  const env = await $('window.yapper.checkEnvironment()');
  check('checkEnvironment does not either', !JSON.stringify(env).includes(KEY), JSON.stringify(env));
  const styles = await $('window.yapper.styleSections()');
  check('styleSections does not either', !JSON.stringify(styles).includes(KEY), 'contains it');

  // --- 2. can the renderer point another provider at the stored key? ---
  // This is the shape of the bug just fixed for storage, on the test path.
  const r1 = await $(`window.yapper.testLlm({ provider: 'compatible',
    baseUrl: ${JSON.stringify(TRAP)}, model: 'm' })`);
  console.log(`      testLlm(compatible -> trampa) => ${JSON.stringify(r1)}`);
  check('the anthropic key does not travel to another provider',
    !seen.some(h => h.auth.includes(KEY) || h.body.includes(KEY)),
    JSON.stringify(seen.map(h => h.auth)));

  // --- 3. and can it be redirected while staying on the same provider? ---
  seen.length = 0;
  const r2 = await $(`window.yapper.testLlm({ provider: 'anthropic',
    baseUrl: ${JSON.stringify(TRAP)}, model: 'm' })`);
  console.log(`      testLlm(anthropic + baseUrl ajeno) => ${JSON.stringify(r2)}`);
  check('anthropic ignores an imposed endpoint',
    !seen.some(h => h.auth.includes(KEY) || h.body.includes(KEY)),
    `reached the trap: ${JSON.stringify(seen.map(h => h.auth))}`);

  // --- 4. does a provider error echo the key back into the UI? ---
  seen.length = 0;
  const echo = http.createServer((req, res) => {
    let b = '';
    req.on('data', c => { b += c; });
    req.on('end', () => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      // some providers really do quote the credential back at you
      res.end(JSON.stringify({ error: { message: `Invalid key: ${req.headers.authorization}` } }));
    });
  });
  await new Promise(r => echo.listen(0, '127.0.0.1', r));
  const ECHO = `http://127.0.0.1:${echo.address().port}/v1`;
  await $(`window.yapper.setLlmSettings({ provider: 'compatible',
    baseUrl: ${JSON.stringify(ECHO)}, apiKey: ${JSON.stringify(KEY)} })`);
  const r3 = await $(`window.yapper.testLlm({ provider: 'compatible' })`);
  console.log(`      error returned => ${JSON.stringify(r3)}`);
  check('a provider error does not reveal the key',
    !JSON.stringify(r3).includes(KEY), JSON.stringify(r3));

  // --- 5. is it on disk in the clear anywhere? ---
  const files = [];
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!/Cache|GPUCache|Code Cache/.test(e.name)) walk(p); }
      else if (/\.(json|txt|log|md)$/i.test(e.name)) files.push(p);
    }
  };
  walk(ROOT);
  const exposed = files.filter(f => {
    try { return fs.readFileSync(f, 'utf8').includes(KEY); } catch { return false; }
  });
  check(`the key is not in cleartext in any of the ${files.length} text files`,
    exposed.length === 0, exposed.join(', '));

  trap.close(); echo.close();
  console.log(process.exitCode ? '\nHAY FUGAS' : '\nPASS');
  app.exit(process.exitCode || 0);
}).catch(e => { console.log('FAIL', e.message); app.exit(1); });
