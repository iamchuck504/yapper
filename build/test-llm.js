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

  // Streaming is the difference between a blank wait and notes appearing as
  // they are written. Two SSE events may arrive in one TCP chunk, so this also
  // proves the parser follows event boundaries rather than socket boundaries.
  srv = await fakeServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"the "}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"notes"}}]}\n\n');
    res.end('data: [DONE]\n\n');
  });
  const partial = [];
  const streamed = await llm.generate(
    { provider: 'compatible', apiKey: 'k', baseUrl: srv.url, model: 'm' },
    { system: 's', input: 'i', onDelta: (_chunk, text) => partial.push(text) });
  check('asks compatible providers to stream when progress is wanted',
    srv.seen[0].body.stream === true, JSON.stringify(srv.seen[0].body));
  check('assembles a streamed answer exactly', streamed === 'the notes', streamed);
  check('publishes progressive text before completion',
    partial.length === 2 && partial[0] === 'the ' && partial[1] === 'the notes', JSON.stringify(partial));
  await srv.close();

  // Some custom gateways accept `stream: true` but still send normal JSON.
  // That is slower to first text, but it must remain compatible.
  srv = await fakeServer(ok);
  const fallbackParts = [];
  const fallback = await llm.generate(
    { provider: 'compatible', apiKey: 'k', baseUrl: srv.url, model: 'm' },
    { system: 's', input: 'i', onDelta: (_chunk, text) => fallbackParts.push(text) });
  check('falls back when a gateway ignores streaming',
    fallback === 'the notes' && fallbackParts.join('') === 'the notes', JSON.stringify(fallbackParts));
  await srv.close();

  // Cancel must close the request itself, not merely stop painting its output:
  // otherwise a local model keeps the GPU busy and a hosted model may finish a
  // request the user explicitly stopped.
  srv = await fakeServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"partial notes"}}]}\n\n');
    const late = setTimeout(() => res.end('data: [DONE]\n\n'), 5000);
    res.on('close', () => clearTimeout(late));
  });
  const controller = new AbortController();
  const cancelStarted = Date.now();
  let cancelMessage = '';
  try {
    await llm.generate(
      { provider: 'compatible', apiKey: 'k', baseUrl: srv.url, model: 'm' },
      { system: 's', input: 'i', signal: controller.signal,
        onDelta: () => controller.abort() });
  } catch (err) {
    cancelMessage = err.message;
  }
  check('canceling stops a streamed provider request',
    /generation canceled/i.test(cancelMessage), cancelMessage);
  check('canceling returns immediately instead of waiting for the provider',
    Date.now() - cancelStarted < 1000, `${Date.now() - cancelStarted} ms`);
  await srv.close();

  const alreadyCanceled = new AbortController();
  alreadyCanceled.abort();
  try {
    await llm.generate(
      { provider: 'compatible', apiKey: 'k', baseUrl: srv.url, model: 'm' },
      { system: 's', input: 'i', signal: alreadyCanceled.signal });
    check('an already canceled job never starts', false, 'did not throw');
  } catch (err) {
    check('an already canceled job never starts',
      /generation canceled/i.test(err.message), err.message);
  }

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
  await expectError('a remote HTTP endpoint is refused before sending a key',
    { provider: 'compatible', apiKey: 'secret', baseUrl: 'http://example.com/v1', model: 'm' },
    'must use HTTPS');

  srv = await fakeServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'x'.repeat(2.1 * 1024 * 1024) } }] }));
  });
  await expectError('an unexpectedly large provider response is stopped',
    { provider: 'compatible', apiKey: 'k', baseUrl: srv.url, model: 'm' }, 'large response');
  await srv.close();

  console.log(fails ? `\n${fails} failures` : '\nPASS');
  process.exit(fails ? 1 : 0);
})();
