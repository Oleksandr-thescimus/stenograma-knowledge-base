import type { StenogramaMessage } from './stenograma/types.ts';
import { estimateTokens } from './tokens.ts';

// At most ~400 tokens: 6 such chunks fit Groq's free-tier context (N4), and multilingual-e5 reads at most 512
export const MAX_CHUNK_TOKENS = 400;

export interface ChunkDraft {
  ord: number;
  // Kind, title and date only: what doesn't change during a meeting, so a growing one keeps its earlier chunks
  header: string;
  text: string;
  // Milliseconds from the session's first timestamp, to link an answer to the moment
  startMs?: number;
}

export interface Line {
  text: string;
  startMs?: number;
}

// Cuts a line longer than a chunk on spaces
const splitLongLine = (text: string) => {
  const maxChars = MAX_CHUNK_TOKENS * 3;
  const parts: string[] = [];
  let rest = text;

  while (estimateTokens(rest) > MAX_CHUNK_TOKENS) {
    const space = rest.lastIndexOf(' ', maxChars);
    const cut = space > 0 ? space : maxChars;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }

  return [...parts, rest];
};

// Packs lines into chunks from the start, never splitting a line unless it alone is too long: lines added at the end
// change only the last chunk
export const chunkLines = (header: string, lines: Line[]): ChunkDraft[] => {
  const chunks: ChunkDraft[] = [];
  let texts: string[] = [];
  let tokens = 0;
  let startMs: number | undefined;

  const flush = () => {
    if (texts.length) {
      chunks.push({ ord: chunks.length, header, text: texts.join('\n'), startMs });
    }

    texts = [];
    tokens = 0;
    startMs = undefined;
  };

  for (const line of lines) {
    for (const text of splitLongLine(line.text)) {
      if (texts.length && tokens + estimateTokens(text) > MAX_CHUNK_TOKENS) {
        flush();
      }

      startMs ??= line.startMs;
      texts.push(text);
      tokens += estimateTokens(text) + 1;
    }
  }

  flush();

  return chunks;
};

// A transcript as "Speaker: text" lines, cut on message boundaries (step 7 of the plan's Sending). Messages without a
// timestamp give chunks without a start, linked to the meeting
export const chunkTranscript = (header: string, messages: StenogramaMessage[]) => {
  const spoken = messages.filter((message) => message.text?.trim());
  const first = spoken.find((message) => message.timestamp)?.timestamp;

  return chunkLines(header, spoken.map((message) => ({
    text: `${message.user || '?'}: ${message.text.replace(/\s+/g, ' ').trim()}`,
    startMs: message.timestamp && first !== undefined ? message.timestamp - first : undefined,
  })));
};
