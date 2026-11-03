// N3: search p95 under 300 ms at 100k chunks. Builds a throwaway knowledge base of generated chunks (made-up words,
// random 1024-dimension vectors like bge-m3's, as bits plus floats in the cache) in a temporary directory, then times hybrid searches.
// yarn bench [chunks]; with Ollama running, also times embedding a query with the settings' model
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../db.ts';
import { createEmbeddingProvider, type EmbeddingProvider } from '../embed/provider.ts';
import { ensureVectorTable, vectorTableName } from '../embed/store.ts';
import { search } from '../search.ts';
import { loadSettings } from '../settings.ts';
import { findOrCreateSource } from '../sources.ts';

const CHUNKS = Number(process.argv[2] ?? 100_000);
const CHUNKS_PER_DOCUMENT = 50;
const DIMENSIONS = 1024;
const QUERIES = 50;
const MODEL = 'bench:random';

// A seeded generator, so runs compare
let seed = 42;
const random = () => {
  seed = ((seed * 1_103_515_245) + 12_345) % 2_147_483_648;

  return seed / 2_147_483_648;
};

const SYLLABLES = ['ба', 'ве', 'го', 'ді', 'жу', 'зо', 'ка', 'ле', 'мі', 'но', 'пу', 'ра', 'се', 'ти', 'фу', 'ха', 'це', 'чі', 'ша', 'юр'];
const VOCABULARY = Array.from({ length: 5000 }, () => Array.from({ length: 2 + Math.floor(random() * 3) },
  () => SYLLABLES[Math.floor(random() * SYLLABLES.length)]).join(''));
const words = (count: number) => Array.from({ length: count }, () => VOCABULARY[Math.floor(random() * VOCABULARY.length)]).join(' ');

const unitVector = () => {
  const vector = Float32Array.from({ length: DIMENSIONS }, () => random() - 0.5);
  const length = Math.hypot(...vector);

  return vector.map((value) => value / length);
};

const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];

const dir = mkdtempSync(join(tmpdir(), 'kb-bench-'));
const db = openDb(join(dir, 'kb.sqlite'));

try {
  const started = Date.now();
  const sourceId = findOrCreateSource(db, 'stenograma-backup', 'bench').id;
  ensureVectorTable(db, MODEL, DIMENSIONS);
  const insertDocument = db.prepare('insert into documents (id, source_id, kind, title, created_at, updated_at) values (?, ?, \'meeting\', ?, ?, ?)');
  const insertChunk = db.prepare('insert into chunks (document_id, ord, header, text, text_hash) values (?, ?, ?, ?, ?)');
  const insertFts = db.prepare('insert into chunks_fts (rowid, text) values (?, ?)');
  const insertVector = db.prepare(`insert into ${vectorTableName(MODEL)} (chunk_id, embedding, source_kind, created_at) values (?, vec_quantize_binary(?), ?, ?)`);
  // The float vectors the search rescores with, as the core keeps them
  const insertCached = db.prepare('insert into embedding_cache (model, text_hash, vector) values (?, ?, ?)');
  const yearStart = new Date(2025, 0, 1).getTime();

  db.transaction(() => {
    for (let d = 0; d * CHUNKS_PER_DOCUMENT < CHUNKS; d++) {
      const createdAt = yearStart + (Math.floor(random() * 365) * 86_400_000);
      insertDocument.run(`bench:${d}`, sourceId, `Meeting ${d}`, createdAt, createdAt);

      for (let ord = 0; ord < CHUNKS_PER_DOCUMENT && (d * CHUNKS_PER_DOCUMENT) + ord < CHUNKS; ord++) {
        const header = `[Meeting · Meeting ${d} · 2025]`;
        const text = words(180);
        const textHash = `${d}:${ord}`;
        const id = insertChunk.run(`bench:${d}`, ord, header, text, textHash).lastInsertRowid;
        insertFts.run(id, `${header}\n${text}`);
        const vector = unitVector();
        insertVector.run(BigInt(id), Buffer.from(vector.buffer), 'stenograma', BigInt(createdAt));
        insertCached.run(MODEL, textHash, Buffer.from(vector.buffer));
      }
    }
  })();

  console.log(`Built ${CHUNKS} chunks in ${Math.round((Date.now() - started) / 1000)} s`);

  // The query's vector is given, to time the database alone; embedding it is timed below
  const provider: EmbeddingProvider = { id: MODEL, local: true, embed: async (values) => values.map(unitVector) };
  const time = async (label: string, filters: Parameters<typeof search>[2]) => {
    const times: number[] = [];

    for (let q = 0; q < QUERIES; q++) {
      const t0 = performance.now();
      // One query after another, as a user asks them
      // eslint-disable-next-line no-await-in-loop
      await search(db, words(2 + Math.floor(random() * 4)), { provider, ...filters });
      times.push(performance.now() - t0);
    }

    console.log(`${label.padEnd(30)} p50 ${percentile(times, 0.5).toFixed(0).padStart(4)} ms   p95 ${percentile(times, 0.95).toFixed(0).padStart(4)} ms`);
  };

  await time('hybrid', {});
  await time('hybrid, source and 3 months', { sourceKind: 'stenograma', from: new Date(2025, 3, 1).getTime(), to: new Date(2025, 6, 1).getTime() });
  await time('hybrid, person', { person: 'Олена' });

  try {
    const real = createEmbeddingProvider(loadSettings().embedding);
    const times: number[] = [];

    for (let q = 0; q < 20; q++) {
      const t0 = performance.now();
      // eslint-disable-next-line no-await-in-loop
      await real.embed([`Що казали про бюджет на зустрічі ${q}?`], 'query');
      times.push(performance.now() - t0);
    }

    console.log(`${`query embedding, ${real.id}`.padEnd(30)} p50 ${percentile(times, 0.5).toFixed(0).padStart(4)} ms   p95 ${percentile(times, 0.95).toFixed(0).padStart(4)} ms`);
  } catch (error) {
    console.log(`Query embedding not timed: ${(error as Error).message}`);
  }
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
