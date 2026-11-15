import { describe, expect, it } from 'vitest';
import type { AiServer } from '../../core/protocol.ts';
import { DEFAULT_SETTINGS } from '../../core/settings.ts';
import {
  answersLlm, createReachability, keyIdOf, laneOf, localTextLlm, serverId, serversOf, serverTakes, textModel, textModels, whereLabel,
} from '../../core/servers.ts';

// The AI servers: the chat's order, what each takes of the background work, the servers of settings saved before they
// had their models, and whether a server answers

const PI = 'http://127.0.0.1:11435';
const HERE = 'http://127.0.0.1:11434';
const orangePi: AiServer = { name: 'Orange Pi', kind: 'ollama', url: PI, text: 'qwen3.5-9b', images: 'qwen3.5-9b', queue: true };

describe('AI servers', () => {
  it('knows a server by its address, whatever its spelling, or by its cloud provider; a model by its server', () => {
    expect(serverId({ kind: 'ollama', url: `${HERE}/` })).toBe(laneOf({ provider: 'ollama', ollamaUrl: HERE }));
    expect(serverId({ kind: 'groq', url: '' })).toBe(laneOf({ provider: 'groq', ollamaUrl: PI }));
    expect(whereLabel([orangePi, ...DEFAULT_SETTINGS.servers], { provider: 'ollama', ollamaUrl: PI })).toBe('Orange Pi');
    expect(whereLabel(DEFAULT_SETTINGS.servers, { provider: 'gemini', ollamaUrl: '' })).toBe('Gemini');
  });

  it('knows an OpenAI-compatible API by its address, its key too, and never as this computer', () => {
    const cerebras: AiServer = { name: 'Cerebras', kind: 'openai', url: 'https://api.cerebras.ai/v1/', text: 'gpt-oss-120b', images: '', queue: true };
    const openRouter: AiServer = { ...cerebras, name: 'OpenRouter', url: 'https://openrouter.ai/api/v1' };
    const model = textModel(cerebras)!;

    expect(model).toEqual({ provider: 'openai', model: 'gpt-oss-120b', ollamaUrl: 'https://api.cerebras.ai/v1/' });
    expect(serverId(cerebras)).toBe('https://api.cerebras.ai/v1');
    expect(laneOf(model)).toBe(serverId(cerebras));
    expect(keyIdOf(cerebras)).toBe('openai:https://api.cerebras.ai/v1');
    expect(keyIdOf({ kind: 'groq', url: '' })).toBe('groq');
    expect(whereLabel([openRouter, cerebras], model)).toBe('Cerebras');
    expect(localTextLlm({ servers: [cerebras] })).toMatchObject({ provider: 'ollama' });
  });

  it('answers with the first server\'s text model; what may not go to the cloud with the first on this computer', () => {
    const groq: AiServer = { name: 'Groq', kind: 'groq', url: '', text: 'llama-3.3-70b', images: 'ignored', queue: false };
    const settings = { servers: [groq, orangePi, ...DEFAULT_SETTINGS.servers.filter((server) => server.kind === 'ollama')] };

    expect(answersLlm(settings)).toEqual({ provider: 'groq', model: 'llama-3.3-70b', ollamaUrl: '' });
    expect(textModels(settings).map((model) => model.model)).toEqual(['llama-3.3-70b', 'qwen3.5-9b', 'qwen3.5:9b']);
    // The Orange Pi through a tunnel is at a loopback address too
    expect(localTextLlm(settings)).toEqual({ provider: 'ollama', model: 'qwen3.5-9b', ollamaUrl: PI });
    // Groq reads no images
    expect(serverTakes(groq)).toEqual(['drafts', 'summaries']);
    expect(serverTakes({ ...orangePi, text: '' })).toEqual(['images']);
  });

  it('makes the servers of settings saved before from their models: each task\'s, the answers\' server first', () => {
    const servers = serversOf({
      servers: [{ name: 'This computer', url: HERE, model: 'qwen3.5:9b' }, { name: 'orangepi', url: PI, model: 'qwen3.5-9b' }],
      llm: { provider: 'ollama', model: 'qwen3.5-4b', ollamaUrl: PI },
      summaries: { llm: { provider: 'ollama', model: 'qwen3.5-9b', ollamaUrl: PI } },
      drafts: { llm: null },
      attachments: { provider: 'ollama', model: 'qwen3.5-4b', ollamaUrl: PI },
    });

    expect(servers).toEqual([
      { name: 'orangepi', kind: 'ollama', url: PI, text: 'qwen3.5-9b', images: 'qwen3.5-4b', queue: true },
      { name: 'This computer', kind: 'ollama', url: HERE, text: 'qwen3.5:9b', images: '', queue: true },
      { name: 'Groq', kind: 'groq', url: '', text: '', images: '', queue: false },
      { name: 'Gemini', kind: 'gemini', url: '', text: '', images: '', queue: false },
      { name: 'Claude', kind: 'anthropic', url: '', text: '', images: '', queue: false },
      { name: 'Ollama Cloud', kind: 'ollama-cloud', url: '', text: '', images: '', queue: false },
    ]);
    // As saved now, with Groq and Gemini always there
    expect(serversOf({ servers: [orangePi] })).toEqual([orangePi, ...DEFAULT_SETTINGS.servers.filter((server) => server.kind !== 'ollama')]);
  });

  it('asks a server whether it answers at most every so often, and takes a failed call as an answer', async () => {
    let asked = 0;
    const reach = createReachability(async () => {
      asked += 1;

      return new Response('{}');
    });

    expect(reach.last(PI)).toBeNull();
    expect(await reach.check(PI)).toBe(true);
    expect(await reach.check(`${PI}/`)).toBe(true);
    expect(asked).toBe(1);

    reach.unreachable(PI);
    expect(await reach.check(PI)).toBe(false);
    expect(await reach.check(PI, true)).toBe(true);
    expect(asked).toBe(2);
  });
});
