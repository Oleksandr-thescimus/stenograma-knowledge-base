import { generateText, type LanguageModel } from 'ai';
import type { ChatMessage } from '../chat/types.ts';
import type { Db } from '../db.ts';
import { callOptions } from '../llm.ts';
import type { LlmSettings } from '../settings.ts';
import { estimateTokens } from '../tokens.ts';

// The user's style for reply drafts (F9), from what they wrote themselves in the messenger: their replies to messages
// like the one answered (the same person's first, then the same room's and those with the same words), the drafts they
// rewrote before sending with what they sent, and a description of how they write, made by a model from their messages
// and edited by them in Settings. Only the draft's own source is read, so F8 holds as for the conversation itself

const DAY = 86_400_000;
// A reply within an hour of the message before it, and the user's messages within 3 minutes of each other as one;
// the replies of the last two years count a little more
const REPLY_WITHIN_MS = 60 * 60_000;
const CONTINUED_WITHIN_MS = 3 * 60_000;
const RECENT_MS = 2 * 365 * DAY;
const MAX_EXAMPLES = 8;
const MAX_CORRECTIONS = 3;
const MAX_EXAMPLE_CHARS = 300;
// Examples and corrections leave the most of the prompt to the conversation and the sources
export const STYLE_TOKEN_BUDGET = 1200;

export interface ReplyExample {
  // The message replied to
  author: string;
  message: string;
  reply: string;
}

export interface Correction {
  draft: string;
  sent: string;
}

const textOf = (json: string) => (JSON.parse(json) as ChatMessage);
const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
const clip = (text: string) => (text.length > MAX_EXAMPLE_CHARS ? `${text.slice(0, MAX_EXAMPLE_CHARS)}…` : text);

// As copied into the messenger: no [n] marks, spaces and case aside
const plain = (text: string) => text.replace(/\[\d{1,3}\]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

interface Pair {
  roomId: string;
  threadId: string | null;
  ts: number;
  prev: ChatMessage;
  reply: ChatMessage;
}

// The user's replies: their messages right after someone else's in the same conversation (a thread with its first
// message, or a room's main line), within an hour, with the ones they wrote right after (a reply in a few messages)
const replyPairs = (db: Db, sourceId: number, username: string): Pair[] => {
  const rows = db.prepare(`
    select room_id as roomId, coalesce(thread_id, '') as conversation, ts, json from chat_messages where source_id = ?
    union all
    select room_id, message_id, ts, json from chat_messages where source_id = ?
      and message_id in (select thread_id from chat_messages where source_id = ? and thread_id is not null)
    order by roomId, conversation, ts
  `).all(sourceId, sourceId, sourceId) as { roomId: string, conversation: string, ts: number, json: string }[];
  const pairs: Pair[] = [];
  let open = null as Pair | null;
  let last = null as { key: string, ts: number, message: ChatMessage } | null;

  for (const row of rows) {
    const key = `${row.roomId}\n${row.conversation}`;
    const message = textOf(row.json);
    const before = last?.key === key ? last : null;

    if (message.username === username) {
      if (open && before && row.ts - before.ts <= CONTINUED_WITHIN_MS) {
        open.reply = { ...open.reply, text: `${open.reply.text}\n${message.text}` };
      } else if (before && before.message.username !== username && row.ts - before.ts <= REPLY_WITHIN_MS) {
        open = { roomId: row.roomId, threadId: row.conversation || null, ts: row.ts, prev: before.message, reply: message };
        pairs.push(open);
      } else {
        open = null;
      }
    } else {
      open = null;
    }

    last = { key, ts: row.ts, message };
  }

  return pairs.filter(({ prev, reply }) => prev.text.trim() && reply.text.trim() && reply.text.length <= 2 * MAX_EXAMPLE_CHARS);
};

export const countReplies = (db: Db, sourceId: number, username: string) => replyPairs(db, sourceId, username).length;

// The user's replies most like the one to write: to the same person, in the same room, with the same words, and recent;
// none from the conversation given with the draft
export const replyExamples = (
  db: Db, sourceId: number, username: string, answered: ChatMessage, conversationStart: number, now = Date.now(), limit = MAX_EXAMPLES,
): ReplyExample[] => {
  const asked = words(answered.text);
  const sameConversation = (pair: Pair) => pair.roomId === answered.roomId && (pair.threadId ?? null) === (answered.threadId ?? null)
    && pair.ts >= conversationStart;
  const score = (pair: Pair) => {
    const theirs = words(pair.prev.text);
    const shared = [...asked].filter((word) => theirs.has(word)).length;
    const overlap = shared / Math.max(1, Math.sqrt(asked.size * theirs.size));

    return (pair.prev.username === answered.username ? 3 : 0) + (pair.roomId === answered.roomId ? 1 : 0) + (4 * overlap)
      + (0.5 * Math.max(0, 1 - ((now - pair.ts) / RECENT_MS)));
  };

  return replyPairs(db, sourceId, username)
    .filter((pair) => !sameConversation(pair))
    .map((pair) => ({ pair, score: score(pair) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ pair }) => ({ author: pair.prev.author, message: clip(pair.prev.text), reply: clip(pair.reply.text) }));
};

// The drafts the user answered with a message of their own, the latest first, with that message
const answeredDrafts = (db: Db, sourceId: number, limit: number) => (db.prepare(`
  select d.text as draft, m.json from drafts d
  join chat_messages m on m.source_id = d.source_id and m.message_id = d.sent_message_id
  where d.source_id = ? and d.text <> '' order by d.updated_at desc limit ?
`).all(sourceId, limit) as { draft: string, json: string }[]).map(({ draft, json }) => ({ draft, sent: textOf(json).text }));

// The last drafts the user rewrote before sending, with what they sent
export const corrections = (db: Db, sourceId: number, limit = MAX_CORRECTIONS): Correction[] => answeredDrafts(db, sourceId, 50)
  .filter(({ draft, sent }) => sent.trim() && plain(draft) !== plain(sent))
  .slice(0, limit)
  .map(({ draft, sent }) => ({ draft: clip(draft), sent: clip(sent) }));

// How the drafts did: of those the user answered, how many were sent as written
export const draftOutcomes = (db: Db, sourceId: number) => {
  const answered = answeredDrafts(db, sourceId, 10_000);
  const asWritten = answered.filter(({ draft, sent }) => plain(draft) === plain(sent)).length;

  return { answered: answered.length, asWritten };
};

// The examples and corrections as the prompt has them, within the budget, the best first
export const formatStyle = (examples: ReplyExample[], fixes: Correction[], budget = STYLE_TOKEN_BUDGET) => {
  let left = budget;
  const take = <T>(items: T[], format: (item: T) => string) => items.map(format).filter((text) => {
    const cost = estimateTokens(text);

    if (cost > left) {
      return false;
    }

    left -= cost;

    return true;
  });
  const fixed = take(fixes, (fix) => `Draft: ${fix.draft}\nSent: ${fix.sent}`);
  const replies = take(examples, (example) => `${example.author}: ${example.message}\nThe user: ${example.reply}`);

  return [
    replies.length && `The user's own replies to other messages, to write like them (length, language, greetings or none, punctuation, emoji); not a source of facts:\n\n${replies.join('\n\n')}`,
    fixed.length && `Drafts written for the user before and what they sent instead; write like what they sent:\n\n${fixed.join('\n\n')}`,
  ].filter(Boolean).join('\n\n');
};

// The user's latest messages with some text, for the description of their style
export const styleSample = (db: Db, sources: { sourceId: number, username: string }[], limit = 200, maxChars = 8000) => {
  const messages = sources.flatMap(({ sourceId, username }) => (db.prepare(`
    select json from chat_messages where source_id = ? and json_extract(json, '$.username') = ? order by ts desc limit ?
  `).all(sourceId, username, limit) as { json: string }[]).map(({ json }) => textOf(json)))
    .filter((message) => message.text.trim().length >= 2)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit);
  const sample: string[] = [];
  let chars = 0;

  for (const message of messages) {
    const text = clip(message.text.replace(/\s+/g, ' ').trim());

    if (chars + text.length > maxChars) {
      break;
    }

    sample.push(text);
    chars += text.length;
  }

  return sample;
};

export const STYLE_SYSTEM = [
  'You describe how a person writes chat messages, for someone who will write replies as them. From their messages,',
  'write 5 to 8 short bullet points, as instructions: the usual length; greetings and sign-offs or none; the language',
  'or languages and when they mix them; formal or informal address; capital letters and punctuation; emoji; typical',
  'words and phrases. Do not quote whole messages and do not name people or projects. Only the bullet points.',
].join(' ');

export const describeStyle = async (model: LanguageModel, settings: LlmSettings, sample: string[], abortSignal?: AbortSignal) => {
  const { text } = await generateText({
    model,
    abortSignal,
    system: STYLE_SYSTEM,
    prompt: `The person's messages, the latest first:\n\n${sample.map((message) => `- ${message}`).join('\n')}`,
    maxOutputTokens: 500,
    ...callOptions(settings),
    ...(settings.provider === 'ollama' && { providerOptions: { ollama: { think: false, options: { num_ctx: 8192 } } } }),
  });

  if (!text.trim()) {
    throw new Error('The model gave no description');
  }

  return text.trim();
};
