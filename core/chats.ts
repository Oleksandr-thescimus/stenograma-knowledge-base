import type { Db } from './db.ts';
import type { AskPart, ChatSummary, ChatTurn, CitedSource, LlmSettings, SavedChat, SavedTurn } from './protocol.ts';

// The app's chats, kept with the knowledge base (the plan's Decisions of 2026-11-03): each question with what the
// rewrite made of it, the sources given and the answer. A cited chunk's text isn't kept, only its ids: it's read again
// while its document is there, and a citation of a document removed since (in its browser, or with its source) shows
// as removed while the answer stays

type RequestPart = Extract<AskPart, { kind: 'request' }>;
type SourcesPart = Extract<AskPart, { kind: 'sources' }>;

interface TurnRow {
  id: number;
  question: string;
  request: string | null;
  sources: string | null;
  answer: string;
  state: SavedTurn['state'];
  error: string | null;
  createdAt: number;
}

const TITLE_LENGTH = 80;

// The first question, on one line
export const chatTitle = (question: string) => {
  const line = question.replace(/\s+/g, ' ').trim();

  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1).trimEnd()}…` : line;
};

export const createChat = (db: Db, question: string, now = Date.now()) => Number(db
  .prepare('insert into chats (title, created_at, updated_at) values (?, ?, ?)')
  .run(chatTitle(question), now, now).lastInsertRowid);

// The model a chat's questions go to, from its last one
export const setChatLlm = (db: Db, chatId: number, llm: LlmSettings | null) => db
  .prepare('update chats set llm = ? where id = ?').run(llm ? JSON.stringify(llm) : null, chatId);

export const chatExists = (db: Db, chatId: number) => Boolean(db.prepare('select 1 from chats where id = ?').get(chatId));

export const listChats = (db: Db) => db
  .prepare('select id, title, updated_at as updatedAt from chats order by updated_at desc, id desc')
  .all() as ChatSummary[];

export const deleteChat = (db: Db, chatId: number) => db.prepare('delete from chats where id = ?').run(chatId).changes > 0;

// A question being answered
export const addTurn = (db: Db, chatId: number, question: string, now = Date.now()) => db.transaction(() => {
  db.prepare('update chats set updated_at = ? where id = ?').run(now, chatId);

  return Number(db.prepare('insert into chat_turns (chat_id, question, state, created_at) values (?, ?, \'running\', ?)')
    .run(chatId, question, now).lastInsertRowid);
})();

export const saveRequest = (db: Db, turnId: number, request: RequestPart) => db
  .prepare('update chat_turns set request = ? where id = ?').run(JSON.stringify(request), turnId);

export const saveSources = (db: Db, turnId: number, sources: SourcesPart) => db
  .prepare('update chat_turns set sources = ? where id = ?')
  .run(JSON.stringify({ ...sources, sources: sources.sources.map((source) => ({ ...source, text: '' })) }), turnId);

export const finishTurn = (db: Db, turnId: number, { answer, error }: { answer: string, error?: string }) => db
  .prepare('update chat_turns set answer = ?, state = ?, error = ? where id = ?')
  .run(answer, error === undefined ? 'done' : 'error', error ?? null, turnId);

// Answers the app stopped in the middle of, when it was killed; at the core's start
export const interruptRunningTurns = (db: Db) => db
  .prepare('update chat_turns set state = \'error\', error = ? where state = \'running\'')
  .run('The app stopped before the answer was done').changes;

// The chat's last answered exchanges, oldest first, for the rewrite to complete a follow-up question
export const chatHistory = (db: Db, chatId: number, exchanges: number): ChatTurn[] => (db.prepare(`
  select question, answer from chat_turns
  where chat_id = ? and state = 'done' and answer <> ''
  order by id desc limit ?
`).all(chatId, exchanges) as { question: string, answer: string }[])
  .reverse()
  .flatMap(({ question, answer }) => [{ role: 'user' as const, content: question }, { role: 'assistant' as const, content: answer }]);

// The cited sources as they are now: a chunk's text while it's there, else removed with its document
const resolveSources = (db: Db, turns: { sources: SourcesPart | null }[]) => {
  const cited = turns.flatMap((turn) => turn.sources?.sources ?? []);
  const documents = new Set((db.prepare('select id from documents where id in (select value from json_each(?))')
    .all(JSON.stringify([...new Set(cited.map((source) => source.documentId))])) as { id: string }[]).map(({ id }) => id));
  const chunks = new Map((db.prepare('select id, document_id as documentId, text from chunks where id in (select value from json_each(?))')
    .all(JSON.stringify(cited.map((source) => source.chunkId))) as { id: number, documentId: string, text: string }[])
    .map((chunk) => [chunk.id, chunk]));

  // A meeting sent again has new chunks: the meeting view then finds the cited moment by its start
  const resolve = (source: CitedSource): CitedSource => {
    if (!documents.has(source.documentId)) {
      return { ...source, removed: true };
    }

    const chunk = chunks.get(source.chunkId);

    return { ...source, text: chunk?.documentId === source.documentId ? chunk.text : '' };
  };

  return (sources: SourcesPart | null) => sources && { ...sources, sources: sources.sources.map(resolve) };
};

export const getChat = (db: Db, chatId: number): SavedChat | null => {
  const chat = db.prepare('select id, title, llm from chats where id = ?').get(chatId) as { id: number, title: string, llm: string | null } | undefined;

  if (!chat) {
    return null;
  }

  const turns = (db.prepare(`
    select id, question, request, sources, answer, state, error, created_at as createdAt
    from chat_turns where chat_id = ? order by id
  `).all(chatId) as TurnRow[]).map((row) => ({
    ...row,
    request: row.request ? JSON.parse(row.request) as RequestPart : null,
    sources: row.sources ? JSON.parse(row.sources) as SourcesPart : null,
  }));
  const resolve = resolveSources(db, turns);

  return {
    ...chat,
    llm: chat.llm ? JSON.parse(chat.llm) as LlmSettings : null,
    turns: turns.map((turn) => ({ ...turn, sources: resolve(turn.sources) })),
  };
};
