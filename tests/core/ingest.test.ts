import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { embedPending, pendingEmbeddings } from '../../core/embed/store.ts';
import { search } from '../../core/search.ts';
import { findOrCreateSource } from '../../core/sources.ts';
import { ingestBundles, meetingDocumentId, reconcileSessions } from '../../core/stenograma/ingest.ts';
import { bundle, createFakeProvider, createTestDb, message, type Db } from './helpers.ts';

const SESSION = '2026/11/02 10:00:00 -> /abc-defg-hij';
const lines = (count: number, from = 0) => Array.from({ length: count }, (_, n) => message('Olena',
  `Репліка ${n + from}: говоримо про бюджет на наступний квартал і закупівлю серверів для команди.`, 1_000 + ((n + from) * 10_000)));

describe('ingesting Stenograma sessions', () => {
  let db: Db;
  let cleanup: () => void;
  let sourceId: number;

  beforeEach(() => {
    ({ db, cleanup } = createTestDb());
    sourceId = findOrCreateSource(db, 'stenograma-backup', 'data.json').id;
  });

  afterEach(() => cleanup());

  const documents = () => (db.prepare('select id, kind from documents order by id').all() as { id: string, kind: string }[]);
  const chunkCount = () => (db.prepare('select count(*) as n from chunks').get() as { n: number }).n;

  it('makes the meeting, its summary and its action items, each marked as made by AI or not', () => {
    ingestBundles(db, sourceId, [bundle(SESSION, lines(3), {
      assistantAnswers: [{ sessionId: SESSION, createdAt: 1, kind: 'summary', text: 'Погодили бюджет.' }],
      actionItems: [{ sessionId: SESSION, createdAt: 1, what: 'Надіслати оцінку', who: 'Марія', done: false }],
    })], null);

    const id = meetingDocumentId(sourceId, SESSION);

    expect(documents()).toEqual([
      { id, kind: 'meeting' }, { id: `${id}:actions`, kind: 'meeting-actions' }, { id: `${id}:summary`, kind: 'meeting-summary' },
    ]);
    expect(db.prepare('select made_by_ai as ai from documents where id = ?').get(`${id}:summary`)).toEqual({ ai: 1 });
  });

  it('deletes what a newer bundle of the session no longer has', () => {
    ingestBundles(db, sourceId, [bundle(SESSION, lines(3), {
      assistantAnswers: [{ sessionId: SESSION, createdAt: 1, kind: 'summary', text: 'Погодили бюджет.' }],
    })], null);
    ingestBundles(db, sourceId, [bundle(SESSION, lines(3))], null);

    expect(documents().map((doc) => doc.kind)).toEqual(['meeting']);
  });

  it('embeds only the new texts of a meeting that grows (N5)', async () => {
    const { provider, embedded } = createFakeProvider();
    ingestBundles(db, sourceId, [bundle(SESSION, lines(30))], provider.id);
    const first = await embedPending(db, provider);
    const chunksBefore = chunkCount();

    ingestBundles(db, sourceId, [bundle(SESSION, [...lines(30), ...lines(30, 30)])], provider.id);
    const second = await embedPending(db, provider);

    expect(first).toBe(chunksBefore);
    // The last chunk changed and the new ones are added; the earlier ones keep their vectors
    expect(second).toBe(chunkCount() - chunksBefore + 1);
    expect(embedded).toHaveLength(first + second);
    expect(pendingEmbeddings(db, provider)).toBe(0);
  });

  it('takes a vector from the cache when a text comes back', async () => {
    const { provider, embedded } = createFakeProvider();
    ingestBundles(db, sourceId, [bundle(SESSION, lines(3))], provider.id);
    await embedPending(db, provider);
    ingestBundles(db, sourceId, [bundle(SESSION, lines(4))], provider.id);
    await embedPending(db, provider);
    ingestBundles(db, sourceId, [bundle(SESSION, lines(3))], provider.id);

    expect(pendingEmbeddings(db, provider)).toBe(0);
    expect(embedded).toHaveLength(2);
  });

  it('removes the sessions a reconcile doesn\'t list, from search too', async () => {
    const other = '2026/11/02 12:00:00 -> /xyz-abcd-efg';
    ingestBundles(db, sourceId, [bundle(SESSION, lines(2)), bundle(other, [message('Andrii', 'Мікрофон знову глючить')])], null);

    expect(reconcileSessions(db, sourceId, [SESSION])).toBe(1);
    expect(documents().map((doc) => doc.id)).toEqual([meetingDocumentId(sourceId, SESSION)]);
    expect((await search(db, 'мікрофон')).hits).toEqual([]);
  });

  it('finds п\'ять, п’ять and пʼять with each other', async () => {
    ingestBundles(db, sourceId, [bundle(SESSION, [message('Olena', 'Зустрінемось о пʼятій, буде п’ять людей')])], null);

    for (const query of ['п\'ять', 'п’ять', 'пʼять']) {
      // eslint-disable-next-line no-await-in-loop
      expect((await search(db, `людей ${query}`)).hits).toHaveLength(1);
    }
  });
});
