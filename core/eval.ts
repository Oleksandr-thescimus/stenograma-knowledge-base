import { readFileSync } from 'node:fs';
import type { Db } from './db.ts';
import type { EmbeddingProvider } from './embed/provider.ts';
import { search } from './search.ts';
import { normalizeForSearch } from './text/normalize.ts';

// kb eval: recall@10 and MRR on the private golden set (N6). A question is answered by the chunks of its expected
// session's meeting that contain the quote

export interface GoldenQuestion {
  id: string;
  question: string;
  expected: { sessionId: string, quote: string }[];
}

export const readGoldenSet = (path: string) => (JSON.parse(readFileSync(path, 'utf8')) as { questions: GoldenQuestion[] }).questions;

const normalize = (text: string) => normalizeForSearch(text.toLowerCase()).replace(/\s+/g, ' ');

// The chunks holding the quote; when a chunk boundary cut it, those holding its first three words
const answeringChunks = (db: Db, question: GoldenQuestion) => {
  const ids = new Set<number>();

  for (const { sessionId, quote } of question.expected) {
    const chunks = db.prepare(`
      select c.id, c.text from chunks c join documents d on d.id = c.document_id where d.kind = 'meeting' and d.thread_id = ?
    `).all(sessionId) as { id: number, text: string }[];
    const full = normalize(quote);
    const start = full.split(' ').slice(0, 3).join(' ');
    const found = chunks.filter((chunk) => normalize(chunk.text).includes(full));
    (found.length ? found : chunks.filter((chunk) => normalize(chunk.text).includes(start))).forEach((chunk) => ids.add(chunk.id));
  }

  return ids;
};

export interface QuestionResult {
  id: string;
  // Of the first answering chunk in the top k, else null; null too when the knowledge base has no answering chunk
  rank: number | null;
  sessionFound: boolean;
  answerable: boolean;
}

export const evaluate = async (db: Db, questions: GoldenQuestion[], provider: EmbeddingProvider | null, k = 10) => {
  const results: QuestionResult[] = [];

  for (const question of questions) {
    const answers = answeringChunks(db, question);
    // One question after another, as a user asks them
    // eslint-disable-next-line no-await-in-loop
    const { hits } = await search(db, question.question, { provider, limit: k });
    const index = hits.findIndex((hit) => answers.has(hit.chunkId));
    results.push({
      id: question.id,
      rank: index < 0 ? null : index + 1,
      sessionFound: hits.some((hit) => question.expected.some((expected) => hit.threadId === expected.sessionId)),
      answerable: answers.size > 0,
    });
  }

  return results;
};

// Recall@k, MRR@k and the share with the right session in the top k, by the letter the ids start with (q direct, p
// paraphrased)
export const summarize = (results: QuestionResult[]) => {
  const groups = Map.groupBy(results, (result) => result.id.replace(/\d+$/, ''));

  return [...groups.entries(), ['all', results] as const].map(([group, items]) => ({
    group,
    questions: items.length,
    recall: items.filter((item) => item.rank).length / items.length,
    mrr: items.reduce((sum, item) => sum + (item.rank ? 1 / item.rank : 0), 0) / items.length,
    session: items.filter((item) => item.sessionFound).length / items.length,
    unanswerable: items.filter((item) => !item.answerable).map((item) => item.id),
  }));
};
