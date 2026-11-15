import { describe, expect, it } from 'vitest';
import { aiCalls, aiErrors, aiUsage, deleteErrors, foldCalls, recordCall, type AiCall } from '../../core/usage.ts';
import { createTestDb } from './helpers.ts';

// The AI's work kept for its statistics: a row per call, folded into a day's totals after a year, counted together

const DAY = 24 * 60 * 60_000;
const NOW = new Date(2026, 10, 14, 12).getTime();

const call = (over: Partial<AiCall> = {}): AiCall => ({
  startedAt: NOW, ms: 2000, task: 'summary', provider: 'ollama', model: 'qwen3.5-4b', server: 'http://127.0.0.1:11435',
  inputTokens: 1000, outputTokens: 100, error: null, background: true, ...over,
});

const name = (provider: string, server: string) => (server.endsWith(':11435') ? 'Orange Pi' : provider);
const item = (ref: string) => (ref === 'meeting:1:s1' ? 'Weekly (14 Nov)' : null);

describe('the AI\'s statistics', () => {
  it('counts the calls by task and by model: time, tokens, speed of those that counted them, items and errors', () => {
    const { db, cleanup } = createTestDb();
    recordCall(db, call());
    recordCall(db, call({ ms: 3000, outputTokens: null, inputTokens: null, error: 'unreachable' }));
    recordCall(db, call({ task: 'embedding', provider: 'gemini', model: 'gemini-embedding-001', server: 'gemini', items: 32, inputTokens: null, outputTokens: null }));
    recordCall(db, call({ task: 'answer', background: false, startedAt: NOW - (10 * DAY) }));

    const all = aiUsage(db, null, name);
    expect(all.total).toEqual({
      calls: 4, background: 3, ms: 9000, inputTokens: 2000, outputTokens: 200, tokensPerSecond: 50, items: 35, errors: 1,
    });
    expect(all.tasks.find((row) => row.task === 'summary')).toEqual({
      task: 'summary', calls: 2, background: 2, ms: 5000, inputTokens: 1000, outputTokens: 100, tokensPerSecond: 50, items: 2, errors: 1,
    });
    expect(all.models.map((row) => [row.server, row.model, row.calls])).toEqual([
      ['Orange Pi', 'qwen3.5-4b', 3], ['gemini', 'gemini-embedding-001', 1],
    ]);
    expect(all.first).toBe(NOW - (10 * DAY));
    // The last week has no answer
    expect(aiUsage(db, NOW - (7 * DAY), name).tasks.map((row) => row.task).sort()).toEqual(['embedding', 'summary']);
    cleanup();
  });

  it('lists the failed calls, the newest first, with what they said cut short; of a task, or of a model on a server', () => {
    const { db, cleanup } = createTestDb();
    recordCall(db, call({ error: 'timeout', errorMessage: 'The model didn\'t answer in 30 minutes', item: 'meeting:1:s1' }));
    recordCall(db, call({ startedAt: NOW + 1000, task: 'image', error: 'failed', errorMessage: 'x'.repeat(500) }));
    recordCall(db, call({ startedAt: NOW + 2000, provider: 'groq', model: 'llama', server: 'groq', error: 'unreachable', errorMessage: null }));
    recordCall(db, call({ startedAt: NOW + 3000, errorMessage: 'kept only for an error' }));

    const all = aiErrors(db, { since: null }, name, item);
    expect(all.map((error) => [error.task, error.server, error.error])).toEqual([
      ['summary', 'groq', 'unreachable'], ['image', 'Orange Pi', 'failed'], ['summary', 'Orange Pi', 'timeout'],
    ]);
    expect(all[1].message).toHaveLength(300);
    expect(all[0]).toMatchObject({ message: null, background: true, item: null });
    // What it worked on, named
    expect(all[2].item).toBe('Weekly (14 Nov)');
    expect(aiErrors(db, { since: null, task: 'image' }, name, item)).toHaveLength(1);
    expect(aiErrors(db, { since: null, model: { provider: 'ollama', model: 'qwen3.5-4b', server: 'http://127.0.0.1:11435' } }, name, item)
      .map((error) => error.message)).toEqual(['x'.repeat(300), 'The model didn\'t answer in 30 minutes']);
    expect(aiErrors(db, { since: NOW + 1500 }, name, item)).toHaveLength(1);

    // Deleted as listed: the image's, then the rest; the call that answered stays
    expect(deleteErrors(db, { since: null, task: 'image' })).toBe(1);
    expect(aiErrors(db, { since: null }, name, item)).toHaveLength(2);
    expect(deleteErrors(db, { since: null })).toBe(2);
    expect(aiUsage(db, null, name).total).toMatchObject({ calls: 1, errors: 0 });
    cleanup();
  });

  it('lists the calls by what they worked on, the newest first; a question\'s rewrite and answer as one', () => {
    const { db, cleanup } = createTestDb();
    // A meeting's summary: its parts' notes, then the summary
    recordCall(db, call({ item: 'meeting:1:s1' }));
    recordCall(db, call({ startedAt: NOW + 1000, item: 'meeting:1:s1', error: 'failed' }));
    recordCall(db, call({ startedAt: NOW + 2000, task: 'rewrite', background: false, item: 'turn:7' }));
    recordCall(db, call({ startedAt: NOW + 3000, task: 'answer', background: false, item: 'turn:7', outputTokens: 400 }));
    // Indexing keeps no item
    recordCall(db, call({ startedAt: NOW + 4000, task: 'embedding', items: 32 }));

    const groups = aiCalls(db, { since: null }, name, item);
    expect(groups.map((group) => [group.task, group.item, group.calls, group.errors, group.title])).toEqual([
      ['answer', 'turn:7', 2, 0, null], ['summary', 'meeting:1:s1', 2, 1, 'Weekly (14 Nov)'],
    ]);
    expect(groups[0]).toMatchObject({ server: 'Orange Pi', ms: 4000, outputTokens: 500, lastAt: NOW + 3000 });
    expect(aiCalls(db, { since: null, task: 'answer' }, name, item).map((group) => group.item)).toEqual(['turn:7']);
    expect(aiCalls(db, { since: null, task: 'summary' }, name, item).map((group) => group.item)).toEqual(['meeting:1:s1']);
    cleanup();
  });

  it('folds the calls of over a year ago into their day, counted as before', () => {
    const { db, cleanup } = createTestDb();
    const old = NOW - (400 * DAY);
    recordCall(db, call({ startedAt: old }));
    recordCall(db, call({ startedAt: old + 1000, error: 'failed' }));
    recordCall(db, call());
    const before = aiUsage(db, null, name);

    expect(foldCalls(db, NOW - (365 * DAY))).toBe(2);
    expect(foldCalls(db, NOW - (365 * DAY))).toBe(0);
    expect(aiUsage(db, null, name).total).toEqual(before.total);
    expect((db.prepare('select count(*) as n from ai_calls').get() as { n: number }).n).toBe(1);
    expect(aiUsage(db, NOW - DAY, name).total.calls).toBe(1);
    cleanup();
  });
});
