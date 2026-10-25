const { app } = require('electron');
const { createClient } = require('@deepgram/sdk');

// Packaged builds never carry provider keys. They reach OpenAI and Deepgram
// through the Relay API proxy. Local development can still use keys from ../.env.
const RELAY_API_BASE = String(process.env.RELAY_API_BASE || 'https://relay.suhaanthayyil.com/api')
    .trim()
    .replace(/\/+$/, '');

const PROXY_HEADERS = {
    'x-relay-client': 'relay-desktop',
    'x-relay-version': app.getVersion()
};

let openAIClient = null;

// OpenAI retires models on a schedule (developers.openai.com/api/docs/deprecations).
// Stored settings or older code may still name a retired model, so map them here.
// GPT-6 Luna is OpenAI's newest small model: text and images, at a lower price
// than gpt-4o-mini and gpt-5.6-luna, which it replaces.
const CHAT_TEXT_MODEL = 'gpt-6-luna';
const VISION_MODEL = 'gpt-6-luna';
const SPEECH_MODEL = 'gpt-4o-mini-tts';
const TRANSCRIBE_MODEL = 'gpt-transcribe';
const LEGACY_MODELS = {
    'gpt-4o-mini': VISION_MODEL, // shuts down 2027-01-14
    'gpt-4.1-nano': CHAT_TEXT_MODEL, // shut down 2026-10-23
    'gpt-4.1-nano-2025-04-14': CHAT_TEXT_MODEL,
    'tts-1': SPEECH_MODEL, // shut down 2027-01-06
    'gpt-4o-mini-transcribe': TRANSCRIBE_MODEL // shut down 2027-02-26
};

function resolveModel(model) {
    const name = String(model || '').trim();
    return LEGACY_MODELS[name] || name;
}

// GPT-5 and newer reject max_tokens and spend output budget on reasoning
// unless told not to, so normalize every chat request in one place.
function isReasoningFamily(model) {
    return Number((/^gpt-(\d+)/.exec(String(model || '')) || [])[1]) >= 5;
}

function normalizeChatRequest(body = {}) {
    const request = { ...body, model: resolveModel(body.model) };
    if (isReasoningFamily(request.model)) {
        if (request.max_tokens != null && request.max_completion_tokens == null) {
            request.max_completion_tokens = request.max_tokens;
        }
        delete request.max_tokens;
        if (request.reasoning_effort == null) request.reasoning_effort = 'none';
    }
    return request;
}

function useDirectKey(envName) {
    return !app.isPackaged
        && process.env.RELAY_FORCE_PROXY !== '1'
        && Boolean(String(process.env[envName] || '').trim());
}

function getAIMode() {
    return {
        openai: useDirectKey('OPENAI_API_KEY') ? 'direct' : 'proxy',
        deepgram: useDirectKey('DEEPGRAM_API_KEY') ? 'direct' : 'proxy',
        apiBase: RELAY_API_BASE
    };
}

function getOpenAIClient() {
    if (!openAIClient) {
        const OpenAI = require('openai');
        openAIClient = useDirectKey('OPENAI_API_KEY')
            ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY.trim(), timeout: 60_000, maxRetries: 1 })
            : new OpenAI({
                apiKey: 'relay-proxy',
                baseURL: `${RELAY_API_BASE}/openai/v1`,
                defaultHeaders: PROXY_HEADERS,
                timeout: 60_000,
                maxRetries: 1
            });
        const completions = openAIClient.chat.completions;
        const create = completions.create.bind(completions);
        completions.create = (body, options) => create(normalizeChatRequest(body), options);
    }
    return openAIClient;
}

function toUploadFile(buffer, filename) {
    const { toFile } = require('openai');
    return toFile(buffer, filename);
}

// Proxy tokens live ~60s and only need to be valid when a connection opens,
// so callers fetch a fresh client for every live connection or request.
async function getDeepgramClient() {
    if (useDirectKey('DEEPGRAM_API_KEY')) {
        return createClient(process.env.DEEPGRAM_API_KEY.trim());
    }

    const response = await fetch(`${RELAY_API_BASE}/deepgram/token`, {
        headers: PROXY_HEADERS,
        signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) {
        throw new Error(`Speech service unavailable (${response.status})`);
    }
    const { access_token: accessToken } = await response.json();
    if (!accessToken) {
        throw new Error('Speech service returned no token');
    }
    return createClient({ accessToken });
}

module.exports = {
    RELAY_API_BASE,
    CHAT_TEXT_MODEL,
    VISION_MODEL,
    SPEECH_MODEL,
    TRANSCRIBE_MODEL,
    resolveModel,
    normalizeChatRequest,
    getAIMode,
    getOpenAIClient,
    getDeepgramClient,
    toUploadFile
};
