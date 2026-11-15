import { generateText, streamText, type LanguageModel } from 'ai';
import { callOptions } from '../llm.ts';
import type { LlmSettings } from '../settings.ts';
import { estimateTokens, INPUT_TOKEN_BUDGET } from '../tokens.ts';

// "Summarize" in the meeting view (the plan's Decisions of 2026-11-03): a short summary of a whole meeting. One that
// doesn't fit the model's input (Groq's free tier, Ollama's context) is summarized in parts, which are then combined;
// Gemini takes it whole

// Ollama's default context (4096 tokens) would cut a part off; a larger one is slower on a small GPU
const OLLAMA_CONTEXT_TOKENS = 8192;
const MAX_NOTES_TOKENS = 1024;
const MAX_SUMMARY_TOKENS = 1536;
// Room for the prompt's own words around the text
const PROMPT_OVERHEAD_TOKENS = 100;
// Notes combined in at most this many rounds, should they not get shorter
const MAX_ROUNDS = 4;

// The meetings are Ukrainian or English (the plan's Decisions of 2026-11-02). Named, as a small model asked for "the
// language of the meeting" writes in the language of these instructions or of an English title
export const meetingLanguage = (lines: string[]) => {
  const text = lines.join(' ');

  return (text.match(/[\u0400-\u04ff]/g)?.length ?? 0) > (text.match(/[a-z]/gi)?.length ?? 0) ? 'Ukrainian' : 'English';
};

const summarySystem = (language: string) => `You write a short summary of one of the user's meetings, for the user.

- Write in ${language}.
- 5 to 7 short bullet points: what was discussed, what was decided, and who took on what, with the deadline when one \
was said.
- Only what the text says. Captions are automatic: words may be misheard or repeated.
- No introduction and no conclusion, only the bullet points.`;

const notesSystem = (language: string) => `You take notes of a part of a meeting, for its summary.

- Write in ${language}.
- Short bullet points: the topics, what was decided, who took on what, and the numbers and dates said.
- Only what this part says. Captions are automatic: words may be misheard or repeated.
- No introduction and no conclusion, only the bullet points.`;

const combineSystem = (language: string) => `You combine notes of consecutive parts of a meeting into shorter notes, for its \
summary.

- Write in ${language}.
- Short bullet points: the topics, what was decided, who took on what, and the numbers and dates said.
- Merge what repeats; keep every decision and task.
- No introduction and no conclusion, only the bullet points.`;

// The model answered nothing: its fault, not the meeting's (the background queue stops its server, as for a refusal)
export class EmptyAnswerError extends Error {}

// The input a summary's call may take, undefined for no limit
export const summaryInputBudget = (settings: LlmSettings) => (settings.provider === 'ollama'
  ? OLLAMA_CONTEXT_TOKENS - MAX_SUMMARY_TOKENS
  : INPUT_TOKEN_BUDGET[settings.provider]);

const summaryCallOptions = (settings: LlmSettings) => (settings.provider === 'ollama'
  ? { ...callOptions(settings), providerOptions: { ollama: { think: false, options: { num_ctx: OLLAMA_CONTEXT_TOKENS } } } }
  : callOptions(settings));

// Lines in parts of at most `budget` tokens, in order. A line longer than that is cut
export const splitIntoParts = (lines: string[], budget: number) => {
  const maxChars = Math.max(1, (budget - 1) * 3);
  const parts: string[][] = [];
  let part: string[] = [];
  let tokens = 0;

  for (const line of lines.flatMap((text) => text.match(new RegExp(`[^]{1,${maxChars}}`, 'g')) ?? [])) {
    const cost = estimateTokens(line) + 1;

    if (part.length && tokens + cost > budget) {
      parts.push(part);
      part = [];
      tokens = 0;
    }

    part.push(line);
    tokens += cost;
  }

  if (part.length) {
    parts.push(part);
  }

  return parts.map((lines) => lines.join('\n'));
};

export interface SummarizeOptions {
  // What the meeting is: its title, date and people
  header: string;
  // "Speaker: text"
  lines: string[];
  abortSignal?: AbortSignal;
  // The calls made of all those needed; all grows when the notes need another round
  onProgress: (done: number, all: number) => void;
  // The summary as it streams
  onText: (text: string) => void;
  // Each model call when it's done: its time and tokens (undefined when the provider doesn't say)
  onCall?: (call: SummaryCall) => void;
}

export interface SummaryCall {
  kind: 'notes' | 'combine' | 'summary';
  ms: number;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
}

export const summarizeTranscript = async (model: LanguageModel, settings: LlmSettings, options: SummarizeOptions) => {
  const { header, lines, abortSignal, onProgress, onText, onCall } = options;
  const call = summaryCallOptions(settings);
  const language = meetingLanguage(lines);
  const systems = { summary: summarySystem(language), notes: notesSystem(language), combine: combineSystem(language) };
  const budget = summaryInputBudget(settings);
  const textBudget = budget === undefined
    ? undefined
    : budget - Math.max(...Object.values(systems).map(estimateTokens)) - estimateTokens(header) - PROMPT_OVERHEAD_TOKENS;
  let level = textBudget === undefined ? [lines.join('\n')] : splitIntoParts(lines, textBudget);
  let notes = false;
  let done = 0;
  let all = level.length > 1 ? level.length + 1 : 1;
  onProgress(done, all);

  // Each part to notes, one call at a time for the providers' per-minute limits; the notes again while they don't fit
  for (let round = 0; level.length > 1 && round < MAX_ROUNDS; round += 1) {
    const next: string[] = [];

    for (const [index, part] of level.entries()) {
      const started = Date.now();
      // eslint-disable-next-line no-await-in-loop
      const { text, usage } = await generateText({
        model,
        abortSignal,
        system: notes ? systems.combine : systems.notes,
        prompt: `${header}\n\n${notes ? 'Notes' : 'Part'} ${index + 1} of ${level.length}:\n\n${part}\n\nWrite in ${language}.`,
        maxOutputTokens: MAX_NOTES_TOKENS,
        ...call,
      });
      onCall?.({ kind: notes ? 'combine' : 'notes', ms: Date.now() - started, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });

      // A model that only thought, or said nothing: its empty notes would leave the part out of the summary unsaid
      if (!text.trim()) {
        throw new EmptyAnswerError('The model gave no notes for a part of the meeting');
      }

      next.push(text.trim());
      done += 1;
      onProgress(done, all);
    }

    level = textBudget === undefined ? [next.join('\n\n')] : splitIntoParts(next, textBudget);
    notes = true;

    if (level.length > 1) {
      all += level.length;
      onProgress(done, all);
    }
  }

  let streamError: unknown;
  const started = Date.now();
  const result = streamText({
    model,
    abortSignal,
    system: systems.summary,
    prompt: `${header}\n\n${notes ? 'Notes of the meeting\'s parts, in order' : 'The meeting'}:\n\n${level.join('\n\n')}\n\nWrite in ${language}.`,
    maxOutputTokens: MAX_SUMMARY_TOKENS,
    ...call,
    // streamText reports provider errors here, not by throwing from textStream
    onError: ({ error }) => {
      streamError = error;
    },
  });
  let summary = '';

  for await (const text of result.textStream) {
    summary += text;
    onText(text);
  }

  // Stopped, the stream just ends
  abortSignal?.throwIfAborted();

  if (streamError) {
    throw streamError;
  }

  if (!summary.trim()) {
    throw new EmptyAnswerError('The model gave no summary');
  }

  if (onCall) {
    const usage = await Promise.resolve(result.usage).catch(() => null);
    onCall({ kind: 'summary', ms: Date.now() - started, inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens });
  }

  return summary.trim();
};
