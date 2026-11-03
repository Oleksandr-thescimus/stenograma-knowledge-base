import { streamText, type LanguageModel } from 'ai';
import type { Db } from '../db.ts';
import { formatMoment } from '../format.ts';
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

export const ANSWER_SYSTEM = `You answer questions about the user's own meetings, emails and chats, using only the \
numbered sources you're given.

- Answer in the language of the question, briefly and to the point.
- After each statement, cite the sources it comes from as [n], e.g. [2] or [1][3].
- Sources marked "made by AI" are AI summaries of a meeting: when they differ from the meeting's own text, trust the text.
- Captions are automatic: words may be misheard or repeated.
- When the sources don't contain the answer, say so plainly instead of guessing.`;

export interface AnswerSource {
  n: number;
  hit: SearchHit;
}

export const formatSource = ({ n, hit }: AnswerSource) => `[${n}] ${hit.header}${formatMoment(hit.startMs)}\n${hit.text}`;

// The best chunks that fit the budget, in their search order. Chunks are never condensed: notes would lose the citations
export const pickSources = (hits: SearchHit[], budgetTokens: number | undefined): AnswerSource[] => {
  const sources: AnswerSource[] = [];
  let tokens = 0;

  for (const hit of hits) {
    const source = { n: sources.length + 1, hit };
    const cost = estimateTokens(formatSource(source)) + 2;

    if (sources.length === MAX_SOURCES || (budgetTokens !== undefined && tokens + cost > budgetTokens)) {
      break;
    }

    sources.push(source);
    tokens += cost;
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

// F8: with a cloud LLM, only chunks of sources with cloudAllowed go into the context
export const prepareAnswer = (db: Db, settings: LlmSettings, question: string, hits: SearchHit[]): PreparedAnswer => {
  const cloudAllowed = new Set((db.prepare('select id from sources where cloud_allowed = 1').all() as { id: number }[]).map((row) => row.id));
  const allowed = isLocalLlm(settings) ? hits : hits.filter((hit) => cloudAllowed.has(hit.sourceId));
  const budget = INPUT_TOKEN_BUDGET[settings.provider];
  const sourcesBudget = budget === undefined
    ? undefined
    : budget - estimateTokens(ANSWER_SYSTEM) - estimateTokens(question) - PROMPT_OVERHEAD_TOKENS;
  const sources = pickSources(allowed, sourcesBudget);

  return {
    system: ANSWER_SYSTEM,
    prompt: `Sources:\n\n${sources.map(formatSource).join('\n\n')}\n\nQuestion: ${question}`,
    sources,
    leftOut: hits.length - allowed.length,
  };
};

// The numbers the answer cites, to list those sources first
export const citedNumbers = (answer: string) => new Set([...answer.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])));

export const streamAnswer = (model: LanguageModel, settings: LlmSettings, prepared: PreparedAnswer, onError: (error: unknown) => void) => streamText({
  model,
  system: prepared.system,
  prompt: prepared.prompt,
  maxOutputTokens: MAX_ANSWER_TOKENS,
  ...callOptions(settings),
  // streamText reports provider errors here, not by throwing from textStream
  onError: ({ error }) => onError(error),
});
