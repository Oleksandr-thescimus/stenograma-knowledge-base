import { sep } from 'node:path';
import Database from 'better-sqlite3';
import { getLoadablePath } from 'sqlite-vec';
import { rebuildVectorTable } from './embed/store.ts';
import { keepOneCopy } from './stenograma/ingest.ts';

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
  // Short summaries the app made ("Summarize" in the meeting view), going with their document
  `
  create table summaries (
    document_id text primary key references documents(id) on delete cascade,
    -- sha256 of the text summarized, to tell when it changed
    text_hash text not null,
    model text not null,
    text text not null,
    created_at integer not null
  );
  `,
  // A meeting several browsers sent is indexed once (stenograma/ingest.ts): the copies indexed before are cut to one
  keepOneCopy,
  // Messengers (F3, chat/store.ts): the rooms synced, and their messages as the chunker reads them, so a room is indexed
  // again without a sync
  `
  create table chat_rooms (
    source_id integer not null references sources(id) on delete cascade,
    room_id text not null,
    -- channel, group, direct
    type text not null,
    -- The name in the room's links, and the one people see
    name text not null,
    title text not null,
    -- The connector's cursors (JSON), null before the room's first sync
    cursor text,
    primary key (source_id, room_id)
  );

  create table chat_messages (
    source_id integer not null references sources(id) on delete cascade,
    room_id text not null,
    message_id text not null,
    -- A reply's thread: the id of the thread's first message
    thread_id text,
    ts integer not null,
    -- chat/types.ts ChatMessage
    json text not null,
    primary key (source_id, message_id)
  );
  create index chat_messages_room on chat_messages(source_id, room_id, ts);
  create index chat_messages_thread on chat_messages(source_id, thread_id) where thread_id is not null;
  `,
  // A room's members (JSON names), read once a day: in a small room they're its documents' participants
  `
  alter table chat_rooms add column members text not null default '[]';
  alter table chat_rooms add column members_at integer;
  `,
  // The files of messages whose content is read (chat/attachments.ts): an image's text and what it shows, by a vision
  // model, and a document's text. The rooms are read whole again, for the files of the messages kept before
  `
  create table chat_attachments (
    source_id integer not null references sources(id) on delete cascade,
    room_id text not null,
    message_id text not null,
    file_id text not null,
    name text not null,
    type text,
    size integer,
    -- Where the messenger serves it, from its server's address
    path text not null,
    -- image, document
    kind text not null,
    ts integer not null,
    -- pending, done, failed, skipped
    state text not null default 'pending',
    text text,
    description text,
    model text,
    error text,
    attempts integer not null default 0,
    primary key (source_id, file_id)
  );
  create index chat_attachments_state on chat_attachments(state, ts);
  create index chat_attachments_message on chat_attachments(source_id, message_id);
  update chat_rooms set cursor = null;
  `,
  // A messenger's people, by username, from messages' authors and rooms' members: a reaction names its people by
  // username. The rooms are read whole again, for the reactions of the messages kept before
  `
  create table chat_users (
    source_id integer not null references sources(id) on delete cascade,
    username text not null,
    name text not null,
    primary key (source_id, username)
  );
  update chat_rooms set cursor = null;
  `,
  // A chat's model (JSON LlmSettings), the one its last question went to; null for the settings' one
  `
  alter table chats add column llm text;
  `,
  // Meeting series (stenograma/series.ts): a name, and the meetings it has by their Meet code, or a weekday and time.
  // A meeting's documents say their series, for the questions about one
  `
  create table meeting_series (
    id integer primary key,
    name text not null unique,
    -- JSON SeriesMatcher[]
    matchers text not null default '[]',
    created_at integer not null
  );
  alter table documents add column series_id integer;
  create index documents_series on documents(series_id) where series_id is not null;
  `,
  // How long a short summary took and in how many calls, for the time the waiting ones will take; null for those made
  // before
  `
  alter table summaries add column duration_ms integer;
  alter table summaries add column calls integer;
  `,
  // When a browser last called the API, a push or only a check that found nothing new
  `
  alter table sources add column last_seen_at integer;
  `,
  // Reply drafts (F9, M7), Rocket.Chat's first: one per message to the user it answers, the conversation being its thread
  // or its room's main line (thread_id null). A room's read_at is when the user last read it in the messenger
  `
  alter table chat_rooms add column read_at integer;
  create table drafts (
    id integer primary key,
    source_id integer not null references sources(id) on delete cascade,
    room_id text not null,
    thread_id text,
    message_id text not null,
    -- direct, mention, thread
    reason text not null,
    -- waiting, writing, ready, failed; then dismissed, replied (the user wrote in the conversation after it) or
    -- superseded (a later message to the user in the same conversation got its own)
    state text not null,
    text text not null default '',
    -- JSON CitedSource[]
    sources text not null default '[]',
    model text,
    error text,
    created_at integer not null,
    updated_at integer not null,
    unique (source_id, message_id)
  );
  create index drafts_state on drafts(state);
  `,
  // A draft the user asked for ("Draft a reply…", "Write again") is written while the background work is paused too
  `
  alter table drafts add column asked integer not null default 0;
  `,
  // The user's message that answered a draft, which teaches the next drafts their style
  `
  alter table drafts add column sent_message_id text;
  `,
  // The AI's work, a row per model call (never its text): kept a year, then in a day's totals (core/usage.ts)
  `
  create table ai_calls (
    id integer primary key,
    started_at integer not null,
    ms integer not null,
    -- answer, rewrite, summary, draft, image, style, embedding, search
    task text not null,
    provider text not null,
    model text not null,
    -- an Ollama server's address, else the provider
    server text not null,
    input_tokens integer,
    output_tokens integer,
    -- the chunks embedded; 1 else
    items integer not null default 1,
    -- null when it answered; else unreachable, timeout, aborted or failed
    error text,
    background integer not null
  );
  create index ai_calls_started on ai_calls(started_at);
  create table ai_call_days (
    day text not null,
    task text not null,
    provider text not null,
    model text not null,
    server text not null,
    background integer not null,
    calls integer not null,
    ms integer not null,
    input_tokens integer not null,
    output_tokens integer not null,
    -- the time of the calls that counted their output tokens, for the speed
    counted_ms integer not null,
    items integer not null,
    errors integer not null,
    primary key (day, task, provider, model, server, background)
  );
  `,
  // A failed call's error as it said, cut short, to list the errors in the statistics; not kept in a day's totals
  `
  alter table ai_calls add column error_message text;
  `,
  // What a call worked on, by its ids (meeting:sourceId:sessionId, draft:id, file:sourceId:fileId), to name it in the
  // list of errors
  `
  alter table ai_calls add column item text;
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
