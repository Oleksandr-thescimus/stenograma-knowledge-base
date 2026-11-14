import type { Db } from '../db.ts';
import type { EmbeddingProvider } from '../embed/provider.ts';
import { hitsOf, search, type SearchHit } from '../search.ts';
import type { MeetingSeries, SeriesMatcher, SeriesSuggestion } from '../protocol.ts';
import { getMeetCode, getSessionDate } from './rules.ts';
import type { Session } from './types.ts';

// Meeting series: "Lead meeting" every Thursday at 11:30, "Daily" at 10:30. Meetings have no name but their Meet code,
// and a recurring calendar event keeps its code, so a series is found by its code and named once by the user. A code
// used for different meetings (a team's own room) is told apart by a weekday and time. The series goes into the
// meeting's title and chunks, and documents.series_id, for the questions about one ("what was discussed at the lead
// meetings last month")

export type { MeetingSeries, SeriesMatcher };

// A matcher's time fits a meeting starting this many minutes from it, unless it says otherwise
export const DEFAULT_TOLERANCE_MINUTES = 20;

export const listSeries = (db: Db): MeetingSeries[] => (db.prepare('select id, name, matchers from meeting_series order by name').all() as
  { id: number, name: string, matchers: string }[]).map((row) => ({ ...row, matchers: JSON.parse(row.matchers) as SeriesMatcher[] }));

export const saveSeries = (db: Db, series: { id?: number, name: string, matchers: SeriesMatcher[] }) => {
  const name = series.name.trim();
  const clash = db.prepare('select id from meeting_series where lower(name) = lower(?)').get(name) as { id: number } | undefined;

  if (clash && clash.id !== series.id) {
    throw new Error(`A series is called "${name}" already`);
  }

  if (series.id) {
    db.prepare('update meeting_series set name = ?, matchers = ? where id = ?').run(name, JSON.stringify(series.matchers), series.id);

    return series.id;
  }

  return Number(db.prepare('insert into meeting_series (name, matchers, created_at) values (?, ?, ?)')
    .run(name, JSON.stringify(series.matchers), Date.now()).lastInsertRowid);
};

export const deleteSeries = (db: Db, id: number) => db.prepare('delete from meeting_series where id = ?').run(id).changes > 0;

const minutesOf = (time: string) => {
  const [hours, minutes] = time.split(':').map(Number);

  return (hours * 60) + minutes;
};

// How specific a matcher is: a code with a time beats a code alone, which beats a time alone
const fits = (matcher: SeriesMatcher, meeting: { code: string | null, start: Date }) => {
  const at = meeting.start.getTime();

  if (Number.isNaN(at) || (!matcher.code && !matcher.time && !matcher.weekdays?.length)) {
    return 0;
  }

  if ((matcher.code && matcher.code !== meeting.code)
    || (matcher.weekdays?.length && !matcher.weekdays.includes(meeting.start.getDay()))
    || (matcher.from !== undefined && at < matcher.from) || (matcher.to !== undefined && at >= matcher.to)) {
    return 0;
  }

  if (matcher.time) {
    const started = (meeting.start.getHours() * 60) + meeting.start.getMinutes();

    if (Math.abs(started - minutesOf(matcher.time)) > (matcher.tolerance ?? DEFAULT_TOLERANCE_MINUTES)) {
      return 0;
    }
  }

  return (matcher.code ? 4 : 0) + (matcher.time ? 2 : 0) + (matcher.weekdays?.length ? 1 : 0) + (matcher.from !== undefined || matcher.to !== undefined ? 1 : 0);
};

// The series a meeting is in: the one with the most specific matcher that fits it
export const seriesOf = (series: MeetingSeries[], session: Session): MeetingSeries | null => {
  const meeting = { code: getMeetCode(session), start: getSessionDate(session) };
  let best: { series: MeetingSeries, score: number } | null = null;

  for (const candidate of series) {
    for (const matcher of candidate.matchers) {
      const score = fits(matcher, meeting);

      if (score && (!best || score > best.score)) {
        best = { series: candidate, score };
      }
    }
  }

  return best?.series ?? null;
};

// The series a question names, as the rewrite gives it (one of their names, any case)
export const findSeries = (db: Db, said: string) => {
  const key = said.trim().toLowerCase();

  return listSeries(db).find((series) => series.name.toLowerCase() === key) ?? null;
};

// The meetings by their Meet code, to name as series: how many, the weekday and the time most have, when, who speaks
export const seriesSuggestions = (db: Db): SeriesSuggestion[] => {
  const rows = db.prepare(`
    select r.json, d.participants, d.series_id as seriesId from stenograma_rows r
    join documents d on d.id = 'stenograma:' || r.source_id || ':' || r.session_id
    where r.table_name = 'sessions'
  `).all() as { json: string, participants: string, seriesId: number | null }[];
  const byCode = new Map<string, { start: Date, participants: string[], seriesId: number | null }[]>();

  for (const row of rows) {
    const session = JSON.parse(row.json) as Session;
    const code = getMeetCode(session);
    const start = getSessionDate(session);

    if (code && !Number.isNaN(start.getTime())) {
      byCode.set(code, [...(byCode.get(code) ?? []), { start, participants: JSON.parse(row.participants) as string[], seriesId: row.seriesId }]);
    }
  }

  const most = <T>(values: T[]) => {
    const counts = new Map<T, number>();
    values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
    const [[value, count]] = [...counts.entries()].sort((a, b) => b[1] - a[1]);

    return { value, share: count / values.length };
  };
  // To 15 minutes: one meeting starts at 11:28, the next at 11:33
  const slot = (date: Date) => {
    const minutes = Math.round(((date.getHours() * 60) + date.getMinutes()) / 15) * 15;

    return `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  };

  return [...byCode.entries()].map(([code, meetings]) => {
    const speakers = new Map<string, number>();
    meetings.flatMap((meeting) => meeting.participants).forEach((name) => speakers.set(name, (speakers.get(name) ?? 0) + 1));
    const weekday = most(meetings.map((meeting) => meeting.start.getDay()));
    const time = most(meetings.map((meeting) => slot(meeting.start)));

    return {
      code,
      meetings: meetings.length,
      weekday: weekday.value,
      weekdayShare: weekday.share,
      time: time.value,
      timeShare: time.share,
      firstAt: Math.min(...meetings.map((meeting) => meeting.start.getTime())),
      lastAt: Math.max(...meetings.map((meeting) => meeting.start.getTime())),
      participants: [...speakers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name]) => name),
      // The series most of its meetings are in now
      seriesId: most(meetings.map((meeting) => meeting.seriesId)).value,
    };
  }).sort((a, b) => b.meetings - a.meetings);
};

// The meetings a question about a series can cover, at most: a month of dailies
const SERIES_MEETINGS = 30;

// The sources for a question about a series: a meeting each, the newest first, as its short summary or the extension's,
// else its chunks most like the query. The top chunks of all its meetings would leave most of them out
export const seriesSources = async (
  db: Db, query: string, options: { seriesId: number, from?: number, to?: number, provider: EmbeddingProvider | null, perMeeting?: number },
): Promise<{ hits: SearchHit[], warning?: string }> => {
  const meetings = db.prepare(`
    select id from documents where kind = 'meeting' and series_id = ? and created_at >= ? and created_at < ? order by created_at desc limit ?
  `).all(options.seriesId, options.from ?? 0, options.to ?? Number.MAX_SAFE_INTEGER, SERIES_MEETINGS) as { id: string }[];

  if (!meetings.length) {
    return { hits: [] };
  }

  const found = await search(db, query, { seriesIds: [options.seriesId], from: options.from, to: options.to, provider: options.provider, limit: 400 });
  const chunksOf = (documentId: string) => (db.prepare('select id from chunks where document_id = ? order by ord').all(documentId) as { id: number }[])
    .map(({ id }) => id);
  const picked: { chunkId: number, score: number }[] = [];

  meetings.forEach(({ id }, index) => {
    // Newer meetings first, and a meeting's own order within it
    const score = meetings.length - index;
    const summary = [`${id}:short`, `${id}:summary`].map(chunksOf).find((ids) => ids.length);
    const chunks = summary ?? found.hits.filter((hit) => hit.documentId === id).slice(0, options.perMeeting ?? 2).map((hit) => hit.chunkId);
    chunks.forEach((chunkId, order) => picked.push({ chunkId, score: score - (order / 100) }));
  });

  return { hits: hitsOf(db, picked), warning: found.warning };
};
