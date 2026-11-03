import { createHash } from 'node:crypto';
import type { ChunkDraft } from './chunk.ts';
import type { Db } from './db.ts';
import { queueEmbedding, vectorTables } from './embed/store.ts';
import { normalizeForSearch } from './text/normalize.ts';

export interface DocumentInput {
  id: string;
  sourceId: number;
  kind: string;
  threadId?: string;
  title: string;
  author?: string;
  participants: string[];
  createdAt: number;
  url?: string;
  madeByAi: boolean;
  chunks: ChunkDraft[];
}

// What a chunk's vector is made from, and so what its hash covers
export const embeddingInput = (chunk: { header: string, text: string }) => `${chunk.header}\n${chunk.text}`;

const hashOf = (chunk: ChunkDraft) => createHash('sha256').update(embeddingInput(chunk)).digest('hex');

const deleteChunks = (db: Db, ids: number[]) => {
  const tables = vectorTables(db);

  for (const id of ids) {
    db.prepare('delete from chunks_fts where rowid = ?').run(id);
    tables.forEach((table) => db.prepare(`delete from ${table} where chunk_id = ?`).run(BigInt(id)));
    db.prepare('delete from chunks where id = ?').run(id);
  }
};

// Writes a document and its chunks, idempotent by id (N5). A chunk whose text is unchanged keeps its row and vector; a
// new or changed one gets its vector from the cache or a job in the queue for the embedding model
export const syncDocument = (db: Db, doc: DocumentInput, embedModel: string | null) => {
  const now = Date.now();
  db.prepare(`
    insert into documents (id, source_id, kind, thread_id, title, author, participants, created_at, updated_at, url, made_by_ai)
    values (@id, @sourceId, @kind, @threadId, @title, @author, @participants, @createdAt, @now, @url, @madeByAi)
    on conflict (id) do update set kind = @kind, thread_id = @threadId, title = @title, author = @author,
      participants = @participants, created_at = @createdAt, updated_at = @now, url = @url, made_by_ai = @madeByAi
  `).run({
    id: doc.id,
    sourceId: doc.sourceId,
    kind: doc.kind,
    threadId: doc.threadId ?? null,
    title: doc.title,
    author: doc.author ?? null,
    participants: JSON.stringify(doc.participants),
    createdAt: doc.createdAt,
    now,
    url: doc.url ?? null,
    madeByAi: doc.madeByAi ? 1 : 0,
  });

  const sourceKind = (db.prepare('select kind from sources where id = ?').get(doc.sourceId) as { kind: string }).kind;
  const existing = new Map((db.prepare('select id, ord, text_hash as textHash, start_ms as startMs from chunks where document_id = ?')
    .all(doc.id) as { id: number, ord: number, textHash: string, startMs: number | null }[]).map((row) => [row.ord, row]));
  const insert = db.prepare('insert into chunks (document_id, ord, header, text, text_hash, start_ms) values (?, ?, ?, ?, ?, ?)');

  for (const chunk of doc.chunks) {
    const textHash = hashOf(chunk);
    const previous = existing.get(chunk.ord);
    existing.delete(chunk.ord);

    if (previous?.textHash === textHash && previous.startMs === (chunk.startMs ?? null)) {
      continue;
    }

    if (previous) {
      deleteChunks(db, [previous.id]);
    }

    const id = Number(insert.run(doc.id, chunk.ord, chunk.header, chunk.text, textHash, chunk.startMs ?? null).lastInsertRowid);
    db.prepare('insert into chunks_fts (rowid, text) values (?, ?)').run(id, normalizeForSearch(embeddingInput(chunk)));
    queueEmbedding(db, embedModel, { id, textHash, sourceKind, createdAt: doc.createdAt });
  }

  deleteChunks(db, [...existing.values()].map((row) => row.id));
};

export const deleteDocument = (db: Db, id: string) => {
  deleteChunks(db, (db.prepare('select id from chunks where document_id = ?').all(id) as { id: number }[]).map((row) => row.id));
  db.prepare('delete from documents where id = ?').run(id);
};
