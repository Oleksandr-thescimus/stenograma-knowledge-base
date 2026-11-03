import { z } from 'zod';
import type { AppMethods } from '../../core/protocol';

// The renderer is untrusted (CLAUDE.md): it will show emails and messages written by other people. So every call it
// makes through window.kb is checked here before it reaches the core, and anything else is refused

const NO_PARAMS = z.object({}).strict();
const ID = z.number().int().positive();
const TEXT = z.string().max(20_000);
const MS = z.number().int().nonnegative();

const EMBEDDING = z.object({ provider: z.enum(['ollama', 'gemini']), model: z.string().min(1).max(200), ollamaUrl: z.url().max(500) }).strict();
const LLM = z.object({ provider: z.enum(['groq', 'gemini', 'ollama']), model: z.string().min(1).max(200), ollamaUrl: z.url().max(500) }).strict();
const KEY_PROVIDER = z.enum(['groq', 'gemini']);
const MEETING = z.object({ sourceId: ID, sessionId: z.string().min(1).max(1000) }).strict();

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
    }).strict(),
  }).strict(),
  cancelAsk: z.object({ askId: z.string().min(1).max(100) }).strict(),
  chats: NO_PARAMS,
  chat: z.object({ chatId: ID }).strict(),
  deleteChat: z.object({ chatId: ID }).strict(),
  meeting: MEETING,
  addBrowser: z.object({ label: z.string().max(100) }).strict(),
  removeSource: z.object({ sourceId: ID }).strict(),
  setCloudAllowed: z.object({ sourceId: ID, allowed: z.boolean() }).strict(),
  getSettings: NO_PARAMS,
  saveSettings: z.object({
    embedding: EMBEDDING,
    llm: LLM,
    server: z.object({ port: z.number().int().min(1024).max(65535) }).strict(),
    app: z.object({ startAtLogin: z.boolean() }).strict(),
  }).strict(),
  keys: NO_PARAMS,
  setKey: z.object({ provider: KEY_PROVIDER, key: z.string().trim().min(1).max(500) }).strict(),
  deleteKey: z.object({ provider: KEY_PROVIDER }).strict(),
  openInStenograma: MEETING.extend({ startMs: MS.nullable() }).strict(),
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
