import { z } from 'zod';
import { prepareAnswer, streamAnswer } from './answer/answer.ts';
import { rewriteQuestion } from './answer/rewrite.ts';
import { summarizeTranscript, type SummaryCall } from './answer/summary.ts';
import { BROWSER_KIND, createBrowserSource, renewBrowserToken, updateBrowser } from './browsers.ts';
import {
  addTurn, chatExists, chatHistory, createChat, deleteChat, finishTurn, getChat, interruptRunningTurns, listChats,
  saveRequest, saveSources, setChatLlm,
} from './chats.ts';
import {
  countAttachments, failRead, getAttachment, keepFile, MAX_DOCUMENT_BYTES, MAX_IMAGE_BYTES, nextPending, readImagesAgain,
  readKeptFile, recentImages, saveRead, type AttachmentRow, type PendingFilter,
} from './chat/attachments.ts';
import { describeImage, imageMediaType, readDocument } from './chat/read.ts';
import { findRooms, getConversation, getRoom, indexRead, listRooms, roomLabel, roomStats, topReacted } from './chat/store.ts';
import { createSyncRunner, type SyncRunner } from './connectors/runner.ts';
import { getKbId, openDb, type Db } from './db.ts';
import { embeddingModelId, isLocalEmbedding, type EmbeddingProvider } from './embed/provider.ts';
import { embedPending, keepJobsOf, pendingBySource, pendingEmbeddings, queueModel } from './embed/store.ts';
import { createConfiguredEmbeddingProvider, createLanguageModel, isLocalLlm, llmKeyName } from './llm.ts';
import { acquireLock } from './lock.ts';
import { dataDir, dbPath, ensureDataDir, lockPath } from './paths.ts';
import type {
  AskPart, AttachmentSettings, ChatTurn, CitedSource, CoreEvent, CoreMethods, CoreStatus, EmbeddingSettings, KeyProvider,
  LlmSettings, ModelChoice, RewriteFilter, RocketChatAccess, SearchFilters, ServerStatus, Settings, SummaryPart, SummaryStatus, SyncLimits,
} from './protocol.ts';
import { createRocketChatApi, FileTooLargeError, normalizeServerUrl } from './rocketchat/api.ts';
import { createRocketChatConnector } from './rocketchat/connector.ts';
import { toRoomChoices } from './rocketchat/convert.ts';
import {
  changePeriod, createRocketChatSource, DEFAULT_LIMITS, indexContext, limitsOf, messageLink, readConfig, ROCKETCHAT_KIND, tokenSecretName,
  writeConfig,
} from './rocketchat/sync.ts';
import { hitsOf, search, type SearchHit } from './search.ts';
import { deleteSecret, getSecret, setSecret } from './secrets.ts';
import { buildServer, stenogramaOpenUrl } from './server.ts';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type StoredSettings } from './settings.ts';
import { listSources, removeSource, setCloudAllowed } from './sources.ts';
import { meetingDocumentId, reindexMeeting, reindexMeetings } from './stenograma/ingest.ts';
import { deleteSeries, findSeries, listSeries, saveSeries, seriesSources, seriesSuggestions } from './stenograma/series.ts';
import { getIndexedVersion, getMeeting, meetingHeader, meetingLines, sourceMeetings } from './stenograma/meeting.ts';
import {
  averageSummaryMs, lastSummaryModel, meetingsToSummarize, saveSummary, summaryCounts, textHash,
} from './summaries.ts';

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
  // Tests replace the network (Rocket.Chat) and the keyring
  fetch?: typeof fetch;
  secrets?: SecretStore;
}

export interface SecretStore {
  get: (name: string) => string | undefined;
  set: (name: string, value: string) => void;
  delete: (name: string) => void;
}

const KEYRING: SecretStore = { get: getSecret, set: setSecret, delete: deleteSecret };

// The renderer is untrusted (CLAUDE.md), and the main process checks what it passes; this checks again what's written
const EMBEDDING = z.object({ provider: z.enum(['ollama', 'gemini']), model: z.string().trim().min(1), ollamaUrl: z.url() });
const SETTINGS = z.object({
  summaries: z.object({ auto: z.boolean(), months: z.number().int().min(0).max(120) }),
  attachments: z.object({
    describeImages: z.boolean(),
    provider: z.enum(['ollama', 'gemini']),
    model: z.string().trim().min(1),
    ollamaUrl: z.url(),
    readDocuments: z.boolean(),
    months: z.number().int().min(0).max(120),
  }),
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

// F8: a meeting whose source doesn't allow cloud AI is summarized by Ollama on this computer with its default model,
// when a cloud LLM is chosen; as drafts will be (F9)
const summaryLlm = (settings: LlmSettings, cloudAllowed: boolean): LlmSettings => {
  if (cloudAllowed || isLocalLlm(settings)) {
    return settings;
  }

  const local: LlmSettings = { provider: 'ollama', model: DEFAULT_SETTINGS.llm.model, ollamaUrl: settings.ollamaUrl };

  if (!isLocalLlm(local)) {
    throw new Error('This meeting may not go to cloud AI, and Ollama isn\'t set up on this computer');
  }

  return local;
};

// A chat file is read at most this many times: then it's marked failed. A model or server that isn't there doesn't count
const MAX_READ_ATTEMPTS = 3;
// While an answer or a summary runs, the files wait this long: they use the same model
const READ_YIELD_MS = 30_000;

// A pause of reading images, while it lasts
const activePause = (settings: StoredSettings) => (settings.backgroundPaused && (settings.backgroundPaused.until === null || settings.backgroundPaused.until > Date.now())
  ? settings.backgroundPaused
  : null);

// The start of a period of months back; 0 for all
const monthsBack = (months: number) => {
  const since = new Date();
  since.setMonth(since.getMonth() - months);

  return months ? since.getTime() : 0;
};

// Files of the period set, of the kinds read; images not while paused
const pendingFilter = (settings: StoredSettings): PendingFilter => {
  const { attachments } = settings;
  const since = new Date();
  since.setMonth(since.getMonth() - attachments.months);

  return {
    kinds: [
      ...(attachments.describeImages && !activePause(settings) ? ['image' as const] : []),
      ...(attachments.readDocuments ? ['document' as const] : []),
    ],
    since: attachments.months ? since.getTime() : 0,
  };
};

// The model or the network isn't there: nothing is wrong with the file, which waits
const isUnreachable = (error: unknown) => /ECONNREFUSED|fetch failed|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|didn't answer|Cannot connect/i
  .test(`${messageOf(error)} ${messageOf((error as { cause?: unknown } | null)?.cause ?? '')}`);

// F8, as summaries: an image of a chat that may not go to cloud AI is read by Ollama's default vision model
const visionLlm = (settings: Pick<AttachmentSettings, 'provider' | 'model' | 'ollamaUrl'>, cloudAllowed: boolean): LlmSettings => {
  const chosen: LlmSettings = { provider: settings.provider, model: settings.model, ollamaUrl: settings.ollamaUrl };

  if (cloudAllowed || isLocalLlm(chosen)) {
    return chosen;
  }

  const local: LlmSettings = { provider: 'ollama', model: DEFAULT_SETTINGS.attachments.model, ollamaUrl: settings.ollamaUrl };

  if (!isLocalLlm(local)) {
    throw new Error('This chat may not go to cloud AI, and Ollama isn\'t set up on this computer');
  }

  return local;
};

export const createKbService = (options: ServiceOptions) => {
  const { onEvent, log = () => undefined, retryEmbeddingMs = 60_000, secrets = KEYRING } = options;
  const makeEmbedder = options.createEmbeddingProvider ?? createConfiguredEmbeddingProvider;
  const makeModel = options.createLanguageModel ?? createLanguageModel;

  let db: Db | null = null;
  let releaseLock: (() => void) | null = null;
  let server: ReturnType<typeof buildServer> | null = null;
  let runner: SyncRunner | null = null;
  let serverStatus: ServerStatus = { port: 0, listening: false, error: null };
  const asks = new Map<string, AbortController>();
  const summaries = new Map<string, AbortController>();
  let stopping = false;
  const stopController = new AbortController();

  const openedDb = () => {
    if (!db) {
      throw new Error('The knowledge base isn\'t open');
    }

    return db;
  };

  // A source's own calls keep its limit; checking a token before there's a source, the default one
  const rocketChat = (access: RocketChatAccess, limits: SyncLimits = DEFAULT_LIMITS) => createRocketChatApi(access, {
    fetch: options.fetch, signal: stopController.signal, requestsPerMinute: limits.requestsPerMinute,
  });

  const rocketChatConfig = (sourceId: number) => {
    const current = openedDb();
    const row = current.prepare('select kind from sources where id = ?').get(sourceId) as { kind: string } | undefined;

    if (row?.kind !== ROCKETCHAT_KIND) {
      throw new Error(`No Rocket.Chat source ${sourceId}`);
    }

    return readConfig(current, sourceId);
  };

  const rocketChatToken = (sourceId: number) => {
    const token = secrets.get(tokenSecretName(getKbId(openedDb()), sourceId));

    if (!token) {
      throw new Error('The token isn\'t in the keyring: give it again');
    }

    return token;
  };

  // A source's new token, once Rocket.Chat takes it as the same user's
  const storeRocketChatToken = async (sourceId: number, token: string) => {
    const config = rocketChatConfig(sourceId);
    const me = await rocketChat({ ...config, token: token.trim() }).me();

    if (me._id !== config.userId) {
      throw new Error(`The token belongs to another user than ${config.username}`);
    }

    secrets.set(tokenSecretName(getKbId(openedDb()), sourceId), token.trim());
  };

  // Embedding: one run at a time; a push or a change during it runs it again after
  let embedRun: Promise<void> | null = null;
  let embedAgain = false;
  let embedRetry: ReturnType<typeof setTimeout> | null = null;
  let embedError: string | null = null;
  let rebuildTotal = 0;

  const summaryStatus = (current: Db, settings: StoredSettings, filesPending: number): SummaryStatus => {
    const counts = summaryCounts(current, monthsBack(settings.summaries.months));
    const pending = settings.summaries.auto ? counts.pending ?? 0 : 0;
    const model = summaryRun?.llm ?? lastSummaryModel(current);
    const retrying = attachmentRetry ? backgroundRetry : null;
    const waitingFor = (): SummaryStatus['waitingFor'] => {
      if (summarizing || pending <= unsummarized.size) {
        return null;
      }

      if (activePause(settings)) {
        return 'paused';
      }

      if (asks.size || summaries.size || retrying?.reason === 'answer') {
        return 'answer';
      }

      if (retrying?.reason === 'unreachable') {
        return 'unreachable';
      }

      return attachmentRun || filesPending > 0 ? 'files' : null;
    };
    const waiting = waitingFor();

    return {
      pending,
      done: counts.done ?? 0,
      running: summarizing,
      current: summaryRun,
      averageMs: model ? averageSummaryMs(current, model) : null,
      tokensPerSecond: summaryTokensPerSecond,
      skipped: unsummarized.size,
      error: summaryError,
      waitingFor: waiting,
      retryAt: waiting === 'unreachable' || waiting === 'answer' ? retrying?.at ?? null : null,
    };
  };

  const status = (): CoreStatus => {
    const current = openedDb();
    const settings = loadSettings();
    const pendingOf = (embedding: EmbeddingSettings) => pendingEmbeddings(current, {
      id: embeddingModelId(embedding), local: isLocalEmbedding(embedding),
    });
    const rebuildPending = settings.embeddingRebuild ? pendingOf(settings.embeddingRebuild) : 0;
    const attachments = {
      ...countAttachments(current, { ...pendingFilter(settings), kinds: ['image', 'document'] }),
      running: Boolean(attachmentRun) && !summarizing,
      error: attachmentError,
      paused: activePause(settings),
    };

    return {
      kbId: getKbId(current),
      dataDir: dataDir(),
      sources: (() => {
        const waiting = pendingBySource(current, { id: embeddingModelId(settings.embedding), local: isLocalEmbedding(settings.embedding) });

        return listSources(current).map((source) => ({
          ...source, embeddingsPending: waiting.get(source.id) ?? 0, connector: runner?.info(source.id) ?? null,
        }));
      })(),
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
      attachments,
      summaries: summaryStatus(current, settings, attachments.pending),
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

  // Chat files: one read at a time, the newest first, after answers and summaries. A model or server that isn't there
  // stops the run, which is tried again after a while
  let attachmentRun: Promise<void> | null = null;
  let attachmentAgain = false;
  let attachmentRetry: ReturnType<typeof setTimeout> | null = null;
  let attachmentError: string | null = null;
  // Aborts the image being read, or the meeting being summarized, when the background work is paused
  let imageRead: AbortController | null = null;
  let summarizing = false;
  // The background summary being made, its speed and the last one's error, for the status
  let summaryRun: SummaryStatus['current'] = null;
  let summaryTokensPerSecond: number | null = null;
  let summaryError: string | null = null;
  // Why the background work waits for its timer: an answer going on, or a model not reached
  let backgroundRetry: { at: number, reason: 'answer' | 'unreachable' } | null = null;
  // Meetings whose summary failed in this run of the core: tried again after a restart
  const unsummarized = new Set<string>();
  let pauseTimer: ReturnType<typeof setTimeout> | null = null;

  const sourceCloudAllowed = (sourceId: number) => Boolean((openedDb().prepare('select cloud_allowed as allowed from sources where id = ?')
    .get(sourceId) as { allowed: number } | undefined)?.allowed);

  // Files are fetched one at a time, those shown in the app too
  let downloads: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(fetchIt: () => Promise<T>) => {
    const next = downloads.then(fetchIt, fetchIt);
    downloads = next.catch(() => undefined);

    return next;
  };

  // A chat file from its messenger: the knowledge base's copy of an image when it has one. Whether it was fetched, for
  // the pause after it
  const fetchFile = async (file: AttachmentRow) => {
    const kept = file.kind === 'image' ? readKeptFile(openedDb(), file.sourceId, file.fileId) : null;

    if (kept) {
      return { bytes: new Uint8Array(kept), fetched: false };
    }

    const config = rocketChatConfig(file.sourceId);
    const { bytes } = await oneAtATime(() => rocketChat({ ...config, token: rocketChatToken(file.sourceId) }, limitsOf(config))
      .download(file.path, file.kind === 'image' ? MAX_IMAGE_BYTES : MAX_DOCUMENT_BYTES));

    if (file.kind === 'image') {
      keepFile(openedDb(), file.sourceId, file.fileId, bytes);
    }

    return { bytes, fetched: true };
  };

  const readFile = async (file: AttachmentRow) => {
    const current = openedDb();
    const settings = loadSettings().attachments;

    let fetched = false;

    try {
      const got = await fetchFile(file);
      const { bytes } = got;
      ({ fetched } = got);

      if (file.kind === 'image') {
        const llm = visionLlm(settings, sourceCloudAllowed(file.sourceId));
        imageRead = new AbortController();
        const read = await describeImage(makeModel(llm), llm, bytes, imageMediaType(file), AbortSignal.any([stopController.signal, imageRead.signal]))
          .finally(() => {
            imageRead = null;
          });
        saveRead(current, file.sourceId, file.fileId, { state: 'done', ...read, model: `${llm.provider} ${llm.model}` });
      } else {
        const text = await readDocument(bytes, file);
        saveRead(current, file.sourceId, file.fileId, text ? { state: 'done', text } : { state: 'skipped', error: 'No text in it (a scan?)' });
      }
    } catch (error) {
      if (!(error instanceof FileTooLargeError)) {
        throw error;
      }

      saveRead(current, file.sourceId, file.fileId, { state: 'skipped', error: error.message });
    }

    const embedModel = embeddingModelId(loadSettings().embedding);
    indexRead(current, getAttachment(current, file.sourceId, file.fileId)!, indexContext(readConfig(current, file.sourceId), embedModel));
    runEmbedding();

    return { fetched };
  };

  // A summary's model calls, logged by their time and tokens (never their text), counted for its speed
  const summaryCalls = (sourceId: number, background: boolean) => {
    let calls = 0;
    let ms = 0;
    let outputTokens = 0;

    return {
      onCall: (call: SummaryCall) => {
        calls += 1;

        if (call.outputTokens) {
          ms += call.ms;
          outputTokens += call.outputTokens;
        }

        log(`${background ? 'background ' : ''}summary call (${call.kind}) of source ${sourceId}: ${call.ms} ms, `
          + `${call.inputTokens ?? '?'} tokens in, ${call.outputTokens ?? '?'} out`);
      },
      calls: () => calls,
      tokensPerSecond: () => (outputTokens && ms ? Math.round((outputTokens / ms) * 10_000) / 10 : null),
    };
  };

  // A short summary of a series's meeting, made in the background as by "Summarize", and indexed with it
  const summarizeMeeting = async (meeting: { id: string, sourceId: number, sessionId: string }) => {
    const current = openedDb();
    const view = getMeeting(current, meeting.sourceId, meeting.sessionId);
    const lines = view ? meetingLines(view) : [];

    if (!view || !lines.length) {
      unsummarized.add(meeting.id);

      return;
    }

    const llm = summaryLlm(loadSettings().llm, sourceCloudAllowed(meeting.sourceId));
    const label = `${llm.provider} ${llm.model}`;
    const calls = summaryCalls(meeting.sourceId, true);
    imageRead = new AbortController();
    summarizing = true;
    const startedAt = Date.now();
    summaryRun = {
      title: view.title, createdAt: view.createdAt, startedAt, done: 0, all: 1, llm: label, local: isLocalLlm(llm),
    };
    emitStatus();

    try {
      const text = await summarizeTranscript(makeModel(llm), llm, {
        header: meetingHeader(view),
        lines,
        abortSignal: AbortSignal.any([stopController.signal, imageRead.signal]),
        onProgress: (done, all) => {
          if (summaryRun) {
            summaryRun = { ...summaryRun, done, all };
            emitStatus();
          }
        },
        onText: () => undefined,
        onCall: calls.onCall,
      });
      const durationMs = Date.now() - startedAt;
      saveSummary(current, meeting.id, textHash(lines), label, text, { durationMs, calls: calls.calls() });
      summaryTokensPerSecond = calls.tokensPerSecond() ?? summaryTokensPerSecond;
      summaryError = null;
      reindexMeeting(current, meeting.sourceId, meeting.sessionId, embeddingModelId(loadSettings().embedding));
      log(`summarized meeting of source ${meeting.sourceId} in the background: ${lines.length} lines, ${calls.calls()} calls, ${durationMs} ms`);
      runEmbedding();
    } finally {
      imageRead = null;
      summarizing = false;
      summaryRun = null;
    }
  };

  const runBackground = () => {
    if (!db || stopping) {
      return;
    }

    if (attachmentRun) {
      attachmentAgain = true;

      return;
    }

    if (attachmentRetry) {
      clearTimeout(attachmentRetry);
      attachmentRetry = null;
    }

    backgroundRetry = null;
    const current = db;
    const retry = (ms: number, reason: 'answer' | 'unreachable' = 'unreachable') => {
      attachmentRetry = setTimeout(runBackground, ms);
      backgroundRetry = { at: Date.now() + ms, reason };
    };

    attachmentRun = (async () => {
      // A run with nothing to read would end before attachmentRun is set, which would then never be cleared
      await Promise.resolve();
      let stopped = false;

      do {
        attachmentAgain = false;

        while (!stopping && !stopped) {
          // Answers and summaries first: they use the same model
          if (asks.size || summaries.size) {
            retry(READ_YIELD_MS, 'answer');
            stopped = true;
            break;
          }

          const settings = loadSettings();
          const file = nextPending(current, pendingFilter(settings));

          // No file waits: a series's meeting without a summary, unless that's off or paused
          if (!file) {
            const [meeting] = settings.summaries.auto && !activePause(settings)
              ? meetingsToSummarize(current, monthsBack(settings.summaries.months), unsummarized, 1)
              : [];

            if (!meeting) {
              break;
            }

            try {
              // eslint-disable-next-line no-await-in-loop
              await summarizeMeeting(meeting);
              attachmentError = null;
            } catch (error) {
              if (stopping) {
                break;
              }

              if (!activePause(loadSettings())) {
                summaryError = messageOf(error);
                log(`a background summary of source ${meeting.sourceId} failed`);

                if (isUnreachable(error)) {
                  retry(retryEmbeddingMs);
                  stopped = true;
                } else {
                  unsummarized.add(meeting.id);
                }
              }
            }

            emitStatus();
            continue;
          }

          try {
            // eslint-disable-next-line no-await-in-loop
            const { fetched } = await readFile(file);
            attachmentError = null;

            // A pause after a file from the server, as its source is set
            const pause = fetched ? limitsOf(readConfig(current, file.sourceId)).filePauseSeconds * 1000 : 0;

            if (pause) {
              // eslint-disable-next-line no-await-in-loop
              await new Promise((resolve) => {
                const timer = setTimeout(resolve, pause);
                stopController.signal.addEventListener('abort', () => {
                  clearTimeout(timer);
                  resolve(null);
                }, { once: true });
              });
            }
          } catch (error) {
            if (stopping) {
              break;
            }

            // Paused while it was read: it waits, nothing wrong with it
            if (activePause(loadSettings()) && file.kind === 'image') {
              continue;
            }

            attachmentError = messageOf(error);
            log(`reading file ${file.fileId} of source ${file.sourceId} failed`);

            if (isUnreachable(error)) {
              retry(retryEmbeddingMs);
              stopped = true;
            } else {
              failRead(current, file.sourceId, file.fileId, attachmentError, MAX_READ_ATTEMPTS);
            }
          }

          emitStatus();
        }
      } while (attachmentAgain && !stopping && !stopped);

      attachmentRun = null;
      emitStatus();
    })();
    emitStatus();
  };

  // Ollama's models with what they can do (completion, vision, embedding...)
  const ollamaModels = async (ollamaUrl: string) => {
    const base = ollamaUrl.replace(/\/$/, '');
    const fetchJson = async (path: string, body?: unknown) => {
      const response = await (options.fetch ?? fetch)(`${base}${path}`, {
        method: body ? 'POST' : 'GET',
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        throw new Error(`Ollama answered ${response.status}`);
      }

      return response.json() as Promise<unknown>;
    };
    const { models } = await fetchJson('/api/tags').catch(() => {
      throw new Error(`Ollama doesn't answer at ${base}`);
    }) as { models: { name: string }[] };

    return Promise.all(models.map(async ({ name }) => ({
      name,
      capabilities: ((await fetchJson('/api/show', { model: name }).catch(() => ({}))) as { capabilities?: string[] }).capabilities ?? [],
    })));
  };

  // Groq's and Gemini's chat models, listed by their APIs with the key in the keyring, for 10 minutes; none without one
  const cloudLists = new Map<'groq' | 'gemini', { at: number, models: ModelChoice[] }>();
  const cloudModels = async (provider: 'groq' | 'gemini'): Promise<ModelChoice[]> => {
    const cached = cloudLists.get(provider);

    if (cached && Date.now() - cached.at < 10 * 60_000) {
      return cached.models;
    }

    const key = secrets.get(llmKeyName(provider));

    if (!key) {
      return [];
    }

    try {
      const fetchImpl = options.fetch ?? fetch;
      const signal = AbortSignal.timeout(10_000);
      let names: string[];

      if (provider === 'groq') {
        const response = await fetchImpl('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${key}` }, signal });
        const { data } = await response.json() as { data: { id: string, active?: boolean }[] };
        // Speech, moderation and the like don't answer questions
        names = data.filter((model) => model.active !== false && !/whisper|tts|guard|playai|distil|orpheus|compound/i.test(model.id)).map((model) => model.id);
      } else {
        const response = await fetchImpl('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key }, signal });
        const { models } = await response.json() as { models: { name: string, supportedGenerationMethods?: string[] }[] };
        names = models.filter((model) => model.supportedGenerationMethods?.includes('generateContent') && /^models\/gemini/.test(model.name)
          && !/embedding|image|tts|audio|live/i.test(model.name)).map((model) => model.name.replace(/^models\//, ''));
      }

      const models = names.sort().map((model) => ({ provider, model, local: false }));
      cloudLists.set(provider, { at: Date.now(), models });

      return models;
    } catch (error) {
      log(`listing ${provider}'s models failed: ${messageOf(error)}`);

      return [];
    }
  };

  // When a pause ends by itself, reading goes on
  const schedulePauseEnd = () => {
    if (pauseTimer) {
      clearTimeout(pauseTimer);
      pauseTimer = null;
    }

    const until = activePause(loadSettings())?.until;

    if (until) {
      // A timer can't wait longer than ~24 days; a week at most is asked
      pauseTimer = setTimeout(() => {
        pauseTimer = null;
        runBackground();
        emitStatus();
      }, Math.min(until - Date.now() + 1000, (2 ** 31) - 1));
    }
  };

  // Ollama keeps a model loaded for 5 minutes after its last call: a pause frees the GPU at once. The answers' model
  // loads again with the next question
  const letGoOfVisionModel = () => {
    const { attachments } = loadSettings();

    if (attachments.provider === 'ollama') {
      (options.fetch ?? fetch)(`${attachments.ollamaUrl.replace(/\/$/, '')}/api/generate`, {
        method: 'POST',
        body: JSON.stringify({ model: attachments.model, keep_alive: 0 }),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => log('Ollama didn\'t let go of the vision model'));
    }
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
      onSeen: emitStatus,
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
    // The chat's model; null for the settings' one
    llm: LlmSettings | null;
    // What the rewrite takes from the question but isn't used
    without: RewriteFilter[];
  }

  const answer = async ({ askId, turnId, question, history, filters, llm: asked, without }: Asked) => {
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
      const llm = asked ?? settings.llm;
      const model = makeModel(llm);
      const rewritten = await rewriteQuestion(model, llm, question, history, new Date(), controller.signal, listSeries(current).map((series) => series.name));
      controller.signal.throwIfAborted();
      // Asked again without what the rewrite made up
      const kept = {
        query: rewritten.query,
        ...(!without.includes('dates') && { from: rewritten.from, to: rewritten.to }),
        ...(!without.includes('person') && rewritten.person && { person: rewritten.person }),
        ...(!without.includes('room') && rewritten.room && { room: rewritten.room }),
        ...(!without.includes('rank') && rewritten.rank && { rank: rewritten.rank }),
        ...(!without.includes('series') && rewritten.series && { series: rewritten.series }),
      };

      // Filters set by hand win over the rewrite's, which still completes a follow-up question
      const byHand = filters.from !== undefined || filters.to !== undefined;
      const request = {
        ...kept,
        ...(byHand && { from: filters.from, to: filters.to }),
        ...(filters.person && { person: filters.person }),
        ...(filters.room && { room: filters.room }),
        ...(filters.series && { series: filters.series }),
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

      const { query, room, rank, series: seriesName, ...dates } = request;
      // A meeting series: a meeting each of the period, as its summary or its chunks most like the query
      const series = seriesName ? findSeries(current, seriesName) : null;
      const seriesWarning = seriesName && !series ? `No meeting series is called "${seriesName}": searched everywhere` : undefined;
      // A room the question names: its messages only, or everything with a warning when no room is called so
      const rooms = room ? findRooms(current, room) : [];
      const roomWarning = room && !rooms.length ? `No chat room is called "${room}": searched everywhere` : undefined;
      const inRooms = rooms.length ? rooms : undefined;
      // "The most reactions" is no likeness to the query: those messages are found by their reactions
      const reacted = rank === 'reactions' ? topReacted(current, { rooms: inRooms, from: dates.from, to: dates.to, limit: 8 }) : [];
      let found: { hits: SearchHit[], warning?: string };

      if (reacted.length) {
        found = { hits: hitsOf(current, reacted.map(({ chunkId, count, note }) => ({ chunkId, score: count, note }))) };
      } else if (series) {
        found = await seriesSources(current, query, { seriesId: series.id, from: dates.from, to: dates.to, provider });
      } else {
        found = await search(current, query, { ...dates, sourceKind: filters.sourceKind, rooms: inRooms, provider, limit: 20 });
      }

      controller.signal.throwIfAborted();

      const prepared = prepareAnswer(current, llm, question, found.hits, history.length ? query : undefined, { maxSources: series ? 40 : undefined });
      const sourcesPart: AskPart = {
        kind: 'sources',
        sources: prepared.sources.map(toCited),
        leftOut: prepared.leftOut,
        warning: [roomWarning, seriesWarning, providerWarning ?? found.warning].filter(Boolean).join('. ') || undefined,
        llm: `${llm.provider} ${llm.model}`,
        local: isLocalLlm(llm),
      };
      send(sourcesPart);
      save((opened) => saveSources(opened, turnId, sourcesPart));

      if (!prepared.sources.length) {
        save((opened) => finishTurn(opened, turnId, { answer: '' }));
        send({ kind: 'done' });

        return;
      }

      let streamError: unknown;
      const result = streamAnswer(model, llm, prepared, (error) => {
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

  const summarize = async ({ summaryId, sourceId, sessionId }: CoreMethods['summarize']['params']) => {
    const controller = new AbortController();
    const send = (part: SummaryPart) => onEvent({ type: 'summary', summaryId, part });
    let local = false;
    summaries.set(summaryId, controller);

    try {
      const current = openedDb();
      const meeting = getMeeting(current, sourceId, sessionId);

      if (!meeting) {
        throw new Error('This meeting is no longer in the knowledge base');
      }

      const lines = meetingLines(meeting);

      if (!lines.length) {
        throw new Error('This meeting has no text to summarize');
      }

      const configured = loadSettings().llm;
      const source = listSources(current).find((candidate) => candidate.id === sourceId);
      const llm = summaryLlm(configured, source?.cloudAllowed ?? false);
      const label = `${llm.provider} ${llm.model}`;
      local = llm !== configured;
      const calls = summaryCalls(sourceId, false);
      const startedAt = Date.now();
      const text = await summarizeTranscript(makeModel(llm), llm, {
        header: meetingHeader(meeting),
        lines,
        abortSignal: controller.signal,
        onProgress: (done, all) => send({ kind: 'progress', done, all, llm: label, local: isLocalLlm(llm) }),
        onText: (part) => send({ kind: 'text', text: part }),
        onCall: calls.onCall,
      });
      const stats = { durationMs: Date.now() - startedAt, calls: calls.calls() };

      // The core may have stopped meanwhile
      if (!current.open) {
        return;
      }

      const summary = saveSummary(current, meetingDocumentId(sourceId, sessionId), textHash(lines), label, text, stats);
      send({ kind: 'done', summary });
      log(`summarized a meeting of source ${sourceId}: ${lines.length} lines, ${text.length} characters, ${stats.calls} calls, ${stats.durationMs} ms`);
    } catch (error) {
      if (controller.signal.aborted) {
        send({ kind: 'stopped' });
      } else {
        const message = messageOf(error);
        send({ kind: 'error', message: local ? `This meeting may not go to cloud AI, so Ollama summarizes it: ${message}` : message });
      }
    } finally {
      summaries.delete(summaryId);
    }
  };

  const getSettings = (): Settings => {
    const { embeddingRebuild, ...settings } = loadSettings();

    return { ...settings, embedding: embeddingRebuild ?? settings.embedding };
  };

  const methods: { [M in keyof CoreMethods]: (params: CoreMethods[M]['params']) => Promise<CoreMethods[M]['result']> | CoreMethods[M]['result'] } = {
    status,

    ask: ({ askId, chatId, question, filters, llm, without = [] }) => {
      const current = openedDb();

      if (chatId !== null && !chatExists(current, chatId)) {
        throw new Error('The chat was deleted');
      }

      const id = chatId ?? createChat(current, question);
      const history = chatHistory(current, id, HISTORY_EXCHANGES);
      const turnId = addTurn(current, id, question);
      setChatLlm(current, id, llm);
      // Answered in parts, as events; the call itself returns at once
      answer({ askId, turnId, question, history, filters, llm, without });

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

    sourceMeetings: ({ sourceId }) => sourceMeetings(openedDb(), sourceId),

    summarize: (params) => {
      // Summarized in parts, as events; the call itself returns at once
      summarize(params);

      return null;
    },

    cancelSummary: ({ summaryId }) => {
      summaries.get(summaryId)?.abort();

      return null;
    },

    addBrowser: ({ label, browser }) => {
      const { source, token } = createBrowserSource(openedDb(), label.trim() || 'Browser', browser);
      log(`paired a browser as source ${source.id}`);
      emitStatus();

      return { sourceId: source.id, token };
    },

    updateBrowser: ({ sourceId, label, browser }) => {
      if (!updateBrowser(openedDb(), sourceId, label.trim() || 'Browser', browser)) {
        throw new Error(`No browser source ${sourceId}`);
      }

      emitStatus();

      return null;
    },

    renewBrowserToken: ({ sourceId }) => {
      const token = renewBrowserToken(openedDb(), sourceId);

      if (!token) {
        throw new Error(`No browser source ${sourceId}`);
      }

      log(`made a new token for source ${sourceId}`);

      return { token };
    },

    removeSource: async ({ sourceId }) => {
      const current = openedDb();
      const kind = (current.prepare('select kind from sources where id = ?').get(sourceId) as { kind: string } | undefined)?.kind;
      await runner?.remove(sourceId);
      removeSource(current, sourceId, embeddingModelId(loadSettings().embedding));

      if (kind === ROCKETCHAT_KIND) {
        secrets.delete(tokenSecretName(getKbId(current), sourceId));
      }

      log(`removed source ${sourceId}`);
      emitStatus();
      // Another browser's copies of its meetings may have chunks to embed
      runEmbedding();

      return null;
    },

    rocketChatCheck: async (access) => {
      const api = rocketChat(access);
      const [me, subscriptions, rooms] = [await api.me(), await api.subscriptions(), await api.rooms()];

      return { user: me.name ? `${me.name} (${me.username})` : me.username, rooms: toRoomChoices(subscriptions, rooms) };
    },

    addRocketChat: async ({ selection, since, limits, ...access }) => {
      const current = openedDb();
      const serverUrl = normalizeServerUrl(access.serverUrl);
      const me = await rocketChat(access).me();

      if (me._id !== access.userId) {
        throw new Error('The token belongs to another user than this User ID');
      }

      const sourceId = createRocketChatSource(current, `${me.username}@${new URL(serverUrl).host}`, {
        serverUrl, userId: access.userId, username: me.username, selection, since, limits,
      });
      secrets.set(tokenSecretName(getKbId(current), sourceId), access.token.trim());
      log(`added Rocket.Chat as source ${sourceId}`);
      runner?.add(sourceId);
      emitStatus();

      return { sourceId };
    },

    rocketChatRooms: async ({ sourceId }) => {
      const config = rocketChatConfig(sourceId);
      const api = rocketChat({ ...config, token: rocketChatToken(sourceId) }, limitsOf(config));

      // The rooms it reads, with what the knowledge base has of each
      const stats = roomStats(openedDb(), sourceId);
      const checked = new Map(listRooms(openedDb(), sourceId).map((room) => [room.id, room.cursor ? (JSON.parse(room.cursor) as { checkedAt: number }).checkedAt : null]));
      const rooms = toRoomChoices(await api.subscriptions(), await api.rooms()).map((room) => ({
        ...room,
        stats: checked.has(room.id) ? { ...(stats.get(room.id) ?? { messages: 0, threads: 0, reacted: 0, images: 0, imagesRead: 0, files: 0, filesRead: 0 }), checkedAt: checked.get(room.id) ?? null } : null,
      }));

      return { selection: config.selection, since: config.since, limits: limitsOf(config), rooms };
    },

    updateRocketChat: async ({ sourceId, selection, since, limits, token }) => {
      const current = openedDb();

      if (token) {
        await storeRocketChatToken(sourceId, token);
      }

      changePeriod(current, sourceId, since, embeddingModelId(loadSettings().embedding));
      writeConfig(current, sourceId, { ...readConfig(current, sourceId), selection, limits });
      log(`changed what source ${sourceId} reads`);
      // Rooms no longer chosen go, and new ones are read, in the run
      runner?.syncNow(sourceId);
      emitStatus();
      runEmbedding();

      return null;
    },

    // Without listing the rooms, which the refused token can't
    setRocketChatToken: async ({ sourceId, token }) => {
      await storeRocketChatToken(sourceId, token);
      log(`gave source ${sourceId} a new token`);
      runner?.syncNow(sourceId);

      return null;
    },

    syncSource: ({ sourceId }) => {
      if (!runner) {
        throw new Error('The knowledge base isn\'t open');
      }

      runner.syncNow(sourceId);

      return null;
    },

    conversation: ({ documentId, startMs }) => getConversation(openedDb(), documentId, startMs),

    attachmentImage: async ({ sourceId, fileId }) => {
      const file = getAttachment(openedDb(), sourceId, fileId);

      if (file?.kind !== 'image') {
        return null;
      }

      try {
        return `data:${imageMediaType(file)};base64,${Buffer.from((await fetchFile(file)).bytes).toString('base64')}`;
      } catch (error) {
        log(`showing file ${fileId} of source ${sourceId} failed`);

        if (error instanceof FileTooLargeError) {
          return null;
        }

        throw error;
      }
    },

    recentImages: () => recentImages(openedDb(), 24).map((file) => {
      const room = getRoom(openedDb(), file.sourceId, file.roomId);

      return { sourceId: file.sourceId, fileId: file.fileId, name: file.name, ts: file.ts, room: room ? roomLabel(room) : '' };
    }),

    tryImageModel: async ({ sourceId, fileId, model }) => {
      const file = getAttachment(openedDb(), sourceId, fileId);

      if (file?.kind !== 'image') {
        throw new Error('No such image in the knowledge base');
      }

      const llm: LlmSettings = { provider: model.provider, model: model.model, ollamaUrl: model.ollamaUrl };

      if (!isLocalLlm(llm) && !sourceCloudAllowed(sourceId)) {
        throw new Error('This chat may not go to cloud AI: try an Ollama model, or allow it in Sources');
      }

      const { bytes } = await fetchFile(file);
      const started = Date.now();
      const read = await describeImage(makeModel(llm), llm, bytes, imageMediaType(file), stopController.signal);

      return { ...read, model: `${llm.provider} ${llm.model}`, ms: Date.now() - started };
    },

    visionModels: async ({ ollamaUrl }) => (await ollamaModels(ollamaUrl))
      .filter((model) => model.capabilities.includes('vision')).map((model) => model.name).sort(),

    chatModels: async () => {
      const { llm } = loadSettings();
      const models = await Promise.all([
        ollamaModels(llm.ollamaUrl).then((found) => found
          // Rerankers say they complete, but don't answer
          .filter((model) => model.capabilities.includes('completion') && !model.capabilities.includes('embedding') && !/rerank/i.test(model.name))
          .map((model): ModelChoice => ({ provider: 'ollama', model: model.name, local: isLocalLlm({ ...llm, provider: 'ollama', model: model.name }) })))
          .catch(() => []),
        cloudModels('groq'),
        cloudModels('gemini'),
      ]);
      const choices = models.flat();
      // The settings' model, though its provider can't be reached now
      const configured = choices.some((choice) => choice.provider === llm.provider && choice.model === llm.model)
        ? []
        : [{ provider: llm.provider, model: llm.model, local: isLocalLlm(llm) }];

      return [...configured, ...choices];
    },

    pauseBackground: ({ minutes }) => {
      const until = minutes === null ? null : Date.now() + (minutes * 60_000);
      saveSettings({ ...loadSettings(), backgroundPaused: { until } });
      imageRead?.abort();
      letGoOfVisionModel();
      schedulePauseEnd();
      log(`the background AI work paused${minutes === null ? '' : ` for ${minutes} minutes`}`);
      emitStatus();

      return null;
    },

    resumeBackground: () => {
      const { backgroundPaused: _paused, ...settings } = loadSettings();
      saveSettings(settings);
      schedulePauseEnd();
      log('the background AI work resumed');
      runBackground();
      emitStatus();

      return null;
    },

    meetingSeries: () => {
      const current = openedDb();
      const counts = new Map((current.prepare(`
        select d.series_id as id, count(*) as meetings, count(s.document_id) as summarized, max(d.created_at) as lastAt
        from documents d left join summaries s on s.document_id = d.id
        where d.kind = 'meeting' and d.series_id is not null group by d.series_id
      `).all() as { id: number, meetings: number, summarized: number, lastAt: number }[]).map((row) => [row.id, row]));

      return {
        series: listSeries(current).map((series) => ({
          ...series, meetings: counts.get(series.id)?.meetings ?? 0, summarized: counts.get(series.id)?.summarized ?? 0, lastAt: counts.get(series.id)?.lastAt ?? null,
        })),
        suggestions: seriesSuggestions(current),
      };
    },

    // A series changes the titles and chunks of its meetings: they're indexed again, and those whose text changed embedded
    saveMeetingSeries: (params) => {
      const current = openedDb();
      const id = saveSeries(current, params);
      reindexMeetings(current, embeddingModelId(loadSettings().embedding));
      log(`saved meeting series ${id} with ${params.matchers.length} matchers`);
      runEmbedding();
      runBackground();
      emitStatus();

      return { id };
    },

    deleteMeetingSeries: ({ id }) => {
      const current = openedDb();

      if (!deleteSeries(current, id)) {
        throw new Error(`No meeting series ${id}`);
      }

      reindexMeetings(current, embeddingModelId(loadSettings().embedding));
      log(`deleted meeting series ${id}`);
      runEmbedding();
      emitStatus();

      return null;
    },

    readImagesAgain: () => {
      const images = readImagesAgain(openedDb());
      log(`${images} images to read again`);
      runBackground();
      emitStatus();

      return { images };
    },

    chatLink: ({ documentId, messageId }) => {
      const current = openedDb();
      const doc = current.prepare('select d.source_id as sourceId, d.thread_id as roomId, s.kind from documents d join sources s on s.id = d.source_id where d.id = ?')
        .get(documentId) as { sourceId: number, roomId: string, kind: string } | undefined;
      const room = doc && doc.kind === ROCKETCHAT_KIND ? getRoom(current, doc.sourceId, doc.roomId) : undefined;

      if (!doc || !room) {
        throw new Error('This conversation is no longer in the knowledge base');
      }

      return messageLink(readConfig(current, doc.sourceId), room, messageId);
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
      const saved: StoredSettings = {
        ...stored, attachments: next.attachments, summaries: next.summaries, llm: next.llm, server: next.server, app: next.app,
      };

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
      runBackground();
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

      return stenogramaOpenUrl(serverStatus.port || loadSettings().server.port, sourceId, sessionId, startMs,
        getIndexedVersion(openedDb(), sourceId, sessionId));
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
      const opened = db;
      runner = createSyncRunner({
        db: opened,
        connectors: [createRocketChatConnector({
          db: opened,
          getToken: (sourceId) => secrets.get(tokenSecretName(getKbId(opened), sourceId)),
          embedModel: () => embeddingModelId(loadSettings().embedding),
          fetch: options.fetch,
          log,
        })],
        onStatus: emitStatus,
        onChange: () => {
          runEmbedding();
          runBackground();
        },
        log,
      });
      runner.start();
      runEmbedding();
      runBackground();
      schedulePauseEnd();
      onEvent({ type: 'status', status: status() });
    },

    stop: async () => {
      stopping = true;
      stopController.abort();
      asks.forEach((controller) => controller.abort());
      summaries.forEach((controller) => controller.abort());

      if (embedRetry) {
        clearTimeout(embedRetry);
      }

      if (attachmentRetry) {
        clearTimeout(attachmentRetry);
      }

      if (pauseTimer) {
        clearTimeout(pauseTimer);
      }

      if (statusTimer) {
        clearTimeout(statusTimer);
      }

      await server?.close();
      await runner?.stop();
      runner = null;
      await attachmentRun;
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
