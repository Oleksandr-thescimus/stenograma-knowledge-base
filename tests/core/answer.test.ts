import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { citedNumbers, formatSource, pickSources, prepareAnswer, type AnswerSource } from '../../core/answer/answer.ts';
import { parseRewrite, rewriteQuestion } from '../../core/answer/rewrite.ts';
import type { SearchHit } from '../../core/search.ts';
import { DEFAULT_SETTINGS, type LlmSettings } from '../../core/settings.ts';
import { findOrCreateSource } from '../../core/sources.ts';
import { estimateTokens } from '../../core/tokens.ts';
import { createTestDb, type Db } from './helpers.ts';

const replying = (text: string) => new MockLanguageModelV3({
  doGenerate: async () => ({
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
    warnings: [],
  }),
});

const OLLAMA = DEFAULT_SETTINGS.llm;
const GROQ: LlmSettings = { ...OLLAMA, provider: 'groq', model: 'openai/gpt-oss-120b' };

describe('the rewrite (F6)', () => {
  // Monday 2026-11-02
  const today = new Date(2026, 10, 2, 9, 30);

  it('tells the model today\'s date, weekday and time zone, and reads its dates as local days', async () => {
    const model = replying('{"query": "що казала Олена про бюджет", "from": "2026-10-26", "to": "2026-11-01", "person": "Олена"}');
    const request = await rewriteQuestion(model, OLLAMA, 'Що Олена казала про бюджет минулого тижня?', [], today);
    const system = JSON.stringify(model.doGenerateCalls[0].prompt[0]);

    expect(system).toContain('Today is 2026-11-02, Monday');
    expect(system).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(request).toEqual({
      query: 'що казала Олена про бюджет',
      from: new Date(2026, 9, 26).getTime(),
      // The end of Sunday, as the start of Monday
      to: new Date(2026, 10, 2).getTime(),
      person: 'Олена',
    });
  });

  it('passes the conversation, so a follow-up question can be completed', async () => {
    const model = replying('{"query": "коли реліз 2.4", "from": null, "to": null, "person": null}');
    await rewriteQuestion(model, OLLAMA, 'А коли він?', [
      { role: 'user', content: 'Що з релізом 2.4?' },
      { role: 'assistant', content: 'Його перенесли [1].' },
    ], today);

    expect(JSON.stringify(model.doGenerateCalls[0].prompt)).toContain('User: Що з релізом 2.4?');
  });

  it('reads JSON in a code block', () => {
    expect(parseRewrite('```json\n{"query": "бюджет", "from": null}\n```', 'q')).toEqual({ query: 'бюджет' });
  });

  it('searches the question as it is when the JSON can\'t be read', async () => {
    expect(parseRewrite('Sure! The query is: budget', 'Що з бюджетом?')).toEqual({ query: 'Що з бюджетом?' });
    expect(parseRewrite('{"query": "бюджет", "from": "last week"}', 'Що з бюджетом?')).toEqual({ query: 'Що з бюджетом?' });
    expect(parseRewrite('{"query": "бюджет",', 'Що з бюджетом?')).toEqual({ query: 'Що з бюджетом?' });

    const failing = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error('connection refused');
      },
    });

    expect(await rewriteQuestion(failing, OLLAMA, 'Що з бюджетом?')).toEqual({ query: 'Що з бюджетом?' });
  });
});

describe('the answer\'s context', () => {
  let db: Db;
  let cleanup: () => void;
  let meetings: number;
  let mail: number;

  beforeEach(() => {
    ({ db, cleanup } = createTestDb());
    meetings = findOrCreateSource(db, 'stenograma-backup', 'data.json').id;
    // Email: no cloudAllowed by default (F8)
    mail = findOrCreateSource(db, 'outlook', 'me@example.com').id;
  });

  afterEach(() => cleanup());

  const hit = (n: number, sourceId: number, text = `Текст фрагмента ${n} `.repeat(60)): SearchHit => ({
    chunkId: n, documentId: `d${n}`, documentKind: 'meeting', sourceId, threadId: `t${n}`, title: `Meeting ${n}`, createdAt: 0,
    startMs: null, header: `[Meeting · Meeting ${n} · 2026-11-02]`, text, madeByAi: false, participants: [], score: 1 / n,
  });

  it('fits Groq\'s input budget, in search order, and never more than 8 chunks', () => {
    const hits = Array.from({ length: 12 }, (_, n) => hit(n + 1, meetings));

    const picked = pickSources(hits, 2000);
    const cost = (source: AnswerSource) => estimateTokens(formatSource(source)) + 2;
    const used = picked.reduce((sum, source) => sum + cost(source), 0);

    expect(picked.map((source) => source.hit.chunkId)).toEqual(hits.slice(0, picked.length).map((h) => h.chunkId));
    expect(used).toBeLessThanOrEqual(2000);
    expect(used + cost({ n: picked.length + 1, hit: hits[picked.length] })).toBeGreaterThan(2000);
    expect(pickSources(hits, undefined)).toHaveLength(8);
    expect(prepareAnswer(db, GROQ, 'Що вирішили?', hits).sources.length).toBeLessThan(10);
  });

  it('leaves out sources without cloudAllowed for a cloud LLM, and keeps them for a local one (F8)', () => {
    const hits = [hit(1, mail, 'Лист про бюджет'), hit(2, meetings, 'Зустріч про бюджет')];
    const cloud = prepareAnswer(db, GROQ, 'Що з бюджетом?', hits);
    const local = prepareAnswer(db, OLLAMA, 'Що з бюджетом?', hits);

    expect(cloud.sources.map((source) => source.hit.chunkId)).toEqual([2]);
    expect(cloud.leftOut).toBe(1);
    expect(cloud.prompt).not.toContain('Лист про бюджет');
    expect(local.sources.map((source) => source.hit.chunkId)).toEqual([1, 2]);
    expect(local.prompt).toContain('[1] [Meeting · Meeting 1 · 2026-11-02]\nЛист про бюджет');
  });

  it('finds the sources an answer cites', () => {
    expect(citedNumbers('Бюджет погодили [2], реліз перенесли [1][3].')).toEqual(new Set([1, 2, 3]));
  });
});
