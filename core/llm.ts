import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import type { LanguageModel } from 'ai';
import { createOllama } from 'ollama-ai-provider-v2';
import { isLoopback } from './embed/provider.ts';
import { getSecret } from './secrets.ts';
import type { LlmSettings } from './settings.ts';

// The extension's providers (F6), with keys entered here: the extension's stay in the browser

export const llmKeyName = (provider: string) => `llm:${provider}`;

// F8: only Ollama at a loopback address may see sources without cloudAllowed
export const isLocalLlm = (settings: LlmSettings) => settings.provider === 'ollama' && isLoopback(settings.ollamaUrl);

const requireKey = (provider: string) => {
  const key = getSecret(llmKeyName(provider));

  if (!key) {
    throw new Error(`No ${provider} key: yarn kb key set ${provider}`);
  }

  return key;
};

export const createLanguageModel = (settings: LlmSettings): LanguageModel => {
  switch (settings.provider) {
    case 'groq':
      return createGroq({ apiKey: requireKey('groq') })(settings.model);
    case 'gemini':
      return createGoogleGenerativeAI({ apiKey: requireKey('gemini') })(settings.model);
    default:
      return createOllama({ baseURL: `${settings.ollamaUrl.replace(/\/$/, '')}/api` })(settings.model);
  }
};

// For every call. Groq's free tier waits out its per-minute limit: the AI SDK honours retry-after (N3). Ollama answers
// without thinking, which took over 5 minutes for one draft in M0
export const callOptions = (settings: LlmSettings) => ({
  maxRetries: settings.provider === 'groq' ? 6 : 2,
  ...(settings.provider === 'ollama' && { providerOptions: { ollama: { think: false } } }),
});
