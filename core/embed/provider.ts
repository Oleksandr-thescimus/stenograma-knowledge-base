import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { embedMany } from 'ai';
import { createOllama } from 'ollama-ai-provider-v2';

export type EmbeddingKind = 'query' | 'document';

export interface EmbeddingProvider {
  // Kept with each vector and cached embedding, e.g. ollama:bge-m3
  id: string;
  // A local provider embeds every source; a cloud one only the sources with cloudAllowed (F8)
  local: boolean;
  embed: (values: string[], kind: EmbeddingKind, abortSignal?: AbortSignal) => Promise<Float32Array[]>;
}

export interface EmbeddingSettings {
  provider: 'ollama' | 'gemini';
  model: string;
  ollamaUrl: string;
}

// Gemini's 3072 dimensions by default take four times the storage (docs/PLAN.md, Architecture)
const GEMINI_DIMENSIONS = 768;

// Ollama counts as local only at a loopback address (F8)
export const isLoopback = (url: string) => URL.canParse(url) && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname);

const normalize = (vector: number[]) => {
  const length = Math.hypot(...vector) || 1;

  return Float32Array.from(vector, (value) => value / length);
};

// multilingual-e5 needs to be told what it reads
const withPrefix = (model: string, kind: EmbeddingKind) => (model.includes('e5')
  ? (value: string) => `${kind === 'query' ? 'query' : 'passage'}: ${value}`
  : (value: string) => value);

export const createEmbeddingProvider = (settings: EmbeddingSettings, apiKey?: string): EmbeddingProvider => {
  if (settings.provider === 'gemini') {
    if (!apiKey) {
      throw new Error('Gemini embeddings need an API key');
    }

    const model = createGoogleGenerativeAI({ apiKey }).embeddingModel(settings.model);

    return {
      id: `gemini:${settings.model}:${GEMINI_DIMENSIONS}`,
      local: false,
      embed: async (values, kind, abortSignal) => (await embedMany({
        model,
        values,
        abortSignal,
        providerOptions: {
          google: { outputDimensionality: GEMINI_DIMENSIONS, taskType: kind === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT' },
        },
      })).embeddings.map(normalize),
    };
  }

  const model = createOllama({ baseURL: `${settings.ollamaUrl.replace(/\/$/, '')}/api` }).embedding(settings.model);

  return {
    id: `ollama:${settings.model}`,
    local: isLoopback(settings.ollamaUrl),
    embed: async (values, kind, abortSignal) => (await embedMany({
      model,
      values: values.map(withPrefix(settings.model, kind)),
      // One request at a time: Ollama runs them one after another anyway
      maxParallelCalls: 1,
      abortSignal,
    })).embeddings.map(normalize),
  };
};
