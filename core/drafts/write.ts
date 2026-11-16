import { generateText, type LanguageModel } from 'ai';
import { attachmentsOf } from '../chat/attachments.ts';
import type { ImageNote } from '../chat/chunk.ts';
import { getRoom, imagesOf, roomLabel, roomMembers } from '../chat/store.ts';
import type { ChatMessage } from '../chat/types.ts';
import type { Db } from '../db.ts';
import { formatDay } from '../format.ts';
import { callOptions, isLocalLlm } from '../llm.ts';
import type { DraftMessage } from '../protocol.ts';
import type { SearchHit } from '../search.ts';
import type { LlmSettings } from '../settings.ts';
import { estimateTokens, INPUT_TOKEN_BUDGET } from '../tokens.ts';
import { formatSource, pickSources, type AnswerSource } from '../answer/answer.ts';
import type { DraftRow } from './store.ts';

// A reply draft (F9): the conversation up to the message it answers, and what the knowledge base has on it (meetings,
// other chats), as numbered sources the draft cites, so the user checks it before copying it into the messenger

// The conversation's messages given: a thread's first and its last replies, or the room's last ones of two days
const CONVERSATION_MESSAGES = 20;
const CONVERSATION_MS = 2 * 86_400_000;
// What is searched for: the messages to the user since they last wrote, the last few
const ASKED_MESSAGES = 3;
const MAX_SOURCES = 6;
// Ollama's default context would cut the prompt; a larger one is slower on a small GPU (as summaries)
const OLLAMA_CONTEXT_TOKENS = 8192;
const MAX_DRAFT_TOKENS = 600;
const PROMPT_OVERHEAD_TOKENS = 150;
const MAX_MESSAGE_CHARS = 1500;

export const DRAFT_SYSTEM = `You draft a reply to a chat message for the user, who reads it, edits it and sends it \
themselves.

- Write as the user, in the first person, to the people in the conversation; in the language of the message they \
reply to. Write the way the user writes: their own replies and their style, when given, show how (length, greetings \
or none, punctuation, emoji); they are never a source of facts.
- Answer what was asked of the user. Take facts (decisions, dates, numbers, who does what) only from the conversation \
and the numbered sources, and cite a source after what comes from it as [n], e.g. [2]: the user checks these and \
removes the marks.
- Captions of meetings are automatic: words may be misheard. Sources marked "made by AI" are summaries. An image sent \
in the conversation is given as what AI read of it ("[image …, described by AI: …]"): answer about what it shows.
- When neither the conversation nor the sources say what's needed, don't make it up: reply briefly that you'll find out, \
or ask what's needed.
- Only the reply itself: no "Draft:", no explanations, no quotes around it.`;

const time = (ts: number) => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

const parse = (rows: unknown[]) => (rows as { json: string }[]).map(({ json }) => JSON.parse(json) as ChatMessage);

// The messages shown with the draft and given to the model, in order, the answered one last
export const conversationOf = (db: Db, draft: Pick<DraftRow, 'sourceId' | 'roomId' | 'threadId' | 'messageId'>) => {
  const [answered] = parse(db.prepare('select json from chat_messages where source_id = ? and message_id = ?').all(draft.sourceId, draft.messageId));

  if (!answered) {
    return [];
  }

  if (draft.threadId) {
    const first = parse(db.prepare('select json from chat_messages where source_id = ? and message_id = ?').all(draft.sourceId, draft.threadId));
    const replies = parse(db.prepare(`
      select json from (
        select json, ts from chat_messages where source_id = ? and thread_id = ? and ts <= ? order by ts desc limit ?
      ) order by ts
    `).all(draft.sourceId, draft.threadId, answered.ts, CONVERSATION_MESSAGES - 1));

    return [...first, ...replies];
  }

  return parse(db.prepare(`
    select json from (
      select json, ts from chat_messages where source_id = ? and room_id = ? and thread_id is null and ts <= ? and ts >= ?
      order by ts desc limit ?
    ) order by ts
  `).all(draft.sourceId, draft.roomId, answered.ts, answered.ts - CONVERSATION_MS, CONVERSATION_MESSAGES));
};

export const toDraftMessages = (messages: ChatMessage[], username: string): DraftMessage[] => messages.map((message) => ({
  id: message.id,
  author: message.author,
  text: message.text,
  ts: message.ts,
  mine: message.username === username,
}));

// "#general" or "direct: Olena", with " › thread" for a thread
export const conversationLabel = (db: Db, draft: Pick<DraftRow, 'sourceId' | 'roomId' | 'threadId'>) => {
  const room = getRoom(db, draft.sourceId, draft.roomId);

  return `${room ? roomLabel(room) : 'a room no longer synced'}${draft.threadId ? ' › thread' : ''}`;
};

type ImagesOf = (message: ChatMessage) => ImageNote[];

const NO_IMAGES: ImagesOf = () => [];

// What a vision model read of an image: what it shows and its text, in place of the file's name
const imageNote = (image: ImageNote) => `[image ${image.name}, described by AI: ${image.description?.replace(/\s+/g, ' ').trim() ?? ''}${
  image.text ? ` Text in it: ${image.text.replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE_CHARS)}` : ''}]`;

const formatMessage = (message: ChatMessage, username: string, images: ImageNote[]) => {
  const quotes = (message.quotes ?? []).map((quote) => `> ${quote.author}: ${quote.text.replace(/\s+/g, ' ').slice(0, 300)}\n`).join('');
  const described = new Set(images.map((image) => image.name));
  const names = (message.files ?? []).filter((name) => !described.has(name));
  const files = [names.length ? `[files: ${names.join(', ')}]` : '', ...images.map(imageNote)].filter(Boolean).map((part) => ` ${part}`).join('');

  return `${quotes}${message.author}${message.username === username ? ' (the user)' : ''}, ${formatDay(message.ts)} ${time(message.ts)}: ${
    message.text.slice(0, MAX_MESSAGE_CHARS)}${files}`;
};

// The messages a draft answers: the others' since the user last wrote, the last few
export const askedMessages = (messages: ChatMessage[], username: string) => {
  const lastMine = messages.findLastIndex((message) => message.username === username);

  return messages.slice(lastMine + 1).filter((message) => message.username !== username).slice(-ASKED_MESSAGES);
};

// What to search for: those messages, with what was read of their images (an image sent without a word is all there is)
export const askedText = (messages: ChatMessage[], username: string, images: ImagesOf = NO_IMAGES) => askedMessages(messages, username)
  .map((message) => [message.text, ...images(message).map((image) => [image.description, image.text].filter(Boolean).join('\n'))]
    .filter((part) => part.trim()).join('\n'))
  .filter(Boolean).join('\n');

// The images of the messages a draft answers not read yet: the draft waits for them, so it knows what they show
export const unreadImages = (db: Db, sourceId: number, messages: ChatMessage[], username: string, since: number) => {
  const files = attachmentsOf(db, sourceId, askedMessages(messages, username).map((message) => message.id));

  return [...files.values()].flat().filter((file) => file.kind === 'image' && file.state === 'pending' && file.attempts === 0 && file.ts >= since);
};

// How the user writes: their description, edited in Settings, and their replies and corrected drafts as the prompt has
// them (style.ts)
export interface DraftStyle {
  description: string;
  examples: string;
}

const NO_STYLE: DraftStyle = { description: '', examples: '' };

export const draftSystem = (style: DraftStyle) => (style.description.trim()
  ? `${DRAFT_SYSTEM}\n\nHow the user writes, in their own words:\n${style.description.trim()}`
  : DRAFT_SYSTEM);

export interface PreparedDraft {
  system: string;
  prompt: string;
  sources: AnswerSource[];
}

// F8: with a cloud LLM only the chunks of sources with cloudAllowed are given. The conversation's own chunks are left
// out, as its messages are given whole
export const prepareDraft = (
  db: Db, settings: LlmSettings, draft: Pick<DraftRow, 'sourceId' | 'roomId' | 'threadId'>, messages: ChatMessage[], username: string,
  hits: SearchHit[], style: DraftStyle = NO_STYLE,
): PreparedDraft => {
  const cloudAllowed = new Set((db.prepare('select id from sources where cloud_allowed = 1').all() as { id: number }[]).map((row) => row.id));
  const start = messages[0]?.ts ?? 0;
  const own = (hit: SearchHit) => hit.sourceId === draft.sourceId && hit.threadId === draft.roomId && hit.createdAt >= start - 86_400_000;
  const allowed = hits.filter((hit) => !own(hit) && (isLocalLlm(settings) || cloudAllowed.has(hit.sourceId)));
  const images = imagesOf(db, draft.sourceId, messages);
  const conversation = `Conversation in ${conversationLabel(db, draft)}:\n\n${
    messages.map((message) => formatMessage(message, username, images(message))).join('\n')}`;
  const budget = settings.provider === 'ollama' ? OLLAMA_CONTEXT_TOKENS - MAX_DRAFT_TOKENS : INPUT_TOKEN_BUDGET[settings.provider];
  const system = draftSystem(style);
  const sourcesBudget = budget === undefined
    ? undefined
    : Math.max(0, budget - estimateTokens(system) - estimateTokens(style.examples) - estimateTokens(conversation) - PROMPT_OVERHEAD_TOKENS);
  const sources = pickSources(allowed, sourcesBudget, (hit) => roomMembers(db, hit.sourceId, hit.threadId!), MAX_SOURCES);
  const answered = messages.at(-1);

  return {
    system,
    prompt: `${sources.length ? `Sources:\n\n${sources.map(formatSource).join('\n\n')}\n\n` : 'No sources were found.\n\n'}`
      + `${style.examples ? `${style.examples}\n\n` : ''}${conversation}\n\n`
      + `Draft the user's reply to ${answered ? `${answered.author}'s last message` : 'the conversation'}.`,
    sources,
  };
};

export const writeDraft = async (model: LanguageModel, settings: LlmSettings, prepared: PreparedDraft, abortSignal?: AbortSignal) => {
  const { text } = await generateText({
    model,
    abortSignal,
    system: prepared.system,
    prompt: prepared.prompt,
    maxOutputTokens: MAX_DRAFT_TOKENS,
    ...callOptions(settings),
    ...(settings.provider === 'ollama' && { providerOptions: { ollama: { think: false, options: { num_ctx: OLLAMA_CONTEXT_TOKENS } } } }),
  });
  const draft = text.trim().replace(/^(draft|reply|чернетка|відповідь)\s*:\s*/i, '');

  if (!draft) {
    throw new Error('The model gave no draft');
  }

  return draft;
};
