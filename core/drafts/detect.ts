import type { ChatMessage, ChatRoomType } from '../chat/types.ts';
import type { Db } from '../db.ts';
import type { DraftReason } from '../protocol.ts';
import { addDraft, OPEN_STATES } from './store.ts';

// Which messages of a messenger get a reply draft (F9): those to the user — in a direct message, mentioning them by name
// (@all and @here don't count), or replying in a thread they started or wrote in — that they haven't answered yet, the
// last of each conversation (a thread, or a room's main line). The messages from before drafts were turned on count
// only while unread, those of the last days set (a day by default); later ones count once they're kept, read or not,
// as the user may read a message before its draft is written. None older than the days set (3) gets one, as when the
// app was off: it's answered or forgotten by then

const DAY = 86_400_000;

export interface DraftsSetup {
  sourceId: number;
  // The user's username in the messenger
  username: string;
  // When drafts were turned on for the source
  since: number;
  // Settings' drafts
  unreadDays: number;
  maxAgeDays: number;
  now?: number;
}

interface Candidate {
  message: ChatMessage;
  reason: DraftReason;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Messages kept before mentions were (2026-11-14) only say @username in their text
export const mentionsUser = (message: Pick<ChatMessage, 'mentions' | 'text'>, username: string) => Boolean(message.mentions?.includes(username))
  || new RegExp(`(^|[^\\w.-])@${escapeRegExp(username)}(?![\\w.-])`, 'i').test(message.text);

const parse = (rows: { json: string }[]) => rows.map(({ json }) => JSON.parse(json) as ChatMessage);

// The user's first message in the message's conversation after it: in its thread, else in its room's main line or in
// a thread started from it; null when they haven't answered
const answeredBy = (db: Db, sourceId: number, username: string, message: ChatMessage) => ((message.threadId
  ? db.prepare(`
      select message_id as id from chat_messages where source_id = ? and thread_id = ? and ts > ? and json_extract(json, '$.username') = ?
      order by ts limit 1
    `).get(sourceId, message.threadId, message.ts, username)
  : db.prepare(`
      select message_id as id from chat_messages where source_id = ? and ts > ? and json_extract(json, '$.username') = ?
        and ((room_id = ? and thread_id is null) or thread_id = ?) order by ts limit 1
    `).get(sourceId, message.ts, username, message.roomId, message.id)) as { id: string } | undefined)?.id ?? null;

const answered = (db: Db, sourceId: number, username: string, message: ChatMessage) => answeredBy(db, sourceId, username, message) !== null;

export const findAddressed = (db: Db, { sourceId, username, since, unreadDays, maxAgeDays, now = Date.now() }: DraftsSetup): Candidate[] => {
  const from = Math.max(since - (unreadDays * DAY), now - (maxAgeDays * DAY));
  const rows = db.prepare(`
    select m.json, r.type, r.read_at as readAt from chat_messages m
    join chat_rooms r on r.source_id = m.source_id and r.room_id = m.room_id
    where m.source_id = ? and m.ts >= ? order by m.ts
  `).all(sourceId, from) as { json: string, type: ChatRoomType, readAt: number | null }[];

  // The threads the user started or wrote in
  const mine = db.prepare('select message_id as id, thread_id as threadId from chat_messages where source_id = ? and json_extract(json, \'$.username\') = ?')
    .all(sourceId, username) as { id: string, threadId: string | null }[];
  const ownThreads = new Set(mine.flatMap(({ id, threadId }) => (threadId ? [id, threadId] : [id])));
  const latest = new Map<string, Candidate>();

  for (const { json, type, readAt } of rows) {
    const [message] = parse([{ json }]);

    if (message.username === username || (message.ts < since && readAt !== null && message.ts <= readAt)) {
      continue;
    }

    let reason: DraftReason | null = null;

    if (type === 'direct') {
      reason = 'direct';
    } else if (mentionsUser(message, username)) {
      reason = 'mention';
    } else if (message.threadId && ownThreads.has(message.threadId)) {
      reason = 'thread';
    }

    if (reason) {
      latest.set(`${message.roomId}\n${message.threadId ?? ''}`, { message, reason });
    }
  }

  return [...latest.values()].filter(({ message }) => !answered(db, sourceId, username, message));
};

// Closes the open drafts the user answered in the messenger since, keeping the message that answered each; returns how
// many. One asked for by hand is answered only by what the user wrote after asking, as its message may be one they
// answered already
export const closeAnswered = (db: Db, sourceId: number, username: string, now = Date.now()) => {
  const open = db.prepare(`
    select d.id, d.reason, d.created_at as createdAt, m.json from drafts d
    join chat_messages m on m.source_id = d.source_id and m.message_id = d.message_id
    where d.source_id = ? and d.state in (${OPEN_STATES.map(() => '?').join(', ')})
  `).all(sourceId, ...OPEN_STATES) as { id: number, reason: string, createdAt: number, json: string }[];
  const done = open.flatMap(({ id, reason, createdAt, json }) => {
    const message = JSON.parse(json) as ChatMessage;
    const sent = answeredBy(db, sourceId, username, reason === 'manual' ? { ...message, ts: Math.max(message.ts, createdAt) } : message);

    return sent ? [{ id, sent }] : [];
  });
  const close = db.prepare('update drafts set state = \'replied\', sent_message_id = ?, updated_at = ? where id = ?');
  done.forEach(({ id, sent }) => close.run(sent, now, id));

  return done.length;
};

// The conversations with a message from someone else since then, the latest first, each with that message: a draft
// asked for by hand answers it
export const latestFromOthers = (db: Db, sourceId: number, username: string, from: number, limit = 40) => (db.prepare(`
  select room_id as roomId, thread_id as threadId, json, max(ts) as ts from chat_messages
  where source_id = ? and ts >= ? and coalesce(json_extract(json, '$.username'), '') <> ?
  group by room_id, thread_id order by ts desc limit ?
`).all(sourceId, from, username, limit) as { roomId: string, threadId: string | null, json: string }[])
  .map(({ roomId, threadId, json }) => ({ roomId, threadId, message: JSON.parse(json) as ChatMessage }));

// After a sync: the drafts answered are closed, and the new messages to the user get theirs. Returns how many were added
export const detectDrafts = (db: Db, setup: DraftsSetup) => db.transaction(() => {
  const now = setup.now ?? Date.now();
  closeAnswered(db, setup.sourceId, setup.username, now);

  return findAddressed(db, { ...setup, now }).filter(({ message, reason }) => {
    // A conversation whose draft answers a later message already keeps it
    const later = db.prepare(`
      select 1 from drafts d join chat_messages m on m.source_id = d.source_id and m.message_id = d.message_id
      where d.source_id = ? and d.room_id = ? and d.thread_id is ? and m.ts > ? limit 1
    `).get(setup.sourceId, message.roomId, message.threadId ?? null, message.ts);

    return !later && addDraft(db, {
      sourceId: setup.sourceId, roomId: message.roomId, threadId: message.threadId ?? null, messageId: message.id, reason,
    }, now) !== null;
  }).length;
})();
