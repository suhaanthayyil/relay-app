import Constants from 'expo-constants';

// All AI requests go through the Relay API proxy. The app never holds provider keys.
const API_BASE = (process.env.EXPO_PUBLIC_RELAY_API_URL || 'https://relay.suhaanthayyil.com/api').replace(/\/+$/, '');

const CLIENT_HEADERS = {
  'x-relay-client': 'relay-mobile',
  'x-relay-version': Constants.expoConfig?.version ?? '1.0.0',
};

export class RelayApiError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

async function relayFetch(path: string, init: RequestInit = {}, timeoutMs = 25000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { ...CLIENT_HEADERS, ...(init.headers as Record<string, string> | undefined) },
      signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 429) throw new RelayApiError('Too many requests. Please wait a minute and try again.', 429);
      if (response.status === 404 || response.status >= 500) {
        throw new RelayApiError('Relay AI is unavailable right now. Please try again later.', response.status);
      }
      let message = `Relay could not complete that request (${response.status}).`;
      try {
        const body = await response.json();
        if (body?.error?.message) message = body.error.message;
      } catch {
        // keep the generic message
      }
      throw new RelayApiError(message, response.status);
    }
    return response;
  } catch (error) {
    if (error instanceof RelayApiError) throw error;
    if ((error as Error)?.name === 'AbortError') {
      throw new RelayApiError('The request took too long. Check your connection and try again.');
    }
    throw new RelayApiError('Could not reach Relay. Check your internet connection.');
  } finally {
    clearTimeout(timer);
  }
}

type ChatContent = string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail: 'low' | 'high' } })[];

// GPT-6 Luna: OpenAI's newest small model, for both text and camera images.
export const AI_MODEL = 'gpt-6-luna';

export async function chatCompletion(options: {
  model: typeof AI_MODEL;
  system: string;
  user: ChatContent;
  maxTokens: number;
  temperature?: number;
  timeoutMs?: number;
}): Promise<string> {
  const response = await relayFetch(
    '/openai/v1/chat/completions',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: options.model,
        temperature: options.temperature ?? 0.2,
        // GPT-5 and newer take max_completion_tokens and should skip reasoning for speed.
        max_completion_tokens: options.maxTokens,
        reasoning_effort: 'none',
        messages: [
          { role: 'system', content: options.system },
          { role: 'user', content: options.user },
        ],
      }),
    },
    options.timeoutMs
  );
  const data = await response.json();
  const text = String(data?.choices?.[0]?.message?.content || '').trim();
  if (!text) throw new RelayApiError('Relay did not return an answer. Please try again.');
  return text;
}

export async function getDeepgramToken(): Promise<string> {
  const response = await relayFetch('/deepgram/token', {}, 10000);
  const data = await response.json();
  if (!data?.access_token) throw new RelayApiError('Captions are unavailable right now.');
  return data.access_token as string;
}

export function describeError(error: unknown): string {
  if (error instanceof RelayApiError) return error.message;
  return 'Something went wrong. Please try again.';
}
