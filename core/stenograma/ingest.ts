import { chunkLines, chunkTranscript } from '../chunk.ts';
import type { Db } from '../db.ts';
import { deleteDocument, syncDocument } from '../documents.ts';
import { formatDay } from '../format.ts';
import { getParticipants, getSessionDate, getSessionTitle, pickMessages, pickSummary, sortActionItems } from './rules.ts';
import type { ActionItem, AssistantAnswer, Session, SessionBundle, Transcript } from './types.ts';

// A session's documents: its text, the latest summary of the whole meeting and its action items (step 1 of Sending)
export const meetingDocumentId = (sourceId: number, sessionId: string) => `stenograma:${sourceId}:${sessionId}`;
const documentIds = (sourceId: number, sessionId: string) => {
  const id = meetingDocumentId(sourceId, sessionId);

  return [id, `${id}:summary`, `${id}:actions`];
};

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
export const indexSession = (db: Db, sourceId: number, sessionId: string, embedModel: string | null) => {
  const [meetingId, summaryId, actionsId] = documentIds(sourceId, sessionId);
  const { session, transcripts, answers, actionItems } = readRows(db, sourceId, sessionId);

  if (!session) {
    [meetingId, summaryId, actionsId].forEach((id) => deleteDocument(db, id));

    return;
  }

  const title = getSessionTitle(session);
  const date = getSessionDate(session);
  const createdAt = Number.isNaN(date.getTime()) ? 0 : date.getTime();
  const messages = pickMessages(session, transcripts);
  const base = { sourceId, threadId: sessionId, title, createdAt, participants: getParticipants(session, messages) };
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
};

// Takes a push or an import: each bundle replaces its session, which is indexed again
export const ingestBundles = (db: Db, sourceId: number, bundles: SessionBundle[], embedModel: string | null) => db.transaction(() => {
  for (const bundle of bundles) {
    replaceRows(db, sourceId, bundle);
    indexSession(db, sourceId, bundle.session.sessionId, embedModel);
  }
})();

// Deletes the source's sessions that aren't in the list: what the browser (or a new backup) no longer has
export const reconcileSessions = (db: Db, sourceId: number, sessionIds: string[]) => db.transaction(() => {
  const keep = new Set(sessionIds);
  const gone = (db.prepare('select distinct session_id as sessionId from stenograma_rows where source_id = ?').all(sourceId) as
    { sessionId: string }[]).map((row) => row.sessionId).filter((id) => !keep.has(id));

  for (const sessionId of gone) {
    db.prepare('delete from stenograma_rows where source_id = ? and session_id = ?').run(sourceId, sessionId);
    indexSession(db, sourceId, sessionId, null);
  }

  return gone.length;
})();

// Indexes a source's kept rows again, after the rules of F1 change: no push needed
export const reindexSource = (db: Db, sourceId: number, embedModel: string | null) => db.transaction(() => {
  (db.prepare('select distinct session_id as sessionId from stenograma_rows where source_id = ?').all(sourceId) as { sessionId: string }[])
    .forEach(({ sessionId }) => indexSession(db, sourceId, sessionId, embedModel));
})();
