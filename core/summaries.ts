import { createHash } from 'node:crypto';
import type { Db } from './db.ts';
import type { ShortSummary } from './protocol.ts';

// The short summaries the app made ("Summarize" in the meeting view), one per document, kept with the hash of the text
// they summarize: when the text changes, the summary is shown as stale until it's made again

export const textHash = (lines: string[]) => createHash('sha256').update(lines.join('\n')).digest('hex');

export const getSummary = (db: Db, documentId: string, currentHash: string): ShortSummary | null => {
  const row = db.prepare('select text_hash as textHash, model, text, created_at as createdAt from summaries where document_id = ?')
    .get(documentId) as { textHash: string, model: string, text: string, createdAt: number } | undefined;

  return row ? { text: row.text, model: row.model, createdAt: row.createdAt, stale: row.textHash !== currentHash } : null;
};

// How long a summary took, and the model calls it made (one, or the parts' notes and the summary)
export interface SummaryStats {
  durationMs: number;
  calls: number;
}

export const saveSummary = (
  db: Db, documentId: string, hash: string, model: string, text: string, stats: SummaryStats | null = null, now = Date.now(),
): ShortSummary => {
  db.prepare(`
    insert into summaries (document_id, text_hash, model, text, created_at, duration_ms, calls) values (?, ?, ?, ?, ?, ?, ?)
    on conflict (document_id) do update set text_hash = excluded.text_hash, model = excluded.model, text = excluded.text,
      created_at = excluded.created_at, duration_ms = excluded.duration_ms, calls = excluded.calls
  `).run(documentId, hash, model, text, now, stats?.durationMs ?? null, stats?.calls ?? null);

  return { text, model, createdAt: now, stale: false };
};

// The meetings of a named series from a time on without a short summary, newest first: their summaries are made in the
// background, so a question about many of them is answered from one each
// cloudOnly: for a cloud server's queue, the meetings of sources that may go to cloud AI only (F8)
export const meetingsToSummarize = (db: Db, since: number, skip: Set<string>, limit = 20, { cloudOnly = false } = {}) => (db.prepare(`
  select d.id, d.source_id as sourceId, d.thread_id as sessionId from documents d
  where d.kind = 'meeting' and d.series_id is not null and d.created_at >= ?
    and not exists (select 1 from summaries s where s.document_id = d.id)
    and exists (select 1 from chunks c where c.document_id = d.id)
    and (? = 0 or exists (select 1 from sources src where src.id = d.source_id and src.cloud_allowed = 1))
  order by d.created_at desc limit ?
`).all(since, cloudOnly ? 1 : 0, limit + skip.size) as { id: string, sourceId: number, sessionId: string }[]).filter((meeting) => !skip.has(meeting.id)).slice(0, limit);

// Waiting: those meetingsToSummarize would give, a meeting with no text isn't summarized
export const summaryCounts = (db: Db, since: number) => db.prepare(`
  select sum(s.document_id is null and exists (select 1 from chunks c where c.document_id = d.id)) as pending,
    sum(s.document_id is not null) as done
  from documents d left join summaries s on s.document_id = d.id
  where d.kind = 'meeting' and d.series_id is not null and d.created_at >= ?
`).get(since) as { pending: number | null, done: number | null };

// The average time of a model's last summaries, null before it made one that was timed
export const averageSummaryMs = (db: Db, model: string, last = 10) => {
  const row = db.prepare(`
    select avg(duration_ms) as ms from (
      select duration_ms from summaries where model = ? and duration_ms is not null order by created_at desc limit ?
    )
  `).get(model, last) as { ms: number | null };

  return row.ms === null ? null : Math.round(row.ms);
};

// The model of the summary made last, whose average says how long the waiting ones will take
export const lastSummaryModel = (db: Db) => (db.prepare('select model from summaries where duration_ms is not null order by created_at desc limit 1')
  .get() as { model: string } | undefined)?.model ?? null;
