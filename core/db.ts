import { sep } from 'node:path';
import Database from 'better-sqlite3';
import { getLoadablePath } from 'sqlite-vec';
import { rebuildVectorTable } from './embed/store.ts';

export type Db = Database.Database;

// The schema of docs/PLAN.md (Architecture), one migration per user_version: SQL, or a function for what SQL alone can't do. Vector tables are made per embedding
// model when it's first used (vectorTable in embed/store.ts); drafts and sent_log come with M7
const MIGRATIONS: (string | ((db: Db) => void))[] = [
  `
  create table meta (key text primary key, value text not null);

  create table sources (
    id integer primary key,
    -- stenograma-backup, stenograma-browser; later outlook, gmail, telegram...
    kind text not null,
    account text,
    config text not null default '{}',
    cursor text,
    -- F8: whether its content may go to cloud embeddings and into a cloud LLM's context
    cloud_allowed integer not null,
    replies_enabled integer not null default 0,
    enabled integer not null default 1,
    last_sync_at integer,
    last_error text,
    -- A browser's bearer token, hashed (M2)
    token_hash text,
    created_at integer not null
  );

  -- The rows a browser pushed or a backup brought, so the rules of F1 can run again without a push
  create table stenograma_rows (
    source_id integer not null references sources(id) on delete cascade,
    session_id text not null,
    table_name text not null,
    row_key text not null,
    json text not null,
    primary key (source_id, table_name, row_key)
  );
  create index stenograma_rows_session on stenograma_rows(source_id, session_id);

  create table documents (
    -- <source>:<nativeId>, e.g. stenograma:1:<sessionId>, stenograma:1:<sessionId>:summary
    id text primary key,
    source_id integer not null references sources(id) on delete cascade,
    kind text not null,
    -- The conversation: a meeting's session id, an email's thread
    thread_id text,
    title text not null,
    author text,
    -- JSON array of names
    participants text not null default '[]',
    created_at integer not null,
    updated_at integer not null,
    url text,
    made_by_ai integer not null default 0
  );
  create index documents_source on documents(source_id);

  create table chunks (
    id integer primary key,
    document_id text not null references documents(id) on delete cascade,
    ord integer not null,
    header text not null,
    text text not null,
    -- sha256 of what is embedded (header and text), the key of embedding_cache
    text_hash text not null,
    start_ms integer,
    unique (document_id, ord)
  );

  -- Normalized text (text/normalize.ts) by chunk id; contentless, as the text is in chunks
  create virtual table chunks_fts using fts5(text, content = '', contentless_delete = 1, tokenize = 'unicode61');

  create table embedding_cache (
    model text not null,
    text_hash text not null,
    vector blob not null,
    primary key (model, text_hash)
  );

  -- The embedding queue: chunks still to embed with a model
  create table jobs (
    chunk_id integer not null references chunks(id) on delete cascade,
    model text not null,
    attempts integer not null default 0,
    next_at integer not null default 0,
    last_error text,
    primary key (chunk_id, model)
  );
  `,
  // Vector tables hold bit vectors, rescored from embedding_cache (embed/store.ts): rebuilt from the cache, so nothing is
  // embedded again
  (db) => (db.prepare('select distinct model from embedding_cache').all() as { model: string }[])
    .forEach(({ model }) => rebuildVectorTable(db, model)),
  // The app's chats (core/chats.ts)
  `
  create table chats (
    id integer primary key,
    -- The first question, on one line
    title text not null,
    created_at integer not null,
    updated_at integer not null
  );

  create table chat_turns (
    id integer primary key,
    chat_id integer not null references chats(id) on delete cascade,
    question text not null,
    -- JSON: what the rewrite made of the question, and the sources given (ids, without the chunks' text)
    request text,
    sources text,
    answer text not null default '',
    -- running, done, error
    state text not null,
    error text,
    created_at integer not null
  );
  create index chat_turns_chat on chat_turns(chat_id);
  `,
];

// sqlite-vec's path points inside app.asar in a packaged app, which SQLite's dlopen can't read (M0)
const vecExtensionPath = () => getLoadablePath().replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);

const migrate = (db: Db) => {
  const version = db.pragma('user_version', { simple: true }) as number;

  MIGRATIONS.slice(version).forEach((migration, index) => db.transaction(() => {
    if (typeof migration === 'string') {
      db.exec(migration);
    } else {
      migration(db);
    }

    db.pragma(`user_version = ${version + index + 1}`);
  })());

  db.prepare('insert or ignore into meta (key, value) values (\'id\', ?)').run(crypto.randomUUID());
};

// Opens the knowledge base. A readonly one (kb search, kb ask) never writes, so it can run next to the app's core
export const openDb = (path: string, { readonly = false } = {}) => {
  const db = new Database(path, { readonly, fileMustExist: readonly });

  db.loadExtension(vecExtensionPath());
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  if (!readonly) {
    db.pragma('journal_mode = WAL');
    migrate(db);
  }

  return db;
};

// The knowledge base's id: a new one resets the extension's cursor (GET /status)
export const getKbId = (db: Db) => (db.prepare('select value from meta where key = \'id\'').get() as { value: string }).value;
