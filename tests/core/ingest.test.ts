import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBrowserSource } from '../../core/browsers.ts';
import { embedPending, pendingEmbeddings } from '../../core/embed/store.ts';
import { search } from '../../core/search.ts';
import { findOrCreateSource, listSources, removeSource } from '../../core/sources.ts';
import { saveSummary } from '../../core/summaries.ts';
import { ingestBundles, keepOneCopy, meetingDocumentId, reconcileSessions } from '../../core/stenograma/ingest.ts';
import { sourceMeetings } from '../../core/stenograma/meeting.ts';
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

    expect(reconcileSessions(db, sourceId, [SESSION], null)).toBe(1);
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

// A backup restored in Chrome and in Firefox: each browser sends the same sessions
describe('a meeting that several browsers sent', () => {
  let db: Db;
  let cleanup: () => void;
  let chrome: number;
  let firefox: number;

  beforeEach(() => {
    ({ db, cleanup } = createTestDb());
    [chrome, firefox] = ['Chrome', 'Firefox'].map((label) => createBrowserSource(db, label).source.id);
  });

  afterEach(() => cleanup());

  const restored = () => bundle(SESSION, lines(3), {
    actionItems: [{ sessionId: SESSION, createdAt: 1, what: 'Надіслати оцінку', who: 'Марія', done: false }],
  });
  const indexedFrom = () => (db.prepare('select distinct source_id as sourceId from documents order by source_id').all() as { sourceId: number }[])
    .map(({ sourceId }) => sourceId);
  const sendFromBoth = () => {
    ingestBundles(db, chrome, [restored()], null);
    ingestBundles(db, firefox, [restored()], null);
  };

  it('is indexed once, from the browser that sent it first, and found once', async () => {
    sendFromBoth();

    expect(indexedFrom()).toEqual([chrome]);
    expect((await search(db, 'бюджет')).hits.map((hit) => hit.documentId)).toEqual([meetingDocumentId(chrome, SESSION)]);
    expect(listSources(db).map((source) => source.indexedElsewhere)).toEqual([0, 1]);
    expect(listSources(db).map((source) => source.copiesIn)).toEqual([[], [{ sourceId: chrome, meetings: 1 }]]);
  });

  it('lists each browser\'s meetings, a copy indexed in another as from that one, with the newest on its card', () => {
    const own = '2026/11/02 12:00:00 -> /xyz-abcd-efg';
    sendFromBoth();
    ingestBundles(db, firefox, [bundle(own, lines(2))], null);
    saveSummary(db, meetingDocumentId(firefox, own), 'hash', 'model', 'Погодили бюджет.');

    expect(sourceMeetings(db, firefox).map(({ sessionId, indexedIn, summarized }) => ({ sessionId, indexedIn, summarized })))
      .toEqual(expect.arrayContaining([
        { sessionId: SESSION, indexedIn: chrome, summarized: false },
        { sessionId: own, indexedIn: firefox, summarized: true },
      ]));
    expect(sourceMeetings(db, chrome).map((meeting) => meeting.sessionId)).toEqual([SESSION]);

    const card = listSources(db).find((source) => source.id === firefox)!;
    expect(card).toMatchObject({ meetings: 1, summarized: 1, inSeries: 0, latestMeeting: { title: expect.any(String), createdAt: expect.any(Number) } });
    expect(card.firstMeetingAt).toBe(card.latestMeeting!.createdAt);
  });

  it('keeps the indexed copy for the same rows with their keys in another order', () => {
    ingestBundles(db, chrome, [restored()], null);
    const reordered = JSON.parse(JSON.stringify(restored()), (_key, value: unknown) => (value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).reverse())
      : value));
    ingestBundles(db, firefox, [reordered], null);

    expect(indexedFrom()).toEqual([chrome]);
  });

  it('indexes the copy that changed last, with the short summary moved to it', () => {
    sendFromBoth();
    saveSummary(db, meetingDocumentId(chrome, SESSION), 'hash', 'model', 'Погодили бюджет.');
    ingestBundles(db, firefox, [bundle(SESSION, lines(4))], null);

    expect(indexedFrom()).toEqual([firefox]);
    expect(db.prepare('select document_id as documentId, text from summaries').all())
      .toEqual([{ documentId: meetingDocumentId(firefox, SESSION), text: 'Погодили бюджет.' }]);
  });

  it('indexes another browser\'s copy when the indexed one is deleted, or its browser removed', () => {
    sendFromBoth();
    reconcileSessions(db, chrome, [], null);

    expect(indexedFrom()).toEqual([firefox]);

    ingestBundles(db, chrome, [restored()], null);
    removeSource(db, firefox, null);

    expect(indexedFrom()).toEqual([chrome]);
    expect(listSources(db).map((source) => source.indexedElsewhere)).toEqual([0]);
  });

  it('keeps the indexed copy when another browser deletes its own', () => {
    sendFromBoth();
    reconcileSessions(db, firefox, [], null);

    expect(indexedFrom()).toEqual([chrome]);
    expect(listSources(db).map((source) => source.indexedElsewhere)).toEqual([0, 0]);
  });

  it('cuts the copies indexed before to the one of the browser that sent last, with the short summary', () => {
    // As before 2026-11-12: Firefox's copy is indexed too, ingested while its source wasn't a browser's yet
    const own = '2026/11/02 12:00:00 -> /xyz-abcd-efg';
    ingestBundles(db, chrome, [restored(), bundle(own, lines(2))], null);
    db.prepare('update sources set kind = \'other\' where id = ?').run(firefox);
    ingestBundles(db, firefox, [restored()], null);
    db.prepare('update sources set kind = \'stenograma-browser\', last_sync_at = 2 where id = ?').run(firefox);
    db.prepare('update sources set last_sync_at = 1 where id = ?').run(chrome);
    saveSummary(db, meetingDocumentId(chrome, SESSION), 'hash', 'model', 'Погодили бюджет.');

    keepOneCopy(db);

    expect(db.prepare('select id from documents where kind = \'meeting\' order by id').all())
      .toEqual([{ id: meetingDocumentId(chrome, own) }, { id: meetingDocumentId(firefox, SESSION) }]);
    expect(db.prepare('select document_id as documentId from summaries').all()).toEqual([{ documentId: meetingDocumentId(firefox, SESSION) }]);
  });

  it('leaves a backup\'s copy apart: the backup is removed once a browser is paired', () => {
    const backup = findOrCreateSource(db, 'stenograma-backup', 'data.json').id;
    ingestBundles(db, backup, [restored()], null);
    ingestBundles(db, chrome, [restored()], null);

    expect(indexedFrom()).toEqual([chrome, backup]);
  });
});
