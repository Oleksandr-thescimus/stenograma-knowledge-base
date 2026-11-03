import type { Db } from './db.ts';
import type { EmbeddingProvider } from './embed/provider.ts';
import { fromBlob, hasVectorTable, vectorTableName } from './embed/store.ts';
import { nameMatches, toFtsQuery } from './text/normalize.ts';

// Each ranking is read this deep before fusion
const DEPTH = 50;
// Candidates of the bit-vector search, rescored with float vectors down to DEPTH
const VECTOR_CANDIDATES = 400;
// Reciprocal rank fusion's k
const RRF_K = 60;
// M0: BM25 at full weight pushed the right chunk out of the top 10 for paraphrased questions; at half it costs nothing on
// direct ones and loses nothing on paraphrases
export const BM25_WEIGHT = 0.5;
// F5: a person raises the rank of chunks where they speak, and less of those from a meeting they were in
const SPEAKER_BOOST = 1.5;
const PARTICIPANT_BOOST = 1.2;

export interface SearchFilters {
  // A source kind or its family: stenograma matches stenograma-backup and stenograma-browser
  sourceKind?: string;
  // Milliseconds; from inclusive, to exclusive
  from?: number;
  to?: number;
  person?: string;
}

export interface SearchHit {
  chunkId: number;
  documentId: string;
  documentKind: string;
  sourceId: number;
  threadId: string | null;
  title: string;
  createdAt: number;
  startMs: number | null;
  header: string;
  text: string;
  madeByAi: boolean;
  participants: string[];
  score: number;
}

export interface SearchResult {
  hits: SearchHit[];
  // False when there were no vectors to search, or the query couldn't be embedded (warning says why)
  usedVectors: boolean;
  warning?: string;
}

// Merges rankings by reciprocal rank fusion, each with its weight
export const fuseRankings = (rankings: { ids: number[], weight: number }[]) => {
  const scores = new Map<number, number>();

  for (const { ids, weight } of rankings) {
    ids.forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + (weight / (RRF_K + index + 1))));
  }

  return scores;
};

const hasFilters = (filters: SearchFilters) => Boolean(filters.sourceKind) || filters.from !== undefined || filters.to !== undefined;

// With filters, BM25 first takes this many best matches without joins, and filters only those
const FTS_CANDIDATES = 1000;

const FILTERED_FTS = `
  select c.id from chunks_fts f
  join chunks c on c.id = f.rowid join documents d on d.id = c.document_id join sources s on s.id = d.source_id
  where chunks_fts match @match
    and (@kind is null or s.kind = @kind or s.kind like @kind || '-%')
    and (@from is null or d.created_at >= @from) and (@to is null or d.created_at < @to)
  order by bm25(chunks_fts) limit @depth`;

const searchFts = (db: Db, query: string, filters: SearchFilters) => {
  const match = toFtsQuery(query);

  if (!match) {
    return [];
  }

  const ranked = (limit: number) => (db.prepare('select rowid as id from chunks_fts where chunks_fts match ? order by bm25(chunks_fts) limit ?')
    .all(match, limit) as { id: number }[]).map((row) => Number(row.id));

  if (!hasFilters(filters)) {
    return ranked(DEPTH);
  }

  // A common word matches tens of thousands of chunks, and joining each of them took ~100 ms at 100k chunks. So the
  // filters go over the best matches first; only when they leave too few of many matches, over all of them
  const params = { kind: filters.sourceKind ?? null, from: filters.from ?? null, to: filters.to ?? null };
  const candidates = ranked(FTS_CANDIDATES);
  const kept = new Set(candidates.length ? (db.prepare(`
    select c.id from chunks c join documents d on d.id = c.document_id join sources s on s.id = d.source_id
    where c.id in (${candidates.map(() => '?').join(',')})
      and (@kind is null or s.kind = @kind or s.kind like @kind || '-%')
      and (@from is null or d.created_at >= @from) and (@to is null or d.created_at < @to)
  `).all(...candidates, params) as { id: number }[]).map((row) => row.id) : []);
  const filtered = candidates.filter((id) => kept.has(id));

  if (filtered.length >= DEPTH || candidates.length < FTS_CANDIDATES) {
    return filtered.slice(0, DEPTH);
  }

  return (db.prepare(FILTERED_FTS).all({ match, ...params, depth: DEPTH }) as { id: number }[]).map((row) => Number(row.id));
};

// The float vectors of the candidates, from embedding_cache by their text's hash, scored exactly
const rescore = (db: Db, model: string, ids: number[], query: Float32Array) => {
  if (!ids.length) {
    return [];
  }

  const rows = db.prepare(`
    select c.id, e.vector from chunks c join embedding_cache e on e.model = ? and e.text_hash = c.text_hash
    where c.id in (${ids.map(() => '?').join(',')})
  `).all(model, ...ids) as { id: number, vector: Buffer }[];
  const scored = rows.map((row) => {
    const vector = fromBlob(row.vector);
    let score = 0;

    for (let i = 0; i < query.length; i++) {
      score += vector[i] * query[i];
    }

    return { id: row.id, score };
  });

  return scored.sort((a, b) => b.score - a.score).slice(0, DEPTH).map((row) => row.id);
};

// Bit vectors find the candidates by Hamming distance, with the filters inside the search; the float vectors rank them
const searchVectors = (db: Db, model: string, vector: Float32Array, filters: SearchFilters) => {
  const conditions = ['embedding match vec_quantize_binary(?)', 'k = ?'];
  // vec0 takes integers only, and better-sqlite3 binds numbers as REAL
  const params: unknown[] = [Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength), BigInt(VECTOR_CANDIDATES)];

  if (filters.sourceKind) {
    conditions.push('source_kind = ?');
    params.push(filters.sourceKind.split('-')[0]);
  }

  if (filters.from !== undefined) {
    conditions.push('created_at >= ?');
    params.push(BigInt(filters.from));
  }

  if (filters.to !== undefined) {
    conditions.push('created_at < ?');
    params.push(BigInt(filters.to));
  }

  const candidates = (db.prepare(`select chunk_id as id from ${vectorTableName(model)} where ${conditions.join(' and ')}`)
    .all(...params) as { id: number }[]).map((row) => Number(row.id));

  return rescore(db, model, candidates, vector);
};

const loadHits = (db: Db, ids: number[]) => {
  if (!ids.length) {
    return new Map<number, Omit<SearchHit, 'score'>>();
  }

  const rows = db.prepare(`
    select c.id as chunkId, d.id as documentId, d.kind as documentKind, d.source_id as sourceId, d.thread_id as threadId,
      d.title, d.created_at as createdAt, c.start_ms as startMs, c.header, c.text, d.made_by_ai as madeByAi, d.participants
    from chunks c join documents d on d.id = c.document_id where c.id in (${ids.map(() => '?').join(',')})
  `).all(...ids) as (Omit<SearchHit, 'madeByAi' | 'participants' | 'score'> & { madeByAi: number, participants: string })[];

  return new Map(rows.map((row) => [row.chunkId, { ...row, madeByAi: Boolean(row.madeByAi), participants: JSON.parse(row.participants) as string[] }]));
};

// Speakers of a transcript chunk's "Name: text" lines
const speakersOf = (text: string) => new Set([...text.matchAll(/^([^:\n]{1,60}): /gm)].map((match) => match[1]));

// Hybrid search (F5): BM25 and vectors with the same filters, fused, then a person's chunks raised
export const search = async (
  db: Db, query: string, options: SearchFilters & { provider?: EmbeddingProvider | null, limit?: number } = {},
): Promise<SearchResult> => {
  const { provider, limit = 10, ...filters } = options;
  const bm25 = searchFts(db, query, filters);
  let vectorIds: number[] = [];
  let warning: string | undefined;

  if (provider && hasVectorTable(db, provider.id)) {
    try {
      const [vector] = await provider.embed([query], 'query');
      vectorIds = searchVectors(db, provider.id, vector, filters);
    } catch (error) {
      warning = `Searched by words only: the query couldn't be embedded (${(error as Error).message})`;
    }
  } else if (provider) {
    warning = `Searched by words only: nothing is embedded with ${provider.id} yet`;
  }

  const scores = fuseRankings([{ ids: bm25, weight: BM25_WEIGHT }, { ids: vectorIds, weight: 1 }]);
  const candidates = loadHits(db, [...scores.keys()]);

  if (filters.person) {
    const { person } = filters;

    for (const [id, hit] of candidates) {
      if ([...speakersOf(hit.text)].some((name) => nameMatches(name, person))) {
        scores.set(id, (scores.get(id) ?? 0) * SPEAKER_BOOST);
      } else if (hit.participants.some((name) => nameMatches(name, person))) {
        scores.set(id, (scores.get(id) ?? 0) * PARTICIPANT_BOOST);
      }
    }
  }

  const hits = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
    .map(([id, score]) => ({ ...candidates.get(id)!, score }));

  return { hits, usedVectors: vectorIds.length > 0, warning };
};
