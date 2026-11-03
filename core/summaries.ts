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

export const saveSummary = (db: Db, documentId: string, hash: string, model: string, text: string, now = Date.now()): ShortSummary => {
  db.prepare(`
    insert into summaries (document_id, text_hash, model, text, created_at) values (?, ?, ?, ?, ?)
    on conflict (document_id) do update set text_hash = excluded.text_hash, model = excluded.model, text = excluded.text,
      created_at = excluded.created_at
  `).run(documentId, hash, model, text, now);

  return { text, model, createdAt: now, stale: false };
};
