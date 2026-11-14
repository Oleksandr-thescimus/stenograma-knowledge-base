import { generateText, type LanguageModel } from 'ai';
import { z } from 'zod';
import type { LlmSettings } from '../settings.ts';
import { callOptions } from '../llm.ts';
import type { ChatTurn } from '../protocol.ts';

// F6: before the search, one call turns the question and the conversation into what to search for, the dates and the
// person. When its JSON can't be read, the question is searched as it is

export type { ChatTurn };

export interface SearchRequest {
  query: string;
  // Milliseconds, local days: from the start of `from` to the end of `to`
  from?: number;
  to?: number;
  person?: string;
  // A chat room, as the question names it
  room?: string;
  // The messages with the most reactions, instead of those most like the query
  rank?: 'reactions';
  // A meeting series, one of those named
  series?: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const REWRITE = z.object({
  query: z.string().trim().min(1),
  from: z.string().regex(DAY).nullish(),
  to: z.string().regex(DAY).nullish(),
  person: z.string().trim().min(1).nullish(),
  room: z.string().trim().min(1).nullish(),
  // A small model may say it its own way
  rank: z.string().nullish().transform((rank) => (rank && /reaction|реакц/i.test(rank) ? 'reactions' as const : undefined)),
  series: z.string().trim().min(1).nullish(),
});

const localDay = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export const rewriteSystem = (now: Date, timeZone: string, series: string[] = []) => `You turn a question about the user's \
meetings, emails and chats into a search request. Today is ${localDay(now)}, ${now.toLocaleDateString('en-US', { weekday: 'long' })}; time zone ${timeZone}.

Reply with one JSON object and nothing else:
{"query": "...", "from": "YYYY-MM-DD" or null, "to": "YYYY-MM-DD" or null, "person": "..." or null, "room": "..." or null, \
"rank": "reactions" or null${series.length ? ', "series": "..." or null' : ''}}

- query: what to search for, in the question's language, complete on its own: replace "it", "that meeting" and the like \
with what the conversation means.
- from, to: the days the question is limited to, both inclusive ("last week" is its Monday to Sunday, "yesterday" is \
one day); null when it names no time.
- person: whose words or messages the question is about, as written in it; null when none.
- room: the chat room or channel the question is limited to, as written in it (e.g. "qa_dev_talks"); null when none.
- rank: "reactions" when the question asks for the messages with the most reactions (the most liked, the most \
popular); null otherwise.${series.length ? `
- series: when the question is about the meetings of one of these recurring series, its name exactly as written here \
(the question may say it another way or in another language): ${series.map((name) => JSON.stringify(name)).join(', ')}; \
null otherwise.` : ''}`;

const conversationText = (question: string, history: ChatTurn[]) => [
  ...history.map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content}`),
  `User: ${question}`,
].join('\n\n');

const startOfDay = (day: string) => new Date(`${day}T00:00:00`).getTime();
const startOfNextDay = (day: string) => {
  const date = new Date(`${day}T00:00:00`);
  date.setDate(date.getDate() + 1);

  return date.getTime();
};

// The model's reply as a search request; the question as it is when the reply has no readable JSON
export const parseRewrite = (reply: string, question: string): SearchRequest => {
  const json = /\{[\s\S]*\}/.exec(reply)?.[0];
  let parsed: z.infer<typeof REWRITE> | undefined;

  try {
    parsed = json ? REWRITE.safeParse(JSON.parse(json)).data : undefined;
  } catch {
    parsed = undefined;
  }

  if (!parsed) {
    return { query: question };
  }

  return {
    query: parsed.query,
    ...(parsed.from && { from: startOfDay(parsed.from) }),
    ...(parsed.to && { to: startOfNextDay(parsed.to) }),
    ...(parsed.person && { person: parsed.person }),
    ...(parsed.room && { room: parsed.room.replace(/^#/, '') }),
    ...(parsed.rank && { rank: parsed.rank }),
    ...(parsed.series && { series: parsed.series }),
  };
};

export const rewriteQuestion = async (
  model: LanguageModel, settings: LlmSettings, question: string, history: ChatTurn[] = [], now = new Date(), abortSignal?: AbortSignal,
  // The meeting series' names, which a question may name
  series: string[] = [],
): Promise<SearchRequest> => {
  try {
    const { text } = await generateText({
      model,
      abortSignal,
      system: rewriteSystem(now, Intl.DateTimeFormat().resolvedOptions().timeZone, series),
      prompt: conversationText(question, history),
      maxOutputTokens: 300,
      ...callOptions(settings),
    });

    return parseRewrite(text, question);
  } catch {
    // The search goes on without the rewrite; the answer call reports a provider that's down
    return { query: question };
  }
};
