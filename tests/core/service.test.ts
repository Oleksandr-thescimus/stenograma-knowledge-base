import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { embeddingModelId } from '../../core/embed/provider.ts';
import type { AskPart, CoreEvent, RewriteFilter, Settings } from '../../core/protocol.ts';
import { createKbService, type KbService, type ServiceOptions } from '../../core/service.ts';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type LlmSettings } from '../../core/settings.ts';
import { answersLlm } from '../../core/servers.ts';
import { createFakeProvider } from './helpers.ts';
import { tinyPdf } from './pdf.ts';
import { createFakeRocketChat, SERVER, TOKEN, USER } from './rocketchat-fake.ts';

// The chat's model of the default settings: this computer's Ollama
const DEFAULT_LLM = answersLlm(DEFAULT_SETTINGS);

// The core as the app runs it (core/service.ts), on a knowledge base in a temporary directory: the extension's contract
// fixture pushed over HTTP, a fake embedding model and a mock LLM
const FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/kb-ingest.json', import.meta.url), 'utf8'));
const MEETING = FIXTURE.bundles[0].session.sessionId as string;

// Rocket.Chat's limits, without waiting in the tests
const FAST = { intervalMinutes: 5, requestsPerMinute: 30, filePauseSeconds: 0 };

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

  const makeService = (options: Partial<ServiceOptions> = {}) => {
    const service = createKbService({
      ...options,
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
  const askParts = async (
    service: KbService, askId: string, params: { question: string, filters?: object, chatId?: number, llm?: LlmSettings, without?: RewriteFilter[] },
  ) => {
    const { chatId } = await service.invoke('ask', { askId, chatId: null, filters: {}, llm: null, ...params });
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
    const { service, sourceId } = await startWithMeetings();
    // A meeting not summarized yet says so in the statistics' list of calls
    expect(await service.invoke('aiCallResult', { item: `meeting:${sourceId}:${MEETING}` })).toEqual({ kind: 'none', reason: 'waiting' });
    const { parts } = await askParts(service, 'a1', { question: 'Що з бюджетом?' });

    expect(parts[0]).toEqual({ kind: 'request', query: 'бюджет' });
    expect(parts[1]).toMatchObject({ kind: 'sources', leftOut: 0, llm: 'ollama qwen3.5:9b', local: true });
    expect((parts[1] as Extract<AskPart, { kind: 'sources' }>).sources.length).toBeGreaterThan(0);
    expect(parts.filter((part) => part.kind === 'text').map((part) => part.text).join('')).toBe('Бюджет затвердили [1].');
    expect(parts.at(-1)).toEqual({ kind: 'done' });

    // Its calls are kept for the statistics: the rewrite, the question embedded for the search, the answer streamed;
    // listed by the question, whose answer opens its chat
    const [group] = await service.invoke('aiCalls', { since: null, task: 'answer' });
    expect(group).toMatchObject({ task: 'answer', title: 'Що з бюджетом?', calls: 2 });
    expect(await service.invoke('aiCallResult', { item: group.item })).toMatchObject({
      kind: 'answer', question: 'Що з бюджетом?', text: 'Бюджет затвердили [1].', chatId: expect.any(Number),
    });
    expect(await service.invoke('aiCallResult', { item: 'draft:999' })).toBeNull();
    const { tasks } = await service.invoke('aiUsage', { since: null });
    const of = (task: string) => tasks.find((row) => row.task === task);
    expect(of('rewrite')).toMatchObject({ calls: 1, inputTokens: 1, outputTokens: 1, errors: 0, background: 0 });
    expect(of('answer')).toMatchObject({ calls: 1, inputTokens: 1, outputTokens: 1, errors: 0, background: 0 });
    expect(of('search')).toMatchObject({ calls: 1, items: 1, errors: 0, background: 0 });
    expect(of('embedding')).toMatchObject({ background: expect.any(Number), errors: 0 });
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
    // The failed calls are kept as such (an error that isn't a provider's isn't tried again)
    const { tasks } = await service.invoke('aiUsage', { since: null });
    expect(tasks.filter((row) => ['rewrite', 'answer'].includes(row.task)).map(({ task, calls, errors }) => ({ task, calls, errors })))
      .toEqual(expect.arrayContaining([{ task: 'rewrite', calls: 1, errors: 1 }, { task: 'answer', calls: 1, errors: 1 }]));
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
    await expect(service.invoke('ask', { askId: 'c4', chatId: first.chatId, question: 'Ще?', filters: {}, llm: null })).rejects.toThrow(/deleted/);
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
    // Groq first in the list: it answers, and summarizes what asks for it
    const servers = loadSettings().servers.map((server) => (server.kind === 'groq' ? { ...server, text: 'openai/gpt-oss-120b' } : server));
    saveSettings({ ...loadSettings(), servers: [servers.find((server) => server.kind === 'groq')!, ...servers.filter((server) => server.kind !== 'groq')] });

    await summaryParts(service, 's2', sourceId);

    expect(llms.at(-1)).toMatchObject({ provider: 'groq' });

    await service.invoke('setCloudAllowed', { sourceId, allowed: false });
    const parts = await summaryParts(service, 's3', sourceId);

    expect(llms.at(-1)).toEqual({ provider: 'ollama', model: 'qwen3.5:9b', ollamaUrl: DEFAULT_LLM.ollamaUrl });
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
    const { chatId } = await service.invoke('ask', { askId: 's1', chatId: null, question: 'Що з бюджетом?', filters: {}, llm: null });
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
    // An Ollama server without its address, or the same server twice
    await expect(service.invoke('saveSettings', { ...DEFAULT_SETTINGS, servers: [{ ...DEFAULT_SETTINGS.servers[0], url: '' }] })).rejects.toThrow();
    await expect(service.invoke('saveSettings', { ...DEFAULT_SETTINGS, servers: [DEFAULT_SETTINGS.servers[0], DEFAULT_SETTINGS.servers[0]] })).rejects.toThrow();
    expect(loadSettings().server.port).toBe(port);
  });

  it('adds Rocket.Chat with a checked token kept in the keyring, syncs it, and removes it with its token', async () => {
    const server = createFakeRocketChat();
    server.addRoom('general', 'c', 'general');
    server.post('general', 'm1', 'Бюджет на квартал погодили?');
    server.post('general', 'm2', 'Так, у пʼятницю', { tmid: 'm1' });
    const secrets = new Map<string, string>();
    const service = makeService({
      fetch: server.fetch,
      secrets: { get: (name) => secrets.get(name), set: (name, value) => secrets.set(name, value), delete: (name) => secrets.delete(name) },
    });
    await service.start();
    const access = { serverUrl: `${SERVER}/`, userId: USER._id, token: TOKEN };
    const setup = { selection: { mode: 'chosen' as const, ids: ['general'] }, since: 0, limits: FAST };

    await expect(service.invoke('rocketChatCheck', { ...access, token: 'wrong' })).rejects.toThrow('refused the token');
    expect(await service.invoke('rocketChatCheck', access)).toMatchObject({
      user: 'Olena Koval (olena)', rooms: [{ id: 'general', type: 'channel', title: 'general', parent: null }],
    });

    const { sourceId } = await service.invoke('addRocketChat', { ...access, ...setup });

    expect([...secrets.values()]).toEqual([TOKEN]);
    await vi.waitFor(async () => expect((await service.invoke('status', {})).sources.find((source) => source.id === sourceId)).toMatchObject({
      documents: 2, lastError: null, cloudAllowed: false, connector: { running: false, detail: 'olena on chat.example.com · 1 room' },
    }));
    await expect(service.invoke('addRocketChat', { ...access, ...setup })).rejects.toThrow('a source already');

    const thread = `chat:${sourceId}:general:thread:m1`;
    expect(await service.invoke('conversation', { documentId: thread, startMs: 0 })).toMatchObject({ kind: 'thread', cited: { first: 0, last: 1 } });
    // Each room with what the knowledge base has of it
    expect((await service.invoke('rocketChatRooms', { sourceId })).rooms).toMatchObject([{
      id: 'general', members: 2, stats: { messages: 2, threads: 1, reacted: 0, images: 0, files: 0, checkedAt: expect.any(Number) },
    }]);
    expect((await service.invoke('status', {})).sources[0].connector?.summary).toBe('2 messages · 1 thread');
    expect(await service.invoke('chatLink', { documentId: thread, messageId: 'm2' })).toBe('https://chat.example.com/channel/general?msg=m2');
    await expect(service.invoke('updateRocketChat', { sourceId, ...setup, token: 'wrong' })).rejects.toThrow('refused the token');

    await service.invoke('removeSource', { sourceId });

    expect(secrets.size).toBe(0);
    expect((await service.invoke('status', {})).sources).toEqual([]);
  });

  it('tells a refused token from a server not reached, and takes a new token without listing the rooms', async () => {
    const server = createFakeRocketChat();
    server.addRoom('general', 'c', 'general');
    server.post('general', 'm1', 'Бюджет на квартал погодили?');
    const secrets = new Map<string, string>();
    let offline = false;
    const service = makeService({
      fetch: (input, init) => (offline ? Promise.reject(new TypeError('fetch failed')) : server.fetch(input, init)),
      secrets: { get: (name) => secrets.get(name), set: (name, value) => secrets.set(name, value), delete: (name) => secrets.delete(name) },
    });
    await service.start();
    const { sourceId } = await service.invoke('addRocketChat', {
      serverUrl: SERVER, userId: USER._id, token: TOKEN, selection: { mode: 'chosen', ids: ['general'] }, since: 0, limits: FAST,
    });
    const source = async () => (await service.invoke('status', {})).sources.find((candidate) => candidate.id === sourceId);
    await vi.waitFor(async () => expect(await source()).toMatchObject({ lastError: null, connector: { running: false, problem: null } }));

    offline = true;
    await service.invoke('syncSource', { sourceId });
    await vi.waitFor(async () => expect(await source()).toMatchObject({ lastError: expect.stringContaining('didn\'t answer'), connector: { problem: 'network' } }));

    // The token revoked in Rocket.Chat
    offline = false;
    const [name] = secrets.keys();
    secrets.set(name, 'revoked');
    await service.invoke('syncSource', { sourceId });
    await vi.waitFor(async () => expect(await source()).toMatchObject({ lastError: expect.stringContaining('refused the token'), connector: { problem: 'auth' } }));

    await expect(service.invoke('setRocketChatToken', { sourceId, token: 'wrong' })).rejects.toThrow('refused the token');
    await service.invoke('setRocketChatToken', { sourceId, token: TOKEN });

    expect(secrets.get(name)).toBe(TOKEN);
    await vi.waitFor(async () => expect(await source()).toMatchObject({ lastError: null, connector: { running: false, problem: null } }));
  });

  it('drafts replies to the messages to the user once turned on, and closes a draft answered in Rocket.Chat', async () => {
    model = mockModel('Так, бюджет погодили [1].', []);
    const server = createFakeRocketChat({ start: Date.now() - 3_600_000 });
    server.addRoom('general', 'c', 'general');
    server.addRoom('dm-andrii', 'd', 'andrii', 'Andrii Melnyk');
    server.post('general', 'm1', 'Всім привіт');
    server.post('general', 'm2', '@olena бюджет погодили?', { mentions: [{ _id: USER._id, username: USER.username }] });
    server.post('dm-andrii', 'm3', 'Скинь звіт, будь ласка');
    const secrets = new Map<string, string>();
    const service = makeService({
      fetch: server.fetch,
      secrets: { get: (name) => secrets.get(name), set: (name, value) => secrets.set(name, value), delete: (name) => secrets.delete(name) },
    });
    await service.start();
    const { sourceId } = await service.invoke('addRocketChat', {
      serverUrl: SERVER, userId: USER._id, token: TOKEN, selection: { mode: 'chosen', ids: ['general', 'dm-andrii'] }, since: 0, limits: FAST,
    });
    const source = async () => (await service.invoke('status', {})).sources.find((candidate) => candidate.id === sourceId);
    await vi.waitFor(async () => expect(await source()).toMatchObject({ lastSyncAt: expect.any(Number), connector: { running: false } }));

    expect(await service.invoke('drafts', {})).toEqual([]);

    await service.invoke('setRepliesEnabled', { sourceId, enabled: true });
    await vi.waitFor(async () => expect((await service.invoke('status', {})).drafts).toMatchObject({ ready: 2, waiting: 0 }), { timeout: 5000 });
    const drafts = await service.invoke('drafts', {});

    expect(drafts.map(({ conversation, reason, state, text }) => ({ conversation, reason, state, text })).sort((a, b) => a.reason.localeCompare(b.reason)))
      .toEqual([
        { conversation: 'direct: Andrii Melnyk', reason: 'direct', state: 'ready', text: 'Так, бюджет погодили [1].' },
        { conversation: '#general', reason: 'mention', state: 'ready', text: 'Так, бюджет погодили [1].' },
      ]);
    expect(drafts.find((draft) => draft.reason === 'mention')!.messages.map((message) => message.text)).toEqual(['Всім привіт', '@olena бюджет погодили?']);

    // Answered in Rocket.Chat: gone after the next sync
    server.post('general', 'm4', 'Так, погодили', { author: { username: USER.username, name: USER.name } });
    await service.invoke('syncSource', { sourceId });
    await vi.waitFor(async () => expect((await service.invoke('drafts', {})).map((draft) => draft.reason)).toEqual(['direct']));

    const [direct] = await service.invoke('drafts', {});
    await service.invoke('draftAction', { draftId: direct.id, action: 'dismiss' });
    expect(await service.invoke('drafts', {})).toEqual([]);
    expect((await service.invoke('status', {})).drafts).toMatchObject({ ready: 0, waiting: 0 });

    // Asked for by hand, though answered: #general's last message from someone else
    const conversations = await service.invoke('draftableConversations', {});
    expect(conversations.map(({ conversation, last, drafted }) => [conversation, last.text, drafted]))
      .toEqual([['direct: Andrii Melnyk', 'Скинь звіт, будь ласка', false], ['#general', '@olena бюджет погодили?', false]]);

    await service.invoke('requestDraft', { sourceId, roomId: 'general', threadId: null });
    await vi.waitFor(async () => expect((await service.invoke('drafts', {})).map(({ reason, state }) => [reason, state])).toEqual([['manual', 'ready']]));
  });

  it('writes while the background work is paused only the drafts the user asked for, and keeps the pause out of the settings form', async () => {
    model = mockModel('Скину ввечері.', []);
    const server = createFakeRocketChat({ start: Date.now() - 3_600_000 });
    server.addRoom('dm-andrii', 'd', 'andrii', 'Andrii Melnyk');
    server.post('dm-andrii', 'm1', 'Скинь звіт, будь ласка');
    const secrets = new Map<string, string>();
    const service = makeService({
      fetch: server.fetch,
      secrets: { get: (name) => secrets.get(name), set: (name, value) => secrets.set(name, value), delete: (name) => secrets.delete(name) },
    });
    await service.start();
    const { sourceId } = await service.invoke('addRocketChat', {
      serverUrl: SERVER, userId: USER._id, token: TOKEN, selection: { mode: 'chosen', ids: ['dm-andrii'] }, since: 0, limits: FAST,
    });
    await vi.waitFor(async () => expect((await service.invoke('status', {})).sources[0]).toMatchObject({ lastSyncAt: expect.any(Number) }));

    await service.invoke('pauseBackground', { minutes: 60 });
    expect(await service.invoke('getSettings', {})).not.toHaveProperty('backgroundPaused');

    await service.invoke('setRepliesEnabled', { sourceId, enabled: true });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const [waiting] = await service.invoke('drafts', {});
    expect(waiting).toMatchObject({ reason: 'direct', state: 'waiting', asked: false });

    await service.invoke('draftAction', { draftId: waiting.id, action: 'rewrite' });
    await vi.waitFor(async () => expect((await service.invoke('drafts', {}))[0]).toMatchObject({ state: 'ready', text: 'Скину ввечері.', asked: true }));
  });

  it('tries a summary model on a meeting without keeping it, and only Ollama for a source that may not go to cloud AI', async () => {
    model = mockModel('{}', ['- Погодили ', 'бюджет']);
    const { service, sourceId } = await startWithMeetings();
    const [meeting] = await service.invoke('summaryTryMeetings', {});
    expect(meeting).toMatchObject({ sourceId, lines: expect.any(Number), saved: null });

    const params = { tryId: 't1', sourceId, sessionId: meeting.sessionId };
    const tried = await service.invoke('trySummary', { ...params, llm: DEFAULT_LLM });
    expect(tried).toMatchObject({ llm: `ollama ${DEFAULT_LLM.model}`, local: true, text: '- Погодили бюджет', calls: 1, ms: expect.any(Number) });
    expect((await service.invoke('summaryTryMeetings', {}))[0].saved).toBeNull();

    await service.invoke('setCloudAllowed', { sourceId, allowed: false });
    await expect(service.invoke('trySummary', { ...params, tryId: 't2', llm: { ...DEFAULT_LLM, provider: 'groq', model: 'openai/gpt-oss-120b' } }))
      .rejects.toThrow('may not go to cloud AI');
  });

  it('keeps a browser\'s browser as chosen, else guesses it from its label, and renames it', async () => {
    const { service, sourceId } = await startWithMeetings();
    const { sourceId: other } = await service.invoke('addBrowser', { label: 'Work laptop', browser: 'brave' });
    const { sourceId: guessed } = await service.invoke('addBrowser', { label: 'Firefox2' });
    const browsers = async () => (await service.invoke('status', {})).sources.map(({ id, account, browser, meetings }) => ({ id, account, browser, meetings }));

    expect(await browsers()).toEqual([
      { id: sourceId, account: 'Chrome', browser: 'chrome', meetings: 2 },
      { id: other, account: 'Work laptop', browser: 'brave', meetings: 0 },
      { id: guessed, account: 'Firefox2', browser: 'firefox', meetings: 0 },
    ]);

    await service.invoke('updateBrowser', { sourceId, label: ' Home ', browser: 'edge' });

    expect((await browsers())[0]).toEqual({ id: sourceId, account: 'Home', browser: 'edge', meetings: 2 });
    await expect(service.invoke('updateBrowser', { sourceId: 999, label: 'X', browser: 'other' })).rejects.toThrow('No browser source');
  });

  describe('chat files', () => {
    const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

    // Rocket.Chat with an image, a PDF and an archive in #general, files of any time read
    const startWithFiles = async (onFetch?: (url: string) => void, answer?: (url: string) => Response | undefined) => {
      saveSettings({ ...DEFAULT_SETTINGS, server: { port }, attachments: { ...DEFAULT_SETTINGS.attachments, months: 0 } });
      const server = createFakeRocketChat();
      server.addRoom('general', 'c', 'general');
      server.upload('general', 'm1', 'Дивіться, що на проді', { id: 'f1', name: 'screen.png', type: 'image/png', bytes: PNG });
      server.upload('general', 'm2', 'Звіт за квартал', { id: 'f2', name: 'report.pdf', type: 'application/pdf', bytes: tinyPdf('Budget 2026 approved') });
      server.upload('general', 'm3', 'Архів', { id: 'f3', name: 'logs.zip', type: 'application/zip', bytes: PNG });
      const secrets = new Map<string, string>();
      const service = makeService({
        fetch: async (input, init) => {
          onFetch?.(String(input));

          return answer?.(String(input)) ?? server.fetch(input, init);
        },
        secrets: { get: (name) => secrets.get(name), set: (name, value) => secrets.set(name, value), delete: (name) => secrets.delete(name) },
      });
      await service.start();
      const { sourceId } = await service.invoke('addRocketChat', {
        serverUrl: SERVER, userId: USER._id, token: TOKEN, selection: { mode: 'all', types: ['channel'] }, since: 0, limits: FAST,
      });

      return { service, sourceId };
    };

    const chunkTexts = async (service: KbService, documentId: string) => (await service.invoke('conversation', { documentId, startMs: 0 }))?.messages;

    it('reads an image with the vision model and a PDF\'s text, into the search, and shows them', async () => {
      model = mockModel('TEXT: Error 500 at /api/orders\nDESCRIPTION: Скріншот помилки сервера', []);
      const { service, sourceId } = await startWithFiles();

      await vi.waitFor(async () => expect((await service.invoke('status', {})).attachments).toMatchObject({ done: 2, pending: 0, running: false }), { timeout: 5000 });
      // The image's time, for the average of the server's model
      expect((await service.invoke('status', {})).attachments.images).toMatchObject({
        pending: 0, servers: [{ name: 'This computer', work: null, wait: null, averageMs: expect.any(Number) }], waiting: null,
      });

      const day = `chat:${sourceId}:general:2026-11-10`;
      const messages = await chunkTexts(service, day);
      expect(messages?.[0].attachments).toEqual([{
        id: 'f1', name: 'screen.png', kind: 'image', state: 'done', description: 'Скріншот помилки сервера', text: 'Error 500 at /api/orders',
      }]);
      // The archive isn't read: only its name is in the chunk
      expect(messages?.[2].attachments).toEqual([]);
      // As base64: ollama-ai-provider-v2 sent bytes as a JSON object, which Ollama refused
      expect(model.doGenerateCalls.some((call) => JSON.stringify(call.prompt).includes(`"data":"${Buffer.from(PNG).toString('base64')}"`))).toBe(true);

      const ask = await askParts(service, 'a1', { question: 'Яка помилка на проді?' });
      const sources = ask.parts.find((part) => part.kind === 'sources') as Extract<AskPart, { kind: 'sources' }>;
      const imageSource = sources.sources.find((source) => source.documentId === day);
      expect(imageSource?.text).toContain('Andrii Melnyk: Дивіться, що на проді [image screen.png, described by AI: Скріншот помилки сервера Text in it: Error 500 at /api/orders]');

      // The PDF's text is a document of its own, which opens its message
      const file = `chat:${sourceId}:general:file:f2`;
      expect((await service.invoke('conversation', { documentId: file, startMs: null }))?.cited).toEqual({ first: 1, last: 1 });
      const pdf = await askParts(service, 'a2', { question: 'Budget 2026 approved' });
      expect((pdf.parts.find((part) => part.kind === 'sources') as Extract<AskPart, { kind: 'sources' }>).sources.map((source) => source.documentId))
        .toContain(file);

      // The image is kept next to the knowledge base, and shown from it
      expect(existsSync(join(dir, 'attachments', String(sourceId), 'f1'))).toBe(true);
      expect(await service.invoke('attachmentImage', { sourceId, fileId: 'f1' })).toBe(`data:image/png;base64,${Buffer.from(PNG).toString('base64')}`);

      expect(await service.invoke('recentImages', {})).toEqual([{ sourceId, fileId: 'f1', name: 'screen.png', ts: expect.any(Number), room: '#general' }]);
      const tried = await service.invoke('tryImageModel', { sourceId, fileId: 'f1', model: { provider: 'ollama', model: 'gemma3:4b', ollamaUrl: DEFAULT_LLM.ollamaUrl } });
      expect(tried).toMatchObject({ description: 'Скріншот помилки сервера', model: 'ollama gemma3:4b' });
      // F8: the chat may not go to cloud AI
      await expect(service.invoke('tryImageModel', { sourceId, fileId: 'f1', model: { provider: 'gemini', model: 'gemini-2.5-flash', ollamaUrl: DEFAULT_LLM.ollamaUrl } }))
        .rejects.toThrow('may not go to cloud AI');

      expect(await service.invoke('readImagesAgain', {})).toEqual({ images: 1 });
      await vi.waitFor(async () => expect((await service.invoke('status', {})).attachments).toMatchObject({ done: 2, pending: 0, running: false }), { timeout: 5000 });
    });

    it('says a model that doesn\'t read images can\'t, leaving the images waiting and the documents read', async () => {
      // As an Orange Pi's RKLLama says of its text models
      const { service, sourceId } = await startWithFiles(undefined, (url) => (url.endsWith('/api/show') ? Response.json({ capabilities: ['completion'] }) : undefined));

      await vi.waitFor(async () => expect((await service.invoke('status', {})).attachments).toMatchObject({
        done: 1, pending: 1, failed: 0, error: expect.stringContaining('doesn\'t read images'),
      }), { timeout: 4000 });
      // The Activity page says why the image waits, and that it waits for this computer
      const { attachments, ai } = await service.invoke('status', {});
      const noVision = { reason: 'noVision', server: 'This computer', retryAt: expect.any(Number) };
      expect(attachments.images).toMatchObject({ pending: 1, servers: [{ name: 'This computer', work: null, wait: noVision }], waiting: noVision });
      expect(ai.lanes[0]).toMatchObject({
        name: 'This computer', id: DEFAULT_LLM.ollamaUrl, now: null, asked: false, retryAt: null, queue: true, takes: ['drafts', 'images', 'summaries'],
      });
      await expect(service.invoke('tryImageModel', { sourceId, fileId: 'f1', model: DEFAULT_LLM }))
        .rejects.toThrow('qwen3.5:9b on This computer doesn\'t read images');
    });

    it('waits while the vision model isn\'t there, without counting it against the file', async () => {
      model = new MockLanguageModelV3({
        doGenerate: async () => {
          throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:11434') });
        },
      });
      const { service } = await startWithFiles();

      await vi.waitFor(async () => expect((await service.invoke('status', {})).attachments.error).toContain('fetch failed'), { timeout: 5000 });
      expect((await service.invoke('status', {})).attachments).toMatchObject({ pending: 1, failed: 0 });
    });

    it('pauses reading images, stopping the one being read and letting go of the model, and goes on when resumed', async () => {
      let block = true;
      model = new MockLanguageModelV3({
        doGenerate: async ({ abortSignal }) => {
          if (block) {
            await new Promise((_resolve, reject) => abortSignal?.addEventListener('abort', () => reject(new Error('Aborted'))));
          }

          return { content: [{ type: 'text', text: 'TEXT: none\nDESCRIPTION: Скріншот' }], finishReason: FINISH, usage: USAGE, warnings: [] };
        },
      });
      const calls: string[] = [];
      const { service } = await startWithFiles((url) => calls.push(url));

      await vi.waitFor(async () => expect((await service.invoke('status', {})).attachments.running).toBe(true));
      await service.invoke('pauseBackground', { minutes: null });
      block = false;

      // The document is read; the image waits, not counted as failed
      await vi.waitFor(async () => expect((await service.invoke('status', {})).attachments).toMatchObject({
        done: 1, pending: 1, failed: 0, running: false, paused: { until: null },
      }), { timeout: 5000 });
      expect(calls.some((url) => url.endsWith('/api/generate'))).toBe(true);

      await service.invoke('resumeBackground', {});
      await vi.waitFor(async () => expect((await service.invoke('status', {})).attachments).toMatchObject({ done: 2, pending: 0, paused: null }), { timeout: 5000 });
    });
  });

  it('asks with a chat\'s own model, kept with the chat, and lists the models to choose from', async () => {
    const {ollamaUrl} = DEFAULT_LLM;
    const ollama: typeof fetch = async (input, init) => {
      const url = String(input);

      if (url.endsWith('/api/tags')) {
        return Response.json({ models: [{ name: 'qwen3.5:9b' }, { name: 'gemma3:4b' }, { name: 'bge-m3' }, { name: 'bge-reranker' }] });
      }

      const { model: name } = JSON.parse(String(init?.body)) as { model: string };
      const capabilities = { 'bge-m3': ['embedding'], 'bge-reranker': ['completion'] }[name] ?? ['completion', 'vision'];

      return Response.json({ capabilities });
    };
    const service = makeService({ fetch: ollama, secrets: { get: () => undefined, set: () => undefined, delete: () => undefined } });
    await service.start();

    // Neither the embedding model nor the reranker; no Groq or Gemini without their key
    const here = { provider: 'ollama' as const, ollamaUrl, server: 'This computer', local: true };
    expect(await service.invoke('chatModels', {})).toEqual([{ ...here, model: 'qwen3.5:9b' }, { ...here, model: 'gemma3:4b' }]);
    // The embedding models: only Ollama's that embed, and none of Gemini's without its key; the vision models: those
    // that say they read images
    expect(await service.invoke('taskModels', { task: 'embeddings' })).toEqual([{ ...here, model: 'bge-m3' }]);
    expect(await service.invoke('taskModels', { task: 'images' })).toEqual([{ ...here, model: 'gemma3:4b' }, { ...here, model: 'qwen3.5:9b' }]);

    const gemma = { provider: 'ollama' as const, model: 'gemma3:4b', ollamaUrl };
    const { chatId, parts } = await askParts(service, 'm1', { question: 'Що з бюджетом?', llm: gemma });

    expect(llms.at(-1)).toEqual(gemma);
    expect(parts.find((part) => part.kind === 'sources')).toMatchObject({ llm: 'ollama gemma3:4b', local: true });
    expect((await service.invoke('chat', { chatId }))?.llm).toEqual(gemma);

    // Its calls are kept by the model and server that made them
    expect((await service.invoke('aiUsage', { since: null })).models)
      .toContainEqual(expect.objectContaining({ provider: 'ollama', model: 'gemma3:4b', server: 'This computer' }));
  });

  it('lists every server\'s models, answers on the next server when the first isn\'t reached, and turns a queue off', async () => {
    const PI = 'http://127.0.0.1:11435';
    let piUp = true;
    const servers: typeof fetch = async (input) => {
      const url = String(input);

      if (url.startsWith(PI) && !piUp) {
        throw new TypeError('fetch failed');
      }

      if (url.endsWith('/api/version')) {
        return Response.json({ version: '0.1' });
      }

      if (url.endsWith('/api/tags')) {
        return Response.json({ models: [{ name: url.startsWith(PI) ? 'qwen3.5-4b' : 'qwen3.5:9b' }] });
      }

      return Response.json({ capabilities: ['completion'] });
    };
    // The Orange Pi first: it answers the chat
    const orangePi = { name: 'Orange Pi', kind: 'ollama' as const, url: PI, text: 'qwen3.5-4b', images: '', queue: true };
    saveSettings({ ...loadSettings(), servers: [orangePi, ...DEFAULT_SETTINGS.servers] });
    const service = makeService({ fetch: servers, secrets: { get: () => undefined, set: () => undefined, delete: () => undefined } });
    await service.start();

    expect((await service.invoke('chatModels', {})).map((choice) => `${choice.server} ${choice.model}`)).toEqual(['Orange Pi qwen3.5-4b', 'This computer qwen3.5:9b']);
    expect(await service.invoke('serverModels', { kind: 'ollama', url: PI })).toEqual({ reachable: true, text: ['qwen3.5-4b'], images: [] });
    // No Groq models without its key
    expect(await service.invoke('serverModels', { kind: 'groq', url: '' })).toEqual({ reachable: false, text: [], images: [] });

    // The Orange Pi off: the next server with a text model answers
    piUp = false;
    expect(await service.invoke('serverModels', { kind: 'ollama', url: PI })).toEqual({ reachable: false, text: [], images: [] });
    await askParts(service, 'p1', { question: 'Що з бюджетом?' });
    expect(llms.at(-1)).toEqual(DEFAULT_LLM);

    // Its queue off: the background work is this computer's alone
    await service.invoke('setServerQueue', { server: PI, queue: false });
    expect(loadSettings().servers[0]).toMatchObject({ name: 'Orange Pi', queue: false });
    expect((await service.invoke('status', {})).ai).toMatchObject({
      lanes: [
        { name: 'Orange Pi', id: PI, reachable: false, queue: false, takes: ['drafts', 'summaries'] },
        { name: 'This computer', reachable: true, queue: true, takes: ['drafts', 'images', 'summaries'] },
        { name: 'Groq', takes: [] },
        { name: 'Gemini', takes: [] },
        { name: 'Claude', kind: 'anthropic', reachable: false, takes: [] },
      ],
      answers: { server: 'This computer', model: 'qwen3.5:9b' },
    });
    await expect(service.invoke('setServerQueue', { server: 'http://nowhere', queue: true })).rejects.toThrow('No such server');
  });

  it('lists Claude\'s models with its key, newest first, for text and images alike', async () => {
    let asked: Headers | null = null;
    const service = makeService({
      fetch: async (input, init) => {
        if (String(input).startsWith('https://api.anthropic.com/v1/models')) {
          asked = new Headers(init?.headers);

          return Response.json({ data: [{ id: 'claude-opus-5-5' }, { id: 'claude-sonnet-5-5' }, { id: 'claude-haiku-5-5' }], has_more: false });
        }

        throw new TypeError('fetch failed');
      },
      secrets: { get: (name) => (name === 'llm:anthropic' ? 'sk-ant-test' : undefined), set: () => undefined, delete: () => undefined },
    });
    await service.start();

    const models = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
    expect(await service.invoke('serverModels', { kind: 'anthropic', url: '' })).toEqual({ reachable: true, text: models, images: models });
    expect(asked!.get('x-api-key')).toBe('sk-ant-test');
    expect(asked!.get('anthropic-version')).toBe('2023-06-01');
    expect((await service.invoke('chatModels', {})).filter((model) => model.provider === 'anthropic').map((model) => model.model)).toEqual(models);
  });

  it('says what a cloud provider answered when it refuses to list its models', async () => {
    const service = makeService({
      fetch: async (input) => (String(input).startsWith('https://api.anthropic.com/')
        ? Response.json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, { status: 401 })
        : Promise.reject(new TypeError('fetch failed'))),
      secrets: { get: (name) => (name === 'llm:anthropic' ? 'sk-ant-wrong' : undefined), set: () => undefined, delete: () => undefined },
    });
    await service.start();

    expect(await service.invoke('serverModels', { kind: 'anthropic', url: '' })).toEqual({
      reachable: false, text: [], images: [], error: 'Claude answered 401: invalid x-api-key',
    });
  });

  it('puts a summary back to wait when its server\'s queue is turned off in the middle of it', async () => {
    saveSettings({ ...DEFAULT_SETTINGS, server: { port }, summaries: { auto: true, months: 0 } });
    // A summary that goes on until it's stopped
    model = new MockLanguageModelV3({
      // Stopped before it's called, as fetch with an aborted signal is
      doStream: ({ abortSignal }) => new Promise((_resolve, reject) => {
        if (abortSignal?.aborted) {
          reject(new Error('Aborted'));
        }

        abortSignal?.addEventListener('abort', () => reject(new Error('Aborted')));
      }),
    });
    const { service } = await startWithMeetings();
    await service.invoke('saveMeetingSeries', { name: 'Weekly planning', matchers: [{ code: 'abc-defg-hij' }] });
    await vi.waitFor(async () => expect((await service.invoke('status', {})).summaries.running).toBe(true), { timeout: 4000 });

    await service.invoke('setServerQueue', { server: DEFAULT_LLM.ollamaUrl, queue: false });

    await vi.waitFor(async () => expect((await service.invoke('status', {})).summaries).toMatchObject({ running: false, pending: 1, skipped: 0, error: null }));
    expect((await service.invoke('status', {})).summaries.waiting).toMatchObject({ reason: 'noServer' });
  });

  it('waits out a rate limit instead of skipping the meeting, and says until when', async () => {
    saveSettings({ ...DEFAULT_SETTINGS, server: { port }, summaries: { auto: true, months: 0 } });
    // As Gemini's free tier refuses: the minute's quota, try again in 37 seconds
    model = new MockLanguageModelV3({
      doStream: async () => {
        throw Object.assign(new Error('You exceeded your current quota'), {
          statusCode: 429,
          responseBody: JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', details: [{ retryDelay: '37s' }] } }),
        });
      },
    });
    const { service } = await startWithMeetings();
    await service.invoke('saveMeetingSeries', { name: 'Weekly planning', matchers: [{ code: 'abc-defg-hij' }] });

    await vi.waitFor(async () => expect((await service.invoke('status', {})).ai.lanes[0].limited).toMatchObject({ daily: false }), { timeout: 4000 });
    const { summaries, ai } = await service.invoke('status', {});
    expect(ai.lanes[0].limited!.until).toBeGreaterThan(Date.now() + 30_000);
    // The meeting waits, not skipped until a restart
    expect(summaries).toMatchObject({ pending: 1, skipped: 0, waiting: { reason: 'limited', server: 'This computer' } });
  });

  it('shares the background summaries between the servers with their queue on, each meeting once', async () => {
    const PI = 'http://127.0.0.1:11435';
    const orangePi = { name: 'Orange Pi', kind: 'ollama' as const, url: PI, text: 'qwen3.5-9b', images: '', queue: true };
    saveSettings({ ...DEFAULT_SETTINGS, server: { port }, servers: [...DEFAULT_SETTINGS.servers, orangePi], summaries: { auto: true, months: 0 } });
    // Slow enough that both servers are at work at once
    let working = 0;
    let most = 0;
    model = new MockLanguageModelV3({
      doStream: async () => {
        working += 1;
        most = Math.max(most, working);
        await new Promise((resolve) => {
          setTimeout(resolve, 300);
        });
        working -= 1;

        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 't' },
              { type: 'text-delta', id: 't', delta: '- Погодили бюджет' },
              { type: 'text-end', id: 't' },
              { type: 'finish', finishReason: FINISH, usage: USAGE },
            ],
          }),
        };
      },
    });
    const service = await startService();
    const { token } = await service.invoke('addBrowser', { label: 'Chrome' });
    // A second meeting of the series, a week later
    const [first] = FIXTURE.bundles as { session: { sessionId: string, stenogramaArray: { timestamp: number }[] } }[];
    const week = 7 * 24 * 60 * 60_000;
    const later = {
      ...first,
      session: {
        ...first.session,
        sessionId: '2026/10/27 10:00:00 -> /abc-defg-hij',
        stenogramaArray: first.session.stenogramaArray.map((line) => ({ ...line, timestamp: line.timestamp + week })),
      },
    };
    expect((await push(token, { ...FIXTURE, bundles: [...FIXTURE.bundles, later] })).status).toBe(200);
    await service.invoke('saveMeetingSeries', { name: 'Weekly planning', matchers: [{ code: 'abc-defg-hij' }] });

    // Activity tells what each server summarizes
    const making = { title: expect.stringMatching(/^Weekly planning/), step: { done: 0, all: 1 } };
    await vi.waitFor(async () => expect((await service.invoke('status', {})).summaries.servers).toMatchObject([
      { name: 'This computer', work: { ...making, server: 'This computer' } },
      { name: 'Orange Pi', work: { ...making, model: 'qwen3.5-9b', server: 'Orange Pi' } },
    ]), { timeout: 4000, interval: 20 });
    await vi.waitFor(async () => expect((await service.invoke('status', {})).summaries).toMatchObject({ done: 2, pending: 0, running: false }), { timeout: 4000 });
    expect(most).toBe(2);
    expect(new Set(llms.filter((llm) => llm.model !== 'qwen3.5:9b' || llm.ollamaUrl !== PI).map((llm) => llm.ollamaUrl))).toEqual(new Set([DEFAULT_LLM.ollamaUrl, PI]));
    // Each meeting summarized once, and listed with the summary it made
    expect((await service.invoke('aiUsage', { since: null })).tasks.find((row) => row.task === 'summary')).toMatchObject({ calls: 2, errors: 0 });
    const groups = await service.invoke('aiCalls', { since: null, task: 'summary' });
    expect(new Set(groups.map((group) => group.item)).size).toBe(2);
    expect(groups.every((group) => group.title?.startsWith('Weekly planning ('))).toBe(true);
    expect(await service.invoke('aiCallResult', { item: groups[0].item })).toMatchObject({ kind: 'summary', text: '- Погодили бюджет' });
  });

  it('asks again without a filter the rewrite took from the question', async () => {
    model = mockModel('{"query": "бюджет", "from": "2026-11-12", "to": "2026-11-12", "person": "Олена", "room": "general"}', ['Ок']);
    const service = await startService();
    const request = async (askId: string, without?: RewriteFilter[]) => (await askParts(service, askId, { question: 'Що Олена казала про бюджет сьогодні?', without }))
      .parts.find((part) => part.kind === 'request');

    expect(await request('w1')).toMatchObject({ person: 'Олена', room: 'general', from: expect.any(Number), to: expect.any(Number) });

    const again = await request('w2', ['dates', 'room']);
    expect(again).toMatchObject({ person: 'Олена' });
    expect(again).not.toHaveProperty('from');
    expect(again).not.toHaveProperty('room');
  });

  it('summarizes a named series\'s meetings in the background, and answers a question about the series from them', async () => {
    saveSettings({ ...DEFAULT_SETTINGS, server: { port }, summaries: { auto: true, months: 0 } });
    model = mockModel('{"query": "що обговорювали", "from": null, "to": null, "person": null, "series": "Weekly planning"}', ['- Погодили ', 'бюджет на квартал']);
    const { service } = await startWithMeetings();

    expect((await service.invoke('meetingSeries', {})).suggestions[0]).toMatchObject({ code: 'abc-defg-hij', seriesId: null });

    await service.invoke('saveMeetingSeries', { name: 'Weekly planning', matchers: [{ code: 'abc-defg-hij' }] });
    await vi.waitFor(async () => expect((await service.invoke('status', {})).summaries).toMatchObject({ done: 1, pending: 0, running: false }), { timeout: 5000 });
    expect((await service.invoke('status', {})).summaries).toMatchObject({
      servers: [{ name: 'This computer', work: null, wait: null, averageMs: expect.any(Number) }], skipped: 0, error: null, waiting: null,
    });
    expect((await service.invoke('meetingSeries', {})).series).toMatchObject([{ name: 'Weekly planning', meetings: 1, summarized: 1 }]);

    const { parts } = await askParts(service, 's1', { question: 'Що обговорювали на weekly planning?' });
    const sources = parts.find((part) => part.kind === 'sources') as Extract<AskPart, { kind: 'sources' }>;

    expect(parts.find((part) => part.kind === 'request')).toMatchObject({ series: 'Weekly planning' });
    expect(sources.sources.map((source) => [source.documentKind, source.title])).toEqual([['meeting-short-summary', 'Weekly planning']]);
  });
});
