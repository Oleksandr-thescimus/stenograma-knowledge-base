import { z } from 'zod';
import { prepareAnswer, streamAnswer } from './answer/answer.ts';
import { rewriteQuestion } from './answer/rewrite.ts';
import { BROWSER_KIND, createBrowserSource } from './browsers.ts';
import {
  addTurn, chatExists, chatHistory, createChat, deleteChat, finishTurn, getChat, interruptRunningTurns, listChats,
  saveRequest, saveSources,
} from './chats.ts';
import { getKbId, openDb, type Db } from './db.ts';
import { embeddingModelId, isLocalEmbedding, type EmbeddingProvider } from './embed/provider.ts';
import { embedPending, keepJobsOf, pendingEmbeddings, queueModel } from './embed/store.ts';
import { createConfiguredEmbeddingProvider, createLanguageModel, isLocalLlm, llmKeyName } from './llm.ts';
import { acquireLock } from './lock.ts';
import { dataDir, dbPath, ensureDataDir, lockPath } from './paths.ts';
import type {
  AskPart, ChatTurn, CitedSource, CoreEvent, CoreMethods, CoreStatus, EmbeddingSettings, KeyProvider, SearchFilters,
  ServerStatus, Settings,
} from './protocol.ts';
import { search, type SearchHit } from './search.ts';
import { deleteSecret, getSecret, setSecret } from './secrets.ts';
import { buildServer, stenogramaOpenUrl } from './server.ts';
import { loadSettings, saveSettings, type StoredSettings } from './settings.ts';
import { listSources, removeSource, setCloudAllowed } from './sources.ts';
import { getMeeting } from './stenograma/meeting.ts';

// The core as the app runs it, in a utilityProcess (docs/PLAN.md, M3): it holds the lock, the database, the API for
// the extension and the embedding queue, and answers the methods of protocol.ts. No Electron here, so the tests run it.
// Logs ids, counts and lengths only

export interface ServiceOptions {
  onEvent: (event: CoreEvent) => void;
  log?: (line: string) => void;
  // Tests replace the providers
  createEmbeddingProvider?: (settings: EmbeddingSettings) => EmbeddingProvider;
  createLanguageModel?: typeof createLanguageModel;
  // After a failed embedding run, the queue is tried again (Ollama not running yet)
  retryEmbeddingMs?: number;
}

// The renderer is untrusted (CLAUDE.md), and the main process checks what it passes; this checks again what's written
const EMBEDDING = z.object({ provider: z.enum(['ollama', 'gemini']), model: z.string().trim().min(1), ollamaUrl: z.url() });
const SETTINGS = z.object({
  embedding: EMBEDDING,
  llm: z.object({ provider: z.enum(['groq', 'gemini', 'ollama']), model: z.string().trim().min(1), ollamaUrl: z.url() }),
  server: z.object({ port: z.number().int().min(1024).max(65535) }),
  app: z.object({ startAtLogin: z.boolean() }),
});

// The rewrite sees the chat's last exchanges, to complete a follow-up question
const HISTORY_EXCHANGES = 3;

// A failed batch stops the run at once, so the status says why; the whole queue is tried again after retryEmbeddingMs
const EMBED_OPTIONS = { maxAttempts: 1 };

const sameEmbedding = (a: EmbeddingSettings, b: EmbeddingSettings) => embeddingModelId(a) === embeddingModelId(b)
  && a.ollamaUrl === b.ollamaUrl;

const toCited = ({ n, hit }: { n: number, hit: SearchHit }): CitedSource => ({
  n,
  chunkId: hit.chunkId,
  documentId: hit.documentId,
  sourceId: hit.sourceId,
  sourceKind: hit.sourceKind,
  documentKind: hit.documentKind,
  threadId: hit.threadId,
  title: hit.title,
  createdAt: hit.createdAt,
  startMs: hit.startMs,
  madeByAi: hit.madeByAi,
  text: hit.text,
});

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const createKbService = (options: ServiceOptions) => {
  const { onEvent, log = () => undefined, retryEmbeddingMs = 60_000 } = options;
  const makeEmbedder = options.createEmbeddingProvider ?? createConfiguredEmbeddingProvider;
  const makeModel = options.createLanguageModel ?? createLanguageModel;

  let db: Db | null = null;
  let releaseLock: (() => void) | null = null;
  let server: ReturnType<typeof buildServer> | null = null;
  let serverStatus: ServerStatus = { port: 0, listening: false, error: null };
  const asks = new Map<string, AbortController>();
  let stopping = false;
  const stopController = new AbortController();

  const openedDb = () => {
    if (!db) {
      throw new Error('The knowledge base isn\'t open');
    }

    return db;
  };

  // Embedding: one run at a time; a push or a change during it runs it again after
  let embedRun: Promise<void> | null = null;
  let embedAgain = false;
  let embedRetry: ReturnType<typeof setTimeout> | null = null;
  let embedError: string | null = null;
  let rebuildTotal = 0;

  const status = (): CoreStatus => {
    const current = openedDb();
    const settings = loadSettings();
    const pendingOf = (embedding: EmbeddingSettings) => pendingEmbeddings(current, {
      id: embeddingModelId(embedding), local: isLocalEmbedding(embedding),
    });
    const rebuildPending = settings.embeddingRebuild ? pendingOf(settings.embeddingRebuild) : 0;

    return {
      kbId: getKbId(current),
      dataDir: dataDir(),
      sources: listSources(current),
      embedding: {
        model: embeddingModelId(settings.embedding),
        pending: pendingOf(settings.embedding),
        running: Boolean(embedRun),
        error: embedError,
        rebuild: settings.embeddingRebuild ? {
          model: embeddingModelId(settings.embeddingRebuild),
          pending: rebuildPending,
          total: Math.max(rebuildTotal, rebuildPending),
        } : null,
      },
      server: serverStatus,
    };
  };

  // At most a few times a second while a queue is worked through
  let statusTimer: ReturnType<typeof setTimeout> | null = null;
  const emitStatus = () => {
    if (statusTimer || stopping) {
      return;
    }

    statusTimer = setTimeout(() => {
      statusTimer = null;

      if (db && !stopping) {
        onEvent({ type: 'status', status: status() });
      }
    }, 500);
  };

  const embedActive = async (current: Db, settings: StoredSettings) => {
    const active = makeEmbedder(settings.embedding);
    const done = await embedPending(current, active, { ...EMBED_OPTIONS, abortSignal: stopController.signal, onProgress: emitStatus });

    if (done) {
      log(`embedded ${done} chunks with ${active.id}`);
    }
  };

  // When the model being built has everything, the search switches to it (F7)
  const embedRebuild = async (current: Db, target: EmbeddingSettings) => {
    const rebuilding = makeEmbedder(target);
    queueModel(current, rebuilding.id);
    rebuildTotal = Math.max(rebuildTotal, pendingEmbeddings(current, rebuilding));
    emitStatus();
    await embedPending(current, rebuilding, { ...EMBED_OPTIONS, abortSignal: stopController.signal, onProgress: emitStatus });

    // A change of model while this ran wins
    const latest = loadSettings();

    if (pendingEmbeddings(current, rebuilding) === 0 && latest.embeddingRebuild && sameEmbedding(latest.embeddingRebuild, target)) {
      const { embeddingRebuild: _done, ...rest } = latest;
      saveSettings({ ...rest, embedding: target });
      keepJobsOf(current, [rebuilding.id]);
      rebuildTotal = 0;
      log(`the search now uses ${rebuilding.id}`);
    }
  };

  // The search's model, then the one being built. Each goes on when the other fails: a rebuild away from Gemini runs
  // without its key
  const embedAll = async (current: Db) => {
    const settings = loadSettings();
    const errors: string[] = [];
    const steps = [
      () => embedActive(current, settings),
      ...(settings.embeddingRebuild ? [() => embedRebuild(current, settings.embeddingRebuild!)] : []),
    ];

    for (const step of steps) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await step();
      } catch (error) {
        stopController.signal.throwIfAborted();
        errors.push(messageOf(error));
      }
    }

    if (errors.length) {
      throw new Error(errors.join('; '));
    }
  };

  const runEmbedding = () => {
    if (!db || stopping) {
      return;
    }

    if (embedRun) {
      embedAgain = true;

      return;
    }

    if (embedRetry) {
      clearTimeout(embedRetry);
      embedRetry = null;
    }

    const current = db;
    embedRun = (async () => {
      do {
        embedAgain = false;

        try {
          // eslint-disable-next-line no-await-in-loop
          await embedAll(current);
          embedError = null;
        } catch (error) {
          if (!stopping) {
            embedError = messageOf(error);
            log(`embedding failed: ${embedError}`);
            embedRetry = setTimeout(runEmbedding, retryEmbeddingMs);
          }

          break;
        }
      } while (embedAgain && !stopping);

      embedRun = null;
      emitStatus();
    })();
    emitStatus();
  };

  const startServer = async (current: Db, port: number) => {
    const next = buildServer({
      db: current,
      port,
      embedModel: () => embeddingModelId(loadSettings().embedding),
      onChange: () => {
        emitStatus();
        runEmbedding();
      },
      log,
    });

    try {
      await next.listen({ host: '127.0.0.1', port });
      server = next;
      serverStatus = { port, listening: true, error: null };
      log(`the API for the extension listens on 127.0.0.1:${port}`);
    } catch (error) {
      await next.close();
      const inUse = (error as NodeJS.ErrnoException).code === 'EADDRINUSE';
      serverStatus = { port, listening: false, error: inUse ? `Port ${port} is used by another program` : messageOf(error) };
      log(`the API for the extension couldn't listen on ${port}: ${inUse ? 'in use' : 'error'}`);
    }
  };

  const restartServer = async (port: number) => {
    await server?.close();
    server = null;
    await startServer(openedDb(), port);
  };

  interface Asked {
    askId: string;
    turnId: number;
    question: string;
    history: ChatTurn[];
    filters: SearchFilters;
  }

  const answer = async ({ askId, turnId, question, history, filters }: Asked) => {
    const current = openedDb();
    const controller = new AbortController();
    const send = (part: AskPart) => onEvent({ type: 'ask', askId, part });
    // The core may have stopped meanwhile: the turn is then marked when it starts again
    const save = (write: (opened: Db) => unknown) => {
      if (current.open) {
        write(current);
      }
    };
    let text = '';
    asks.set(askId, controller);

    try {
      const settings = loadSettings();
      const model = makeModel(settings.llm);
      const rewritten = await rewriteQuestion(model, settings.llm, question, history, new Date(), controller.signal);
      controller.signal.throwIfAborted();

      // Filters set by hand win over the rewrite's, which still completes a follow-up question
      const byHand = filters.from !== undefined || filters.to !== undefined;
      const request = {
        ...rewritten,
        ...(byHand && { from: filters.from, to: filters.to }),
        ...(filters.person && { person: filters.person }),
      };
      const requestPart: AskPart = { kind: 'request', ...request };
      send(requestPart);
      save((opened) => saveRequest(opened, turnId, requestPart));

      let provider: EmbeddingProvider | null = null;
      let providerWarning: string | undefined;

      try {
        provider = makeEmbedder(settings.embedding);
      } catch (error) {
        providerWarning = `Searched by words only: ${messageOf(error)}`;
      }

      const { query, ...dates } = request;
      const found = await search(current, query, { ...dates, sourceKind: filters.sourceKind, provider, limit: 20 });
      controller.signal.throwIfAborted();

      const prepared = prepareAnswer(current, settings.llm, question, found.hits, history.length ? query : undefined);
      const sourcesPart: AskPart = {
        kind: 'sources',
        sources: prepared.sources.map(toCited),
        leftOut: prepared.leftOut,
        warning: providerWarning ?? found.warning,
        llm: `${settings.llm.provider} ${settings.llm.model}`,
        local: isLocalLlm(settings.llm),
      };
      send(sourcesPart);
      save((opened) => saveSources(opened, turnId, sourcesPart));

      if (!prepared.sources.length) {
        save((opened) => finishTurn(opened, turnId, { answer: '' }));
        send({ kind: 'done' });

        return;
      }

      let streamError: unknown;
      const result = streamAnswer(model, settings.llm, prepared, (error) => {
        streamError = error;
      }, controller.signal);

      for await (const part of result.textStream) {
        text += part;
        send({ kind: 'text', text: part });
      }

      if (streamError && !controller.signal.aborted) {
        throw streamError;
      }

      save((opened) => finishTurn(opened, turnId, { answer: text }));
      send({ kind: 'done' });
      log(`answered: ${prepared.sources.length} sources, ${text.length} characters`);
    } catch (error) {
      // Stopped by the user, the answer so far is kept; stopped with the app, it's marked unfinished
      const message = stopping ? 'The app stopped before the answer was done' : messageOf(error);
      save((opened) => finishTurn(opened, turnId, { answer: text, ...((stopping || !controller.signal.aborted) && { error: message }) }));
      send(controller.signal.aborted ? { kind: 'done' } : { kind: 'error', message });
    } finally {
      asks.delete(askId);
    }
  };

  const getSettings = (): Settings => {
    const { embeddingRebuild, ...settings } = loadSettings();

    return { ...settings, embedding: embeddingRebuild ?? settings.embedding };
  };

  const methods: { [M in keyof CoreMethods]: (params: CoreMethods[M]['params']) => Promise<CoreMethods[M]['result']> | CoreMethods[M]['result'] } = {
    status,

    ask: ({ askId, chatId, question, filters }) => {
      const current = openedDb();

      if (chatId !== null && !chatExists(current, chatId)) {
        throw new Error('The chat was deleted');
      }

      const id = chatId ?? createChat(current, question);
      const history = chatHistory(current, id, HISTORY_EXCHANGES);
      const turnId = addTurn(current, id, question);
      // Answered in parts, as events; the call itself returns at once
      answer({ askId, turnId, question, history, filters });

      return { chatId: id };
    },

    cancelAsk: ({ askId }) => {
      asks.get(askId)?.abort();

      return null;
    },

    chats: () => listChats(openedDb()),

    chat: ({ chatId }) => getChat(openedDb(), chatId),

    deleteChat: ({ chatId }) => {
      deleteChat(openedDb(), chatId);
      log(`deleted chat ${chatId}`);

      return null;
    },

    meeting: ({ sourceId, sessionId }) => getMeeting(openedDb(), sourceId, sessionId),

    addBrowser: ({ label }) => {
      const { source, token } = createBrowserSource(openedDb(), label.trim() || 'Browser');
      log(`paired a browser as source ${source.id}`);
      emitStatus();

      return { sourceId: source.id, token };
    },

    removeSource: ({ sourceId }) => {
      removeSource(openedDb(), sourceId);
      log(`removed source ${sourceId}`);
      emitStatus();

      return null;
    },

    setCloudAllowed: ({ sourceId, allowed }) => {
      if (!setCloudAllowed(openedDb(), sourceId, allowed)) {
        throw new Error(`No source ${sourceId}`);
      }

      emitStatus();
      // A cloud embedding model may now embed its chunks
      runEmbedding();

      return null;
    },

    getSettings,

    saveSettings: async (params) => {
      const next = SETTINGS.parse(params);
      const stored = loadSettings();
      const saved: StoredSettings = { ...stored, llm: next.llm, server: next.server, app: next.app };

      // A new embedding model is built in the background while the search keeps the current one (F7); choosing the
      // current one again stops a rebuild
      if (sameEmbedding(next.embedding, stored.embedding)) {
        saved.embedding = next.embedding;
        saved.embeddingRebuild = undefined;
      } else if (!stored.embeddingRebuild || !sameEmbedding(next.embedding, stored.embeddingRebuild)) {
        saved.embeddingRebuild = next.embedding;
        rebuildTotal = 0;
      }

      saveSettings(saved);
      keepJobsOf(openedDb(), [saved.embedding, saved.embeddingRebuild].filter((embedding) => embedding !== undefined).map(embeddingModelId));

      if (next.server.port !== serverStatus.port || !serverStatus.listening) {
        await restartServer(next.server.port);
      }

      embedError = null;
      runEmbedding();
      emitStatus();

      return getSettings();
    },

    keys: () => ({ groq: Boolean(getSecret(llmKeyName('groq'))), gemini: Boolean(getSecret(llmKeyName('gemini'))) }),

    setKey: ({ provider, key }: { provider: KeyProvider, key: string }) => {
      setSecret(llmKeyName(provider), key.trim());
      log(`kept the ${provider} key`);
      // Gemini embeddings may have waited for it
      runEmbedding();

      return null;
    },

    deleteKey: ({ provider }) => {
      deleteSecret(llmKeyName(provider));
      log(`removed the ${provider} key`);

      return null;
    },

    stenogramaLink: ({ sourceId, sessionId, startMs }) => {
      const source = listSources(openedDb()).find((candidate) => candidate.id === sourceId);

      if (source?.kind !== BROWSER_KIND) {
        throw new Error('Only a browser\'s meetings open in Stenograma');
      }

      return stenogramaOpenUrl(serverStatus.port || loadSettings().server.port, sourceId, sessionId, startMs);
    },
  };

  return {
    // Takes the lock (kb serve and kb import can't run next to it), opens the knowledge base, starts the API and the
    // embedding queue. Throws when the lock is taken
    start: async () => {
      ensureDataDir();
      releaseLock = acquireLock(lockPath());

      try {
        db = openDb(dbPath());
      } catch (error) {
        releaseLock();
        releaseLock = null;
        throw error;
      }

      const interrupted = interruptRunningTurns(db);

      if (interrupted) {
        log(`${interrupted} answers were cut off when the app last stopped`);
      }

      await startServer(db, loadSettings().server.port);
      runEmbedding();
      onEvent({ type: 'status', status: status() });
    },

    stop: async () => {
      stopping = true;
      stopController.abort();
      asks.forEach((controller) => controller.abort());

      if (embedRetry) {
        clearTimeout(embedRetry);
      }

      if (statusTimer) {
        clearTimeout(statusTimer);
      }

      await server?.close();
      await embedRun;
      db?.close();
      db = null;
      releaseLock?.();
      releaseLock = null;
    },

    invoke: async <M extends keyof CoreMethods>(method: M, params: CoreMethods[M]['params']): Promise<CoreMethods[M]['result']> => {
      const handler = methods[method] as ((params: CoreMethods[M]['params']) => Promise<CoreMethods[M]['result']> | CoreMethods[M]['result']) | undefined;

      if (!handler) {
        throw new Error(`Unknown method ${String(method)}`);
      }

      return handler(params);
    },
  };
};

export type KbService = ReturnType<typeof createKbService>;
