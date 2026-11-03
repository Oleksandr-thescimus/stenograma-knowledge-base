import type { Db } from '../db.ts';
import type { EmbeddingProvider } from './provider.ts';

// A vec0 table per embedding model, so the model can change without downtime. Source and date are metadata columns,
// so their filters apply inside the nearest-neighbour search (docs/PLAN.md, Scale; checked in M0).
// It holds each vector's signs only (bit[]): at 100k chunks a float32 scan took ~250 ms, more than N3 allows, and int8
// was slower still in sqlite-vec 0.1.9. The search rescores its candidates with the float vectors of embedding_cache
export const vectorTableName = (model: string) => `vec_${model.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;

export const hasVectorTable = (db: Db, model: string) => Boolean(db.prepare(
  'select 1 from sqlite_master where type = \'table\' and name = ?',
).get(vectorTableName(model)));

export const ensureVectorTable = (db: Db, model: string, dimensions: number) => db.exec(`
  create virtual table if not exists ${vectorTableName(model)} using vec0(
    chunk_id integer primary key,
    embedding bit[${dimensions}],
    source_kind text,
    created_at integer
  )
`);

// The vec0 tables (not their shadow tables), to delete a chunk's vectors from all of them
export const vectorTables = (db: Db) => (db.prepare(
  'select name from sqlite_master where type = \'table\' and name like \'vec\\_%\' escape \'\\\' and sql like \'CREATE VIRTUAL TABLE%\'',
).all() as { name: string }[]).map(({ name }) => name);

// Source kinds such as stenograma-backup and stenograma-browser filter as one: stenograma
export const sourceFamily = (kind: string) => kind.split('-')[0];

export const toBlob = (vector: Float32Array) => Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
export const fromBlob = (blob: Buffer) => new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));

const insertVector = (db: Db, model: string, chunkId: number, vector: Float32Array, sourceKind: string, createdAt: number) => {
  ensureVectorTable(db, model, vector.length);

  const table = vectorTableName(model);
  db.prepare(`delete from ${table} where chunk_id = ?`).run(BigInt(chunkId));
  db.prepare(`insert into ${table} (chunk_id, embedding, source_kind, created_at) values (?, vec_quantize_binary(?), ?, ?)`)
    .run(BigInt(chunkId), toBlob(vector), sourceFamily(sourceKind), BigInt(createdAt));
};

// A new chunk gets its vector from the cache when its text was embedded before (a meeting pushed again, a renamed one
// renamed back), else a job in the queue (N5)
export const queueEmbedding = (db: Db, model: string | null, chunk: { id: number, textHash: string, sourceKind: string, createdAt: number }) => {
  if (!model) {
    return;
  }

  const cached = db.prepare('select vector from embedding_cache where model = ? and text_hash = ?').get(model, chunk.textHash) as
    { vector: Buffer } | undefined;

  if (cached) {
    insertVector(db, model, chunk.id, fromBlob(cached.vector), chunk.sourceKind, chunk.createdAt);
  } else {
    db.prepare('insert or ignore into jobs (chunk_id, model) values (?, ?)').run(chunk.id, model);
  }
};

export const pendingEmbeddings = (db: Db, provider: EmbeddingProvider) => (db.prepare(`
  select count(*) as n from jobs j
  join chunks c on c.id = j.chunk_id join documents d on d.id = c.document_id join sources s on s.id = d.source_id
  where j.model = ? and (? or s.cloud_allowed = 1)
`).get(provider.id, provider.local ? 1 : 0) as { n: number }).n;

interface PendingChunk {
  chunkId: number;
  header: string;
  text: string;
  textHash: string;
  createdAt: number;
  sourceKind: string;
}

interface EmbedOptions {
  batchSize?: number;
  maxAttempts?: number;
  onProgress?: (done: number, total: number) => void;
  abortSignal?: AbortSignal;
}

// Works through the queue. A cloud provider gets only the chunks of sources with cloudAllowed (F8). A failed batch is
// retried with a growing delay, and the error is thrown after maxAttempts
export const embedPending = async (db: Db, provider: EmbeddingProvider, options: EmbedOptions = {}) => {
  const { batchSize = 32, maxAttempts = 5, onProgress, abortSignal } = options;
  const total = pendingEmbeddings(db, provider);
  const next = db.prepare(`
    select j.chunk_id as chunkId, c.header, c.text, c.text_hash as textHash, d.created_at as createdAt, s.kind as sourceKind
    from jobs j
    join chunks c on c.id = j.chunk_id join documents d on d.id = c.document_id join sources s on s.id = d.source_id
    where j.model = ? and (? or s.cloud_allowed = 1)
    order by j.chunk_id limit ?
  `);
  let done = 0;
  let failures = 0;

  for (;;) {
    abortSignal?.throwIfAborted();

    const batch = next.all(provider.id, provider.local ? 1 : 0, batchSize) as PendingChunk[];

    if (!batch.length) {
      break;
    }

    let vectors: Float32Array[];

    try {
      // Batches go one after another: the model is the bottleneck, and the queue is read again after each
      // eslint-disable-next-line no-await-in-loop
      vectors = await provider.embed(batch.map((chunk) => `${chunk.header}\n${chunk.text}`), 'document', abortSignal);
      failures = 0;
    } catch (error) {
      failures++;
      db.prepare(`update jobs set attempts = attempts + 1, last_error = ? where model = ? and chunk_id in (${batch.map(() => '?').join(',')})`)
        .run((error as Error).message.slice(0, 200), provider.id, ...batch.map((chunk) => chunk.chunkId));

      if (failures >= maxAttempts || abortSignal?.aborted) {
        throw error;
      }

      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 1000 * (2 ** failures)));
      continue;
    }

    db.transaction(() => batch.forEach((chunk, index) => {
      db.prepare('insert or ignore into embedding_cache (model, text_hash, vector) values (?, ?, ?)')
        .run(provider.id, chunk.textHash, toBlob(vectors[index]));
      insertVector(db, provider.id, chunk.chunkId, vectors[index], chunk.sourceKind, chunk.createdAt);
      db.prepare('delete from jobs where chunk_id = ? and model = ?').run(chunk.chunkId, provider.id);
    }))();

    done += batch.length;
    onProgress?.(done, total);
  }

  return done;
};

// Fills a model's vector table from the cache, for every chunk whose text it has: after a change to the table's format
export const rebuildVectorTable = (db: Db, model: string) => {
  const sample = db.prepare('select length(vector) / 4 as dimensions from embedding_cache where model = ? limit 1').get(model) as
    { dimensions: number } | undefined;

  if (!sample) {
    return;
  }

  db.exec(`drop table if exists ${vectorTableName(model)}`);
  ensureVectorTable(db, model, sample.dimensions);
  db.prepare(`
    insert into ${vectorTableName(model)} (chunk_id, embedding, source_kind, created_at)
    select c.id, vec_quantize_binary(e.vector),
      case when instr(s.kind, '-') > 0 then substr(s.kind, 1, instr(s.kind, '-') - 1) else s.kind end, d.created_at
    from chunks c join documents d on d.id = c.document_id join sources s on s.id = d.source_id
    join embedding_cache e on e.model = ? and e.text_hash = c.text_hash
  `).run(model);
};
