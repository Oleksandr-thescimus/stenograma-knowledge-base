import { describe, expect, it } from 'vitest';
import type { CitedSource, MeetingView } from '../../core/protocol.ts';
import { citationOf, citedNumbers, linkCitations, splitCitations } from '../../app/renderer/src/lib/citations.ts';
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
