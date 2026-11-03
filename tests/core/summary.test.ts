import { simulateReadableStream } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { meetingLanguage, splitIntoParts, summarizeTranscript, summaryInputBudget } from '../../core/answer/summary.ts';
import { DEFAULT_SETTINGS, type LlmSettings } from '../../core/settings.ts';
import { findOrCreateSource } from '../../core/sources.ts';
import { ingestBundles, meetingDocumentId, reconcileSessions } from '../../core/stenograma/ingest.ts';
import { getMeeting, meetingLines } from '../../core/stenograma/meeting.ts';
import { saveSummary, textHash } from '../../core/summaries.ts';
import { estimateTokens } from '../../core/tokens.ts';
import { bundle, createTestDb, message, type Db } from './helpers.ts';

// "Summarize" in the meeting view: a short summary of a whole meeting, in parts when it doesn't fit the model, kept
// with the meeting until its text changes

const USAGE = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const FINISH = { unified: 'stop', raw: 'stop' } as const;
const GEMINI: LlmSettings = { ...DEFAULT_SETTINGS.llm, provider: 'gemini', model: 'gemini-2.5-flash' };
const GROQ: LlmSettings = { ...DEFAULT_SETTINGS.llm, provider: 'groq', model: 'openai/gpt-oss-120b' };

// Notes for each part, then the summary streamed
const summarizer = (summary: string[]) => {
  let notes = 0;

  return new MockLanguageModelV3({
    doGenerate: async () => {
      notes += 1;

      return { content: [{ type: 'text', text: `- нотатка ${notes}` }], finishReason: FINISH, usage: USAGE, warnings: [] };
    },
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't' },
          ...summary.map((delta) => ({ type: 'text-delta' as const, id: 't', delta })),
          { type: 'text-end', id: 't' },
          { type: 'finish', finishReason: FINISH, usage: USAGE },
        ],
      }),
    }),
  });
};

const transcript = (count: number) => Array.from({ length: count }, (_, n) => `Olena: Репліка ${n}: говоримо про бюджет на квартал і закупівлю серверів.`);

describe('summaries of meetings', () => {
  it('splits a text into parts within the budget, in order, cutting a line longer than that', () => {
    const parts = splitIntoParts([...transcript(30), 'x'.repeat(200)], 60);

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => estimateTokens(part) <= 60)).toBe(true);
    // Nothing lost or reordered
    expect(parts.join('').replace(/\n/g, '')).toBe([...transcript(30), 'x'.repeat(200)].join(''));
  });

  it('names the meeting\'s language, as a small model follows the instructions\' or an English title\'s', async () => {
    expect(meetingLanguage(['Olena Koval: Доброго ранку, почнемо з бюджету.'])).toBe('Ukrainian');
    expect(meetingLanguage(['Olena Koval: Good morning, let\'s start with the budget.'])).toBe('English');

    const model = summarizer(['- Підсумок.']);
    await summarizeTranscript(model, GROQ, { header: 'Meeting: Infrastructure review', lines: transcript(400), onProgress: () => undefined, onText: () => undefined });

    expect([...model.doGenerateCalls, ...model.doStreamCalls].every((call) => JSON.stringify(call.prompt).includes('Write in Ukrainian'))).toBe(true);
  });

  it('summarizes a meeting at once when it fits, as Gemini takes any', async () => {
    const model = summarizer(['- Погодили ', 'бюджет.']);
    const progress: [number, number][] = [];
    let streamed = '';
    const summary = await summarizeTranscript(model, GEMINI, {
      header: 'Meeting: Weekly', lines: transcript(400), onProgress: (done, all) => progress.push([done, all]), onText: (text) => {
        streamed += text;
      },
    });

    expect(summary).toBe('- Погодили бюджет.');
    expect(streamed).toBe('- Погодили бюджет.');
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(progress).toEqual([[0, 1]]);
    expect(JSON.stringify(model.doStreamCalls[0].prompt)).toContain('Репліка 399');
  });

  it('summarizes a meeting too long for the model in parts, then combines their notes', async () => {
    const model = summarizer(['- Підсумок.']);
    const progress: [number, number][] = [];
    const lines = transcript(400);
    const summary = await summarizeTranscript(model, GROQ, {
      header: 'Meeting: Weekly', lines, onProgress: (done, all) => progress.push([done, all]), onText: () => undefined,
    });
    const parts = model.doGenerateCalls.length;

    expect(summary).toBe('- Підсумок.');
    expect(parts).toBeGreaterThan(1);
    // Each call within Groq's free tier
    expect(model.doGenerateCalls.every((call) => estimateTokens(JSON.stringify(call.prompt)) < summaryInputBudget(GROQ)! * 1.1)).toBe(true);
    expect(progress[0]).toEqual([0, parts + 1]);
    expect(progress.at(-1)).toEqual([parts, parts + 1]);

    const final = JSON.stringify(model.doStreamCalls[0].prompt);

    expect(final).toContain('- нотатка 1');
    expect(final).toContain(`- нотатка ${parts}`);
    expect(final).not.toContain('Репліка');
  });

  describe('kept with the meeting', () => {
    const SESSION = '2026/11/02 10:00:00 -> /abc-defg-hij';
    let db: Db;
    let cleanup: () => void;
    let sourceId: number;

    beforeEach(() => {
      ({ db, cleanup } = createTestDb());
      sourceId = findOrCreateSource(db, 'stenograma-backup', 'data.json').id;
      ingestBundles(db, sourceId, [bundle(SESSION, [message('Olena', 'Почнемо з бюджету.', 1000), message('Oleh', 'Бюджет погодили.', 2000)])], null);
    });

    afterEach(() => cleanup());

    const keep = () => {
      const meeting = getMeeting(db, sourceId, SESSION)!;
      saveSummary(db, meetingDocumentId(sourceId, SESSION), textHash(meetingLines(meeting)), 'ollama qwen3.5:9b', '- Погодили бюджет.');
    };

    it('is shown with the meeting, and as stale once its text changes', () => {
      expect(getMeeting(db, sourceId, SESSION)!.shortSummary).toBeNull();

      keep();

      expect(getMeeting(db, sourceId, SESSION)!.shortSummary).toMatchObject({ text: '- Погодили бюджет.', model: 'ollama qwen3.5:9b', stale: false });

      ingestBundles(db, sourceId, [bundle(SESSION, [message('Olena', 'Почнемо з бюджету.', 1000), message('Oleh', 'Бюджет погодили, але з умовою.', 2000)])], null);

      expect(getMeeting(db, sourceId, SESSION)!.shortSummary).toMatchObject({ text: '- Погодили бюджет.', stale: true });
    });

    it('goes with the meeting when it\'s deleted', () => {
      keep();
      reconcileSessions(db, sourceId, []);

      expect(db.prepare('select count(*) as n from summaries').get()).toEqual({ n: 0 });
    });
  });
});
