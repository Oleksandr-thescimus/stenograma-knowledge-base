import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { wrapLanguageModel, type LanguageModel } from 'ai';
import { createOllama } from 'ollama-ai-provider-v2';
import { Agent, fetch as undiciFetch } from 'undici';
import { createEmbeddingProvider, isLoopback, type EmbeddingSettings } from './embed/provider.ts';
import { getSecret } from './secrets.ts';
import type { LlmSettings } from './settings.ts';

// The extension's providers (F6), with keys entered here: the extension's stay in the browser

export const llmKeyName = (provider: string) => `llm:${provider}`;

// F8: only Ollama at a loopback address may see sources without cloudAllowed
export const isLocalLlm = (settings: LlmSettings) => settings.provider === 'ollama' && isLoopback(settings.ollamaUrl);

const requireKey = (provider: string) => {
  const key = getSecret(llmKeyName(provider));

  if (!key) {
    throw new Error(`No ${provider} key: add it in the app's settings, or with yarn kb key set ${provider}`);
  }

  return key;
};

// A call not streamed gets its answer's headers only when the model is done: a summary's part on an Orange Pi takes
// longer than the 5 minutes Node's fetch waits for them, which cut it off as if the server weren't there. Ollama's calls
// wait up to 30 minutes instead, for the headers and between two pieces of a stream
export const MODEL_CALL_TIMEOUT_MS = 30 * 60_000;
const patientAgent = new Agent({ headersTimeout: MODEL_CALL_TIMEOUT_MS, bodyTimeout: MODEL_CALL_TIMEOUT_MS });
const patientFetch = ((input: Parameters<typeof undiciFetch>[0], init?: Parameters<typeof undiciFetch>[1]) => undiciFetch(input, {
  ...init, dispatcher: patientAgent,
})) as unknown as typeof fetch;

// Node's fetch gave up waiting for the model: it's there, only slow
export const isTimedOut = (error: unknown) => {
  let cause: unknown = error;

  for (let depth = 0; cause && depth < 6; depth += 1) {
    const { code, message } = cause as { code?: unknown, message?: unknown };

    if (/^UND_ERR_(HEADERS|BODY)_TIMEOUT$/.test(String(code)) || /Headers Timeout|Body Timeout/i.test(String(message))) {
      return true;
    }

    cause = (cause as { lastError?: unknown }).lastError ?? (cause as { cause?: unknown }).cause;
  }

  return false;
};

export const createLanguageModel = (settings: LlmSettings): LanguageModel => {
  switch (settings.provider) {
    case 'groq':
      return createGroq({ apiKey: requireKey('groq') })(settings.model);
    case 'gemini':
      return createGoogleGenerativeAI({ apiKey: requireKey('gemini') })(settings.model);
    case 'anthropic':
      // Claude thinks before it answers, and its thinking counts against the cap on output: the caps set for the
      // answer alone (300 tokens for a rewrite) would cut it off, so a call may write up to 16000; the prompts keep the
      // answers short
      return wrapLanguageModel({
        model: createAnthropic({ apiKey: requireKey('anthropic') })(settings.model),
        middleware: {
          specificationVersion: 'v3',
          transformParams: async ({ params }) => ({ ...params, maxOutputTokens: Math.max(params.maxOutputTokens ?? 0, 16_000) }),
        },
      });
    default:
      return createOllama({ baseURL: `${settings.ollamaUrl.replace(/\/$/, '')}/api`, fetch: patientFetch })(settings.model);
  }
};

// For every call. Groq's free tier waits out its per-minute limit: the AI SDK honours retry-after (N3). Ollama answers
// without thinking, which took over 5 minutes for one draft in M0
export const callOptions = (settings: LlmSettings) => ({
  maxRetries: settings.provider === 'groq' ? 6 : 2,
  ...(settings.provider === 'ollama' && { providerOptions: { ollama: { think: false } } }),
});

// Gemini's embeddings take the Gemini key of the LLM
export const createConfiguredEmbeddingProvider = (settings: EmbeddingSettings) => createEmbeddingProvider(
  settings, settings.provider === 'gemini' ? requireKey('gemini') : undefined,
);
