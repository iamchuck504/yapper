// Where the notes get written.
//
// Yapper transcribes locally, but turning a transcript into notes needs a
// model, and different people have different ways to pay for one: Chuck has a
// Claude Max subscription and the CLI installed, a coworker may only have an
// API key, and if this ever becomes a real product it will point at one
// official endpoint for everybody. So the caller asks for text and this module
// decides who produces it.
//
// Adding that official endpoint later means adding an entry here, not touching
// any of the three places that generate notes.

const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TIMEOUT_MS = 180000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

// ---------------------------------------------------------------- providers

// A note on "free": there is no way to give someone working AI summaries with
// no setup at all. Every hosted API needs a credential, and that credential is
// either shipped inside the app (abused within days, and against every
// provider's terms), brokered by a server someone pays for, or the user's own.
// So the honest best is a free tier that takes about a minute to sign up for
// and costs nothing after that — which is what `gemini` is here for.
const PROVIDERS = {
  'claude-cli': {
    label: 'Claude Code',
    hint: 'Uses the Claude Code CLI you are already signed into. No API key, no per-meeting cost.',
    needsKey: false,
    run: runClaudeCli
  },
  gemini: {
    label: 'Google Gemini (free)',
    hint: 'Free, no credit card. Takes about a minute to get a key, then a few hundred meetings a day.',
    free: true,
    // Free tiers are free because the data is worth something: Google may
    // train on what is sent here. Meeting transcripts are not always yours to
    // share, so the UI says this out loud.
    privacy: 'Google may use free-tier requests to improve its models. Not for confidential meetings.',
    needsKey: true,
    keyHint: 'AIza...',
    keyUrl: 'https://aistudio.google.com/apikey',
    defaultModel: 'gemini-3.5-flash-lite',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    run: runOpenAiCompatible
  },
  openrouter: {
    label: 'OpenRouter',
    hint: 'One key, many models — including free ones (their ids end in “:free”).',
    free: true,
    privacy: 'Free models route to providers that may log or train on requests.',
    needsKey: true,
    keyHint: 'sk-or-...',
    keyUrl: 'https://openrouter.ai/keys',
    defaultModel: 'google/gemma-4-31b-it:free',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    run: runOpenAiCompatible
  },
  ollama: {
    label: 'Ollama (on this computer)',
    hint: 'Free and completely private: nothing leaves your machine. Needs Ollama installed and a model pulled.',
    needsKey: false,
    defaultModel: 'llama3.1',
    defaultBaseUrl: 'http://localhost:11434/v1',
    run: runOpenAiCompatible
  },
  anthropic: {
    label: 'Anthropic API',
    hint: 'Your own key from console.anthropic.com. Billed per meeting.',
    needsKey: true,
    keyHint: 'sk-ant-...',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    defaultModel: 'claude-sonnet-5',
    run: runAnthropic
  },
  // The seam for whatever comes next: a company gateway, a self-hosted model,
  // an official Yapper endpoint. Anything that speaks /chat/completions works
  // without new code.
  compatible: {
    label: 'Other (OpenAI-compatible)',
    hint: 'Any endpoint that speaks /chat/completions — a company gateway, a local server, OpenAI itself.',
    needsKey: true,
    needsBaseUrl: true,
    keyHint: 'your key',
    defaultModel: '',
    defaultBaseUrl: '',
    run: runOpenAiCompatible
  }
};

function providerList() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    label: p.label,
    hint: p.hint,
    free: !!p.free,
    privacy: p.privacy || '',
    needsKey: !!p.needsKey,
    needsBaseUrl: !!p.needsBaseUrl,
    keyHint: p.keyHint || '',
    keyUrl: p.keyUrl || '',
    defaultModel: p.defaultModel || '',
    defaultBaseUrl: p.defaultBaseUrl || ''
  }));
}

/**
 * Produce text. `config` is { provider, apiKey, model, baseUrl, claudePath }.
 * Throws with a message meant to be shown to the user.
 */
async function generate(config, { system, input, maxTokens = 8000, onDelta = null, signal = null }) {
  const p = PROVIDERS[config && config.provider];
  if (!p) throw new Error('No note provider is configured. Open Settings and pick one.');
  if (p.needsKey && !(config.apiKey || '').trim()) {
    throw new Error(`${p.label} needs an API key. Add it in Settings.`);
  }
  if (p.needsBaseUrl && !(config.baseUrl || '').trim()) {
    throw new Error(`${p.label} needs an endpoint URL. Add it in Settings.`);
  }
  let out;
  try {
    if (signal && signal.aborted) throw new Error('Note generation canceled.');
    out = await p.run(config, { system, input, maxTokens, onDelta, signal });
  } catch (err) {
    // Providers quote the Authorization header back in rejection messages, and
    // that message is shown in the UI and could end up in a screenshot or a
    // shared screen. The credential does not belong in it.
    throw new Error(redact(err.message, config.apiKey));
  }
  const text = String(out || '').trim();
  if (!text) throw new Error(`${p.label} returned an empty response.`);
  return text;
}

/** Take a secret out of text meant for a human. */
function redact(text, secret) {
  const s = String(secret || '').trim();
  if (!s || s.length < 8) return text;
  return String(text).split(s).join('[key hidden]');
}

/**
 * A cheap round trip, so Settings can say "working" instead of "saved". When
 * the model name is the problem — which is what happens when a provider
 * retires an id that shipped as a default — it asks the provider what it does
 * have rather than leaving the user guessing.
 */
async function test(config) {
  const t = Date.now();
  try {
    const out = await generate(config, {
      system: 'Reply with exactly the word: ok',
      input: 'ping',
      maxTokens: 16
    });
    return { ok: true, ms: Date.now() - t, reply: out.slice(0, 40) };
  } catch (err) {
    if (!/does not exist|not found|no such model|unknown model/i.test(err.message)) throw err;
    const models = await listModels(config).catch(() => []);
    if (!models.length) throw err;
    const err2 = new Error(`${err.message}\nAvailable here: ${models.slice(0, 6).join(', ')}`);
    err2.models = models;
    throw err2;
  }
}

/** What this endpoint actually offers, for OpenAI-compatible providers. */
async function listModels(config) {
  const p = PROVIDERS[config.provider];
  if (!p || p.run !== runOpenAiCompatible) return [];
  const key = (config.apiKey || '').trim();
  const res = await getJson(`${baseUrlFor(config)}/models`,
    key ? { Authorization: `Bearer ${key}` } : {});
  return (res.data || [])
    .map(m => m.id)
    .filter(Boolean)
    // free-tier ids first: those are the ones a new user can actually run
    .sort((a, b) => (b.endsWith(':free') ? 1 : 0) - (a.endsWith(':free') ? 1 : 0));
}

// ---------------------------------------------------------------- claude cli

/**
 * Somewhere harmless for the CLI to work in.
 *
 * This is not housekeeping. A GUI app launched from the Dock inherits `/` as
 * its working directory, a child process inherits that in turn, and the CLI
 * reads its working directory for context when it starts. Pointed at the root
 * of the disk it walks into everything macOS protects — and because it is
 * Yapper's child, macOS attributes every one of those requests to Yapper. The
 * symptom was a queue of permission dialogs at the end of a recording, asking
 * for folders, then Photos, then Apple Music, from an app that wanted none of
 * them and touches none of them.
 *
 * An empty directory of our own gives it nothing to find.
 */
function cliWorkDir() {
  const dir = path.join(os.tmpdir(), 'yapper-cli');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* fall back below */ }
  return fs.existsSync(dir) ? dir : os.tmpdir();
}

function runClaudeCli(config, { system, input, onDelta, signal }) {
  return new Promise((resolve, reject) => {
    const bin = config.claudePath || 'claude';
    const proc = spawn(bin, ['-p', system, '--output-format', 'text'],
      { env: { ...process.env }, cwd: cliWorkDir() });

    // The HTTP providers have had a deadline all along; this one did not, and
    // it is the same class of failure one step later. A CLI that never returns
    // — waiting on a login it cannot show, a network that went away — left the
    // notes step hanging with nothing on screen to act on. Same budget as the
    // others, and the process is killed rather than left behind.
    let settled = false;
    let onAbort = null;
    const finish = fn => (...args) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      fn(...args);
    };
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* already gone */ }
      finish(reject)(new Error(
        `Claude Code did not answer within ${Math.round(TIMEOUT_MS / 1000)}s. `
        + 'It may be waiting to be signed in — run `claude` once in a terminal.'));
    }, TIMEOUT_MS);
    onAbort = () => {
      try { proc.kill(); } catch { /* already gone */ }
      finish(reject)(new Error('Note generation canceled.'));
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }

    let out = '', errOut = '';
    proc.stdout.on('data', d => {
      const chunk = d.toString('utf8');
      out += chunk;
      if (onDelta) {
        try { onDelta(chunk, out); } catch { /* progress must never break the answer */ }
      }
    });
    proc.stderr.on('data', d => { errOut += d.toString('utf8'); });
    proc.on('error', () => finish(reject)(new Error(
      'Claude Code was not found. Install it from claude.com/code and sign in, or switch to an API key in Settings.')));
    proc.on('close', code => {
      if (code !== 0) {
        return finish(reject)(new Error(`Claude Code failed (exit ${code}): ${errOut.slice(-400)}`));
      }
      finish(resolve)(out);
    });
    proc.stdin.write(input, 'utf8');
    proc.stdin.end();
  });
}

// ---------------------------------------------------------------- http

function getJson(url, headers) {
  return request('GET', url, headers, null, null);
}

function postJson(url, headers, body, signal = null) {
  return request('POST', url, headers, body, signal);
}

function endpointTarget(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`That endpoint is not a valid URL: ${url}`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error('The endpoint must use HTTPS, or HTTP on this computer.');
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
    || u.hostname === '[::1]' || u.hostname === '::1';
  if (u.protocol === 'http:' && !local) {
    throw new Error('Remote model endpoints must use HTTPS so transcripts and API keys are encrypted.');
  }
  if (u.username || u.password) {
    throw new Error('Put credentials in the API key field, not in the endpoint URL.');
  }
  return { u, mod: u.protocol === 'http:' ? http : https };
}

function request(method, url, headers, body, signal = null) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = endpointTarget(url); } catch (err) { return reject(err); }
    const { u, mod } = target;
    const payload = body === null ? null : Buffer.from(JSON.stringify(body), 'utf8');

    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      method,
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': payload.length, ...headers }
        : { ...headers }
    }, res => {
      let raw = '';
      let bytes = 0;
      let overflow = false;
      res.setEncoding('utf8');
      res.on('data', c => {
        if (overflow) return;
        bytes += Buffer.byteLength(c, 'utf8');
        if (bytes > MAX_RESPONSE_BYTES) {
          overflow = true;
          res.destroy();
          reject(new Error('The model endpoint returned an unexpectedly large response.'));
          return;
        }
        raw += c;
      });
      res.on('end', () => {
        if (overflow) return;
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch { /* not JSON; the text is the error */ }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const msg = errorText(parsed, raw, res.statusCode);
          return reject(new Error(httpHint(res.statusCode, msg) + msg));
        }
        if (!parsed) return reject(new Error(`Unexpected reply: ${raw.slice(0, 200)}`));
        resolve(parsed);
      });
      res.on('error', err => { if (!overflow) reject(new Error(err.message)); });
    });

    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy(new Error('The request timed out. The transcript may be very long, or the network is down.'));
    });
    const onAbort = () => req.destroy(new Error('Note generation canceled.'));
    const detach = () => { if (signal) signal.removeEventListener('abort', onAbort); };
    req.on('close', detach);
    req.on('error', err => { detach(); reject(new Error(err.message)); });
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    if (!signal || !signal.aborted) req.end(payload || undefined);
  });
}

/**
 * Read Server-Sent Events without waiting for the entire model response. If a
 * compatible endpoint ignores `stream: true` and returns ordinary JSON, that
 * JSON is returned so the provider can fall back without losing the answer.
 */
function postEventStream(url, headers, body, onEvent, signal = null) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = endpointTarget(url); } catch (err) { return reject(err); }
    const { u, mod } = target;
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'Content-Length': payload.length,
        ...headers
      }
    }, res => {
      const isStream = /text\/event-stream/i.test(String(res.headers['content-type'] || ''));
      let raw = '';
      let bytes = 0;
      let overflow = false;
      res.setEncoding('utf8');

      const consume = block => {
        const data = block.split(/\r?\n/)
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart()).join('\n').trim();
        if (!data || data === '[DONE]') return;
        try { onEvent(JSON.parse(data)); } catch { /* comments and provider keep-alives */ }
      };

      res.on('data', chunk => {
        if (overflow) return;
        bytes += Buffer.byteLength(chunk, 'utf8');
        if (bytes > MAX_RESPONSE_BYTES) {
          overflow = true;
          res.destroy();
          reject(new Error('The model endpoint returned an unexpectedly large response.'));
          return;
        }
        raw += chunk;
        if (!isStream || res.statusCode < 200 || res.statusCode >= 300) return;
        let boundary;
        while ((boundary = raw.match(/\r?\n\r?\n/))) {
          const block = raw.slice(0, boundary.index);
          raw = raw.slice(boundary.index + boundary[0].length);
          consume(block);
        }
      });

      res.on('end', () => {
        if (overflow) return;
        let parsed = null;
        if (raw.trim()) {
          if (isStream && res.statusCode >= 200 && res.statusCode < 300) consume(raw);
          else { try { parsed = JSON.parse(raw); } catch { /* error text below */ } }
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const msg = errorText(parsed, raw, res.statusCode);
          return reject(new Error(httpHint(res.statusCode, msg) + msg));
        }
        if (!isStream && !parsed) {
          return reject(new Error(`Unexpected reply: ${raw.slice(0, 200)}`));
        }
        resolve(isStream ? null : parsed);
      });
      res.on('error', err => { if (!overflow) reject(new Error(err.message)); });
    });

    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy(new Error('The request timed out. The transcript may be very long, or the network is down.'));
    });
    const onAbort = () => req.destroy(new Error('Note generation canceled.'));
    const detach = () => { if (signal) signal.removeEventListener('abort', onAbort); };
    req.on('close', detach);
    req.on('error', err => { detach(); reject(new Error(err.message)); });
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    if (!signal || !signal.aborted) req.end(payload);
  });
}

/**
 * The sentence inside an error body, whatever shape the provider chose. They do
 * not agree: OpenAI-style nests it under `error`, Gemini's compatibility
 * endpoint wraps the whole thing in an array, and some just return a string. A
 * miss here means the user is shown raw JSON, which is what a rejected key used
 * to look like on the provider this app recommends first.
 */
function errorText(parsed, raw, status) {
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (typeof first === 'string' && first.trim()) return first.trim();
  const e = (first && first.error) || first;
  const msg = e && (e.message || e.detail || e.type || (typeof e === 'string' ? e : ''));
  return (msg && String(msg).trim()) || raw.slice(0, 300).trim() || `HTTP ${status}`;
}

/** Turn the usual failures into something worth reading. */
function httpHint(status, msg = '') {
  // a bad key is a 400 on some providers and a 401 on others, so the message
  // gets a say as well as the code
  if (/api[\s_-]?key|credential|unauthenticated|unauthorized|permission denied/i.test(msg)) {
    return 'The API key was rejected: ';
  }
  if (status === 401 || status === 403) return 'The API key was rejected: ';
  if (status === 404) return 'That endpoint or model does not exist: ';
  if (status === 429) return 'Rate limited or out of credit: ';
  if (status >= 500) return 'The provider is having trouble: ';
  return '';
}

// ---------------------------------------------------------------- anthropic

async function runAnthropic(config, { system, input, maxTokens, onDelta, signal }) {
  const headers = {
    'x-api-key': config.apiKey.trim(),
    'anthropic-version': '2023-06-01'
  };
  const body = {
    model: config.model || PROVIDERS.anthropic.defaultModel,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: input }]
  };
  if (onDelta) {
    let out = '';
    const fallback = await postEventStream('https://api.anthropic.com/v1/messages', headers,
      { ...body, stream: true }, event => {
        const text = event && event.type === 'content_block_delta'
          && event.delta && event.delta.type === 'text_delta' ? event.delta.text : '';
        if (!text) return;
        out += text;
        try { onDelta(text, out); } catch { /* display-only callback */ }
      }, signal);
    if (!fallback) return out;
    const text = (fallback.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    if (text) { try { onDelta(text, text); } catch { /* display-only callback */ } }
    return text;
  }
  const res = await postJson('https://api.anthropic.com/v1/messages', headers, body, signal);
  return (res.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
}

// ------------------------------------------------- openai-compatible / router

function baseUrlFor(config) {
  const p = PROVIDERS[config.provider] || {};
  return (config.baseUrl || p.defaultBaseUrl || '').trim().replace(/\/+$/, '');
}

async function runOpenAiCompatible(config, { system, input, maxTokens, onDelta, signal }) {
  const base = baseUrlFor(config);
  const key = (config.apiKey || '').trim();
  const headers = {
    // a model running on this machine has nothing to authenticate
    ...(key ? { Authorization: `Bearer ${key}` } : {})
  };
  const body = {
    model: config.model || PROVIDERS[config.provider].defaultModel,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: input }
    ]
  };
  if (onDelta) {
    let out = '';
    const fallback = await postEventStream(`${base}/chat/completions`, headers,
      { ...body, stream: true }, event => {
        const content = event && event.choices && event.choices[0]
          && event.choices[0].delta && event.choices[0].delta.content;
        const text = Array.isArray(content)
          ? content.map(part => part && (part.text || part.content) || '').join('')
          : String(content || '');
        if (!text) return;
        out += text;
        try { onDelta(text, out); } catch { /* display-only callback */ }
      }, signal);
    if (!fallback) return out;
    const choice = (fallback.choices || [])[0];
    const text = (choice && choice.message && choice.message.content) || '';
    if (text) { try { onDelta(text, text); } catch { /* display-only callback */ } }
    return text;
  }
  const res = await postJson(`${base}/chat/completions`, headers, body, signal);
  const choice = (res.choices || [])[0];
  return (choice && choice.message && choice.message.content) || '';
}

module.exports = { PROVIDERS, providerList, generate, test, listModels };
