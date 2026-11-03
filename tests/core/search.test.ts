import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { embedPending } from '../../core/embed/store.ts';
import { BM25_WEIGHT, fuseRankings, search } from '../../core/search.ts';
import { findOrCreateSource } from '../../core/sources.ts';
import { ingestBundles } from '../../core/stenograma/ingest.ts';
import { bundle, createFakeProvider, createTestDb, message, type Db } from './helpers.ts';

describe('reciprocal rank fusion', () => {
  it('adds weighted reciprocal ranks', () => {
    const scores = fuseRankings([{ ids: [1, 2], weight: BM25_WEIGHT }, { ids: [2, 3], weight: 1 }]);

    expect(scores.get(2)).toBeCloseTo((BM25_WEIGHT / 62) + (1 / 61));
    expect([...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)).toEqual([2, 3, 1]);
  });
});

describe('hybrid search', () => {
  let db: Db;
  let cleanup: () => void;
  const { provider } = createFakeProvider();

  beforeEach(async () => {
    ({ db, cleanup } = createTestDb());
    const meetings = findOrCreateSource(db, 'stenograma-backup', 'data.json').id;
    const other = findOrCreateSource(db, 'outlook', 'me@example.com').id;
    ingestBundles(db, meetings, [
      bundle('2025/01/10 10:00:00 -> /aaa-aaaa-aaa', [message('Olena', 'Бюджет погодили, бюджет на квартал')]),
      bundle('2025/03/10 10:00:00 -> /bbb-bbbb-bbb', [message('Andrii', 'Бюджет ще раз, бюджет урізали')]),
      bundle('2025/03/11 10:00:00 -> /ccc-cccc-ccc', [message('Ihor', 'Новий мікрофон купив')]),
    ], provider.id);
    // Another source's chunk, closest to the query of all
    ingestBundles(db, other, [bundle('2025/03/12 10:00:00 -> /ddd-dddd-ddd', [message('Oleg', 'Бюджет бюджет бюджет')])], provider.id);
    db.prepare('update sources set cloud_allowed = 1').run();
    await embedPending(db, provider);
  });

  afterEach(() => cleanup());

  const titles = (hits: { title: string }[]) => hits.map((hit) => hit.title);

  it('fuses words and vectors', async () => {
    const result = await search(db, 'бюджет', { provider });

    expect(result.usedVectors).toBe(true);
    expect(titles(result.hits).slice(0, 3)).toEqual(expect.arrayContaining(['aaa-aaaa-aaa', 'bbb-bbbb-bbb', 'ddd-dddd-ddd']));
  });

  it('filters by source and date inside the vector search', async () => {
    const result = await search(db, 'бюджет', {
      provider, limit: 1, sourceKind: 'stenograma', from: new Date(2025, 2, 1).getTime(), to: new Date(2025, 3, 1).getTime(),
    });

    expect(titles(result.hits)).toEqual(['bbb-bbbb-bbb']);
  });

  it('raises the chunks where the person asked about speaks', async () => {
    const result = await search(db, 'бюджет', { provider, limit: 1, sourceKind: 'stenograma', person: 'Олена' });

    expect(titles(result.hits)).toEqual(['aaa-aaaa-aaa']);
  });

  it('searches by words only, and says so, when the query can\'t be embedded', async () => {
    const failing = {
      ...provider,
      embed: async () => {
        throw new Error('connection refused');
      },
    };
    const result = await search(db, 'мікрофон', { provider: failing });

    expect(result.usedVectors).toBe(false);
    expect(result.warning).toContain('connection refused');
    expect(titles(result.hits)).toEqual(['ccc-cccc-ccc']);
  });

  it('keeps a date filter\'s matches when many better ones fall outside it', async () => {
    const sourceId = findOrCreateSource(db, 'stenograma-backup', 'data.json').id;
    const older = Array.from({ length: 1100 }, (_, n) => bundle(`2024/05/01 10:00:00 -> /old-${String(n).padStart(4, '0')}-aaa`, [
      message('Olena', 'Бюджет, бюджет і ще раз бюджет'),
    ]));
    const filler = 'про різні інші справи команди '.repeat(20);
    const newer = [1, 2, 3].map((n) => bundle(`2025/06/0${n} 10:00:00 -> /new-000${n}-bbb`, [message('Andrii', `${filler} бюджет`)]));
    ingestBundles(db, sourceId, [...older, ...newer], null);

    // The meetings of beforeEach are earlier in 2025
    const result = await search(db, 'бюджет', { from: new Date(2025, 5, 1).getTime() });

    expect(result.hits.map((hit) => hit.threadId).sort()).toEqual(newer.map((b) => b.session.sessionId).sort());
  });
});
