import { BROWSER_KIND } from '../browsers.ts';
import { chunkLines, chunkTranscript } from '../chunk.ts';
import type { Db } from '../db.ts';
import { deleteDocument, syncDocument } from '../documents.ts';
import { formatDay } from '../format.ts';
import { getMeetCode, getParticipants, getSessionDate, getSessionTitle, pickMessages, pickSummary, sortActionItems } from './rules.ts';
import { listSeries, seriesOf } from './series.ts';
import type { ActionItem, AssistantAnswer, Session, SessionBundle, Transcript } from './types.ts';

// A session's documents: its text, the latest summary of the whole meeting and its action items (step 1 of Sending),
// and the app's short summary ("Summarize", summaries.ts)
export const meetingDocumentId = (sourceId: number, sessionId: string) => `stenograma:${sourceId}:${sessionId}`;
const documentIds = (sourceId: number, sessionId: string) => {
  const id = meetingDocumentId(sourceId, sessionId);

  return [id, `${id}:summary`, `${id}:actions`, `${id}:short`];
};

const deleteCopy = (db: Db, sourceId: number, sessionId: string) => documentIds(sourceId, sessionId).forEach((id) => deleteDocument(db, id));

type RowTable = 'sessions' | 'transcripts' | 'assistantAnswers' | 'actionItems';

// Keeps a session's rows as sent, replacing what the source had of it: a row missing from the bundle is deleted
const replaceRows = (db: Db, sourceId: number, bundle: SessionBundle) => {
  const { sessionId } = bundle.session;
  const insert = db.prepare('insert into stenograma_rows (source_id, session_id, table_name, row_key, json) values (?, ?, ?, ?, ?)');
  const keyOf = (row: { createdAt: number }) => `${sessionId}|${row.createdAt}`;
  const rows: { table: RowTable, key: string, row: unknown }[] = [
    { table: 'sessions', key: sessionId, row: bundle.session },
    // A version still being made changes with every utterance, so only done ones count
    ...bundle.transcripts.filter((row) => row.status === 'done').map((row) => ({ table: 'transcripts' as const, key: keyOf(row), row })),
    ...bundle.assistantAnswers.map((row) => ({ table: 'assistantAnswers' as const, key: keyOf(row), row })),
    ...bundle.actionItems.map((row) => ({ table: 'actionItems' as const, key: keyOf(row), row })),
  ];

  db.prepare('delete from stenograma_rows where source_id = ? and session_id = ?').run(sourceId, sessionId);
  rows.forEach(({ table, key, row }) => insert.run(sourceId, sessionId, table, key, JSON.stringify(row)));
};

export const readRows = (db: Db, sourceId: number, sessionId: string) => {
  const rows = db.prepare('select table_name as tableName, json from stenograma_rows where source_id = ? and session_id = ?')
    .all(sourceId, sessionId) as { tableName: RowTable, json: string }[];
  const of = <T>(table: RowTable) => rows.filter((row) => row.tableName === table).map((row) => JSON.parse(row.json) as T);

  return {
    session: of<Session>('sessions')[0] as Session | undefined,
    transcripts: of<Transcript>('transcripts'),
    answers: of<AssistantAnswer>('assistantAnswers'),
    actionItems: of<ActionItem>('actionItems'),
  };
};

// Builds a session's documents from its rows by the rules of F1, and deletes those it no longer has
const indexSession = (db: Db, sourceId: number, sessionId: string, embedModel: string | null) => {
  const [meetingId, summaryId, actionsId, shortId] = documentIds(sourceId, sessionId);
  const { session, transcripts, answers, actionItems } = readRows(db, sourceId, sessionId);

  if (!session) {
    deleteCopy(db, sourceId, sessionId);

    return;
  }

  // A meeting of a series is named by it: the code alone tells nothing
  const series = seriesOf(listSeries(db), session);
  const own = getSessionTitle(session);
  // Its own name, unless it's only the code or the series's own
  const named = own !== getMeetCode(session) && own !== session.sessionId && own.toLowerCase() !== series?.name.toLowerCase();
  let title = own;

  if (series) {
    title = named ? `${series.name} · ${own}` : series.name;
  }

  const date = getSessionDate(session);
  const createdAt = Number.isNaN(date.getTime()) ? 0 : date.getTime();
  const messages = pickMessages(session, transcripts);
  const base = { sourceId, threadId: sessionId, title, createdAt, participants: getParticipants(session, messages), seriesId: series?.id ?? null };
  const kind = session.origin === 'recording' ? 'Recording' : 'Meeting';

  syncDocument(db, {
    ...base, id: meetingId, kind: 'meeting', madeByAi: false,
    chunks: chunkTranscript(`[${kind} · ${title} · ${formatDay(createdAt)}]`, messages),
  }, embedModel);

  const summary = pickSummary(answers);

  if (summary) {
    syncDocument(db, {
      ...base, id: summaryId, kind: 'meeting-summary', madeByAi: true,
      chunks: chunkLines(`[${kind} summary, made by AI · ${title} · ${formatDay(createdAt)}]`, summary.text.split('\n')
        .filter((line) => line.trim()).map((text) => ({ text }))),
    }, embedModel);
  } else {
    deleteDocument(db, summaryId);
  }

  if (actionItems.length) {
    syncDocument(db, {
      ...base, id: actionsId, kind: 'meeting-actions', madeByAi: true,
      chunks: chunkLines(`[Action items, made by AI · ${title} · ${formatDay(createdAt)}]`, sortActionItems(actionItems).map((item) => ({
        text: `- ${item.what}${item.who ? ` (${item.who})` : ''}${item.due ? `, due ${item.due}` : ''}${item.done ? ', done' : ''}`,
      }))),
    }, embedModel);
  } else {
    deleteDocument(db, actionsId);
  }

  // The app's short summary, found by the search too: a question about many meetings is answered from them
  const short = db.prepare('select text from summaries where document_id = ?').get(meetingId) as { text: string } | undefined;

  if (short) {
    syncDocument(db, {
      ...base, id: shortId, kind: 'meeting-short-summary', madeByAi: true,
      chunks: chunkLines(`[${kind} summary, made by AI · ${title} · ${formatDay(createdAt)}]`, short.text.split('\n')
        .filter((line) => line.trim()).map((text) => ({ text }))),
    }, embedModel);
  } else {
    deleteDocument(db, shortId);
  }
};

// A meeting indexed again, as after its short summary is made
export const reindexMeeting = (db: Db, sourceId: number, sessionId: string, embedModel: string | null) => db
  .transaction(() => indexSession(db, sourceId, sessionId, embedModel))();

// Every meeting indexed again, as after a series changes: only chunks whose text changed are embedded again
export const reindexMeetings = (db: Db, embedModel: string | null) => (db.prepare('select id from sources where kind like \'stenograma-%\'')
  .all() as { id: number }[]).forEach(({ id }) => reindexSource(db, id, embedModel));

// A meeting that several browsers sent (a backup restored in each) is indexed once: else it's found twice, and its
// copies take two of an answer's few places. Each browser's rows are kept, so another copy takes over when the indexed
// one goes. The copy indexed is the one that came last, as the extension sends a session only when it changed in that
// browser; but one with the same rows as the indexed copy leaves it, so a browser sending everything again (a new token)
// doesn't break the citations of saved chats. The short summary moves to the copy that takes over
const browserIds = (db: Db) => (db.prepare('select id from sources where kind = ? order by id desc').all(BROWSER_KIND) as { id: number }[])
  .map(({ id }) => id);

const holds = (db: Db, sourceId: number, sessionId: string) => Boolean(db
  .prepare('select 1 from stenograma_rows where source_id = ? and session_id = ? limit 1').get(sourceId, sessionId));

const isIndexed = (db: Db, sourceId: number, sessionId: string) => Boolean(db
  .prepare('select 1 from documents where id = ?').get(meetingDocumentId(sourceId, sessionId)));

// Rows by content: their keys may come in another order from another browser
const canonical = (json: string) => JSON.stringify(JSON.parse(json), (_key, value: unknown) => (value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)))
  : value));

const rowsOf = (db: Db, sourceId: number, sessionId: string) => (db.prepare(`
  select table_name as tableName, row_key as rowKey, json from stenograma_rows where source_id = ? and session_id = ?
  order by table_name, row_key
`).all(sourceId, sessionId) as { tableName: string, rowKey: string, json: string }[])
  .map((row) => `${row.tableName}|${row.rowKey}|${canonical(row.json)}`).join('\n');

const moveSummary = (db: Db, from: string, to: string) => db.prepare(`
  insert or ignore into summaries (document_id, text_hash, model, text, created_at)
  select ?, text_hash, model, text, created_at from summaries where document_id = ?
`).run(to, from);

// Indexes a session after the source's rows of it changed or went
const updateSession = (db: Db, sourceId: number, sessionId: string, embedModel: string | null) => {
  const browsers = browserIds(db);

  if (!browsers.includes(sourceId)) {
    indexSession(db, sourceId, sessionId, embedModel);

    return;
  }

  const held = browsers.filter((id) => holds(db, id, sessionId));
  const indexed = browsers.filter((id) => isIndexed(db, id, sessionId));
  const current = indexed.find((id) => id !== sourceId && held.includes(id));
  let target: number | undefined;

  if (held.includes(sourceId)) {
    target = current !== undefined && rowsOf(db, current, sessionId) === rowsOf(db, sourceId, sessionId) ? current : sourceId;
  } else {
    target = current ?? held[0];
  }

  if (target !== undefined && (target === sourceId || !indexed.includes(target))) {
    indexSession(db, target, sessionId, embedModel);
  }

  for (const id of indexed.filter((other) => other !== target)) {
    if (target !== undefined) {
      moveSummary(db, meetingDocumentId(id, sessionId), meetingDocumentId(target, sessionId));
    }

    deleteCopy(db, id, sessionId);
  }
};

// Before 2026-11-12 each browser's copy of a session was indexed. Keeps the copy of the browser that sent last, as the
// copy that comes last is the one indexed from then on (a migration)
export const keepOneCopy = (db: Db) => {
  const browsers = (db.prepare('select id from sources where kind = ? order by coalesce(last_sync_at, 0) desc, id desc')
    .all(BROWSER_KIND) as { id: number }[]).map(({ id }) => id);
  const sessions = (db.prepare(`
    select thread_id as sessionId from documents
    where kind = 'meeting' and source_id in (select id from sources where kind = ?)
    group by thread_id having count(*) > 1
  `).all(BROWSER_KIND) as { sessionId: string }[]).map(({ sessionId }) => sessionId);

  for (const sessionId of sessions) {
    const [target, ...others] = browsers.filter((id) => isIndexed(db, id, sessionId));

    for (const id of others) {
      moveSummary(db, meetingDocumentId(id, sessionId), meetingDocumentId(target, sessionId));
      deleteCopy(db, id, sessionId);
    }
  }
};

// Takes a push or an import: each bundle replaces its session, which is indexed again
export const ingestBundles = (db: Db, sourceId: number, bundles: SessionBundle[], embedModel: string | null) => db.transaction(() => {
  for (const bundle of bundles) {
    replaceRows(db, sourceId, bundle);
    updateSession(db, sourceId, bundle.session.sessionId, embedModel);
  }
})();

// Deletes the source's sessions that aren't in the list: what the browser (or a new backup) no longer has. Another
// browser's copy of such a session is indexed instead, for the embedding model
export const reconcileSessions = (db: Db, sourceId: number, sessionIds: string[], embedModel: string | null) => db.transaction(() => {
  const keep = new Set(sessionIds);
  const gone = (db.prepare('select distinct session_id as sessionId from stenograma_rows where source_id = ?').all(sourceId) as
    { sessionId: string }[]).map((row) => row.sessionId).filter((id) => !keep.has(id));

  for (const sessionId of gone) {
    db.prepare('delete from stenograma_rows where source_id = ? and session_id = ?').run(sourceId, sessionId);
    updateSession(db, sourceId, sessionId, embedModel);
  }

  return gone.length;
})();

// Indexes a source's kept rows again, after the rules of F1 change: no push needed. A browser's copies indexed from
// another browser stay so
export const reindexSource = (db: Db, sourceId: number, embedModel: string | null) => db.transaction(() => {
  const browser = browserIds(db).includes(sourceId);

  (db.prepare('select distinct session_id as sessionId from stenograma_rows where source_id = ?').all(sourceId) as { sessionId: string }[])
    .filter(({ sessionId }) => !browser || isIndexed(db, sourceId, sessionId))
    .forEach(({ sessionId }) => indexSession(db, sourceId, sessionId, embedModel));
})();
