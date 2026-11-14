import { streamText, type LanguageModel } from 'ai';
import { roomMembers } from '../chat/store.ts';
import type { Db } from '../db.ts';
import { formatChunkStart, isChatDocument } from '../format.ts';
import { callOptions, isLocalLlm } from '../llm.ts';
import type { SearchHit } from '../search.ts';
import type { LlmSettings } from '../settings.ts';
import { estimateTokens, INPUT_TOKEN_BUDGET } from '../tokens.ts';

// F6: an answer streamed from the found chunks, citing them as [n], within the provider's input budget (N4)

// Without a budget, the top chunks of the search
const MAX_SOURCES = 8;
// Room for the prompt's own words around the sources
const PROMPT_OVERHEAD_TOKENS = 100;
// As the extension's final answers
const MAX_ANSWER_TOKENS = 2048;
// A room's members listed in the context; a company's whole #general is ~55
const MAX_MEMBERS = 80;

export const ANSWER_SYSTEM = `You answer questions about the user's own meetings, emails and chats, using only the \
numbered sources you're given.

- Answer in the language of the question, briefly and to the point.
- After each statement, cite the sources it comes from as [n], e.g. [2] or [1][3].
- Sources marked "made by AI" are AI summaries of a meeting: when they differ from the meeting's own text, trust the text.
- Captions are automatic: words may be misheard or repeated.
- In chats, a line starting with ">" is an earlier message the next one quotes and replies to, and a thread's header \
names the message it started with: read a reply with what it answers. "Room members" lists everyone in the chat room, \
also those who didn't write. "[reactions: 👍 Name]" says who reacted to a message with which emoji: a 👍 or ✅ is \
usually agreement or "done".
- When the sources don't contain the answer, say so plainly instead of guessing.`;

export interface AnswerSource {
  n: number;
  hit: SearchHit;
  // A chat room's members, with the first source from it: the messages name only those who wrote
  members?: string[];
}

const formatMembers = (members: string[]) => `Room members (${members.length}): ${members.slice(0, MAX_MEMBERS).join(', ')}${
  members.length > MAX_MEMBERS ? `, and ${members.length - MAX_MEMBERS} more` : ''}\n`;

export const formatSource = ({ n, hit, members }: AnswerSource) => `[${n}] ${hit.header}${formatChunkStart(hit)}\n${
  hit.note ? `(${hit.note})\n` : ''}${members?.length ? formatMembers(members) : ''}${hit.text}`;

// The best chunks that fit the budget, in their search order, with each chat room's members once. Chunks are never
// condensed: notes would lose the citations
export const pickSources = (
  hits: SearchHit[], budgetTokens: number | undefined, membersOf: (hit: SearchHit) => string[] = () => [], maxSources = MAX_SOURCES,
): AnswerSource[] => {
  const sources: AnswerSource[] = [];
  const rooms = new Set<string>();
  let tokens = 0;

  for (const hit of hits) {
    const room = isChatDocument(hit.documentKind) && hit.threadId ? `${hit.sourceId}:${hit.threadId}` : null;
    const members = room && !rooms.has(room) ? membersOf(hit) : [];
    const source: AnswerSource = { n: sources.length + 1, hit, ...(members.length && { members }) };
    const cost = estimateTokens(formatSource(source)) + 2;

    if (sources.length === maxSources || (budgetTokens !== undefined && tokens + cost > budgetTokens)) {
      break;
    }

    sources.push(source);
    tokens += cost;

    if (room) {
      rooms.add(room);
    }
  }

  return sources;
};

export interface PreparedAnswer {
  system: string;
  prompt: string;
  sources: AnswerSource[];
  // Found chunks a cloud LLM may not see (F8)
  leftOut: number;
}

// F8: with a cloud LLM, only chunks of sources with cloudAllowed go into the context. A follow-up question ("and when is
// it?") comes with what the rewrite made of it, complete on its own, as the answer doesn't see the conversation
export const prepareAnswer = (
  db: Db, settings: LlmSettings, question: string, hits: SearchHit[], completeQuestion?: string,
  // A question about a meeting series gets a source for each of its meetings
  { maxSources }: { maxSources?: number } = {},
): PreparedAnswer => {
  const cloudAllowed = new Set((db.prepare('select id from sources where cloud_allowed = 1').all() as { id: number }[]).map((row) => row.id));
  const allowed = isLocalLlm(settings) ? hits : hits.filter((hit) => cloudAllowed.has(hit.sourceId));
  const budget = INPUT_TOKEN_BUDGET[settings.provider];
  const sourcesBudget = budget === undefined
    ? undefined
    : budget - estimateTokens(ANSWER_SYSTEM) - estimateTokens(question) - PROMPT_OVERHEAD_TOKENS;
  const complete = completeQuestion && completeQuestion !== question ? `\nThe question, complete: ${completeQuestion}` : '';
  const sources = pickSources(
    allowed,
    sourcesBudget === undefined ? undefined : sourcesBudget - estimateTokens(complete),
    (hit) => roomMembers(db, hit.sourceId, hit.threadId!),
    maxSources,
  );

  return {
    system: ANSWER_SYSTEM,
    prompt: `Sources:\n\n${sources.map(formatSource).join('\n\n')}\n\nQuestion: ${question}${complete}`,
    sources,
    leftOut: hits.length - allowed.length,
  };
};

// The numbers the answer cites, to list those sources first
export const citedNumbers = (answer: string) => new Set([...answer.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])));

export const streamAnswer = (
  model: LanguageModel, settings: LlmSettings, prepared: PreparedAnswer, onError: (error: unknown) => void, abortSignal?: AbortSignal,
) => streamText({
  model,
  abortSignal,
  system: prepared.system,
  prompt: prepared.prompt,
  maxOutputTokens: MAX_ANSWER_TOKENS,
  ...callOptions(settings),
  // streamText reports provider errors here, not by throwing from textStream
  onError: ({ error }) => onError(error),
});
