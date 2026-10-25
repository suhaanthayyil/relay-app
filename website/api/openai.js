// OpenAI passthrough for the Relay desktop and mobile apps.
// Reached through the rewrite /api/openai/v1/:path* -> /api/openai?path=:path*
// so clients can point the OpenAI SDK's baseURL at /api/openai/v1.

import { checkClient, json } from './_lib/guard.js';

const OPENAI_BASE = 'https://api.openai.com/v1';
const MAX_OUTPUT_TOKENS = 1200;
const DEFAULT_OUTPUT_TOKENS = 600;
const MAX_TTS_CHARS = 4096;

// GPT-6 Luna: OpenAI's newest small model. It reads images and costs less
// than the models it replaces ($0.10 in / $0.50 out per 1M tokens).
const CHAT_MODEL = 'gpt-6-luna';

const MODELS_BY_ROUTE = {
  'chat/completions': new Set([CHAT_MODEL, 'gpt-5.6-luna', 'gpt-4o-mini']),
  'audio/speech': new Set(['gpt-4o-mini-tts']),
  'audio/transcriptions': new Set(['gpt-transcribe'])
};

// Installed apps keep sending the model names they shipped with. Map models
// OpenAI has retired (or scheduled to retire) to their supported replacements.
const LEGACY_MODELS = {
  'gpt-4o-mini': CHAT_MODEL, // shuts down 2027-01-14
  'gpt-5.6-luna': CHAT_MODEL, // replaced by GPT-6 Luna
  'gpt-4.1-nano': CHAT_MODEL, // shut down 2026-10-23
  'tts-1': 'gpt-4o-mini-tts', // shut down 2027-01-06
  'gpt-4o-mini-transcribe': 'gpt-transcribe' // shut down 2027-02-26
};

const resolveModel = (model) => LEGACY_MODELS[model] || model;

// GPT-5 and newer take max_completion_tokens and reasoning settings.
const isReasoningFamily = (model) => Number((/^gpt-(\d+)/.exec(String(model)) || [])[1]) >= 5;

function upstreamHeaders(contentType) {
  const headers = { authorization: `Bearer ${process.env.OPENAI_API_KEY}` };
  if (contentType) headers['content-type'] = contentType;
  return headers;
}

function relay(upstream) {
  const headers = new Headers({ 'cache-control': 'no-store' });
  const type = upstream.headers.get('content-type');
  if (type) headers.set('content-type', type);
  return new Response(upstream.body, { status: upstream.status, headers });
}

function routeOf(request) {
  const url = new URL(request.url);
  return (url.searchParams.get('path') || '').replace(/^\/+|\/+$/g, '');
}

function clampTokens(body) {
  for (const key of ['max_tokens', 'max_completion_tokens']) {
    if (body[key] != null) body[key] = Math.min(Math.max(1, Number(body[key]) || 1), MAX_OUTPUT_TOKENS);
  }
  if (body.max_tokens == null && body.max_completion_tokens == null) {
    body.max_tokens = DEFAULT_OUTPUT_TOKENS;
  }
  // GPT-5 and newer: max_tokens is rejected, and reasoning would eat the output budget.
  if (isReasoningFamily(body.model)) {
    if (body.max_completion_tokens == null) body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
    if (body.reasoning_effort == null) body.reasoning_effort = 'none';
  }
}

export async function GET(request) {
  if (!process.env.OPENAI_API_KEY) return json(503, { error: { message: 'AI service not configured' } });
  const denied = checkClient(request, 'openai', 60);
  if (denied) return denied;

  const route = routeOf(request);
  if (route !== 'models' && !/^models\/[\w.-]+$/.test(route)) {
    return json(404, { error: { message: 'Route not available' } });
  }
  const upstream = await fetch(`${OPENAI_BASE}/${route}`, { headers: upstreamHeaders() });
  return relay(upstream);
}

export async function POST(request) {
  if (!process.env.OPENAI_API_KEY) return json(503, { error: { message: 'AI service not configured' } });
  const denied = checkClient(request, 'openai', 60);
  if (denied) return denied;

  const route = routeOf(request);
  const allowedModels = MODELS_BY_ROUTE[route];
  if (!allowedModels) return json(404, { error: { message: 'Route not available' } });

  if (route === 'audio/transcriptions') {
    let form;
    try {
      form = await request.formData();
    } catch {
      return json(400, { error: { message: 'Expected multipart form data' } });
    }
    const model = resolveModel(String(form.get('model') || ''));
    if (!allowedModels.has(model)) {
      return json(400, { error: { message: 'Model not allowed' } });
    }
    form.set('model', model);
    const upstream = await fetch(`${OPENAI_BASE}/${route}`, {
      method: 'POST',
      headers: upstreamHeaders(),
      body: form
    });
    return relay(upstream);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: { message: 'Expected JSON body' } });
  }
  const requestedModel = String(body?.model || '');
  const original = route === 'chat/completions' && body ? structuredClone(body) : null;
  if (body) body.model = resolveModel(body.model);
  if (!body || !allowedModels.has(body.model)) {
    return json(400, { error: { message: 'Model not allowed' } });
  }

  if (route === 'chat/completions') {
    clampTokens(body);
    body.n = 1;
    body.stream = false;
    delete body.stream_options;
  } else if (route === 'audio/speech') {
    if (typeof body.input !== 'string' || !body.input.trim()) {
      return json(400, { error: { message: 'Missing input text' } });
    }
    body.input = body.input.slice(0, MAX_TTS_CHARS);
  }

  const send = (payload) => fetch(`${OPENAI_BASE}/${route}`, {
    method: 'POST',
    headers: upstreamHeaders('application/json'),
    body: JSON.stringify(payload)
  });
  let upstream = await send(body);

  // If the upgraded model rejects a request an older app shaped for its own
  // model, retry once with the model the app asked for, so nothing breaks.
  if (upstream.status === 400 && original && requestedModel !== body.model && allowedModels.has(requestedModel)) {
    await upstream.body?.cancel();
    original.model = requestedModel;
    clampTokens(original);
    original.n = 1;
    original.stream = false;
    delete original.stream_options;
    upstream = await send(original);
  }
  return relay(upstream);
}
