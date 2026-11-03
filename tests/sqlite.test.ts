import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// better-sqlite3 with sqlite-vec and FTS5 under Electron's Node, as the core will run them (docs/PLAN.md, Architecture)
describe('SQLite', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    sqliteVec.load(db);
  });

  afterEach(() => db.close());

  // A filter on a top k picked first could leave nothing, so source and date filters must apply inside the search.
  // vec0 needs integer rowids and metadata values, hence the BigInts (better-sqlite3 binds numbers as REAL)
  it('filters vec0 metadata columns inside the nearest-neighbour search', () => {
    db.exec('create virtual table chunks_vec using vec0(embedding float[2], source_kind text, created_at integer)');

    const insert = db.prepare('insert into chunks_vec (rowid, embedding, source_kind, created_at) values (?, ?, ?, ?)');

    // Ten meeting chunks next to the query, two emails far from it
    for (let i = 1; i <= 10; i++) {
      insert.run(BigInt(i), new Float32Array([1, i / 100]), 'stenograma', BigInt(1000 + i));
    }

    insert.run(11n, new Float32Array([-1, 0]), 'email', 2000n);
    insert.run(12n, new Float32Array([-1, 0.5]), 'email', 3000n);

    const search = db.prepare<[Float32Array, string, bigint], { rowid: number }>(
      'select rowid from chunks_vec where embedding match ? and k = 2 and source_kind = ? and created_at >= ? '
      + 'order by distance',
    );
    const query = new Float32Array([1, 0]);

    expect(search.all(query, 'email', 0n).map(({ rowid }) => rowid)).toEqual([11, 12]);
    expect(search.all(query, 'email', 2500n).map(({ rowid }) => rowid)).toEqual([12]);
  });

  it('has FTS5 with the unicode61 tokenizer', () => {
    db.exec('create virtual table chunks_fts using fts5(text, tokenize = \'unicode61\')');
    db.prepare('insert into chunks_fts (text) values (?)').run('Обговорили бюджет на наступний квартал');

    const found = db.prepare('select count(*) as n from chunks_fts where chunks_fts match ?').get('бюджет*');

    expect(found).toEqual({ n: 1 });
  });
});
