import { describe, expect, it } from 'vitest';
import { chunkTranscript, MAX_CHUNK_TOKENS } from '../../core/chunk.ts';
import { estimateTokens } from '../../core/tokens.ts';
import { message } from './helpers.ts';

const HEADER = '[Meeting · Planning · 2026-11-02]';
const sentence = (n: number) => `Репліка номер ${n}: обговорили бюджет, реліз і хто що робить до кінця тижня.`;
const meeting = (count: number) => Array.from({ length: count }, (_, n) => message(n % 2 ? 'Olena' : 'Andrii', sentence(n), 1_000 + (n * 15_000)));

describe('transcript chunker', () => {
  it('cuts on message boundaries, at most ~400 tokens each', () => {
    const chunks = chunkTranscript(HEADER, meeting(80));

    expect(chunks.length).toBeGreaterThan(3);

    for (const chunk of chunks) {
      expect(estimateTokens(chunk.text)).toBeLessThanOrEqual(MAX_CHUNK_TOKENS);
      expect(chunk.text.split('\n').every((line) => /^(Olena|Andrii): Репліка номер \d+/.test(line))).toBe(true);
      expect(chunk.header).toBe(HEADER);
    }
  });

  it('keeps each chunk\'s start from the first timestamp', () => {
    const chunks = chunkTranscript(HEADER, meeting(80));

    expect(chunks[0].startMs).toBe(0);
    expect(chunks[1].startMs).toBeGreaterThan(0);
  });

  it('keeps the earlier chunks of a meeting that grows', () => {
    const before = chunkTranscript(HEADER, meeting(60));
    const after = chunkTranscript(HEADER, meeting(90));

    expect(after.slice(0, before.length - 1)).toEqual(before.slice(0, -1));
    expect(after.length).toBeGreaterThan(before.length);
  });

  it('cuts one message longer than a chunk on spaces', () => {
    const long = message('Olena', Array.from({ length: 500 }, (_, n) => `слово${n}`).join(' '));
    const chunks = chunkTranscript(HEADER, [long]);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => estimateTokens(chunk.text) <= MAX_CHUNK_TOKENS)).toBe(true);
    expect(chunks.map((chunk) => chunk.text).join(' ').endsWith('слово499')).toBe(true);
  });

  it('gives chunks without a start when messages have no timestamps, and skips empty ones', () => {
    const chunks = chunkTranscript(HEADER, [message('Olena', 'Привіт'), message('Andrii', '  ')]);

    expect(chunks).toEqual([{ ord: 0, header: HEADER, text: 'Olena: Привіт', startMs: undefined }]);
  });
});
