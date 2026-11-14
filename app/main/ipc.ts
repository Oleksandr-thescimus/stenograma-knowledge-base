import { z } from 'zod';
import type { AppMethods } from '../../core/protocol';

// The renderer is untrusted (CLAUDE.md): it will show emails and messages written by other people. So every call it
// makes through window.kb is checked here before it reaches the core, and anything else is refused

const NO_PARAMS = z.object({}).strict();
const ID = z.number().int().positive();
const TEXT = z.string().max(20_000);
const MS = z.number().int().nonnegative();
const BROWSER = z.enum(['chrome', 'firefox', 'edge', 'brave', 'opera', 'other']);

const EMBEDDING = z.object({ provider: z.enum(['ollama', 'gemini']), model: z.string().min(1).max(200), ollamaUrl: z.url().max(500) }).strict();
const LLM = z.object({ provider: z.enum(['groq', 'gemini', 'ollama']), model: z.string().min(1).max(200), ollamaUrl: z.url().max(500) }).strict();
const KEY_PROVIDER = z.enum(['groq', 'gemini']);
const VISION = { provider: z.enum(['ollama', 'gemini']), model: z.string().min(1).max(200), ollamaUrl: z.url().max(500) };
const FILE = { sourceId: ID, fileId: z.string().min(1).max(200) };
const MEETING = z.object({ sourceId: ID, sessionId: z.string().min(1).max(1000) }).strict();
const DOCUMENT_ID = z.string().min(1).max(1000);
const ROCKETCHAT_TOKEN = z.string().trim().min(1).max(500);
const ROCKETCHAT_ACCESS = {
  serverUrl: z.url({ protocol: /^https?$/ }).max(500),
  userId: z.string().trim().min(1).max(100),
  token: ROCKETCHAT_TOKEN,
};
const ROCKETCHAT_SETUP = {
  selection: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('chosen'), ids: z.array(z.string().min(1).max(100)).max(5000) }).strict(),
    z.object({ mode: z.literal('all'), types: z.array(z.enum(['channel', 'group', 'direct'])).min(1).max(3) }).strict(),
  ]),
  since: MS,
  limits: z.object({
    intervalMinutes: z.union([z.literal(5), z.literal(15), z.literal(30), z.literal(60)]),
    requestsPerMinute: z.number().int().min(1).max(30),
    filePauseSeconds: z.number().int().min(0).max(60),
  }).strict(),
};

export const PARAMS: { [M in keyof AppMethods]: z.ZodType<AppMethods[M]['params']> } = {
  status: NO_PARAMS,
  ask: z.object({
    askId: z.string().min(1).max(100),
    chatId: ID.nullable(),
    question: TEXT.min(1),
    filters: z.object({
      sourceKind: z.string().max(100).optional(),
      from: MS.optional(),
      to: MS.optional(),
      person: z.string().max(200).optional(),
      room: z.string().max(200).optional(),
      series: z.string().max(100).optional(),
    }).strict(),
    llm: LLM.nullable(),
    without: z.array(z.enum(['dates', 'person', 'room', 'rank', 'series'])).max(5).optional(),
  }).strict(),
  chatModels: NO_PARAMS,
  cancelAsk: z.object({ askId: z.string().min(1).max(100) }).strict(),
  chats: NO_PARAMS,
  chat: z.object({ chatId: ID }).strict(),
  deleteChat: z.object({ chatId: ID }).strict(),
  meeting: MEETING,
  sourceMeetings: z.object({ sourceId: ID }).strict(),
  summarize: MEETING.extend({ summaryId: z.string().min(1).max(100) }).strict(),
  cancelSummary: z.object({ summaryId: z.string().min(1).max(100) }).strict(),
  addBrowser: z.object({ label: z.string().max(100), browser: BROWSER.optional() }).strict(),
  updateBrowser: z.object({ sourceId: ID, label: z.string().min(1).max(100), browser: BROWSER }).strict(),
  renewBrowserToken: z.object({ sourceId: ID }).strict(),
  removeSource: z.object({ sourceId: ID }).strict(),
  rocketChatCheck: z.object(ROCKETCHAT_ACCESS).strict(),
  addRocketChat: z.object({ ...ROCKETCHAT_ACCESS, ...ROCKETCHAT_SETUP }).strict(),
  rocketChatRooms: z.object({ sourceId: ID }).strict(),
  updateRocketChat: z.object({ sourceId: ID, ...ROCKETCHAT_SETUP, token: ROCKETCHAT_TOKEN.optional() }).strict(),
  setRocketChatToken: z.object({ sourceId: ID, token: ROCKETCHAT_TOKEN }).strict(),
  syncSource: z.object({ sourceId: ID }).strict(),
  conversation: z.object({ documentId: DOCUMENT_ID, startMs: MS.nullable() }).strict(),
  attachmentImage: z.object(FILE).strict(),
  recentImages: NO_PARAMS,
  tryImageModel: z.object({ ...FILE, model: z.object(VISION).strict() }).strict(),
  visionModels: z.object({ ollamaUrl: z.url().max(500) }).strict(),
  readImagesAgain: NO_PARAMS,
  pauseBackground: z.object({ minutes: z.number().int().min(1).max(7 * 24 * 60).nullable() }).strict(),
  resumeBackground: NO_PARAMS,
  meetingSeries: NO_PARAMS,
  saveMeetingSeries: z.object({
    id: ID.optional(),
    name: z.string().trim().min(1).max(100),
    matchers: z.array(z.object({
      code: z.string().regex(/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/).optional(),
      weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
      time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
      tolerance: z.number().int().min(0).max(180).optional(),
      from: MS.optional(),
      to: MS.optional(),
    }).strict()).max(50),
  }).strict(),
  deleteMeetingSeries: z.object({ id: ID }).strict(),
  setCloudAllowed: z.object({ sourceId: ID, allowed: z.boolean() }).strict(),
  getSettings: NO_PARAMS,
  saveSettings: z.object({
    attachments: z.object({ ...VISION, describeImages: z.boolean(), readDocuments: z.boolean(), months: z.number().int().min(0).max(120) }).strict(),
    summaries: z.object({ auto: z.boolean(), months: z.number().int().min(0).max(120) }).strict(),
    embedding: EMBEDDING,
    llm: LLM,
    server: z.object({ port: z.number().int().min(1024).max(65535) }).strict(),
    app: z.object({ startAtLogin: z.boolean() }).strict(),
  }).strict(),
  keys: NO_PARAMS,
  setKey: z.object({ provider: KEY_PROVIDER, key: z.string().trim().min(1).max(500) }).strict(),
  deleteKey: z.object({ provider: KEY_PROVIDER }).strict(),
  openInStenograma: MEETING.extend({ startMs: MS.nullable() }).strict(),
  openInChat: z.object({ documentId: DOCUMENT_ID, messageId: z.string().min(1).max(200) }).strict(),
  restartCore: NO_PARAMS,
};

export const isAppMethod = (method: unknown): method is keyof AppMethods => typeof method === 'string' && Object.hasOwn(PARAMS, method);

export type AppCall = { [M in keyof AppMethods]: { method: M, params: AppMethods[M]['params'] } }[keyof AppMethods];

// The params of a call, checked; throws on anything else
export const checkCall = (method: unknown, params: unknown): AppCall => {
  if (!isAppMethod(method)) {
    throw new Error('Unknown method');
  }

  return { method, params: PARAMS[method].parse(params ?? {}) } as AppCall;
};
