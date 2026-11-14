import { chunkLines, type ChunkDraft, type Line } from '../chunk.ts';
import { emojiOf } from '../format.ts';
import type { ChatMessage } from './types.ts';

// A conversation's chunks (F3): a pause of more than 30 minutes starts a new one, each at most ~400 tokens, cut on
// message boundaries from the start, so messages added at the end change only the last chunk

export const PAUSE_MS = 30 * 60_000;
// A quoted message, cut to this many characters
const QUOTE_CHARS = 200;
// An image's text in its message's line, cut to this many characters; a longer one is a document of its own too
export const IMAGE_TEXT_CHARS = 600;

// What a vision model read of an image sent with a message (chat/attachments.ts)
export interface ImageNote {
  name: string;
  description: string | null;
  text: string | null;
}

// A reaction's people named in a line, at most
const REACTION_NAMES = 5;

// A reaction with the names of its people (chat/store.ts)
export interface ReactionNote {
  emoji: string;
  names: string[];
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

// "[reactions: 👍 Olena Koval, Taras Bondarenko; ✅ Andrii Melnyk]": who agreed, who saw it done
const reactionsPart = (reactions: ReactionNote[]) => `[reactions: ${reactions.map(({ emoji, names }) => `${emojiOf(emoji)} ${
  names.slice(0, REACTION_NAMES).join(', ')}${names.length > REACTION_NAMES ? ` and ${names.length - REACTION_NAMES} more` : ''}`).join('; ')}]`;

export const snippet = (text: string, chars: number) => {
  const line = oneLine(text);

  return line.length > chars ? `${line.slice(0, chars - 1).trimEnd()}…` : line;
};

export interface LineOptions {
  // A thread's first message in its day says so
  threadMark?: boolean;
  images?: ImageNote[];
  reactions?: ReactionNote[];
}

// "Author: text", after the messages it quotes as "> Author: text": a reply keeps what it answers. An image read by a
// vision model is "[image name, described by AI: …]" in its place. The search reads the speakers from the lines without ">"
export const messageLine = (message: ChatMessage, { threadMark = true, images = [], reactions = [] }: LineOptions = {}) => {
  const quotes = (message.quotes ?? []).map((quote) => `> ${quote.author}: ${snippet(quote.text, QUOTE_CHARS)}`);
  const described = new Set(images.map((image) => image.name));
  const files = (message.files ?? []).filter((name) => !described.has(name));
  const text = [
    oneLine(message.text),
    files.length && `[file: ${files.join(', ')}]`,
    ...images.map((image) => `[image ${image.name}, described by AI: ${oneLine(image.description ?? '')}${
      image.text ? ` Text in it: ${snippet(image.text, IMAGE_TEXT_CHARS)}` : ''}]`),
    threadMark && message.startsThread && '[started a thread]',
    reactions.length && reactionsPart(reactions),
  ].filter(Boolean).join(' ');

  return [...quotes, `${message.author}: ${text}`].join('\n');
};

// Chunks of messages in their order; each starts at its first message, counted from the first one's time
export const chunkConversation = (
  header: string,
  messages: ChatMessage[],
  options: { threadMark?: boolean, imagesOf?: (message: ChatMessage) => ImageNote[], reactionsOf?: (message: ChatMessage) => ReactionNote[] } = {},
): ChunkDraft[] => {
  const start = messages[0]?.ts ?? 0;
  const chunks: ChunkDraft[] = [];
  let window: Line[] = [];
  let last: number | undefined;

  const flush = () => {
    chunkLines(header, window).forEach((chunk) => chunks.push({ ...chunk, ord: chunks.length }));
    window = [];
  };

  for (const message of messages) {
    if (last !== undefined && message.ts - last > PAUSE_MS) {
      flush();
    }

    const line = messageLine(message, { threadMark: options.threadMark, images: options.imagesOf?.(message), reactions: options.reactionsOf?.(message) });
    window.push({ text: line, startMs: message.ts - start });
    last = message.ts;
  }

  flush();

  return chunks;
};
