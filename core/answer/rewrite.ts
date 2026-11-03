import { generateText, type LanguageModel } from 'ai';
import { z } from 'zod';
import type { LlmSettings } from '../settings.ts';
import { callOptions } from '../llm.ts';

// F6: before the search, one call turns the question and the conversation into what to search for, the dates and the
// person. When its JSON can't be read, the question is searched as it is

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface SearchRequest {
  query: string;
  // Milliseconds, local days: from the start of `from` to the end of `to`
  from?: number;
  to?: number;
  person?: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const REWRITE = z.object({
  query: z.string().trim().min(1),
  from: z.string().regex(DAY).nullish(),
  to: z.string().regex(DAY).nullish(),
  person: z.string().trim().min(1).nullish(),
});

const localDay = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export const rewriteSystem = (now: Date, timeZone: string) => `You turn a question about the user's meetings, emails and \
chats into a search request. Today is ${localDay(now)}, ${now.toLocaleDateString('en-US', { weekday: 'long' })}; time zone ${timeZone}.

Reply with one JSON object and nothing else:
{"query": "...", "from": "YYYY-MM-DD" or null, "to": "YYYY-MM-DD" or null, "person": "..." or null}

- query: what to search for, in the question's language, complete on its own: replace "it", "that meeting" and the like \
with what the conversation means.
- from, to: the days the question is limited to, both inclusive ("last week" is its Monday to Sunday, "yesterday" is \
one day); null when it names no time.
- person: whose words or messages the question is about, as written in it; null when none.`;

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
  };
};

export const rewriteQuestion = async (
  model: LanguageModel, settings: LlmSettings, question: string, history: ChatTurn[] = [], now = new Date(),
): Promise<SearchRequest> => {
  try {
    const { text } = await generateText({
      model,
      system: rewriteSystem(now, Intl.DateTimeFormat().resolvedOptions().timeZone),
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
