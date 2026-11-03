import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { embeddingModelId } from '../../core/embed/provider.ts';
import type { AskPart, CoreEvent, Settings } from '../../core/protocol.ts';
import { createKbService, type KbService } from '../../core/service.ts';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type LlmSettings } from '../../core/settings.ts';
import { createFakeProvider } from './helpers.ts';

// The core as the app runs it (core/service.ts), on a knowledge base in a temporary directory: the extension's contract
// fixture pushed over HTTP, a fake embedding model and a mock LLM
const FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/kb-ingest.json', import.meta.url), 'utf8'));
const MEETING = FIXTURE.bundles[0].session.sessionId as string;

const USAGE = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const FINISH = { unified: 'stop', raw: 'stop' } as const;

// Rewrites to the given JSON, then streams the answer in pieces
const mockModel = (rewrite: string, answer: string[]) => new MockLanguageModelV3({
  doGenerate: async () => ({ content: [{ type: 'text', text: rewrite }], finishReason: FINISH, usage: USAGE, warnings: [] }),
  doStream: async () => ({
    stream: simulateReadableStream({
      chunks: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't' },
        ...answer.map((delta) => ({ type: 'text-delta' as const, id: 't', delta })),
        { type: 'text-end', id: 't' },
        { type: 'finish', finishReason: FINISH, usage: USAGE },
      ],
    }),
  }),
});

const freePort = () => new Promise<number>((resolve) => {
  const probe = createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address() as { port: number };
    probe.close(() => resolve(port));
  });
});

describe('the core service', () => {
  let dir: string;
  let port: number;
  let events: CoreEvent[];
  let fake: ReturnType<typeof createFakeProvider>;
  let model: MockLanguageModelV3;
  // The LLM settings each model was made with
  let llms: LlmSettings[];
  const services: KbService[] = [];

  const makeService = () => {
    const service = createKbService({
      onEvent: (event) => events.push(event),
      createEmbeddingProvider: (settings) => ({ ...fake.provider, id: embeddingModelId(settings) }),
      createLanguageModel: (settings) => {
        llms.push(settings);

        return model;
      },
      retryEmbeddingMs: 50,
    });
    services.push(service);

    return service;
  };

  const startService = async () => {
    const service = makeService();
    await service.start();

    return service;
  };

  const push = async (token: string, body: unknown = FIXTURE) => fetch(`http://127.0.0.1:${port}/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

  // A paired browser that pushed the fixture, embedded
  const startWithMeetings = async () => {
    const service = await startService();
    const { sourceId, token } = await service.invoke('addBrowser', { label: 'Chrome' });
    expect((await push(token)).status).toBe(200);
    await vi.waitFor(async () => {
      const { embedding, sources } = await service.invoke('status', {});

      expect(sources[0].chunks).toBeGreaterThan(0);
      expect(embedding).toMatchObject({ pending: 0, running: false });
    });

    return { service, sourceId };
  };

  // An answer's parts, once it's done, and its chat
  const askParts = async (service: KbService, askId: string, params: { question: string, filters?: object, chatId?: number }) => {
    const { chatId } = await service.invoke('ask', { askId, chatId: null, filters: {}, ...params });
    await vi.waitFor(() => expect(events.some((event) => event.type === 'ask' && event.askId === askId && ['done', 'error'].includes(event.part.kind))).toBe(true));

    return { chatId, parts: events.flatMap((event) => (event.type === 'ask' && event.askId === askId ? [event.part] : [])) };
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kb-service-'));
    vi.stubEnv('STENOGRAMA_KB_DATA', dir);
    port = await freePort();
    saveSettings({ ...DEFAULT_SETTINGS, server: { port } });
    events = [];
    llms = [];
    fake = createFakeProvider();
    model = mockModel('{"query": "бюджет", "from": null, "to": null, "person": null}', ['Бюджет ', 'затвердили [1].']);
  });

  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.stop()));
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('holds the lock, so a second core (or kb serve) can\'t start next to it', async () => {
    const service = await startService();

    await expect(makeService().start()).rejects.toThrow(/in use by process/);

    await service.stop();
    await expect(startService()).resolves.toBeDefined();
  });

  it('pairs a browser, takes its push and embeds it, telling the renderer with status events', async () => {
    const { sourceId } = await startWithMeetings();

    expect(fake.embedded.length).toBeGreaterThan(0);

    // Status events come at most twice a second
    await vi.waitFor(() => expect(events.filter((event) => event.type === 'status').at(-1)).toMatchObject({ status: { embedding: { pending: 0, running: false } } }));
    const status = events.filter((event) => event.type === 'status').at(-1);

    expect(status).toMatchObject({
      type: 'status',
      status: {
        server: { port, listening: true, error: null },
        embedding: { model: 'ollama:bge-m3', pending: 0, rebuild: null },
        sources: [{ id: sourceId, kind: 'stenograma-browser', account: 'Chrome', cloudAllowed: true, documents: expect.any(Number) }],
      },
    });
  });

  it('shows a cited meeting from its own copy, with the moments of its messages, and links it to the extension', async () => {
    const { service, sourceId } = await startWithMeetings();
    const meeting = await service.invoke('meeting', { sourceId, sessionId: MEETING });

    expect(meeting).toMatchObject({ sourceId, sessionId: MEETING, origin: 'meet', canOpenInStenograma: true });
    expect(meeting!.messages[0].startMs).toBe(0);
    expect(meeting!.messages.some((message) => (message.startMs ?? 0) > 0)).toBe(true);
    expect(await service.invoke('meeting', { sourceId, sessionId: 'gone' })).toBeNull();

    const link = await service.invoke('stenogramaLink', { sourceId, sessionId: MEETING, startMs: 15_000 });

    expect(link).toBe(`http://127.0.0.1:${port}/stenograma-open?source=${sourceId}&session=${encodeURIComponent(MEETING).replace(/%20/g, '+')}&t=15000`);
  });

  it('links a recording to the version its chunks are made of, so the extension shows that text', async () => {
    const { service, sourceId } = await startWithMeetings();
    const [, recording] = FIXTURE.bundles;
    const link = new URL(await service.invoke('stenogramaLink', { sourceId, sessionId: recording.session.sessionId, startMs: 0 }));

    expect(link.searchParams.get('v')).toBe(String(recording.transcripts[0].createdAt));
    expect(link.searchParams.get('t')).toBe('0');
  });

  it('answers in parts: the request, the sources, the text', async () => {
    const { service } = await startWithMeetings();
    const { parts } = await askParts(service, 'a1', { question: 'Що з бюджетом?' });

    expect(parts[0]).toEqual({ kind: 'request', query: 'бюджет' });
    expect(parts[1]).toMatchObject({ kind: 'sources', leftOut: 0, llm: 'ollama qwen3.5:9b', local: true });
    expect((parts[1] as Extract<AskPart, { kind: 'sources' }>).sources.length).toBeGreaterThan(0);
    expect(parts.filter((part) => part.kind === 'text').map((part) => part.text).join('')).toBe('Бюджет затвердили [1].');
    expect(parts.at(-1)).toEqual({ kind: 'done' });
  });

  it('lets the filters set by hand win over the rewrite\'s, and says when nothing answers', async () => {
    const { service } = await startWithMeetings();
    model = mockModel('{"query": "бюджет", "from": "2026-10-01", "to": "2026-10-31", "person": "Олена"}', []);
    const from = new Date(2030, 0, 1).getTime();
    const { parts } = await askParts(service, 'a2', { question: 'Що з бюджетом?', filters: { from, to: from + 86_400_000, person: 'Oleh' } });

    expect(parts[0]).toEqual({ kind: 'request', query: 'бюджет', from, to: from + 86_400_000, person: 'Oleh' });
    expect(parts[1]).toMatchObject({ kind: 'sources', sources: [] });
    expect(parts.at(-1)).toEqual({ kind: 'done' });
  });

  it('reports a provider\'s failure as the answer\'s error', async () => {
    const { service } = await startWithMeetings();
    model = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error('Ollama isn\'t running');
      },
      doStream: async () => {
        throw new Error('Ollama isn\'t running');
      },
    });
    const { parts } = await askParts(service, 'a3', { question: 'бюджет' });

    expect(parts.at(-1)).toEqual({ kind: 'error', message: expect.stringContaining('Ollama isn\'t running') });
  });

  it('keeps each chat with its answers, and completes a follow-up question with the chat\'s last exchanges', async () => {
    const { service } = await startWithMeetings();
    const first = await askParts(service, 'c1', { question: 'Що з бюджетом?' });

    expect(await service.invoke('chats', {})).toEqual([{ id: first.chatId, title: 'Що з бюджетом?', updatedAt: expect.any(Number) }]);

    const [turn] = (await service.invoke('chat', { chatId: first.chatId }))!.turns;

    expect(turn).toMatchObject({
      question: 'Що з бюджетом?', request: { kind: 'request', query: 'бюджет' }, answer: 'Бюджет затвердили [1].', state: 'done', error: null,
    });
    // The cited chunks' text is read again from the knowledge base, not kept with the chat
    expect(turn.sources!.sources.length).toBeGreaterThan(0);
    expect(turn.sources!.sources[0]).toMatchObject({ text: expect.stringMatching(/\S/) });
    expect(turn.sources!.sources[0].removed).toBeUndefined();

    await askParts(service, 'c2', { question: 'А хто це сказав?', chatId: first.chatId });

    expect(JSON.stringify(model.doGenerateCalls.at(-1)!.prompt)).toContain('Бюджет затвердили [1].');
    expect((await service.invoke('chat', { chatId: first.chatId }))!.turns).toHaveLength(2);

    // A new chat starts without them, and comes first
    const other = await askParts(service, 'c3', { question: 'А реліз?' });

    expect(JSON.stringify(model.doGenerateCalls.at(-1)!.prompt)).not.toContain('Бюджет затвердили');
    expect((await service.invoke('chats', {})).map((chat) => chat.id)).toEqual([other.chatId, first.chatId]);

    await service.invoke('deleteChat', { chatId: first.chatId });

    expect(await service.invoke('chat', { chatId: first.chatId })).toBeNull();
    await expect(service.invoke('ask', { askId: 'c4', chatId: first.chatId, question: 'Ще?', filters: {} })).rejects.toThrow(/deleted/);
  });

  it('keeps a chat\'s answer when its cited meeting goes, showing the citations as removed', async () => {
    const { service, sourceId } = await startWithMeetings();
    const { chatId } = await askParts(service, 'r1', { question: 'Що з бюджетом?' });
    await service.invoke('removeSource', { sourceId });
    const [turn] = (await service.invoke('chat', { chatId }))!.turns;

    expect(turn.answer).toBe('Бюджет затвердили [1].');
    expect(turn.sources!.sources.length).toBeGreaterThan(0);
    expect(turn.sources!.sources.every((source) => source.removed && source.text === '')).toBe(true);
  });

  // A meeting's summary parts, once it's done
  const summaryParts = async (service: KbService, summaryId: string, sourceId: number) => {
    await service.invoke('summarize', { summaryId, sourceId, sessionId: MEETING });
    await vi.waitFor(() => expect(events.some((event) => event.type === 'summary' && event.summaryId === summaryId
      && ['done', 'error', 'stopped'].includes(event.part.kind))).toBe(true));

    return events.flatMap((event) => (event.type === 'summary' && event.summaryId === summaryId ? [event.part] : []));
  };

  it('summarizes a meeting in parts, as events, and keeps the summary with it', async () => {
    const { service, sourceId } = await startWithMeetings();
    const parts = await summaryParts(service, 's1', sourceId);

    expect(parts[0]).toEqual({ kind: 'progress', done: 0, all: 1, llm: 'ollama qwen3.5:9b', local: true });
    expect(parts.filter((part) => part.kind === 'text').map((part) => part.text).join('')).toBe('Бюджет затвердили [1].');
    expect(parts.at(-1)).toMatchObject({ kind: 'done', summary: { text: 'Бюджет затвердили [1].', model: 'ollama qwen3.5:9b', stale: false } });
    expect(await service.invoke('meeting', { sourceId, sessionId: MEETING })).toMatchObject({
      shortSummary: { text: 'Бюджет затвердили [1].', stale: false },
    });
  });

  it('summarizes a meeting that may not go to cloud AI with Ollama, when a cloud LLM is chosen (F8)', async () => {
    const { service, sourceId } = await startWithMeetings();
    saveSettings({ ...loadSettings(), llm: { ...DEFAULT_SETTINGS.llm, provider: 'groq', model: 'openai/gpt-oss-120b' } });

    await summaryParts(service, 's2', sourceId);

    expect(llms.at(-1)).toMatchObject({ provider: 'groq' });

    await service.invoke('setCloudAllowed', { sourceId, allowed: false });
    const parts = await summaryParts(service, 's3', sourceId);

    expect(llms.at(-1)).toEqual({ provider: 'ollama', model: 'qwen3.5:9b', ollamaUrl: DEFAULT_SETTINGS.llm.ollamaUrl });
    expect(parts[0]).toMatchObject({ kind: 'progress', llm: 'ollama qwen3.5:9b', local: true });
  });

  it('stops a summary when asked, keeping none', async () => {
    const { service, sourceId } = await startWithMeetings();
    model = new MockLanguageModelV3({
      doStream: ({ abortSignal }) => new Promise((_resolve, reject) => {
        if (abortSignal?.aborted) {
          reject(new Error('Aborted'));
        }

        abortSignal?.addEventListener('abort', () => reject(new Error('Aborted')));
      }),
    });
    await service.invoke('summarize', { summaryId: 's4', sourceId, sessionId: MEETING });
    await service.invoke('cancelSummary', { summaryId: 's4' });

    await vi.waitFor(() => expect(events.some((event) => event.type === 'summary' && event.part.kind === 'stopped')).toBe(true));
    expect((await service.invoke('meeting', { sourceId, sessionId: MEETING }))!.shortSummary).toBeNull();
  });

  it('marks an answer the app stopped in the middle of', async () => {
    const { service } = await startWithMeetings();
    model = new MockLanguageModelV3({
      doGenerate: ({ abortSignal }) => new Promise((_resolve, reject) => {
        abortSignal?.addEventListener('abort', () => reject(new Error('Aborted')));
      }),
    });
    const { chatId } = await service.invoke('ask', { askId: 's1', chatId: null, question: 'Що з бюджетом?', filters: {} });
    await service.stop();
    const again = await startService();

    expect((await again.invoke('chat', { chatId }))!.turns[0]).toMatchObject({ state: 'error', error: 'The app stopped before the answer was done' });
  });

  it('builds a new embedding model in the background, keeping the search on the old one until it\'s done (F7)', async () => {
    const { service } = await startWithMeetings();
    const before = fake.embedded.length;
    const chosen: Settings = { ...DEFAULT_SETTINGS, server: { port }, embedding: { ...DEFAULT_SETTINGS.embedding, model: 'bge-m3-next' } };

    expect((await service.invoke('saveSettings', chosen)).embedding.model).toBe('bge-m3-next');

    await vi.waitFor(() => expect(loadSettings()).toMatchObject({ embedding: { model: 'bge-m3-next' } }));

    expect(loadSettings().embeddingRebuild).toBeUndefined();
    expect(fake.embedded.length).toBeGreaterThan(before);
    await vi.waitFor(async () => expect((await service.invoke('status', {})).embedding).toMatchObject({
      model: 'ollama:bge-m3-next', pending: 0, rebuild: null,
    }));

    // Back to the first model: its vectors are all in the cache, so nothing is embedded again
    const after = fake.embedded.length;
    await service.invoke('saveSettings', { ...chosen, embedding: DEFAULT_SETTINGS.embedding });
    await vi.waitFor(() => expect(loadSettings().embedding.model).toBe('bge-m3'));

    expect(fake.embedded.length).toBe(after);
  });

  it('tries the embedding queue again after a failure, and says why meanwhile', async () => {
    let failing = true;
    const { embed } = fake.provider;
    fake.provider.embed = async (...args) => {
      if (failing) {
        throw new Error('Ollama isn\'t running');
      }

      return embed(...args);
    };
    const service = await startService();
    const { token } = await service.invoke('addBrowser', { label: 'Chrome' });
    await push(token);

    await vi.waitFor(async () => expect((await service.invoke('status', {})).embedding.error).toContain('Ollama isn\'t running'), { timeout: 5000 });

    failing = false;

    await vi.waitFor(async () => expect((await service.invoke('status', {})).embedding).toMatchObject({ pending: 0, error: null }), { timeout: 5000 });
  });

  it('sets a source\'s cloud policy and removes it with its documents', async () => {
    const { service, sourceId } = await startWithMeetings();
    await service.invoke('setCloudAllowed', { sourceId, allowed: false });

    expect((await service.invoke('status', {})).sources[0].cloudAllowed).toBe(false);

    await service.invoke('removeSource', { sourceId });

    expect((await service.invoke('status', {})).sources).toEqual([]);
    await expect(service.invoke('stenogramaLink', { sourceId, sessionId: MEETING, startMs: null })).rejects.toThrow(/browser/);
  });

  describe('the port', () => {
    let blocker: Server;

    afterEach(() => new Promise<void>((resolve) => {
      blocker.close(() => resolve());
    }));

    it('says when the port is taken, and listens once another one is chosen', async () => {
      blocker = createServer().listen(port, '127.0.0.1');
      await new Promise((resolve) => blocker.once('listening', resolve));
      const service = await startService();

      expect((await service.invoke('status', {})).server).toEqual({ port, listening: false, error: `Port ${port} is used by another program` });

      const other = await freePort();
      await service.invoke('saveSettings', { ...DEFAULT_SETTINGS, server: { port: other } });

      expect((await service.invoke('status', {})).server).toEqual({ port: other, listening: true, error: null });
    });
  });

  it('refuses settings it can\'t use', async () => {
    const service = await startService();

    await expect(service.invoke('saveSettings', { ...DEFAULT_SETTINGS, server: { port: 80 } })).rejects.toThrow();
    await expect(service.invoke('saveSettings', { ...DEFAULT_SETTINGS, llm: { ...DEFAULT_SETTINGS.llm, model: ' ' } })).rejects.toThrow();
    expect(loadSettings().server.port).toBe(port);
  });
});
