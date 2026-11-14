import { describe, expect, it } from 'vitest';
import type { AppStatus, CitedSource, CoreStatus, MeetingView, SourceInfo } from '../../core/protocol.ts';
import { citationOf, citedNumbers, linkCitations, splitCitations } from '../../app/renderer/src/lib/citations.ts';
import { describeStatus } from '../../app/renderer/src/lib/status.ts';
import { summariesLeftMs, summaryStep } from '../../app/renderer/src/lib/summaries.ts';
import { citedRange } from '../../app/renderer/src/lib/meeting.ts';

describe('citations in an answer', () => {
  it('splits the text around [n]', () => {
    expect(splitCitations('Перенесли [1][3], бо тести [2].')).toEqual([
      { kind: 'text', text: 'Перенесли ' },
      { kind: 'citation', n: 1 },
      { kind: 'citation', n: 3 },
      { kind: 'text', text: ', бо тести ' },
      { kind: 'citation', n: 2 },
      { kind: 'text', text: '.' },
    ]);
    expect([...citedNumbers('a [2] b [2][5]')]).toEqual([2, 5]);
  });

  it('links the citations that have a source, and keeps the others as text, not as reference links', () => {
    expect(linkCitations('Так [1][2].', new Set([1]))).toBe('Так [1](#cite-1)\\[2\\].');
    expect(citationOf('#cite-12')).toBe(12);
    expect(citationOf('https://example.com/#cite-1')).toBeNull();
  });
});

describe('the cited moment of a meeting', () => {
  const meeting = {
    messages: [
      { user: 'Олена', text: 'Привіт', startMs: 0 },
      { user: 'Oleh', text: 'Збірка  готова', startMs: 35_000 },
      { user: 'Олена', text: 'Переносимо', startMs: 80_000 },
      { user: 'Ivan', text: 'Допишу фікс', startMs: null },
    ],
  } as MeetingView;
  const source = (text: string, startMs: number | null, documentKind = 'meeting') => ({ text, startMs, documentKind }) as CitedSource;

  it('finds the chunk\'s messages by its first line, its spaces as the chunker writes them', () => {
    expect(citedRange(meeting, source('Oleh: Збірка готова\nОлена: Переносимо', 35_000))).toEqual({ first: 1, last: 2 });
  });

  it('else by its start, and not at all in a summary', () => {
    expect(citedRange(meeting, source('Олена: Переносимо, part of a long message', 60_000))).toEqual({ first: 2, last: 2 });
    expect(citedRange(meeting, source('- Реліз перенесли', null, 'meeting-summary'))).toBeNull();
  });
});

describe('the sidebar\'s status line', () => {
  const core = (over: Partial<CoreStatus> = {}): CoreStatus => ({
    kbId: 'kb',
    dataDir: '/d',
    sources: [],
    embedding: { model: 'ollama:bge-m3', pending: 0, running: false, error: null, rebuild: null },
    attachments: { pending: 0, done: 3, failed: 0, running: false, error: null, paused: null },
    summaries: {
      pending: 0, done: 1, running: false, current: null, averageMs: null, tokensPerSecond: null, skipped: 0, error: null, waitingFor: null,
      retryAt: null,
    },
    server: { port: 47321, listening: true, error: null },
    ...over,
  });
  const app = (coreStatus: CoreStatus): AppStatus => ({
    process: { state: 'running', error: null, restarts: 0, retryAt: null },
    core: coreStatus,
  });
  const chat = {
    id: 2, kind: 'rocketchat', account: 'chat.example.com', lastError: 'Refused',
    connector: { running: false, problem: 'auth' },
  } as unknown as SourceInfo;

  it('puts a source that needs the user before the work going on, and opens where it\'s fixed', () => {
    const summary = describeStatus(app(core({ sources: [chat], embedding: { ...core().embedding, pending: 40 } })));

    expect(summary).toMatchObject({ tone: 'error', text: 'Rocket.Chat: new token needed', tab: 'sources' });
    expect(summary.details).toContain('Rocket.Chat: its token was refused, a new one is needed');
    expect(summary.details).toContain('Indexing: 40 left');
  });

  it('shows the work going on, then the paused work, then "Up to date"', () => {
    expect(describeStatus(app(core({ attachments: { ...core().attachments, pending: 5 } })))).toMatchObject({ tone: 'busy', text: 'Reading images and files: 5 left', tab: 'index' });
    expect(describeStatus(app(core({ attachments: { ...core().attachments, pending: 5, paused: { until: null } } }))).text).toBe('Background AI paused');
    expect(describeStatus(app(core()))).toMatchObject({ tone: 'ok', text: 'Up to date' });
  });

  it('says how long the waiting summaries take, and not a skipped one as work going on', () => {
    const summaries = { ...core().summaries, pending: 3, averageMs: 10 * 60_000 };
    const current = { title: 'Weekly', createdAt: 0, startedAt: 1000, done: 2, all: 5, llm: 'ollama qwen3:8b', local: true };

    expect(summariesLeftMs(summaries, 0)).toBe(30 * 60_000);
    // The one being made counts what's left of it
    expect(summariesLeftMs({ ...summaries, current }, 1000 + (4 * 60_000))).toBe((2 * 10 * 60_000) + (6 * 60_000));
    expect(summariesLeftMs({ ...summaries, averageMs: null }, 0)).toBeNull();
    expect(summaryStep(current)).toBe('notes, step 3 of 5');
    expect(summaryStep({ done: 4, all: 5 })).toBe('writing the summary (step 5 of 5)');

    expect(describeStatus(app(core({ summaries }))).text).toBe('Summarizing meetings: 3 left, ~30 min');
    expect(describeStatus(app(core({ summaries: { ...summaries, skipped: 3 } }))).text).toBe('Up to date');
  });
});
