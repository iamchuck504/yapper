// The provider layer decides where a meeting's notes come from, so its routing
// and its error messages are tested against a fake server rather than against
// someone's billing account.
const http = require('http');
const llm = require('../llm');

let fails = 0;
function check(name, ok, detail) {
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      ${detail}`); }
}

// A stand-in for any OpenAI-compatible endpoint, recording what it was sent.
function fakeServer(handler) {
  return new Promise(resolve => {
    const seen = [];
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        seen.push({ url: req.url, headers: req.headers, body: JSON.parse(body || '{}') });
        handler(req, res, seen[seen.length - 1]);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${srv.address().port}/v1`,
      seen,
      close: () => new Promise(r => srv.close(r))
    }));
  });
}

const ok = (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: 'the notes' } }] }));
};

(async () => {
  // --- the providers a user can pick ---
  const ids = llm.providerList().map(p => p.id);
  check('there is a provider with no key (the subscription)',
    llm.providerList().some(p => !p.needsKey), `proveedores: ${ids.join(', ')}`);
  check('there is a generic seam for a future official API',
    ids.includes('compatible'), `proveedores: ${ids.join(', ')}`);

  // --- routing and payload ---
  let srv = await fakeServer(ok);
  const out = await llm.generate(
    { provider: 'compatible', apiKey: 'k-123', baseUrl: srv.url, model: 'some-model' },
    { system: 'INSTRUCTIONS', input: 'TRANSCRIPT', maxTokens: 1234 });
  const req = srv.seen[0];
  check('returns the model text', out === 'the notes', `returned "${out}"`);
  check('posts to /chat/completions', req.url === '/v1/chat/completions', req.url);
  check('sends the key as Bearer', req.headers.authorization === 'Bearer k-123', req.headers.authorization);
  check('the prompt goes as system and the transcript as user',
    req.body.messages[0].role === 'system' && req.body.messages[0].content === 'INSTRUCTIONS'
    && req.body.messages[1].content === 'TRANSCRIPT',
    JSON.stringify(req.body.messages));
  check('respects the chosen model', req.body.model === 'some-model', req.body.model);
  await srv.close();

  // an unset model falls back to the provider's own default
  srv = await fakeServer(ok);
  await llm.generate({ provider: 'openrouter', apiKey: 'k', baseUrl: srv.url, model: '' },
    { system: 's', input: 'i' });
  check('with no model it uses the provider default',
    !!srv.seen[0].body.model, `sent "${srv.seen[0].body.model}"`);
  await srv.close();

  // a trailing slash in the endpoint must not produce //chat/completions
  srv = await fakeServer(ok);
  await llm.generate({ provider: 'compatible', apiKey: 'k', baseUrl: srv.url + '/', model: 'm' },
    { system: 's', input: 'i' });
  check('tolerates a trailing slash on the endpoint',
    srv.seen[0].url === '/v1/chat/completions', srv.seen[0].url);
  await srv.close();

  // --- errors the user will actually hit ---
  const expectError = async (label, cfg, want) => {
    try {
      await llm.generate(cfg, { system: 's', input: 'i' });
      check(label, false, 'threw no error');
    } catch (e) {
      check(label, e.message.includes(want), `dijo "${e.message}"`);
    }
  };

  await expectError('with no key it says so plainly',
    { provider: 'anthropic', apiKey: '' }, 'needs an API key');
  await expectError('with no endpoint it says so plainly',
    { provider: 'compatible', apiKey: 'k', baseUrl: '' }, 'needs an endpoint');
  await expectError('proveedor desconocido no revienta feo',
    { provider: 'nope' }, 'No note provider');

  srv = await fakeServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid key' } }));
  });
  await expectError('401 is explained as a rejected key',
    { provider: 'compatible', apiKey: 'bad', baseUrl: srv.url, model: 'm' }, 'key was rejected');
  await srv.close();

  srv = await fakeServer((req, res) => {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'slow down' } }));
  });
  await expectError('429 is explained as a rate limit or credit issue',
    { provider: 'compatible', apiKey: 'k', baseUrl: srv.url, model: 'm' }, 'Rate limited');
  await srv.close();

  // Gemini's OpenAI-compatible endpoint wraps its errors in an array and returns
  // 400 for a bad key. Before this was handled the user saw the raw JSON.
  srv = await fakeServer((req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([{ error: { code: 400, message: 'Please pass a valid API key', status: 'INVALID_ARGUMENT' } }]));
  });
  await expectError('an error wrapped in an array still reads',
    { provider: 'gemini', apiKey: 'bad', baseUrl: srv.url, model: 'm' }, 'Please pass a valid API key');
  await expectError('and a 400 caused by the key is explained as a rejected key',
    { provider: 'gemini', apiKey: 'bad', baseUrl: srv.url, model: 'm' }, 'key was rejected');
  await srv.close();

  srv = await fakeServer((req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([{ error: { message: 'Please pass a valid API key' } }]));
  });
  try {
    await llm.generate({ provider: 'gemini', apiKey: 'bad', baseUrl: srv.url, model: 'm' },
      { system: 's', input: 'i' });
    check('the error does not show raw JSON', false, 'did not throw');
  } catch (e) {
    check('the error does not show raw JSON',
      !e.message.includes('{') && !e.message.includes('"'), `dijo "${e.message}"`);
  }
  await srv.close();

  srv = await fakeServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('upstream exploded');
  });
  await expectError('a non-JSON body does not blow up',
    { provider: 'compatible', apiKey: 'k', baseUrl: srv.url, model: 'm' }, 'upstream exploded');
  await srv.close();

  srv = await fakeServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '   ' } }] }));
  });
  await expectError('an empty response is not saved as notes',
    { provider: 'compatible', apiKey: 'k', baseUrl: srv.url, model: 'm' }, 'empty response');
  await srv.close();

  await expectError('an invalid URL is explained',
    { provider: 'compatible', apiKey: 'k', baseUrl: 'not a url', model: 'm' }, 'not a valid URL');

  console.log(fails ? `\n${fails} failures` : '\nPASS');
  process.exit(fails ? 1 : 0);
})();
