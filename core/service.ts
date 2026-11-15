import { wrapLanguageModel, type LanguageModel } from 'ai';
import { z } from 'zod';
import { prepareAnswer, streamAnswer } from './answer/answer.ts';
import { rewriteQuestion } from './answer/rewrite.ts';
import { EmptyAnswerError, summarizeTranscript, type SummaryCall } from './answer/summary.ts';
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
import { formatDay } from './format.ts';
import { aiCalls, aiErrors, aiUsage, deleteErrors, foldCalls, KEEP_CALLS_MS, recordCall, type AiCall } from './usage.ts';
import { headroomOf, rateLimitOf, type RateLimit, serverRefusalOf } from './ratelimit.ts';
import { findRooms, getConversation, getRoom, indexRead, listRooms, roomLabel, roomStats, topReacted } from './chat/store.ts';
import { createSyncRunner, type SyncRunner } from './connectors/runner.ts';
import { getKbId, openDb, type Db } from './db.ts';
import { embeddingModelId, isLocalEmbedding, type EmbeddingProvider } from './embed/provider.ts';
import { embedPending, keepJobsOf, pendingBySource, pendingEmbeddings, queueModel } from './embed/store.ts';
import {
  createConfiguredEmbeddingProvider, createLanguageModel, isLocalLlm, isTimedOut, llmKeyName, MODEL_CALL_TIMEOUT_MS, OLLAMA_CLOUD_API,
} from './llm.ts';
import { acquireLock } from './lock.ts';
import { dataDir, dbPath, ensureDataDir, lockPath } from './paths.ts';
import type {
  AiCallResult, AiServer, AiStatus, AiTask, AskPart, BackgroundTask, LaneActivity, TaskServer, TaskWait, WorkNow, ChatTurn, CitedSource, CoreEvent, CoreMethods, CoreStatus, DraftView, EmbeddingSettings, KeyProvider,
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
import { detectDrafts, latestFromOthers } from './drafts/detect.ts';
import {
  draftCounts, getDraft, listOpenDrafts, nextWaitingDraft, requestDraft, requeueWriting, updateDraft, waitingAhead, type DraftRow,
} from './drafts/store.ts';
import { corrections, countReplies, describeStyle, draftOutcomes, formatStyle, replyExamples, styleSample } from './drafts/style.ts';
import { askedText, conversationLabel, conversationOf, prepareDraft, toDraftMessages, writeDraft } from './drafts/write.ts';
import { deleteSecret, getSecret, setSecret } from './secrets.ts';
import { buildServer, stenogramaOpenUrl } from './server.ts';
import { loadSettings, saveSettings, type StoredSettings } from './settings.ts';
import {
  answersLlm, CLOUD_NAMES, createReachability, DOCUMENTS_LANE, hasAddress, imageModel, keyIdOf, laneOf, localTextLlm, normalizeUrl, sameUrl, serverId,
  serverTakes, textModel, textModels, whereLabel,
} from './servers.ts';
import type { ModelRef } from './servers.ts';
import { listSources, removeSource, setCloudAllowed } from './sources.ts';
import { meetingDocumentId, reindexMeeting, reindexMeetings } from './stenograma/ingest.ts';
import { deleteSeries, findSeries, listSeries, saveSeries, seriesSources, seriesSuggestions } from './stenograma/series.ts';
import { getIndexedVersion, getMeeting, meetingHeader, meetingLines, sourceMeetings } from './stenograma/meeting.ts';
import {
  averageSummaryMs, meetingsToSummarize, saveSummary, summaryCounts, textHash,
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
  // Tests replace the network (Rocket.Chat) and the keyring; a replaced network has no realtime API but a WebSocket
  // given with it
  fetch?: typeof fetch;
  webSocket?: typeof WebSocket;
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
const AI_SERVER = z.object({
  name: z.string().trim().min(1),
  kind: z.enum(['ollama', 'groq', 'gemini', 'anthropic', 'ollama-cloud', 'openai']),
  url: z.union([z.url(), z.literal('')]),
  text: z.string().trim(),
  images: z.string().trim(),
  queue: z.boolean(),
}).refine((server) => !hasAddress(server.kind) || server.url, { message: 'An Ollama server or OpenAI-compatible API needs its address' });
const SETTINGS = z.object({
  // Groq and Gemini once each, and no address twice
  servers: z.array(AI_SERVER).min(1).refine((servers) => new Set(servers.map(serverId)).size === servers.length, { message: 'A server is there twice' }),
  summaries: z.object({ auto: z.boolean(), months: z.number().int().min(0).max(120) }),
  drafts: z.object({ unreadDays: z.number().int().min(1).max(30), maxAgeDays: z.number().int().min(1).max(30), style: z.string().max(4000) }),
  attachments: z.object({ describeImages: z.boolean(), readDocuments: z.boolean(), months: z.number().int().min(0).max(120) }),
  embedding: EMBEDDING,
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

// An error as the user reads it: the last try's after the AI SDK's retries, with what the server said (Ollama's and
// RKLLama's {"error": ...}) instead of only its HTTP status
const messageOf = (error: unknown): string => {
  if (isTimedOut(error)) {
    return `The model didn't answer in ${MODEL_CALL_TIMEOUT_MS / 60_000} minutes`;
  }

  const last = (error as { lastError?: unknown } | null)?.lastError;

  if (last) {
    return messageOf(last);
  }

  if (!(error instanceof Error)) {
    return String(error);
  }

  const body = (error as { responseBody?: unknown }).responseBody;
  let said: unknown;

  try {
    said = typeof body === 'string' ? (JSON.parse(body) as { error?: unknown }).error : undefined;
  } catch {
    said = undefined;
  }

  return typeof said === 'string' && said ? `${error.message}: ${said.slice(0, 300)}` : error.message;
};

// A model chosen to read images that can't: a setting to change, not an image that failed
class NoVisionError extends Error {}

// F8: a meeting whose source doesn't allow cloud AI is summarized by Ollama on this computer with its default model,
// when a cloud LLM is chosen; as drafts will be (F9)
const summaryLlm = (llm: LlmSettings, cloudAllowed: boolean, settings: Pick<StoredSettings, 'servers'>): LlmSettings => {
  if (cloudAllowed || isLocalLlm(llm)) {
    return llm;
  }

  const local = localTextLlm(settings);

  if (!isLocalLlm(local)) {
    throw new Error('This source may not go to cloud AI, and Ollama isn\'t set up on this computer');
  }

  return local;
};

// A chat file is read at most this many times: then it's marked failed. A model or server that isn't there doesn't count
const MAX_READ_ATTEMPTS = 3;
// While an answer or a summary runs, the files wait this long: they use the same model
const READ_YIELD_MS = 30_000;
// A server that refused its work (a wrong key, no credits) is asked again after this, or once its models or key change
const REFUSED_RETRY_MS = 30 * 60_000;
// How often the AI servers are asked whether they answer
const SERVERS_CHECK_MS = 30_000;
// A vision model that doesn't read images is asked again after this long, if the settings haven't changed
const NO_VISION_RETRY_MS = 10 * 60_000;

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

// The provider's model as the AI SDK's middleware sees it, taken from the SDK itself
type LanguageModelV3 = Parameters<typeof wrapLanguageModel>[0]['model'];
type LanguageModelV3Usage = Awaited<ReturnType<LanguageModelV3['doGenerate']>>['usage'];
type LanguageModelV3StreamPart = Awaited<ReturnType<LanguageModelV3['doStream']>>['stream'] extends ReadableStream<infer Part> ? Part : never;

// The model or the network isn't there: nothing is wrong with the file, which waits
const isUnreachable = (error: unknown) => !isTimedOut(error) && /ECONNREFUSED|fetch failed|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|didn't answer|Cannot connect/i
  .test(`${messageOf(error)} ${messageOf((error as { cause?: unknown } | null)?.cause ?? '')}`);

export const createKbService = (options: ServiceOptions) => {
  const { onEvent, log = () => undefined, retryEmbeddingMs = 60_000, secrets = KEYRING } = options;
  const createEmbedder = options.createEmbeddingProvider ?? createConfiguredEmbeddingProvider;
  const createModel = options.createLanguageModel ?? createLanguageModel;

  let db: Db | null = null;
  // When the old AI calls were last folded into days (core/usage.ts): at the start, then daily
  let foldedAt = 0;

  // Every model call kept for the AI's statistics (core/usage.ts): its task, model, server, time, tokens and how it
  // ended, never its text. A failure to keep it never fails the call
  const record = (call: Omit<AiCall, 'ms'>) => {
    try {
      if (db?.open) {
        recordCall(db, { ...call, ms: Date.now() - call.startedAt });
      }
    } catch (error) {
      log(`keeping an AI call failed: ${messageOf(error)}`);
    }
  };
  const callError = (error: unknown): AiCall['error'] => {
    if ((error as Error | null)?.name === 'AbortError' || /aborted/i.test(messageOf(error))) {
      return 'aborted';
    }

    if (isTimedOut(error)) {
      return 'timeout';
    }

    return isUnreachable(error) ? 'unreachable' : 'failed';
  };
  const tokensOf = (usage: LanguageModelV3Usage | null | undefined) => ({
    inputTokens: usage?.inputTokens.total ?? null, outputTokens: usage?.outputTokens.total ?? null,
  });

  // A server as the statistics name it
  const usageServerName = (provider: string, server: string) => (hasAddress(provider as LlmSettings['provider'])
    ? whereLabel(loadSettings().servers, { provider: provider as LlmSettings['provider'], ollamaUrl: server })
    : whereLabel([], { provider: provider as LlmSettings['provider'], ollamaUrl: '' }));

  // What a kept call worked on, by its ids, for the list of errors: null when it's gone
  const itemName = (item: string) => {
    const current = openedDb();
    const [kind, first, ...rest] = item.split(':');
    const sourceId = Number(first);

    if (kind === 'meeting') {
      const meeting = getMeeting(current, sourceId, rest.join(':'));

      return meeting ? `${meeting.title} (${formatDay(meeting.createdAt)})` : null;
    }

    if (kind === 'draft') {
      const draft = getDraft(current, sourceId);

      return draft ? `a reply in ${conversationLabel(current, draft)}` : null;
    }

    if (kind === 'file') {
      const file = getAttachment(current, sourceId, rest.join(':'));
      const room = file && getRoom(current, file.sourceId, file.roomId);

      return file ? `${file.name}${room ? ` in ${roomLabel(room)}` : ''}` : null;
    }

    if (kind === 'turn') {
      const turn = current.prepare('select question from chat_turns where id = ?').get(sourceId) as { question: string } | undefined;

      return turn ? turn.question.replace(/\s+/g, ' ').slice(0, 120) : null;
    }

    return null;
  };

  // What a kept call made, as it's kept now: a meeting's summary, a draft, an image's reading, an answer
  const itemResult = (item: string): AiCallResult | null => {
    const current = openedDb();
    const [kind, first, ...rest] = item.split(':');
    const id = Number(first);

    if (kind === 'meeting') {
      const sessionId = rest.join(':');
      const meeting = getMeeting(current, id, sessionId);
      const summary = current.prepare(`
        select s.text, s.model from summaries s join documents d on d.id = s.document_id
        where d.kind = 'meeting' and d.source_id = ? and d.thread_id = ?
      `).get(id, sessionId) as { text: string, model: string } | undefined;

      if (!meeting) {
        return null;
      }

      if (!summary) {
        const document = current.prepare('select id from documents where kind = \'meeting\' and source_id = ? and thread_id = ?').get(id, sessionId) as
          { id: string } | undefined;

        if (document && claims.meetings.has(document.id)) {
          return { kind: 'none', reason: 'working' };
        }

        return { kind: 'none', reason: document && unsummarized.has(document.id) ? 'failed' : 'waiting' };
      }

      return { kind: 'summary', ...summary, sourceId: id, sessionId, title: meeting.title, createdAt: meeting.createdAt };
    }

    if (kind === 'draft') {
      const draft = getDraft(current, id);

      if (draft && ['waiting', 'writing'].includes(draft.state)) {
        return { kind: 'none', reason: draft.state === 'writing' ? 'working' : 'waiting' };
      }

      return draft ? { kind: 'draft', text: draft.text, state: draft.state, conversation: conversationLabel(current, draft) } : null;
    }

    if (kind === 'file') {
      const file = getAttachment(current, id, rest.join(':'));

      if (file?.state === 'pending') {
        return { kind: 'none', reason: claims.files.has(`${file.sourceId}:${file.fileId}`) ? 'working' : 'waiting' };
      }

      if (file?.state === 'failed') {
        return { kind: 'none', reason: 'failed' };
      }

      return file ? { kind: 'image', description: file.description, text: file.text, name: file.name } : null;
    }

    if (kind === 'turn') {
      const turn = current.prepare('select chat_id as chatId, question, answer from chat_turns where id = ?').get(id) as
        { chatId: number, question: string, answer: string } | undefined;

      return turn ? { kind: 'answer', question: turn.question, text: turn.answer, chatId: turn.chatId } : null;
    }

    return null;
  };

  // A cloud provider's answer saying it's near its limit: its background lane waits until it's back
  const noteHeadroom = (server: string, headers: Record<string, string | undefined> | undefined) => {
    const ahead = headroomOf(headers);

    if (ahead && !normalizeUrl(server).startsWith('http')) {
      limited.set(server, ahead);
      log(`${server} is near its rate limit until ${new Date(ahead.until).toISOString()}`);
    }
  };

  // A model whose calls, each try of them, are kept
  const makeModel = (llm: LlmSettings, task: AiTask, background = false, item: string | null = null): LanguageModel => {
    const model = createModel(llm);

    if (typeof model === 'string') {
      return model;
    }

    const call = { task, provider: llm.provider, model: llm.model, server: laneOf(llm), background, item };

    return wrapLanguageModel({
      model: model as LanguageModelV3,
      middleware: {
        specificationVersion: 'v3',
        wrapGenerate: async ({ doGenerate }) => {
          const startedAt = Date.now();

          try {
            const result = await doGenerate();
            record({ ...call, startedAt, ...tokensOf(result.usage), error: null });
            noteHeadroom(call.server, result.response?.headers);

            return result;
          } catch (error) {
            record({ ...call, startedAt, ...tokensOf(null), error: callError(error), errorMessage: messageOf(error) });
            throw error;
          }
        },
        wrapStream: async ({ doStream }) => {
          const startedAt = Date.now();
          let result: Awaited<ReturnType<typeof doStream>>;

          try {
            result = await doStream();
            noteHeadroom(call.server, result.response?.headers);
          } catch (error) {
            record({ ...call, startedAt, ...tokensOf(null), error: callError(error), errorMessage: messageOf(error) });
            throw error;
          }

          let usage: LanguageModelV3Usage | null = null;
          let failed: unknown = null;
          let kept = false;
          const keep = (error: unknown) => {
            if (!kept) {
              kept = true;
              record({ ...call, startedAt, ...tokensOf(usage), error: error ? callError(error) : null, errorMessage: error ? messageOf(error) : null });
            }
          };
          const reader = result.stream.getReader();

          return {
            ...result,
            stream: new ReadableStream<LanguageModelV3StreamPart>({
              pull: async (controller) => {
                try {
                  const { done, value } = await reader.read();

                  if (done) {
                    keep(failed);
                    controller.close();

                    return;
                  }

                  if (value.type === 'error') {
                    failed = value.error;
                  }

                  // Kept at its end: the SDK may not read on after it
                  if (value.type === 'finish') {
                    ({ usage } = value);
                    keep(failed);
                  }

                  controller.enqueue(value);
                } catch (error) {
                  keep(error);
                  controller.error(error);
                }
              },
              cancel: (reason) => {
                keep(Object.assign(new Error('aborted'), { name: 'AbortError' }));

                return reader.cancel(reason);
              },
            }),
          };
        },
      },
    });
  };

  // An embedding provider whose calls are kept: the chunks embedded, or a search's question
  const makeEmbedder = (settings: EmbeddingSettings): EmbeddingProvider => {
    const provider = createEmbedder(settings);
    const server = settings.provider === 'ollama' ? normalizeUrl(settings.ollamaUrl) : settings.provider;

    return {
      ...provider,
      embed: async (values, kind, abortSignal) => {
        const startedAt = Date.now();
        const call = {
          task: kind === 'query' ? 'search' as const : 'embedding' as const, provider: settings.provider, model: settings.model, server,
          items: values.length, background: kind !== 'query', startedAt, inputTokens: null, outputTokens: null,
        };

        try {
          const vectors = await provider.embed(values, kind, abortSignal);
          record({ ...call, error: null });

          return vectors;
        } catch (error) {
          record({ ...call, error: callError(error), errorMessage: messageOf(error) });
          throw error;
        }
      },
    };
  };
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

  // The work a lane does now
  const workOn = (key: string): LaneActivity['now'] => {
    const run = runs.get(key);

    return run ? { task: run.task, work: run.work } : null;
  };
  const runsOf = (task: BackgroundTask) => [...runs.values()].filter((run) => run.task === task);

  // Why a server whose queue takes a task's work doesn't do it now (TaskWait): null when nothing is in the way
  const laneWait = (settings: StoredSettings, server: AiServer, task: BackgroundTask): TaskWait | null => {
    const pause = activePause(settings);

    if (pause) {
      return { reason: 'paused', server: server.name, retryAt: pause.until };
    }

    const key = serverId(server);
    const lane = lanes.get(key);
    const retrying = lane?.timer ? lane.retry : null;
    const other = runs.get(key)?.task;

    if (retrying?.reason === 'unreachable') {
      return { reason: 'unreachable', server: server.name, retryAt: retrying.at };
    }

    const refusal = refusalOn(key, server);

    if (refusal) {
      return { reason: 'refused', server: server.name, retryAt: refusal.until, error: refusal.error };
    }

    const limit = limitOn(key);

    if (limit) {
      return { reason: 'limited', server: server.name, retryAt: limit.until };
    }

    if (laneBusy(key) || retrying?.reason === 'answer') {
      return { reason: 'answer', server: server.name, retryAt: null };
    }

    if (task === 'images' && Date.now() < (noVisionUntil.get(key) ?? 0)) {
      return { reason: 'noVision', server: server.name, retryAt: noVisionUntil.get(key)! };
    }

    return other && other !== task ? { reason: other, server: server.name, retryAt: null } : null;
  };

  const takersOf = (settings: StoredSettings, task: BackgroundTask) => queueServers(settings).filter((server) => serverTakes(server).includes(task));

  // Why a task's work waits while some is to do, on the servers whose queue takes it: the first one's reason, but a
  // server with nothing in the way means none waits
  const taskWait = (settings: StoredSettings, task: BackgroundTask, waits: boolean): TaskWait | null => {
    if (!waits) {
      return null;
    }

    const takers = takersOf(settings, task);

    if (!takers.length) {
      const pause = activePause(settings);

      return pause ? { reason: 'paused', server: '', retryAt: pause.until } : { reason: 'noServer', server: '', retryAt: null };
    }

    const reasons = takers.map((server) => laneWait(settings, server, task));

    return reasons.every(Boolean) ? reasons[0] : null;
  };

  // Each server whose queue takes a task's work: the one it does now, or why not while some waits, and its model's speed
  const taskServers = (current: Db, settings: StoredSettings, task: BackgroundTask, waits: boolean): TaskServer[] => takersOf(settings, task)
    .map((server) => {
      const key = serverId(server);
      const run = runs.get(key);
      const llm = task === 'images' ? imageModel(server) : textModel(server);
      const label = llm ? `${llm.provider} ${llm.model}` : '';
      const work = run?.task === task ? run.work : null;

      return {
        name: server.name,
        work,
        wait: work || !waits ? null : laneWait(settings, server, task),
        averageMs: task === 'summaries' ? averageSummaryMs(current, label) : averageTime(task, label),
        tokensPerSecond: task === 'summaries' ? summaryTokensPerSecond.get(label) ?? null : null,
      };
    });

  const summaryStatus = (current: Db, settings: StoredSettings): SummaryStatus => {
    const counts = summaryCounts(current, monthsBack(settings.summaries.months));
    const pending = settings.summaries.auto ? counts.pending ?? 0 : 0;
    const making = runsOf('summaries').length;
    const waits = pending > unsummarized.size + making;

    return {
      pending,
      done: counts.done ?? 0,
      running: making > 0,
      servers: taskServers(current, settings, 'summaries', waits),
      skipped: unsummarized.size,
      error: summaryError,
      waiting: taskWait(settings, 'summaries', waits && !making),
    };
  };

  const status = (): CoreStatus => {
    const current = openedDb();
    const settings = loadSettings();
    const pendingOf = (embedding: EmbeddingSettings) => pendingEmbeddings(current, {
      id: embeddingModelId(embedding), local: isLocalEmbedding(embedding),
    });
    const rebuildPending = settings.embeddingRebuild ? pendingOf(settings.embeddingRebuild) : 0;
    const filter = pendingFilter(settings);
    const imagesPending = filter.kinds.includes('image') ? countAttachments(current, { ...filter, kinds: ['image'] }).pending : 0;
    const attachments = {
      ...countAttachments(current, { ...filter, kinds: ['image', 'document'] }),
      running: filesReading > 0,
      error: attachmentError ?? noVisionError,
      paused: activePause(settings),
      images: {
        pending: imagesPending,
        servers: taskServers(current, settings, 'images', imagesPending > runsOf('images').length),
        waiting: taskWait(settings, 'images', imagesPending > runsOf('images').length && !runsOf('images').length),
      },
    };
    const summaries = summaryStatus(current, settings);
    const draftsCounted = draftCounts(current);

    return {
      kbId: getKbId(current),
      ai: aiStatus(settings),
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
      summaries,
      drafts: {
        ...draftsCounted,
        writing: runsOf('drafts').length > 0,
        error: draftError,
        servers: taskServers(current, settings, 'drafts', draftsCounted.waiting > 0),
        wait: taskWait(settings, 'drafts', draftsCounted.waiting > 0 && !runsOf('drafts').length),
      },
    };
  };

  // At most a few times a second while a queue is worked through
  let statusTimer: ReturnType<typeof setTimeout> | null = null;
  let serversTimer: ReturnType<typeof setInterval> | null = null;
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

  // The background work, a queue per lane (servers.ts): a server's or a cloud provider's, each running the work whose
  // model is there, one at a time: reply drafts, then chat files (the newest first), then meetings' summaries. A lane
  // gives way to what the user asked for on it; a server that isn't reached stops its lane, tried again after a while
  // or when it answers again
  interface Lane {
    run: Promise<void> | null;
    again: boolean;
    timer: ReturnType<typeof setTimeout> | null;
    // Why it waits for its timer: an answer going on, a model not reached, a cloud provider's rate limit
    retry: { at: number, reason: 'answer' | 'unreachable' | 'limited' | 'refused' } | null;
  }
  const lanes = new Map<string, Lane>();
  // A cloud provider's rate limit reached, or about to be (core/ratelimit.ts): its lane waits until then
  const limited = new Map<string, RateLimit>();
  const limitOn = (key: string) => {
    const limit = limited.get(key);

    return limit && limit.until > Date.now() ? limit : null;
  };
  // A server that refused its work (serverRefusalOf: a wrong key, no credits, a model it hasn't): its lane waits half an
  // hour, or until its models or its key change, and the work waits for the other servers instead of failing on it
  const refused = new Map<string, { until: number, error: string, models: string }>();
  const modelsOf = (server: AiServer) => `${server.text}|${server.images}`;
  const refusalOn = (key: string, server: AiServer | null | undefined) => {
    const refusal = refused.get(key);

    if (refusal && (refusal.until <= Date.now() || !server || refusal.models !== modelsOf(server))) {
      refused.delete(key);

      return null;
    }

    return refusal ?? null;
  };
  // The lanes of what the user asked for (answers, summaries), by its id
  const askLanes = new Map<string, string>();
  const laneBusy = (key: string) => [...askLanes.values()].includes(key);
  const reach = createReachability((...args) => (options.fetch ?? fetch)(...args));
  let attachmentError: string | null = null;
  // A server whose image model doesn't read images: its images wait until then, or until the settings change, and say why
  const noVisionUntil = new Map<string, number>();
  let noVisionError: string | null = null;
  // Output tokens a second of each model's last background summary
  const summaryTokensPerSecond = new Map<string, number>();
  let summaryError: string | null = null;
  let draftError: string | null = null;
  // What each lane does now, with the abort of it (a pause, a draft dismissed); a summary with its progress
  interface LaneRun {
    task: BackgroundTask;
    work: WorkNow;
    controller: AbortController;
    draftId?: number;
  }
  const runs = new Map<string, LaneRun>();
  // The lanes whose queue was turned off while at work: what they stopped waits again, nothing wrong with it
  const released = new Set<string>();
  // What a lane took, so another doesn't take it too
  const claims = { drafts: new Set<number>(), files: new Set<string>(), meetings: new Set<string>() };
  // Chat files being read now
  let filesReading = 0;
  // The times of the last images read and drafts written by a model ("ollama qwen3.5:4b"), for their average
  const timings = new Map<string, number[]>();
  const timed = (task: BackgroundTask, model: string, ms: number) => {
    const key = `${task} ${model}`;
    timings.set(key, [...(timings.get(key) ?? []), ms].slice(-10));
  };
  const averageTime = (task: BackgroundTask, model: string) => {
    const times = timings.get(`${task} ${model}`);

    return times?.length ? Math.round(times.reduce((sum, ms) => sum + ms, 0) / times.length) : null;
  };
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

  // A chat file: an image by the image model of the lane reading it, a document without a model
  const readFile = async (file: AttachmentRow, lane: { key: string, llm: LlmSettings | null }) => {
    const current = openedDb();

    let fetched = false;
    filesReading += 1;

    try {
      const got = await fetchFile(file);
      const { bytes } = got;
      ({ fetched } = got);

      if (file.kind === 'image') {
        const { llm } = lane;

        if (!llm) {
          throw new Error('No image model on this server');
        }

        // F8: a cloud server's queue takes only the chats that may go there
        if (!isLocalLlm(llm) && !sourceCloudAllowed(file.sourceId)) {
          throw new Error('This chat may not go to cloud AI');
        }

        await checkVision(llm);
        const controller = new AbortController();
        const room = getRoom(current, file.sourceId, file.roomId);
        const startedAt = Date.now();
        runs.set(lane.key, {
          task: 'images',
          controller,
          work: {
            title: file.name, detail: `${room ? `${roomLabel(room)}, ` : ''}${formatDay(file.ts)}`, startedAt, model: llm.model, server: whereLabel(loadSettings().servers, llm),
          },
        });
        emitStatus();
        const read = await describeImage(makeModel(llm, 'image', true, `file:${file.sourceId}:${file.fileId}`), llm, bytes, imageMediaType(file), AbortSignal.any([stopController.signal, controller.signal]))
          .finally(() => runs.delete(lane.key));
        timed('images', `${llm.provider} ${llm.model}`, Date.now() - startedAt);
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
    } finally {
      filesReading -= 1;
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
  const summarizeMeeting = async (meeting: { id: string, sourceId: number, sessionId: string }, lane: { key: string, llm: LlmSettings }) => {
    const current = openedDb();
    const view = getMeeting(current, meeting.sourceId, meeting.sessionId);
    const lines = view ? meetingLines(view) : [];

    if (!view || !lines.length) {
      unsummarized.add(meeting.id);

      return;
    }

    const llm = summaryLlm(lane.llm, sourceCloudAllowed(meeting.sourceId), loadSettings());
    const label = `${llm.provider} ${llm.model}`;
    const calls = summaryCalls(meeting.sourceId, true);
    const controller = new AbortController();
    const startedAt = Date.now();
    const server = whereLabel(loadSettings().servers, llm);
    const run: LaneRun = {
      task: 'summaries',
      controller,
      work: { title: view.title, detail: formatDay(view.createdAt), startedAt, model: llm.model, server, step: { done: 0, all: 1 } },
    };
    runs.set(lane.key, run);
    emitStatus();

    try {
      const text = await summarizeTranscript(makeModel(llm, 'summary', true, `meeting:${meeting.sourceId}:${meeting.sessionId}`), llm, {
        header: meetingHeader(view),
        lines,
        abortSignal: AbortSignal.any([stopController.signal, controller.signal]),
        onProgress: (done, all) => {
          run.work = { ...run.work, step: { done, all } };
          emitStatus();
        },
        onText: () => undefined,
        onCall: calls.onCall,
      });
      const durationMs = Date.now() - startedAt;
      saveSummary(current, meeting.id, textHash(lines), label, text, { durationMs, calls: calls.calls() });
      const speed = calls.tokensPerSecond();

      if (speed !== null) {
        summaryTokensPerSecond.set(label, speed);
      }

      summaryError = null;
      reindexMeeting(current, meeting.sourceId, meeting.sessionId, embeddingModelId(loadSettings().embedding));
      log(`summarized meeting of source ${meeting.sourceId} in the background: ${lines.length} lines, ${calls.calls()} calls, ${durationMs} ms`);
      runEmbedding();
    } finally {
      runs.delete(lane.key);
    }
  };

  // F9: a reply draft from the conversation and what the knowledge base has on it. F8 as summaries: a messenger that
  // doesn't allow cloud AI gets its drafts from Ollama
  const writeQueuedDraft = async (draft: DraftRow, lane: { key: string, llm: LlmSettings }) => {
    const current = openedDb();
    const settings = loadSettings();
    const { username } = readConfig(current, draft.sourceId);
    const messages = conversationOf(current, draft);

    if (!messages.length) {
      updateDraft(current, draft.id, { state: 'failed', error: 'The message is no longer in the knowledge base' });

      return;
    }

    // Written by the server whose queue took it: when it isn't reached, the draft waits again for another one
    const llm = summaryLlm(lane.llm, sourceCloudAllowed(draft.sourceId), settings);
    const label = `${llm.provider} ${llm.model}`;
    const controller = new AbortController();
    updateDraft(current, draft.id, { state: 'writing', error: null, model: label, server: whereLabel(settings.servers, llm) });
    const startedAt = Date.now();
    runs.set(lane.key, {
      task: 'drafts',
      controller,
      draftId: draft.id,
      work: { title: conversationLabel(current, draft), detail: null, startedAt, model: llm.model, server: whereLabel(settings.servers, llm) },
    });
    emitStatus();

    try {
      let provider: EmbeddingProvider | null = null;

      try {
        provider = makeEmbedder(settings.embedding);
      } catch {
        // Found by words only
      }

      const query = askedText(messages, username) || messages.at(-1)!.text;
      const { hits } = await search(current, query, { provider, limit: 20 });
      const examples = replyExamples(current, draft.sourceId, username, messages.at(-1)!, messages[0].ts);
      const fixes = corrections(current, draft.sourceId);
      const prepared = prepareDraft(current, llm, draft, messages, username, hits, {
        description: settings.drafts.style, examples: formatStyle(examples, fixes),
      });
      const text = await writeDraft(makeModel(llm, 'draft', !draft.asked, `draft:${draft.id}`), llm, prepared, AbortSignal.any([stopController.signal, controller.signal]));

      // Dismissed, or answered in the messenger, meanwhile
      if (current.open && getDraft(current, draft.id)?.state === 'writing') {
        updateDraft(current, draft.id, { state: 'ready', text, sources: prepared.sources.map(toCited), error: null });
      }

      draftError = null;
      timed('drafts', label, Date.now() - startedAt);
      log(`wrote reply draft ${draft.id} of source ${draft.sourceId}: ${messages.length} messages, ${prepared.sources.length} sources, `
        + `${examples.length} replies and ${fixes.length} corrected drafts as examples, `
        + `${text.length} characters, ${Date.now() - startedAt} ms`);
    } finally {
      runs.delete(lane.key);
    }
  };

  // The Rocket.Chat sources with the user's username there
  const rocketChatSources = (current: Db) => listSources(current).filter((source) => source.kind === ROCKETCHAT_KIND)
    .map((source) => ({ sourceId: source.id, username: readConfig(current, source.id).username as string }));

  const draftView = (current: Db, draft: DraftRow): DraftView => {
    const { username } = readConfig(current, draft.sourceId);

    return {
      id: draft.id,
      sourceId: draft.sourceId,
      conversation: conversationLabel(current, draft),
      reason: draft.reason,
      state: draft.state as DraftView['state'],
      messages: toDraftMessages(conversationOf(current, draft).slice(-6), username),
      text: draft.text,
      sources: draft.sources,
      llm: draft.model,
      server: draft.server,
      local: draft.model?.startsWith('ollama ') ?? false,
      error: draft.error,
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt,
      ahead: draft.state === 'waiting' ? waitingAhead(current, draft) : 0,
      asked: draft.asked,
    };
  };

  // After a messenger's sync: the drafts answered there close, and new messages to the user get theirs
  const findDrafts = (sourceId: number) => {
    const current = openedDb();
    const source = listSources(current).find((candidate) => candidate.id === sourceId);

    if (!source?.repliesEnabled || source.kind !== ROCKETCHAT_KIND) {
      return;
    }

    const config = readConfig(current, sourceId);
    const added = detectDrafts(current, {
      sourceId, username: config.username, since: config.draftsSince ?? Date.now(), ...loadSettings().drafts,
    });

    if (added) {
      log(`${added} new reply drafts for source ${sourceId}`);
    }

    emitStatus();
    runBackground();
  };

  const laneState = (key: string) => {
    const known = lanes.get(key);

    if (known) {
      return known;
    }

    const lane: Lane = { run: null, again: false, timer: null, retry: null };
    lanes.set(key, lane);

    return lane;
  };

  // The work of a lane as the settings have it now
  // The servers whose queue is on and that have a model for some of the background work, a lane each
  const queueServers = (settings: StoredSettings) => settings.servers.filter((server) => server.queue && serverTakes(server).length > 0);

  const backgroundLanes = (settings: StoredSettings) => new Set([...queueServers(settings).map(serverId), DOCUMENTS_LANE]);

  // A model's server not reached: its lane waits, and the status says so
  const notReached = (key: string) => {
    if (key !== DOCUMENTS_LANE && !Object.keys(CLOUD_NAMES).includes(key)) {
      reach.unreachable(key);
    }
  };

  const runLane = (key: string) => {
    if (!db || stopping) {
      return;
    }

    const lane = laneState(key);

    if (lane.run) {
      lane.again = true;

      return;
    }

    if (lane.timer) {
      clearTimeout(lane.timer);
      lane.timer = null;
    }

    lane.retry = null;
    const current = db;
    const retry = (ms: number, reason: 'answer' | 'unreachable' | 'limited' | 'refused' = 'unreachable') => {
      lane.timer = setTimeout(() => runLane(key), ms);
      lane.retry = { at: Date.now() + ms, reason };
    };
    const refuse = (server: AiServer, error: string) => {
      refused.set(key, { until: Date.now() + REFUSED_RETRY_MS, error, models: modelsOf(server) });
      log(`${key} refused its work (${error.split(':')[0]}): its queue waits`);
      retry(REFUSED_RETRY_MS, 'refused');
    };

    lane.run = (async () => {
      // A run with nothing to do would end before lane.run is set, which would then never be cleared
      await Promise.resolve();
      let stopped = false;

      do {
        lane.again = false;

        while (!stopping && !stopped) {
          // What the user asked for on this lane first: it uses the same model
          if (laneBusy(key)) {
            retry(READ_YIELD_MS, 'answer');
            stopped = true;
            break;
          }

          const settings = loadSettings();
          // Its server's models: a queue turned off, or a server removed, stops its lane
          const server = key === DOCUMENTS_LANE ? null : queueServers(settings).find((candidate) => serverId(candidate) === key);

          if (key !== DOCUMENTS_LANE && !server) {
            break;
          }

          // A cloud provider at its rate limit: the lane waits until it's back, the other servers go on
          const limit = limitOn(key);

          if (limit) {
            retry(limit.until - Date.now(), 'limited');
            stopped = true;
            break;
          }

          // A server that refused its work waits, until its models or its key change
          const refusal = refusalOn(key, server);

          if (refusal) {
            retry(refusal.until - Date.now(), 'refused');
            stopped = true;
            break;
          }

          const text = server ? textModel(server) : null;
          const images = server ? imageModel(server) : null;
          // F8: a cloud server takes only the work of sources that may go to cloud AI
          const cloudOnly = Boolean(server && server.kind !== 'ollama');
          // Reply drafts first: they're waited for. While the background work is paused, only those asked for by hand
          const draft = text ? nextWaitingDraft(current, { manualOnly: Boolean(activePause(settings)), exclude: [...claims.drafts], cloudOnly }) : undefined;

          if (draft && text) {
            claims.drafts.add(draft.id);

            try {
              // eslint-disable-next-line no-await-in-loop
              await writeQueuedDraft(draft, { key, llm: text });
            } catch (error) {
              if (stopping) {
                break;
              }

              const message = messageOf(error);
              const dismissed = getDraft(current, draft.id)?.state !== 'writing';

              const rateLimit = rateLimitOf(error);
              const refusal = serverRefusalOf(error);

              if (released.delete(key)) {
                updateDraft(current, draft.id, { state: 'waiting' });
                claims.drafts.delete(draft.id);
                runBackground();
                stopped = true;
                break;
              }

              if (rateLimit && !dismissed) {
                // Not the draft's fault: it waits again, for another server or this one's limit to pass
                limited.set(key, rateLimit);
                updateDraft(current, draft.id, { state: 'waiting' });
                retry(rateLimit.until - Date.now(), 'limited');
                stopped = true;
                claims.drafts.delete(draft.id);
                runBackground();
              } else if (refusal && server && !dismissed) {
                // Nor when the server refuses all its work: another server's queue takes it
                updateDraft(current, draft.id, { state: 'waiting' });
                refuse(server, refusal);
                stopped = true;
                claims.drafts.delete(draft.id);
                runBackground();
              } else if (isUnreachable(error) && !dismissed) {
                // Another server's queue takes it meanwhile
                draftError = message;
                updateDraft(current, draft.id, { state: 'waiting' });
                notReached(key);
                retry(retryEmbeddingMs);
                stopped = true;
                claims.drafts.delete(draft.id);
                runBackground();
              } else if (!dismissed) {
                draftError = message;
                updateDraft(current, draft.id, { state: activePause(loadSettings()) ? 'waiting' : 'failed', error: message });
              }

              log(`reply draft ${draft.id} of source ${draft.sourceId} failed`);
            } finally {
              claims.drafts.delete(draft.id);
            }

            emitStatus();
            continue;
          }

          const filter = pendingFilter(settings);
          const kinds = filter.kinds.filter((kind) => (kind === 'image' ? Boolean(images) && Date.now() >= (noVisionUntil.get(key) ?? 0) : key === DOCUMENTS_LANE));
          const file = nextPending(current, { ...filter, kinds, exclude: [...claims.files], cloudOnly });

          // No file waits: a series's meeting without a summary, unless that's off or paused
          if (!file) {
            const [meeting] = text && settings.summaries.auto && !activePause(settings)
              ? meetingsToSummarize(current, monthsBack(settings.summaries.months), new Set([...unsummarized, ...claims.meetings]), 1, { cloudOnly })
              : [];

            if (!meeting || !text) {
              break;
            }

            claims.meetings.add(meeting.id);

            try {
              // eslint-disable-next-line no-await-in-loop
              await summarizeMeeting(meeting, { key, llm: text });
            } catch (error) {
              if (stopping) {
                break;
              }

              const rateLimit = rateLimitOf(error);
              // A model that answers nothing would fail every meeting the same way
              const refusal = serverRefusalOf(error) ?? (error instanceof EmptyAnswerError ? error.message : null);

              if (released.delete(key)) {
                claims.meetings.delete(meeting.id);
                runBackground();
                stopped = true;
                break;
              }

              if (rateLimit) {
                // Not the meeting's fault: it waits, and this server until its limit passes
                limited.set(key, rateLimit);
                log(`${key} is at its rate limit until ${new Date(rateLimit.until).toISOString()}`);
                retry(rateLimit.until - Date.now(), 'limited');
                stopped = true;
                claims.meetings.delete(meeting.id);
                runBackground();
              } else if (refusal && server) {
                // Nor when the server refuses all its work: it waits for another server, not skipped until a restart
                refuse(server, refusal);
                stopped = true;
                claims.meetings.delete(meeting.id);
                runBackground();
              } else if (!activePause(loadSettings())) {
                summaryError = messageOf(error);
                log(`a background summary of source ${meeting.sourceId} failed`);

                if (isUnreachable(error)) {
                  notReached(key);
                  retry(retryEmbeddingMs);
                  stopped = true;
                } else {
                  unsummarized.add(meeting.id);
                }
              }
            } finally {
              claims.meetings.delete(meeting.id);
            }

            emitStatus();
            continue;
          }

          const fileKey = `${file.sourceId}:${file.fileId}`;
          claims.files.add(fileKey);

          try {
            // eslint-disable-next-line no-await-in-loop
            const { fetched } = await readFile(file, { key, llm: images });
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

            // The images wait for a model that reads them, the lane's other work goes on: tried again when the settings
            // change, or in a while
            const rateLimit = rateLimitOf(error);
            const refusal = serverRefusalOf(error);

            if (released.delete(key)) {
              attachmentError = null;
              claims.files.delete(fileKey);
              runBackground();
              stopped = true;
              break;
            }

            if (rateLimit) {
              // Not the image's fault: it waits, and this server until its limit passes
              limited.set(key, rateLimit);
              attachmentError = null;
              retry(rateLimit.until - Date.now(), 'limited');
              stopped = true;
              claims.files.delete(fileKey);
              runBackground();
            } else if (refusal && server) {
              // Nor when the server refuses all its work
              attachmentError = null;
              refuse(server, refusal);
              stopped = true;
              claims.files.delete(fileKey);
              runBackground();
            } else if (error instanceof NoVisionError) {
              noVisionUntil.set(key, Date.now() + NO_VISION_RETRY_MS);
              noVisionError = attachmentError;
              attachmentError = null;
            } else if (isUnreachable(error)) {
              notReached(key);
              retry(retryEmbeddingMs);
              stopped = true;
            } else {
              failRead(current, file.sourceId, file.fileId, attachmentError, MAX_READ_ATTEMPTS);
            }
          } finally {
            claims.files.delete(fileKey);
          }

          emitStatus();
        }
      } while (lane.again && !stopping && !stopped);

      // Its work done before the abort came: nothing left to put back
      released.delete(key);
      lane.run = null;
      emitStatus();
    })();
    emitStatus();
  };

  const runBackground = () => {
    if (!db || stopping) {
      return;
    }

    backgroundLanes(loadSettings()).forEach(runLane);
  };

  // What the user asks for goes to the next server's text model, in the settings' order, when its own server isn't
  // reached (Settings → AI models)
  const withFallback = async (llm: LlmSettings) => {
    if (llm.provider !== 'ollama' || await reach.check(llm.ollamaUrl)) {
      return { llm, fellBack: false };
    }

    for (const next of textModels(loadSettings())) {
      // eslint-disable-next-line no-await-in-loop
      if (laneOf(next) !== laneOf(llm) && (next.provider !== 'ollama' || await reach.check(next.ollamaUrl))) {
        log(`${normalizeUrl(llm.ollamaUrl)} isn't reached: ${next.provider} ${next.model} instead of ${llm.model}`);

        return { llm: next, fellBack: true };
      }
    }

    return { llm, fellBack: false };
  };

  // The servers of the background work, asked every 30 seconds: one that answers again has its lane run at once
  const watchServers = async () => {
    if (!db || stopping) {
      return;
    }

    // The calls of over a year ago into their day's totals, once a day for an app that runs for weeks
    if (Date.now() - foldedAt > 24 * 60 * 60_000) {
      foldedAt = Date.now();
      foldCalls(db, foldedAt - KEEP_CALLS_MS);
    }

    const settings = loadSettings();
    const urls = new Set(settings.servers.filter((server) => server.kind === 'ollama').map((server) => normalizeUrl(server.url)));
    let changed = false;

    await Promise.all([...urls].map(async (url) => {
      const before = reach.last(url);
      const now = await reach.check(url, true);

      if (before !== now) {
        changed = true;
        log(`${url} ${now ? 'answers' : 'isn\'t reached'}`);

        if (now) {
          runLane(url);
        }
      }
    }));

    if (changed) {
      emitStatus();
    }
  };

  // A cloud provider answers with its key in the keyring, unless its last call didn't get through. The keyring is read
  // at most every 10 seconds: the status is made several times a second while work goes on
  const keyKnown = new Map<string, { at: number, set: boolean }>();
  const cloudReachable = (keyId: string, lane: Lane | undefined) => {
    const known = keyKnown.get(keyId);
    const set = known && Date.now() - known.at < 10_000 ? known.set : Boolean(secrets.get(llmKeyName(keyId)));
    keyKnown.set(keyId, known && Date.now() - known.at < 10_000 ? known : { at: Date.now(), set });

    return set && !cloudFailures.has(keyId) && !(lane?.timer && lane.retry?.reason === 'unreachable');
  };

  const aiStatus = (settings: StoredSettings): AiStatus => {
    // The chat's model: the first text model whose server isn't known to be down
    const answers = textModels(settings).find((model) => model.provider !== 'ollama' || reach.last(model.ollamaUrl) !== false) ?? answersLlm(settings);

    return {
      lanes: settings.servers.map((server): LaneActivity => {
        const key = serverId(server);
        const known = lanes.get(key);

        return {
          name: server.name,
          id: key,
          kind: server.kind,
          reachable: server.kind === 'ollama' ? reach.last(server.url) : cloudReachable(keyIdOf(server), known),
          queue: server.queue,
          takes: serverTakes(server),
          now: workOn(key),
          asked: laneBusy(key),
          retryAt: known?.timer && known.retry?.reason === 'unreachable' ? known.retry.at : null,
          limited: limitOn(key),
        };
      }),
      answers: { model: answers.model, server: whereLabel(settings.servers, answers) },
    };
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

  // Whether an Ollama model reads images, by what its server says it can do; asked once per model and address. Known
  // only when the server says: one that doesn't is tried
  const visionKnown = new Map<string, boolean>();
  const checkVision = async (llm: LlmSettings) => {
    if (llm.provider !== 'ollama') {
      return;
    }

    const key = `${normalizeUrl(llm.ollamaUrl)}|${llm.model}`;

    if (!visionKnown.has(key)) {
      const response = await (options.fetch ?? fetch)(`${normalizeUrl(llm.ollamaUrl)}/api/show`, {
        method: 'POST', body: JSON.stringify({ model: llm.model }), signal: AbortSignal.timeout(10_000),
      }).catch(() => null);
      const capabilities = response?.ok ? ((await response.json()) as { capabilities?: string[] }).capabilities : undefined;

      if (capabilities) {
        visionKnown.set(key, capabilities.includes('vision'));
      } else if (response?.status === 404) {
        throw new NoVisionError(`${llm.model} isn't on ${whereLabel(loadSettings().servers, llm)}: choose another in Settings → AI models → Images`);
      }
    }

    if (visionKnown.get(key) === false) {
      throw new NoVisionError(`${llm.model} on ${whereLabel(loadSettings().servers, llm)} doesn't read images: choose a vision model in Settings → AI models → Images`);
    }
  };

  const serverChoices = (server: AiServer, names: string[]) => names.map((name): ModelChoice => ({
    provider: 'ollama', model: name, ollamaUrl: server.url, server: server.name, local: isLocalLlm({ provider: 'ollama', model: name, ollamaUrl: server.url }),
  }));

  // The settings' model first, though its server can't be reached now
  const withConfigured = (choices: ModelChoice[], model: ModelRef, servers: AiServer[]): ModelChoice[] => {
    const same = (choice: ModelChoice) => choice.provider === model.provider && choice.model === model.model
      && (!hasAddress(model.provider) || sameUrl(choice.ollamaUrl ?? '', model.ollamaUrl));
    const configured: ModelChoice[] = choices.some(same) ? [] : [{
      provider: model.provider,
      model: model.model,
      local: isLocalLlm(model),
      ...(hasAddress(model.provider) && { ollamaUrl: model.ollamaUrl, server: whereLabel(servers, model) }),
    }];

    return [...configured, ...choices];
  };

  // A server's models that answer: rerankers say they complete, but don't
  const answersText = (model: { name: string, capabilities: string[] }) => model.capabilities.includes('completion')
    && !model.capabilities.includes('embedding') && !/rerank/i.test(model.name);
  const serverChatModels = async (url: string) => (await ollamaModels(url)).filter(answersText).map((model) => model.name);

  // The cloud providers' chat models, listed by their APIs with the key in the keyring, for 10 minutes; none without one.
  // By the key's id (keyIdOf): an OpenAI-compatible API's is its address's
  const cloudLists = new Map<string, { at: number, names: string[] }>();
  // Why a provider's models couldn't be listed, for Settings
  const cloudFailures = new Map<string, string>();
  // The models that read images, as last listed, where the provider tells (Ollama Cloud's details, OpenRouter's
  // modalities); none known means any may
  const cloudVision = new Map<string, Set<string> | null>();
  const cloudModels = async (provider: KeyProvider, server?: Pick<AiServer, 'url' | 'name'>): Promise<ModelChoice[]> => {
    const keyId = keyIdOf({ kind: provider, url: server?.url ?? '' });
    // An OpenAI-compatible API's are its server's, as named and spelled now
    const choicesOf = (names: string[]) => names.map((model): ModelChoice => ({
      provider, model, local: false, ...(provider === 'openai' && server && { ollamaUrl: server.url, server: server.name }),
    }));
    const cached = cloudLists.get(keyId);

    if (cached && Date.now() - cached.at < 10 * 60_000) {
      return choicesOf(cached.names);
    }

    const key = secrets.get(llmKeyName(keyId));

    if (!key) {
      return [];
    }

    try {
      const fetchImpl = options.fetch ?? fetch;
      const signal = AbortSignal.timeout(10_000);
      // What the provider said when it refused: a wrong key, no access to the models list
      const answered = async (response: Response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { error?: { message?: string } | string } | null;
          const said = typeof body?.error === 'string' ? body.error : body?.error?.message;
          const name = provider === 'openai' ? server?.name ?? 'The server' : CLOUD_NAMES[provider];
          throw new Error(`${name} answered ${response.status}${said ? `: ${String(said).slice(0, 200)}` : ''}`);
        }

        return response.json() as Promise<unknown>;
      };
      let names: string[];

      if (provider === 'groq') {
        const response = await fetchImpl('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${key}` }, signal });
        const { data } = await answered(response) as { data: { id: string, active?: boolean }[] };
        // Speech, moderation and the like don't answer questions
        names = data.filter((model) => model.active !== false && !/whisper|tts|guard|playai|distil|orpheus|compound/i.test(model.id)).map((model) => model.id).sort();
      } else if (provider === 'anthropic') {
        // Newest first, as the API lists them
        const response = await fetchImpl('https://api.anthropic.com/v1/models?limit=100', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, signal });
        const { data } = await answered(response) as { data: { id: string }[] };
        names = data.map((model) => model.id);
      } else if (provider === 'ollama-cloud') {
        const headers = { Authorization: `Bearer ${key}` };
        const response = await fetchImpl(`${OLLAMA_CLOUD_API}/tags`, { headers, signal });
        const { models: listed } = await answered(response) as { models: { name: string }[] };
        names = listed.map((model) => model.name).filter((name) => !/embed/i.test(name)).sort();
        // Which read images, as each model's details say; one not told is taken as text only
        const shown = await Promise.all(names.map((model) => fetchImpl(`${OLLAMA_CLOUD_API}/show`, {
          method: 'POST', headers, body: JSON.stringify({ model }), signal,
        }).then((answer) => (answer.ok ? answer.json() as Promise<{ capabilities?: string[] }> : null), () => null)));
        cloudVision.set(keyId, new Set(names.filter((_, index) => shown[index]?.capabilities?.includes('vision'))));
      } else if (provider === 'openai') {
        const response = await fetchImpl(`${normalizeUrl(server?.url ?? '')}/models`, { headers: { Authorization: `Bearer ${key}` }, signal });
        const { data } = await answered(response) as { data: { id: string, architecture?: { input_modalities?: string[] } }[] };
        // Embeddings, speech, moderation and the like don't answer questions
        const chat = data.filter((model) => !/embed|whisper|tts|guard|rerank|moderation|transcribe|audio/i.test(model.id));
        names = chat.map((model) => model.id).sort();
        const told = chat.some((model) => model.architecture?.input_modalities);
        cloudVision.set(keyId, told ? new Set(chat.filter((model) => model.architecture?.input_modalities?.includes('image')).map((model) => model.id)) : null);
      } else {
        const response = await fetchImpl('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key }, signal });
        const { models } = await answered(response) as { models: { name: string, supportedGenerationMethods?: string[] }[] };
        names = models.filter((model) => model.supportedGenerationMethods?.includes('generateContent') && /^models\/gemini/.test(model.name)
          && !/embedding|image|tts|audio|live/i.test(model.name)).map((model) => model.name.replace(/^models\//, '')).sort();
      }

      cloudLists.set(keyId, { at: Date.now(), names });
      cloudFailures.delete(keyId);

      return choicesOf(names);
    } catch (error) {
      log(`listing ${provider}'s models failed: ${messageOf(error)}`);
      cloudFailures.set(keyId, messageOf(error));

      return [];
    }
  };

  // Gemini's embedding models, listed with the key in the keyring, for 10 minutes; none without one
  let geminiEmbeddingList: { at: number, models: string[] } | null = null;
  const geminiEmbeddingModels = async () => {
    if (geminiEmbeddingList && Date.now() - geminiEmbeddingList.at < 10 * 60_000) {
      return geminiEmbeddingList.models;
    }

    const key = secrets.get(llmKeyName('gemini'));

    if (!key) {
      return [];
    }

    const response = await (options.fetch ?? fetch)('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
      headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(10_000),
    });
    const { models } = await response.json() as { models: { name: string, supportedGenerationMethods?: string[] }[] };
    const names = models.filter((model) => model.supportedGenerationMethods?.includes('embedContent'))
      .map((model) => model.name.replace(/^models\//, '')).sort();
    geminiEmbeddingList = { at: Date.now(), models: names };

    return names;
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
    loadSettings().servers.map(imageModel).forEach((model) => {
      if (model?.provider === 'ollama') {
        (options.fetch ?? fetch)(`${normalizeUrl(model.ollamaUrl)}/api/generate`, {
          method: 'POST',
          body: JSON.stringify({ model: model.model, keep_alive: 0 }),
          signal: AbortSignal.timeout(10_000),
        }).catch(() => log('Ollama didn\'t let go of the vision model'));
      }
    });
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
      const { llm } = await withFallback(asked ?? answersLlm(settings));
      askLanes.set(askId, laneOf(llm));
      const rewritten = await rewriteQuestion(makeModel(llm, 'rewrite', false, `turn:${turnId}`), llm, question, history, new Date(), controller.signal, listSeries(current).map((series) => series.name));
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
        server: whereLabel(loadSettings().servers, llm),
      };
      send(sourcesPart);
      save((opened) => saveSources(opened, turnId, sourcesPart));

      if (!prepared.sources.length) {
        save((opened) => finishTurn(opened, turnId, { answer: '' }));
        send({ kind: 'done' });

        return;
      }

      let streamError: unknown;
      const result = streamAnswer(makeModel(llm, 'answer', false, `turn:${turnId}`), llm, prepared, (error) => {
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
      askLanes.delete(askId);
      runBackground();
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

      const { llm: configured } = await withFallback(answersLlm(loadSettings()));
      const source = listSources(current).find((candidate) => candidate.id === sourceId);
      const llm = summaryLlm(configured, source?.cloudAllowed ?? false, loadSettings());
      askLanes.set(summaryId, laneOf(llm));
      const label = `${llm.provider} ${llm.model}`;
      local = llm !== configured;
      const calls = summaryCalls(sourceId, false);
      const startedAt = Date.now();
      const text = await summarizeTranscript(makeModel(llm, 'summary', false, `meeting:${sourceId}:${sessionId}`), llm, {
        header: meetingHeader(meeting),
        lines,
        abortSignal: controller.signal,
        onProgress: (done, all) => send({ kind: 'progress', done, all, llm: label, local: isLocalLlm(llm), server: whereLabel(loadSettings().servers, llm) }),
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
      askLanes.delete(summaryId);
      runBackground();
    }
  };

  // The settings form's: without what the core keeps for itself, which the form would send back
  const getSettings = (): Settings => {
    const { embeddingRebuild, backgroundPaused: _paused, ...settings } = loadSettings();

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

      await checkVision(llm);
      const { bytes } = await fetchFile(file);
      const started = Date.now();
      const read = await describeImage(makeModel(llm, 'image', false, `file:${sourceId}:${fileId}`), llm, bytes, imageMediaType(file), stopController.signal);

      return { ...read, model: `${llm.provider} ${llm.model}`, ms: Date.now() - started };
    },

    summaryTryMeetings: () => {
      const current = openedDb();
      const rows = current.prepare(`
        select d.id, d.source_id as sourceId, d.thread_id as sessionId, d.title, d.created_at as createdAt,
          (select count(*) from chunks c where c.document_id = d.id) as chunks,
          s.text, s.model, s.duration_ms as durationMs
        from documents d left join summaries s on s.document_id = d.id
        where d.kind = 'meeting' order by d.created_at desc limit 60
      `).all() as { sourceId: number, sessionId: string, title: string, createdAt: number, chunks: number, text: string | null, model: string | null,
        durationMs: number | null }[];

      return rows.filter((row) => row.chunks > 0).map((row) => {
        const view = getMeeting(current, row.sourceId, row.sessionId);

        return {
          sourceId: row.sourceId,
          sessionId: row.sessionId,
          title: row.title,
          createdAt: row.createdAt,
          lines: view ? meetingLines(view).length : 0,
          saved: row.text && row.model ? { text: row.text, model: row.model, durationMs: row.durationMs } : null,
        };
      });
    },

    // As "Summarize", with the model given, and nothing kept. It counts as a summary asked for, so the background work
    // doesn't start another meanwhile; one already running shares the model, which the result says
    trySummary: async ({ tryId, sourceId, sessionId, llm }) => {
      const current = openedDb();
      const meeting = getMeeting(current, sourceId, sessionId);
      const lines = meeting ? meetingLines(meeting) : [];

      if (!meeting || !lines.length) {
        throw new Error('This meeting has no text to summarize');
      }

      if (!isLocalLlm(llm) && !sourceCloudAllowed(sourceId)) {
        throw new Error('This meeting may not go to cloud AI: try an Ollama model, or allow its source in Sources');
      }

      const controller = new AbortController();
      summaries.set(tryId, controller);
      askLanes.set(tryId, laneOf(llm));
      const shared = { value: runs.has(laneOf(llm)) };
      const tokens = { input: 0, output: 0, ms: 0, counted: true };
      let calls = 0;
      const started = Date.now();

      try {
        const text = await summarizeTranscript(makeModel(llm, 'summary', false, `meeting:${sourceId}:${sessionId}`), llm, {
          header: meetingHeader(meeting),
          lines,
          abortSignal: AbortSignal.any([stopController.signal, controller.signal]),
          onProgress: () => {
            shared.value ||= runs.has(laneOf(llm));
          },
          onText: () => undefined,
          onCall: (call) => {
            calls += 1;
            tokens.ms += call.ms;

            if (call.inputTokens === undefined || call.outputTokens === undefined) {
              tokens.counted = false;
            } else {
              tokens.input += call.inputTokens;
              tokens.output += call.outputTokens;
            }
          },
        });
        const ms = Date.now() - started;
        log(`tried a summary of a meeting of source ${sourceId} with ${llm.provider} ${llm.model}: ${calls} calls, ${ms} ms`);

        return {
          llm: `${llm.provider} ${llm.model}`,
          server: whereLabel(loadSettings().servers, llm),
          local: isLocalLlm(llm),
          text,
          ms,
          calls,
          inputTokens: tokens.counted ? tokens.input : null,
          outputTokens: tokens.counted ? tokens.output : null,
          tokensPerSecond: tokens.counted && tokens.output && tokens.ms ? Math.round((tokens.output / tokens.ms) * 10_000) / 10 : null,
          shared: shared.value,
        };
      } catch (error) {
        if (controller.signal.aborted) {
          throw new Error('Stopped');
        }

        throw error;
      } finally {
        summaries.delete(tryId);
        askLanes.delete(tryId);
        runBackground();
      }
    },

    aiUsage: ({ since }) => aiUsage(openedDb(), since, usageServerName),
    aiErrors: (query) => aiErrors(openedDb(), query, usageServerName, itemName),
    aiCalls: (query) => aiCalls(openedDb(), query, usageServerName, itemName),
    aiCallResult: ({ item }) => itemResult(item),
    deleteAiErrors: (query) => {
      const deleted = deleteErrors(openedDb(), query);
      log(`deleted ${deleted} failed AI calls from the statistics`);

      return { deleted };
    },

    taskModels: async ({ task }) => {
      const settings = loadSettings();
      const capability = task === 'images' ? 'vision' : 'embedding';
      const models = await Promise.all([
        ...settings.servers.filter((server) => server.kind === 'ollama').map(async (server) => serverChoices(server, (await ollamaModels(server.url)
          .catch(() => [])).filter((model) => model.capabilities.includes(capability)).map((model) => model.name).sort())),
        task === 'images'
          ? cloudModels('gemini')
          : geminiEmbeddingModels().then((names) => names.map((model): ModelChoice => ({ provider: 'gemini', model, local: false })), () => []),
      ]);

      const images = settings.servers.map(imageModel).find(Boolean);

      return task === 'images' && !images ? models.flat() : withConfigured(models.flat(), task === 'images' ? images! : settings.embedding, settings.servers);
    },

    // Every server's chat models, by server, then Groq's and Gemini's with their key set
    chatModels: async () => {
      const settings = loadSettings();
      const { servers } = settings;
      const llm = answersLlm(settings);
      const models = await Promise.all([
        ...servers.filter((server) => server.kind === 'ollama').map(async (server) => serverChoices(server, await serverChatModels(server.url).catch(() => []))),
        cloudModels('groq'),
        cloudModels('gemini'),
        cloudModels('anthropic'),
        cloudModels('ollama-cloud'),
        ...servers.filter((server) => server.kind === 'openai').map((server) => cloudModels('openai', server)),
      ]);

      return withConfigured(models.flat(), llm, servers);
    },

    // A cloud provider's with its key (none without it): every Gemini and Claude model reads images, Groq's none,
    // Ollama Cloud's and an OpenAI-compatible API's those it says, or any when it doesn't
    serverModels: async ({ kind, url }) => {
      if (kind !== 'ollama') {
        const keyId = keyIdOf({ kind, url });
        const name = loadSettings().servers.find((server) => server.kind === kind && sameUrl(server.url, url))?.name ?? normalizeUrl(url);
        const text = (await cloudModels(kind, { url, name })).map((model) => model.model);
        const failure = cloudFailures.get(keyId);
        const vision = cloudVision.get(keyId);
        const reads = (model: string) => kind !== 'groq' && (!vision || vision.has(model));
        const images = text.filter(reads);

        return { reachable: text.length > 0, text, images, ...(failure && { error: failure }) };
      }

      try {
        const models = await ollamaModels(url);
        await reach.check(url, true);

        return {
          reachable: true,
          text: models.filter(answersText).map((model) => model.name),
          images: models.filter((model) => model.capabilities.includes('vision')).map((model) => model.name),
        };
      } catch {
        reach.unreachable(url);

        return { reachable: false, text: [], images: [] };
      }
    },

    setServerQueue: ({ server: id, queue }) => {
      const settings = loadSettings();

      if (!settings.servers.some((server) => serverId(server) === id)) {
        throw new Error('No such server in Settings → AI models');
      }

      saveSettings({ ...settings, servers: settings.servers.map((server) => (serverId(server) === id ? { ...server, queue } : server)) });
      log(`the background queue ${queue ? 'on' : 'off'} for ${id}`);

      // A queue turned off lets go of the work it does now, which waits again for another server
      if (!queue && runs.has(id)) {
        released.add(id);
        runs.get(id)!.controller.abort();
      }

      runBackground();
      emitStatus();

      return null;
    },

    pauseBackground: ({ minutes }) => {
      const until = minutes === null ? null : Date.now() + (minutes * 60_000);
      saveSettings({ ...loadSettings(), backgroundPaused: { until } });
      runs.forEach((run) => run.task !== 'drafts' && run.controller.abort());
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

    setRepliesEnabled: ({ sourceId, enabled }) => {
      const current = openedDb();
      const config = rocketChatConfig(sourceId);
      current.prepare('update sources set replies_enabled = ? where id = ?').run(enabled ? 1 : 0, sourceId);

      if (enabled) {
        // Its unread messages of the last day count, and those to come
        writeConfig(current, sourceId, { ...config, draftsSince: Date.now() });
        findDrafts(sourceId);
      } else {
        current.prepare('update drafts set state = \'dismissed\', updated_at = ? where source_id = ? and state in (\'waiting\', \'failed\')')
          .run(Date.now(), sourceId);
      }

      log(`reply drafts ${enabled ? 'on' : 'off'} for source ${sourceId}`);
      emitStatus();

      return null;
    },

    drafts: () => {
      const current = openedDb();

      return listOpenDrafts(current).map((draft) => draftView(current, draft));
    },

    draftAction: ({ draftId, action }) => {
      const current = openedDb();

      if (!getDraft(current, draftId)) {
        throw new Error('This draft is gone');
      }

      runs.forEach((run) => run.draftId === draftId && run.controller.abort());

      updateDraft(current, draftId, action === 'dismiss' ? { state: 'dismissed' } : { state: 'waiting', asked: true, error: null });
      emitStatus();

      if (action === 'rewrite') {
        runBackground();
      }

      return null;
    },

    draftableConversations: () => {
      const current = openedDb();
      const from = Date.now() - (loadSettings().drafts.maxAgeDays * 86_400_000);
      const open = new Set(listOpenDrafts(current).map((draft) => `${draft.sourceId}\n${draft.roomId}\n${draft.threadId ?? ''}`));

      return listSources(current).filter((source) => source.kind === ROCKETCHAT_KIND).flatMap((source) => {
        const { username } = readConfig(current, source.id);

        return latestFromOthers(current, source.id, username, from).map(({ roomId, threadId, message }) => ({
          sourceId: source.id,
          roomId,
          threadId,
          conversation: conversationLabel(current, { sourceId: source.id, roomId, threadId }),
          last: { author: message.author, text: message.text, ts: message.ts },
          drafted: open.has(`${source.id}\n${roomId}\n${threadId ?? ''}`),
        }));
      }).sort((a, b) => b.last.ts - a.last.ts);
    },

    draftLearning: () => {
      const current = openedDb();

      return rocketChatSources(current).reduce((sum, { sourceId, username }) => {
        const outcomes = draftOutcomes(current, sourceId);

        return {
          replies: sum.replies + countReplies(current, sourceId, username),
          answered: sum.answered + outcomes.answered,
          asWritten: sum.asWritten + outcomes.asWritten,
        };
      }, { replies: 0, answered: 0, asWritten: 0 });
    },

    describeStyle: async () => {
      const current = openedDb();
      const sources = rocketChatSources(current);
      const sample = styleSample(current, sources);

      if (sample.length < 20) {
        throw new Error('Too few of your messages yet: a Rocket.Chat source with your messages is needed');
      }

      // F8: Ollama's model unless every chat read may go to cloud AI
      const { llm: configured } = await withFallback(answersLlm(loadSettings()));
      const llm = summaryLlm(configured, sources.every(({ sourceId }) => sourceCloudAllowed(sourceId)), loadSettings());
      const startedAt = Date.now();
      const text = await describeStyle(makeModel(llm, 'style'), llm, sample, stopController.signal);
      log(`described the user's style from ${sample.length} messages with ${llm.provider} ${llm.model}: ${text.length} characters, `
        + `${Date.now() - startedAt} ms`);

      return text;
    },

    requestDraft: ({ sourceId, roomId, threadId }) => {
      const current = openedDb();
      const { username } = rocketChatConfig(sourceId);
      const [latest] = latestFromOthers(current, sourceId, username, 0, 200)
        .filter((candidate) => candidate.roomId === roomId && candidate.threadId === threadId);

      if (!latest) {
        throw new Error('This conversation has no message from someone else to reply to');
      }

      const draftId = requestDraft(current, { sourceId, roomId, threadId, messageId: latest.message.id });
      log(`reply draft ${draftId} of source ${sourceId} asked for by hand`);
      emitStatus();
      runBackground();

      return null;
    },

    draftLink: ({ draftId }) => {
      const current = openedDb();
      const draft = getDraft(current, draftId);
      const room = draft ? getRoom(current, draft.sourceId, draft.roomId) : undefined;

      if (!draft || !room) {
        throw new Error('This conversation is no longer in the knowledge base');
      }

      return messageLink(readConfig(current, draft.sourceId), room, draft.messageId);
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
        ...stored,
        servers: next.servers,
        attachments: next.attachments,
        summaries: next.summaries,
        drafts: next.drafts,
        server: next.server,
        app: next.app,
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
      // A new vision model is tried at once
      visionKnown.clear();
      noVisionUntil.clear();
      noVisionError = null;
      attachmentError = null;
      watchServers();
      // New drafts' days: the messages they now take get theirs
      listSources(openedDb()).filter((source) => source.repliesEnabled).forEach((source) => findDrafts(source.id));
      runEmbedding();
      runBackground();
      emitStatus();

      return getSettings();
    },

    keys: ({ urls = [] }) => Object.fromEntries([
      ...(['groq', 'gemini', 'anthropic', 'ollama-cloud'] as const).map((provider) => keyIdOf({ kind: provider, url: '' })),
      ...urls.map((url) => keyIdOf({ kind: 'openai', url })),
    ].map((keyId) => [keyId, Boolean(getSecret(llmKeyName(keyId)))])),

    setKey: ({ provider, key, url = '' }) => {
      const keyId = keyIdOf({ kind: provider, url });

      if (provider === 'openai' && !URL.canParse(url)) {
        throw new Error('Type the API\'s address first');
      }

      setSecret(llmKeyName(keyId), key.trim());
      log(`kept the ${provider} key`);
      keyKnown.delete(keyId);
      refused.delete(serverId({ kind: provider, url }));
      cloudLists.delete(keyId);
      // Gemini embeddings may have waited for it, the provider's queue too
      runEmbedding();
      runBackground();
      emitStatus();

      return null;
    },

    deleteKey: ({ provider, url = '' }) => {
      const keyId = keyIdOf({ kind: provider, url });
      deleteSecret(llmKeyName(keyId));
      log(`removed the ${provider} key`);
      keyKnown.delete(keyId);
      refused.delete(serverId({ kind: provider, url }));
      cloudLists.delete(keyId);
      emitStatus();

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

      requeueWriting(db);
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
          webSocket: options.webSocket ?? (options.fetch ? null : globalThis.WebSocket),
          log,
          afterSync: findDrafts,
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
      watchServers();
      serversTimer = setInterval(watchServers, SERVERS_CHECK_MS);
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

      lanes.forEach((lane) => lane.timer && clearTimeout(lane.timer));

      if (serversTimer) {
        clearInterval(serversTimer);
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
      await Promise.all([...lanes.values()].map((lane) => lane.run));
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
