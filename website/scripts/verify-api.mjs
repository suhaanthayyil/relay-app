// Offline checks for the Relay API proxy: upstream calls are mocked.
// Run: npm run verify
import assert from 'node:assert/strict';

const calls = [];
let rejectNext = false;
globalThis.fetch = async (url, opts = {}) => {
  calls.push({ url, opts });
  if (rejectNext) {
    rejectNext = false;
    return new Response(JSON.stringify({ error: { message: 'Unsupported parameter' } }), { status: 400 });
  }
  if (String(url).includes('deepgram')) return new Response(JSON.stringify({ access_token: 'jwt', expires_in: 60 }), { status: 200 });
  return new Response(JSON.stringify({ ok: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
};
process.env.OPENAI_API_KEY = 'sk-test';
process.env.DEEPGRAM_API_KEY = 'dg-test';

const openai = await import('../api/openai.js');
const token = await import('../api/deepgram/token.js');
const headers = (ip) => ({ 'x-relay-client': 'relay-mobile', 'content-type': 'application/json', 'x-forwarded-for': ip });
const post = (path, body, h = headers('1.1.1.1')) =>
  openai.POST(new Request(`https://x/api/openai?path=${path}`, { method: 'POST', headers: h, body: JSON.stringify(body) }));
const lastBody = () => JSON.parse(calls.at(-1).opts.body);

assert.equal((await post('chat/completions', { model: 'gpt-4o-mini' }, { 'content-type': 'application/json' })).status, 403, 'unknown client rejected');
assert.equal((await post('chat/completions', { model: 'gpt-5' })).status, 400, 'unlisted model rejected');
assert.equal((await post('images/generations', { model: 'gpt-4o-mini' })).status, 404, 'unlisted route rejected');

assert.equal((await post('chat/completions', { model: 'gpt-4o-mini', max_tokens: 99999, stream: true, n: 4, messages: [] })).status, 200);
assert.equal(lastBody().model, 'gpt-6-luna', 'retiring gpt-4o-mini mapped to GPT-6 Luna');
assert.deepEqual([lastBody().max_completion_tokens, lastBody().stream, lastBody().n], [1200, false, 1], 'tokens clamped, no streaming');

await post('chat/completions', { model: 'gpt-5.6-luna', max_completion_tokens: 300, reasoning_effort: 'none', messages: [] });
assert.equal(lastBody().model, 'gpt-6-luna', 'gpt-5.6-luna upgraded');

await post('chat/completions', { model: 'gpt-6-luna', max_tokens: 50, messages: [] });
assert.equal(lastBody().model, 'gpt-6-luna', 'gpt-6-luna allowed');
assert.equal(lastBody().reasoning_effort, 'none', 'reasoning off for GPT-6');

rejectNext = true;
const before = calls.length;
const retried = await post('chat/completions', { model: 'gpt-4o-mini', max_tokens: 150, temperature: 0.2, messages: [] });
assert.equal(retried.status, 200, 'retry succeeded');
assert.equal(calls.length - before, 2, 'one retry');
assert.equal(lastBody().model, 'gpt-4o-mini', 'retried with the model the app asked for');
assert.equal(lastBody().max_tokens, 150, 'old request shape kept for the old model');
assert.equal(lastBody().reasoning_effort, undefined);

rejectNext = true;
assert.equal((await post('chat/completions', { model: 'gpt-6-luna', messages: [] })).status, 400, 'no retry when the app asked for GPT-6 Luna');

await post('chat/completions', { model: 'gpt-4.1-nano', max_tokens: 220, messages: [] });
assert.equal(lastBody().model, 'gpt-6-luna', 'retired gpt-4.1-nano mapped');
assert.equal(lastBody().max_completion_tokens, 220, 'max_tokens becomes max_completion_tokens');
assert.equal(lastBody().max_tokens, undefined);
assert.equal(lastBody().reasoning_effort, 'none', 'reasoning off by default');

await post('audio/speech', { model: 'tts-1', voice: 'alloy', input: 'x'.repeat(9000) });
assert.equal(lastBody().model, 'gpt-4o-mini-tts', 'retiring tts-1 mapped');
assert.equal(lastBody().input.length, 4096, 'speech input clamped');

const form = new FormData();
form.set('model', 'gpt-4o-mini-transcribe');
form.set('file', new Blob([new Uint8Array(8)]), 'a.wav');
const t = await openai.POST(new Request('https://x/api/openai?path=audio/transcriptions', { method: 'POST', headers: { 'x-relay-client': 'relay-desktop' }, body: form }));
assert.equal(t.status, 200);
assert.equal(calls.at(-1).opts.body.get('model'), 'gpt-transcribe', 'retiring transcription model mapped');

assert.equal((await token.GET(new Request('https://x/api/deepgram/token', { headers: headers('2.2.2.2') }))).status, 200);
assert.equal(lastBody().ttl_seconds, 60, 'token ttl requested');

let limited;
for (let i = 0; i < 70; i++) limited = await post('chat/completions', { model: 'gpt-4o-mini' }, headers('9.9.9.9'));
assert.equal(limited.status, 429, 'per-IP rate limit');

console.log('Relay API proxy checks passed.');
