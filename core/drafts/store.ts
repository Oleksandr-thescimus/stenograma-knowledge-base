import type { Db } from '../db.ts';
import type { CitedSource, DraftReason, DraftState } from '../protocol.ts';

// Reply drafts as kept (F9, M7): one per message to the user it answers. A draft is open while it waits, is written,
// waits for review or failed; it closes when dismissed, when the user wrote in its conversation after its message
// (replied), or when a later message to the user there got a draft of its own (superseded)

export interface DraftRow {
  id: number;
  sourceId: number;
  roomId: string;
  // The thread it answers in; null for the room's main line
  threadId: string | null;
  messageId: string;
  reason: DraftReason;
  state: DraftState | 'dismissed' | 'replied' | 'superseded';
  text: string;
  sources: CitedSource[];
  model: string | null;
  // The server it was written on, by its name then: "orangepi", "This computer"
  server: string | null;
  error: string | null;
  // Asked for by the user: written while the background work is paused too
  asked: boolean;
  createdAt: number;
  updatedAt: number;
}

export const OPEN_STATES: DraftState[] = ['waiting', 'writing', 'ready', 'failed'];
const OPEN = `(${OPEN_STATES.map((state) => `'${state}'`).join(', ')})`;

const COLUMNS = `id, source_id as sourceId, room_id as roomId, thread_id as threadId, message_id as messageId, reason, state, text,
  sources, model, server, error, asked, created_at as createdAt, updated_at as updatedAt`;

type StoredRow = Omit<DraftRow, 'sources' | 'asked'> & { sources: string, asked: number };

const toRow = (row: StoredRow): DraftRow => ({ ...row, sources: JSON.parse(row.sources) as CitedSource[], asked: Boolean(row.asked) });

export const getDraft = (db: Db, id: number) => {
  const row = db.prepare(`select ${COLUMNS} from drafts where id = ?`).get(id) as StoredRow | undefined;

  return row && toRow(row);
};

// The newest first
export const listOpenDrafts = (db: Db) => (db.prepare(`select ${COLUMNS} from drafts where state in ${OPEN} order by created_at desc, id desc`)
  .all() as StoredRow[]).map(toRow);

// The one to write next: those waiting longest first; only those the user asked for, while the background work is paused
// The next draft to write; not one another server's queue took (exclude), and for a cloud server's only of the sources
// that may go to cloud AI (F8)
export const nextWaitingDraft = (db: Db, { manualOnly = false, exclude = [] as number[], cloudOnly = false } = {}) => {
  const row = db.prepare(`
    select ${COLUMNS} from drafts d where state = 'waiting' ${manualOnly ? 'and asked = 1' : ''}
      and id not in (select value from json_each(?))
      and (? = 0 or exists (select 1 from sources s where s.id = d.source_id and s.cloud_allowed = 1))
    order by updated_at, id limit 1
  `).get(JSON.stringify(exclude), cloudOnly ? 1 : 0) as StoredRow | undefined;

  return row && toRow(row);
};

export interface NewDraft {
  sourceId: number;
  roomId: string;
  threadId: string | null;
  messageId: string;
  reason: DraftReason;
}

// A draft for a message, waiting to be written; an open one of the same conversation is superseded by it. Null when the
// message has one already
export const addDraft = (db: Db, draft: NewDraft, now = Date.now()) => db.transaction(() => {
  if (db.prepare('select 1 from drafts where source_id = ? and message_id = ?').get(draft.sourceId, draft.messageId)) {
    return null;
  }

  db.prepare(`
    update drafts set state = 'superseded', updated_at = ?
    where source_id = ? and room_id = ? and thread_id is ? and state in ${OPEN}
  `).run(now, draft.sourceId, draft.roomId, draft.threadId);

  return Number(db.prepare(`
    insert into drafts (source_id, room_id, thread_id, message_id, reason, state, created_at, updated_at)
    values (?, ?, ?, ?, ?, 'waiting', ?, ?)
  `).run(draft.sourceId, draft.roomId, draft.threadId, draft.messageId, draft.reason, now, now).lastInsertRowid);
})();

// A draft asked for by hand: a new one, or the message's closed one opened again; an open one of the conversation is
// superseded
export const requestDraft = (db: Db, draft: Omit<NewDraft, 'reason'>, now = Date.now()) => db.transaction(() => {
  const existing = db.prepare('select id, state from drafts where source_id = ? and message_id = ?').get(draft.sourceId, draft.messageId) as
    { id: number, state: string } | undefined;

  if (!existing) {
    const id = addDraft(db, { ...draft, reason: 'manual' }, now)!;
    db.prepare('update drafts set asked = 1 where id = ?').run(id);

    return id;
  }

  db.prepare(`
    update drafts set state = 'superseded', updated_at = ?
    where source_id = ? and room_id = ? and thread_id is ? and state in ${OPEN} and id <> ?
  `).run(now, draft.sourceId, draft.roomId, draft.threadId, existing.id);
  db.prepare('update drafts set state = \'waiting\', reason = \'manual\', asked = 1, error = null, created_at = ?, updated_at = ? where id = ?')
    .run(now, now, existing.id);

  return existing.id;
})();

export interface DraftPatch {
  state?: DraftRow['state'];
  // Asked for by the user: written while the background work is paused too
  asked?: boolean;
  text?: string;
  sources?: CitedSource[];
  model?: string | null;
  server?: string | null;
  error?: string | null;
}

export const updateDraft = (db: Db, id: number, patch: DraftPatch, now = Date.now()) => {
  const fields = Object.entries(patch).filter(([, value]) => value !== undefined);
  const column = (key: string) => ({ state: 'state', asked: 'asked', text: 'text', sources: 'sources', model: 'model', server: 'server', error: 'error' })[key]!;
  const value = (key: string, given: unknown) => {
    if (key === 'sources') {
      return JSON.stringify(given);
    }

    return typeof given === 'boolean' ? Number(given) : given;
  };

  db.prepare(`update drafts set ${fields.map(([key]) => `${column(key)} = ?`).join(', ')}${fields.length ? ', ' : ''}updated_at = ? where id = ?`)
    .run(...fields.map(([key, given]) => value(key, given)), now, id);
};

// The drafts being written when the app stopped are written again
export const requeueWriting = (db: Db) => db.prepare('update drafts set state = \'waiting\' where state = \'writing\'').run().changes;

export const draftCounts = (db: Db) => db.prepare(`
  select coalesce(sum(state = 'ready'), 0) as ready, coalesce(sum(state = 'waiting'), 0) as waiting from drafts
`).get() as { ready: number, waiting: number };

// How many are written before a waiting one
export const waitingAhead = (db: Db, draft: Pick<DraftRow, 'id' | 'updatedAt'>) => (db.prepare(`
  select count(*) as n from drafts where state = 'waiting' and (updated_at < ? or (updated_at = ? and id < ?))
`).get(draft.updatedAt, draft.updatedAt, draft.id) as { n: number }).n;
