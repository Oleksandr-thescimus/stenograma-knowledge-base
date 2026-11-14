import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseRewrite, rewriteSystem } from '../../core/answer/rewrite.ts';
import { findOrCreateSource } from '../../core/sources.ts';
import { ingestBundles, meetingDocumentId, reindexMeetings } from '../../core/stenograma/ingest.ts';
import { saveSeries, seriesOf, seriesSources, seriesSuggestions, type MeetingSeries } from '../../core/stenograma/series.ts';
import type { Session } from '../../core/stenograma/types.ts';
import { saveSummary } from '../../core/summaries.ts';
import { bundle, createTestDb, message, type Db } from './helpers.ts';

// A session of a Meet code at a local time, as the extension names them
const sessionId = (day: string, time: string, code: string) => `${day.replace(/-/g, '/')} ${time}:00 -> /${code}`;
const session = (id: string): Session => ({ sessionId: id, stenogramaArray: [] });

describe('meeting series', () => {
  const series = (id: number, name: string, matchers: MeetingSeries['matchers']): MeetingSeries => ({ id, name, matchers });

  it('puts a meeting in the series whose matcher fits it most closely', () => {
    const all = [
      series(1, 'Team room', [{ code: 'abc-defg-hij' }]),
      series(2, 'Lead meeting', [{ code: 'abc-defg-hij', weekdays: [4], time: '11:30' }]),
      series(3, 'Daily', [{ weekdays: [1, 2, 3, 4, 5], time: '10:30', tolerance: 10 }]),
      series(4, 'Retro', [{ code: 'rrr-rrrr-rrr', from: new Date(2026, 9, 1).getTime() }]),
    ];
    const of = (id: string) => seriesOf(all, session(id))?.name ?? null;

    // Thursday 2026-11-05 at 11:34: the code and its time beat the code alone
    expect(of(sessionId('2026-11-05', '11:34', 'abc-defg-hij'))).toBe('Lead meeting');
    expect(of(sessionId('2026-11-05', '15:00', 'abc-defg-hij'))).toBe('Team room');
    expect(of(sessionId('2026-11-04', '11:30', 'abc-defg-hij'))).toBe('Team room');
    // A weekday at 10:30, whatever its code; not later than the tolerance, nor on a Sunday
    expect(of(sessionId('2026-11-03', '10:38', 'xyz-wxyz-xyz'))).toBe('Daily');
    expect(of(sessionId('2026-11-03', '10:45', 'xyz-wxyz-xyz'))).toBeNull();
    expect(of(sessionId('2026-11-08', '10:30', 'xyz-wxyz-xyz'))).toBeNull();
    // From the day the schedule changed
    expect(of(sessionId('2026-09-30', '12:00', 'rrr-rrrr-rrr'))).toBeNull();
    expect(of(sessionId('2026-10-07', '12:00', 'rrr-rrrr-rrr'))).toBe('Retro');
  });

  it('takes a series named in the question, as written in the list it\'s given', () => {
    expect(rewriteSystem(new Date(2026, 10, 13), 'Europe/Kyiv', ['Lead meeting', 'Daily'])).toContain('"Lead meeting", "Daily"');
    expect(rewriteSystem(new Date(2026, 10, 13), 'Europe/Kyiv')).not.toContain('series');
    expect(parseRewrite('{"query": "що обговорювали", "from": "2026-10-13", "to": "2026-11-12", "series": "Lead meeting"}', 'q'))
      .toMatchObject({ query: 'що обговорювали', series: 'Lead meeting' });
  });
});

describe('meetings of a series', () => {
  let db: Db;
  let cleanup: () => void;
  let sourceId: number;

  beforeEach(() => {
    ({ db, cleanup } = createTestDb());
    sourceId = findOrCreateSource(db, 'stenograma-backup', 'data.json').id;
  });

  afterEach(() => cleanup());

  const lead = ['2026-10-15', '2026-10-22', '2026-10-29', '2026-11-05'].map((day) => sessionId(day, '11:30', 'lea-dmee-tin'));
  const daily = sessionId('2026-11-05', '10:30', 'dai-lyda-ily');

  const ingest = () => ingestBundles(db, sourceId, [
    ...lead.map((id, n) => bundle(id, [message('Olena', `Лід ${n}: бюджет і найм, тиждень ${n}`), message('Andrii', `Реліз ${n} переносимо`)], {
      // The bundle's own messages stay: only the name is added
      session: n === 3 ? { customName: 'Planning' } as Session : undefined,
    })),
    bundle(daily, [message('Taras', 'Дейлі: вчора закінчив задачу')]),
  ], null);

  const doc = (id: string) => db.prepare('select title, series_id as seriesId from documents where id = ?').get(meetingDocumentId(sourceId, id)) as
    { title: string, seriesId: number | null };
  const header = (id: string) => (db.prepare('select header from chunks where document_id = ? order by ord limit 1').get(meetingDocumentId(sourceId, id)) as
    { header: string }).header;

  it('suggests series by Meet code, and names their meetings once one is saved', () => {
    ingest();

    expect(seriesSuggestions(db).map(({ code, meetings, weekday, weekdayShare, time, timeShare, seriesId }) => ({ code, meetings, weekday, weekdayShare, time, timeShare, seriesId })))
      .toEqual([
        { code: 'lea-dmee-tin', meetings: 4, weekday: 4, weekdayShare: 1, time: '11:30', timeShare: 1, seriesId: null },
        { code: 'dai-lyda-ily', meetings: 1, weekday: 4, weekdayShare: 1, time: '10:30', timeShare: 1, seriesId: null },
      ]);

    const id = saveSeries(db, { name: 'Lead meeting', matchers: [{ code: 'lea-dmee-tin' }] });
    reindexMeetings(db, null);

    expect(doc(lead[0])).toEqual({ title: 'Lead meeting', seriesId: id });
    // Its own name stays, after the series's
    expect(doc(lead[3])).toEqual({ title: 'Lead meeting · Planning', seriesId: id });
    expect(header(lead[0])).toBe('[Meeting · Lead meeting · 2026-10-15]');
    expect(doc(daily)).toEqual({ title: 'dai-lyda-ily', seriesId: null });
    expect(() => saveSeries(db, { name: 'lead MEETING', matchers: [] })).toThrow('called "lead MEETING" already');
  });

  it('gives a source a meeting of the period, newest first, its summary when it has one, else its chunks most like the query', async () => {
    ingest();
    const id = saveSeries(db, { name: 'Lead meeting', matchers: [{ code: 'lea-dmee-tin' }] });
    reindexMeetings(db, null);
    saveSummary(db, meetingDocumentId(sourceId, lead[2]), 'hash', 'model', '- Погодили бюджет на найм');
    reindexMeetings(db, null);

    const { hits } = await seriesSources(db, 'бюджет', { seriesId: id, from: new Date(2026, 9, 20).getTime(), provider: null });

    expect(hits.map((hit) => [hit.documentId.replace(`stenograma:${sourceId}:`, ''), hit.documentKind])).toEqual([
      [lead[3], 'meeting'],
      [`${lead[2]}:short`, 'meeting-short-summary'],
      [lead[1], 'meeting'],
    ]);
    expect(hits[1].text).toBe('- Погодили бюджет на найм');
  });
});
