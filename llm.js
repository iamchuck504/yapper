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

const TIMEOUT_MS = 180000;

// ---------------------------------------------------------------- providers

const PROVIDERS = {
  'claude-cli': {
    label: 'Claude Code',
    hint: 'Uses the Claude Code CLI you are already signed into. No API key, no per-meeting cost.',
    needsKey: false,
    run: runClaudeCli
  },
  anthropic: {
    label: 'Anthropic API',
    hint: 'Your own key from console.anthropic.com. Billed per meeting.',
    needsKey: true,
    keyHint: 'sk-ant-...',
    defaultModel: 'claude-sonnet-5',
    run: runAnthropic
  },
  openrouter: {
    label: 'OpenRouter',
    hint: 'Your own OpenRouter key. Same shape as any OpenAI-compatible endpoint.',
    needsKey: true,
    keyHint: 'sk-or-...',
    defaultModel: 'anthropic/claude-sonnet-4.5',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    run: runOpenAiCompatible
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
    needsKey: !!p.needsKey,
    needsBaseUrl: !!p.needsBaseUrl,
    keyHint: p.keyHint || '',
    defaultModel: p.defaultModel || '',
    defaultBaseUrl: p.defaultBaseUrl || ''
  }));
}

/**
 * Produce text. `config` is { provider, apiKey, model, baseUrl, claudePath }.
 * Throws with a message meant to be shown to the user.
 */
async function generate(config, { system, input, maxTokens = 8000 }) {
  const p = PROVIDERS[config && config.provider];
  if (!p) throw new Error('No note provider is configured. Open Settings and pick one.');
  if (p.needsKey && !(config.apiKey || '').trim()) {
    throw new Error(`${p.label} needs an API key. Add it in Settings.`);
  }
  if (p.needsBaseUrl && !(config.baseUrl || '').trim()) {
    throw new Error(`${p.label} needs an endpoint URL. Add it in Settings.`);
  }
  const out = await p.run(config, { system, input, maxTokens });
  const text = String(out || '').trim();
  if (!text) throw new Error(`${p.label} returned an empty response.`);
  return text;
}

/** A cheap round trip, so Settings can say "working" instead of "saved". */
async function test(config) {
  const t = Date.now();
  const out = await generate(config, {
    system: 'Reply with exactly the word: ok',
    input: 'ping',
    maxTokens: 16
  });
  return { ok: true, ms: Date.now() - t, reply: out.slice(0, 40) };
}

// ---------------------------------------------------------------- claude cli

function runClaudeCli(config, { system, input }) {
  return new Promise((resolve, reject) => {
    const bin = config.claudePath || 'claude';
    const proc = spawn(bin, ['-p', system, '--output-format', 'text'], { env: { ...process.env } });
    let out = '', errOut = '';
    proc.stdout.on('data', d => { out += d.toString('utf8'); });
    proc.stderr.on('data', d => { errOut += d.toString('utf8'); });
    proc.on('error', () => reject(new Error(
      'Claude Code was not found. Install it from claude.com/code and sign in, or switch to an API key in Settings.')));
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`Claude Code failed (exit ${code}): ${errOut.slice(-400)}`));
      resolve(out);
    });
    proc.stdin.write(input, 'utf8');
    proc.stdin.end();
  });
}

// ---------------------------------------------------------------- http

function postJson(url, headers, body) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error(`That endpoint is not a valid URL: ${url}`)); }
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const mod = u.protocol === 'http:' ? http : https;

    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, ...headers }
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch { /* not JSON; the text is the error */ }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const msg = (parsed && parsed.error && (parsed.error.message || parsed.error.type))
            || (parsed && parsed.message)
            || raw.slice(0, 300)
            || `HTTP ${res.statusCode}`;
          return reject(new Error(httpHint(res.statusCode) + msg));
        }
        if (!parsed) return reject(new Error(`Unexpected reply: ${raw.slice(0, 200)}`));
        resolve(parsed);
      });
    });

    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy(new Error('The request timed out. The transcript may be very long, or the network is down.'));
    });
    req.on('error', err => reject(new Error(err.message)));
    req.end(payload);
  });
}

/** Turn the usual status codes into something worth reading. */
function httpHint(status) {
  if (status === 401 || status === 403) return 'The API key was rejected: ';
  if (status === 404) return 'That endpoint or model does not exist: ';
  if (status === 429) return 'Rate limited or out of credit: ';
  if (status >= 500) return 'The provider is having trouble: ';
  return '';
}

// ---------------------------------------------------------------- anthropic

async function runAnthropic(config, { system, input, maxTokens }) {
  const res = await postJson('https://api.anthropic.com/v1/messages', {
    'x-api-key': config.apiKey.trim(),
    'anthropic-version': '2023-06-01'
  }, {
    model: config.model || PROVIDERS.anthropic.defaultModel,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: input }]
  });
  return (res.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
}

// ------------------------------------------------- openai-compatible / router

async function runOpenAiCompatible(config, { system, input, maxTokens }) {
  const base = (config.baseUrl || PROVIDERS[config.provider].defaultBaseUrl || '').trim().replace(/\/+$/, '');
  const res = await postJson(`${base}/chat/completions`, {
    Authorization: `Bearer ${config.apiKey.trim()}`
  }, {
    model: config.model || PROVIDERS[config.provider].defaultModel,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: input }
    ]
  });
  const choice = (res.choices || [])[0];
  return (choice && choice.message && choice.message.content) || '';
}

module.exports = { PROVIDERS, providerList, generate, test };
