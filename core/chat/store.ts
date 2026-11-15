import { chunkLines } from '../chunk.ts';
import type { Db } from '../db.ts';
import { deleteDocument, syncDocument } from '../documents.ts';
import { formatDay } from '../format.ts';
import type { ConversationView } from '../protocol.ts';
import {
  attachmentsOf, forgetMessageFiles, forgetRoomFiles, getAttachment, registerAttachments, type AttachmentRow,
} from './attachments.ts';
import { chunkConversation, IMAGE_TEXT_CHARS, snippet, type ImageNote, type ReactionNote } from './chunk.ts';
import type { ChatMessage, ChatRoom } from './types.ts';

// A messenger's rooms and messages as the knowledge base keeps them (F3), and their documents: a room's messages of a
// day are one document, and a thread (its first message and the replies) another, so a thread stays together. The
// header of every chunk says where it's from, and a thread's also what it started with, so its replies keep their
// context in an answer

// A room's day, a thread, and a file's text (a document's, or an image's too long for its message's line)
export const CHAT_KINDS = { day: 'chat', thread: 'chat-thread', file: 'chat-file' } as const;

// A thread's first message, cut to this many characters in its chunks' header
const THREAD_CONTEXT_CHARS = 150;
// In a room of up to this many people its members are its documents' participants, so a search for a person finds the
// conversations they're in though they didn't write; in a larger one, such as a company's #general, membership tells
// nothing, and only those who wrote are
export const MEMBERS_AS_PARTICIPANTS = 20;

const roomPrefix = (sourceId: number, roomId: string) => `chat:${sourceId}:${roomId}:`;
const dayDocumentId = (sourceId: number, roomId: string, day: string) => `${roomPrefix(sourceId, roomId)}${day}`;
export const threadDocumentId = (sourceId: number, roomId: string, threadId: string) => `${roomPrefix(sourceId, roomId)}thread:${threadId}`;
const fileDocumentId = (sourceId: number, roomId: string, fileId: string) => `${roomPrefix(sourceId, roomId)}file:${fileId}`;

const dayKey = (ts: number) => formatDay(ts);

const dayRange = (day: string) => {
  const start = new Date(`${day}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  return [start.getTime(), end.getTime()];
};

export const roomLabel = (room: Pick<ChatRoom, 'type' | 'title'>) => (room.type === 'direct' ? `direct: ${room.title}` : `#${room.title}`);

// The documents a change touches, indexed again after it
export interface Affected {
  days: Set<string>;
  threads: Set<string>;
}

export const noneAffected = (): Affected => ({ days: new Set(), threads: new Set() });

const touch = (affected: Affected, message: Pick<ChatMessage, 'id' | 'threadId' | 'ts' | 'startsThread'>) => {
  if (message.threadId) {
    affected.threads.add(message.threadId);
  } else {
    affected.days.add(dayKey(message.ts));
  }

  if (message.startsThread) {
    affected.threads.add(message.id);
  }
};

// Rooms

interface RoomRow extends ChatRoom {
  cursor: string | null;
  members: string[];
  // When they were read, null before
  membersAt: number | null;
}

const ROOM_COLUMNS = 'room_id as id, type, name, title, cursor, members, members_at as membersAt';
const toRoomRow = (row: Omit<RoomRow, 'members'> & { members: string }): RoomRow => ({ ...row, members: JSON.parse(row.members) as string[] });

export const getRoom = (db: Db, sourceId: number, roomId: string) => {
  const row = db.prepare(`select ${ROOM_COLUMNS} from chat_rooms where source_id = ? and room_id = ?`).get(sourceId, roomId) as
    (Omit<RoomRow, 'members'> & { members: string }) | undefined;

  return row && toRoomRow(row);
};

export const listRooms = (db: Db, sourceId: number) => (db
  .prepare(`select ${ROOM_COLUMNS} from chat_rooms where source_id = ? order by title`)
  .all(sourceId) as (Omit<RoomRow, 'members'> & { members: string })[]).map(toRoomRow);

// Keeps a room's name and title; whether the title changed, as every chunk's header has it
export const saveRoom = (db: Db, sourceId: number, room: ChatRoom) => {
  const before = getRoom(db, sourceId, room.id);
  db.prepare(`
    insert into chat_rooms (source_id, room_id, type, name, title) values (?, ?, ?, ?, ?)
    on conflict (source_id, room_id) do update set type = excluded.type, name = excluded.name, title = excluded.title
  `).run(sourceId, room.id, room.type, room.name, room.title);

  return Boolean(before && (before.title !== room.title || before.type !== room.type));
};

export const setRoomCursor = (db: Db, sourceId: number, roomId: string, cursor: unknown) => db
  .prepare('update chat_rooms set cursor = ? where source_id = ? and room_id = ?').run(JSON.stringify(cursor), sourceId, roomId);

// Keeps a room's members, read now; whether they changed
export const setRoomMembers = (db: Db, sourceId: number, roomId: string, members: string[], now: number) => {
  const sorted = JSON.stringify([...new Set(members)].sort((a, b) => a.localeCompare(b)));
  const before = getRoom(db, sourceId, roomId);
  db.prepare('update chat_rooms set members = ?, members_at = ? where source_id = ? and room_id = ?').run(sorted, now, sourceId, roomId);

  return Boolean(before && JSON.stringify(before.members) !== sorted);
};

// A room's members as last read, for the answer's context
export const roomMembers = (db: Db, sourceId: number, roomId: string) => getRoom(db, sourceId, roomId)?.members ?? [];

// When the user last read the room in the messenger, for which messages to them are unread
export const setRoomReadAt = (db: Db, sourceId: number, roomId: string, readAt: number | null) => db
  .prepare('update chat_rooms set read_at = ? where source_id = ? and room_id = ?').run(readAt, sourceId, roomId);

// Reading them failed for a reason of the room's (not allowed): tried again in a day
export const markMembersRead = (db: Db, sourceId: number, roomId: string, now: number) => db
  .prepare('update chat_rooms set members_at = ? where source_id = ? and room_id = ?').run(now, sourceId, roomId);

const roomDocuments = (db: Db, sourceId: number, roomId: string) => (db
  .prepare('select id from documents where source_id = ? and thread_id = ? and kind in (?, ?, ?)')
  .all(sourceId, roomId, CHAT_KINDS.day, CHAT_KINDS.thread, CHAT_KINDS.file) as { id: string }[]).map(({ id }) => id);

// A room no longer synced goes with its messages, their files and its documents
export const removeRoom = (db: Db, sourceId: number, roomId: string) => db.transaction(() => {
  roomDocuments(db, sourceId, roomId).forEach((id) => deleteDocument(db, id));
  forgetRoomFiles(db, sourceId, roomId);
  db.prepare('delete from chat_messages where source_id = ? and room_id = ?').run(sourceId, roomId);
  db.prepare('delete from chat_rooms where source_id = ? and room_id = ?').run(sourceId, roomId);
})();

// People: a reaction names its people by username

// How many people it learned the name of, or a new name
export const saveUsers = (db: Db, sourceId: number, users: { username: string, name: string }[]) => {
  const upsert = db.prepare(`
    insert into chat_users (source_id, username, name) values (?, ?, ?)
    on conflict (source_id, username) do update set name = excluded.name where name <> excluded.name
  `);

  return users.filter((user) => user.username && user.name && user.name !== user.username)
    .reduce((learned, user) => learned + upsert.run(sourceId, user.username, user.name).changes, 0);
};

// The rooms with reactions, whose lines name their people
export const roomsWithReactions = (db: Db, sourceId: number) => (db
  .prepare('select distinct room_id as roomId from chat_messages where source_id = ? and json like \'%"reactions":%\'')
  .all(sourceId) as { roomId: string }[]).map(({ roomId }) => roomId);

// The names of a source's people by username, else the username
const namesOf = (db: Db, sourceId: number) => {
  const names = new Map((db.prepare('select username, name from chat_users where source_id = ?').all(sourceId) as { username: string, name: string }[])
    .map(({ username, name }) => [username, name]));

  return (username: string) => names.get(username) ?? username;
};

const reactionsWithNames = (db: Db, sourceId: number) => {
  const nameOf = namesOf(db, sourceId);

  return (message: ChatMessage): ReactionNote[] => (message.reactions ?? [])
    .map(({ emoji, usernames }) => ({ emoji, names: usernames.map(nameOf) }));
};

// Messages

const parse = (rows: unknown[]) => (rows as { json: string }[]).map(({ json }) => JSON.parse(json) as ChatMessage);

export const getMessage = (db: Db, sourceId: number, messageId: string) => parse(db
  .prepare('select json from chat_messages where source_id = ? and message_id = ?').all(sourceId, messageId))[0] as ChatMessage | undefined;

// How many people's names it learned from their messages (saveUsers)
export const saveMessages = (db: Db, sourceId: number, messages: ChatMessage[], affected: Affected) => {
  const upsert = db.prepare(`
    insert into chat_messages (source_id, room_id, message_id, thread_id, ts, json) values (?, ?, ?, ?, ?, ?)
    on conflict (source_id, message_id) do update set room_id = excluded.room_id, thread_id = excluded.thread_id,
      ts = excluded.ts, json = excluded.json
  `);

  return db.transaction(() => {
    messages.forEach((message) => {
      upsert.run(sourceId, message.roomId, message.id, message.threadId ?? null, message.ts, JSON.stringify(message));
      registerAttachments(db, sourceId, message);
      touch(affected, message);
    });

    return saveUsers(db, sourceId, messages.map((message) => ({ username: message.username ?? '', name: message.author })));
  })();
};

export const deleteMessages = (db: Db, sourceId: number, messageIds: string[], affected: Affected) => db.transaction(() => {
  for (const id of messageIds) {
    const message = getMessage(db, sourceId, id);

    if (message) {
      // Its thread loses its first message too
      touch(affected, { ...message, startsThread: true });
      forgetMessageFiles(db, sourceId, id).forEach((fileId) => deleteDocument(db, fileDocumentId(sourceId, message.roomId, fileId)));
      db.prepare('delete from chat_messages where source_id = ? and message_id = ?').run(sourceId, id);
    }
  }
})();

// The ids of a room's messages from a time on, for a full sync to delete those the server no longer has
export const messageIds = (db: Db, sourceId: number, roomId: string, from: number) => (db
  .prepare('select message_id as id from chat_messages where source_id = ? and room_id = ? and ts >= ?')
  .all(sourceId, roomId, from) as { id: string }[]).map(({ id }) => id);

const dayMessages = (db: Db, sourceId: number, roomId: string, day: string, since: number) => {
  const [start, end] = dayRange(day);

  return parse(db.prepare(`
    select json from chat_messages where source_id = ? and room_id = ? and thread_id is null and ts >= ? and ts < ? order by ts
  `).all(sourceId, roomId, Math.max(start, since), end));
};

const threadReplies = (db: Db, sourceId: number, threadId: string) => parse(db
  .prepare('select json from chat_messages where source_id = ? and thread_id = ? order by ts').all(sourceId, threadId));

// Indexing

export interface IndexContext {
  // The source's name in the chunks' header, e.g. Rocket.Chat
  label: string;
  // Messages before it aren't indexed: they're kept only as the first message of a later thread
  since: number;
  embedModel: string | null;
}

// Those who wrote or reacted, and in a small room its members
const participantsOf = (messages: ChatMessage[], room: RoomRow, reactionsOf: (message: ChatMessage) => ReactionNote[]) => [...new Set([
  ...messages.map((message) => message.author),
  ...messages.flatMap((message) => reactionsOf(message).flatMap((reaction) => reaction.names)),
  ...(room.members.length <= MEMBERS_AS_PARTICIPANTS ? room.members : []),
])];

// What a vision model read of the messages' images, for their lines
const imagesOf = (db: Db, sourceId: number, messages: ChatMessage[]) => {
  const files = attachmentsOf(db, sourceId, messages.map((message) => message.id));

  return (message: ChatMessage): ImageNote[] => (files.get(message.id) ?? [])
    .filter((file) => file.kind === 'image' && file.state === 'done')
    .map((file) => ({ name: file.name, description: file.description, text: file.text }));
};

const indexDay = (db: Db, sourceId: number, room: RoomRow, day: string, context: IndexContext) => {
  const id = dayDocumentId(sourceId, room.id, day);
  const messages = dayMessages(db, sourceId, room.id, day, context.since);

  if (!messages.length) {
    deleteDocument(db, id);

    return;
  }

  const reactionsOf = reactionsWithNames(db, sourceId);

  syncDocument(db, {
    id,
    sourceId,
    kind: CHAT_KINDS.day,
    threadId: room.id,
    title: roomLabel(room),
    participants: participantsOf(messages, room, reactionsOf),
    createdAt: messages[0].ts,
    madeByAi: false,
    chunks: chunkConversation(`[${context.label} · ${roomLabel(room)} · ${day}]`, messages, { imagesOf: imagesOf(db, sourceId, messages), reactionsOf }),
  }, context.embedModel);
};

const indexThread = (db: Db, sourceId: number, room: RoomRow, threadId: string, context: IndexContext) => {
  const id = threadDocumentId(sourceId, room.id, threadId);
  const replies = threadReplies(db, sourceId, threadId);

  if (!replies.length) {
    deleteDocument(db, id);

    return;
  }

  const first = getMessage(db, sourceId, threadId);
  const messages = first ? [first, ...replies] : replies;
  const reactionsOf = reactionsWithNames(db, sourceId);
  const started = first ? `${first.author}: ${snippet(first.text, THREAD_CONTEXT_CHARS)}` : 'its first message isn\'t kept';

  syncDocument(db, {
    id,
    sourceId,
    kind: CHAT_KINDS.thread,
    threadId: room.id,
    title: `Thread in ${roomLabel(room)}${first ? `: ${snippet(first.text, 60)}` : ''}`,
    participants: participantsOf(messages, room, reactionsOf),
    createdAt: messages[0].ts,
    madeByAi: false,
    chunks: chunkConversation(`[${context.label} · ${roomLabel(room)} · thread of ${formatDay(messages[0].ts)} · ${started}]`, messages, {
      threadMark: false,
      imagesOf: imagesOf(db, sourceId, messages),
      reactionsOf,
    }),
  }, context.embedModel);
};

// A file's text as a document of its own: a document's, or an image's too long for its message's line
const fileText = (file: AttachmentRow) => {
  if (file.state !== 'done' || !file.text?.trim()) {
    return null;
  }

  if (file.kind === 'document') {
    return file.text;
  }

  return file.text.length > IMAGE_TEXT_CHARS ? [file.description, file.text].filter(Boolean).join('\n') : null;
};

const indexFile = (db: Db, sourceId: number, room: RoomRow, file: AttachmentRow, context: IndexContext) => {
  const id = fileDocumentId(sourceId, room.id, file.fileId);
  const text = file.ts >= context.since ? fileText(file) : null;
  const message = getMessage(db, sourceId, file.messageId);

  if (!text || !message) {
    deleteDocument(db, id);

    return;
  }

  const what = file.kind === 'image' ? 'image, read by AI' : 'file';
  syncDocument(db, {
    id,
    sourceId,
    kind: CHAT_KINDS.file,
    threadId: room.id,
    title: `${file.name} in ${roomLabel(room)}`,
    participants: [message.author],
    createdAt: file.ts,
    madeByAi: file.kind === 'image',
    chunks: chunkLines(
      `[${context.label} · ${roomLabel(room)} · ${what} ${file.name} sent by ${message.author} · ${formatDay(file.ts)}]`,
      text.split('\n').filter((line) => line.trim()).map((line) => ({ text: line.trim() })),
    ),
  }, context.embedModel);
};

// After a file is read: its message's line (an image) and its own document
export const indexRead = (db: Db, file: AttachmentRow, context: IndexContext) => {
  const room = getRoom(db, file.sourceId, file.roomId);
  const message = getMessage(db, file.sourceId, file.messageId);

  if (!room || !message) {
    return;
  }

  db.transaction(() => {
    const affected = noneAffected();
    touch(affected, message);
    indexAffected(db, file.sourceId, file.roomId, affected, context);
    indexFile(db, file.sourceId, room, file, context);
  })();
};

export const indexAffected = (db: Db, sourceId: number, roomId: string, affected: Affected, context: IndexContext) => {
  const room = getRoom(db, sourceId, roomId);

  if (!room) {
    return;
  }

  db.transaction(() => {
    affected.days.forEach((day) => indexDay(db, sourceId, room, day, context));
    affected.threads.forEach((threadId) => indexThread(db, sourceId, room, threadId, context));
  })();
};

// Every document of a room again: after its title changes, or the period kept does
export const reindexRoom = (db: Db, sourceId: number, roomId: string, context: IndexContext) => {
  const affected = noneAffected();
  parse(db.prepare('select json from chat_messages where source_id = ? and room_id = ?').all(sourceId, roomId))
    .forEach((message) => touch(affected, message));
  // Documents of days no longer kept go too
  roomDocuments(db, sourceId, roomId).forEach((id) => {
    const key = id.slice(roomPrefix(sourceId, roomId).length);

    if (!key.startsWith('thread:') && !key.startsWith('file:')) {
      affected.days.add(key);
    }
  });
  indexAffected(db, sourceId, roomId, affected, context);
  const room = getRoom(db, sourceId, roomId);

  if (room) {
    (db.prepare('select file_id as fileId from chat_attachments where source_id = ? and room_id = ?').all(sourceId, roomId) as { fileId: string }[])
      .forEach(({ fileId }) => indexFile(db, sourceId, room, getAttachment(db, sourceId, fileId)!, context));
  }
};

// Drops a room's messages from before a later start of the period, but those that start a thread with later replies
export const dropBefore = (db: Db, sourceId: number, roomId: string, since: number) => db.prepare(`
  delete from chat_messages where source_id = ? and room_id = ? and ts < ?
    and not exists (select 1 from chat_messages r where r.source_id = chat_messages.source_id
      and r.thread_id = chat_messages.message_id and r.ts >= ?)
`).run(sourceId, roomId, since, since).changes;

// The conversation view

const documentKey = (documentId: string, sourceId: number, roomId: string) => documentId.slice(roomPrefix(sourceId, roomId).length);

// A cited conversation from the knowledge base's own copy: its messages, with those of the cited chunk marked
export const getConversation = (db: Db, documentId: string, startMs: number | null): ConversationView | null => {
  const doc = db.prepare(`
    select d.source_id as sourceId, s.kind as sourceKind, d.kind, d.thread_id as roomId, d.title, d.created_at as createdAt
    from documents d join sources s on s.id = d.source_id where d.id = ?
  `).get(documentId) as { sourceId: number, sourceKind: string, kind: string, roomId: string, title: string, createdAt: number } | undefined;

  if (!doc || !Object.values(CHAT_KINDS).includes(doc.kind as never)) {
    return null;
  }

  const room = getRoom(db, doc.sourceId, doc.roomId);
  const key = documentKey(documentId, doc.sourceId, doc.roomId);

  // A file's text opens its message, in its day or thread
  if (doc.kind === CHAT_KINDS.file) {
    const file = getAttachment(db, doc.sourceId, key.slice('file:'.length));
    const message = file && getMessage(db, doc.sourceId, file.messageId);

    if (!message) {
      return null;
    }

    const view = getConversation(db, message.threadId
      ? threadDocumentId(doc.sourceId, doc.roomId, message.threadId)
      : dayDocumentId(doc.sourceId, doc.roomId, dayKey(message.ts)), null);
    const index = view?.messages.findIndex((viewed) => viewed.id === message.id) ?? -1;

    return view && { ...view, cited: index >= 0 ? { first: index, last: index } : null };
  }

  let messages: ChatMessage[];

  if (doc.kind === CHAT_KINDS.thread) {
    const threadId = key.slice('thread:'.length);
    const first = getMessage(db, doc.sourceId, threadId);
    messages = [...(first ? [first] : []), ...threadReplies(db, doc.sourceId, threadId)];
  } else {
    messages = dayMessages(db, doc.sourceId, doc.roomId, key, 0);
  }

  const threads = new Set((db.prepare('select id from documents where source_id = ? and thread_id = ? and kind = ?')
    .all(doc.sourceId, doc.roomId, CHAT_KINDS.thread) as { id: string }[]).map(({ id }) => id));
  const files = attachmentsOf(db, doc.sourceId, messages.map((message) => message.id));
  const reactionsOf = reactionsWithNames(db, doc.sourceId);
  const starts = (db.prepare('select start_ms as startMs from chunks where document_id = ? order by ord').all(documentId) as
    { startMs: number | null }[]).map((row) => row.startMs).filter((ms): ms is number => ms !== null);
  let cited: ConversationView['cited'] = null;

  if (startMs !== null) {
    const from = doc.createdAt + startMs;
    const next = starts.find((start) => start > startMs);
    const to = next === undefined ? Infinity : doc.createdAt + next;
    const first = messages.findIndex((message) => message.ts >= from);
    const last = messages.findLastIndex((message) => message.ts < to);

    cited = first >= 0 && last >= first ? { first, last } : null;
  }

  return {
    documentId,
    sourceId: doc.sourceId,
    sourceKind: doc.sourceKind,
    kind: doc.kind === CHAT_KINDS.thread ? 'thread' : 'day',
    title: doc.title,
    room: room ? roomLabel(room) : doc.title,
    members: room?.members ?? [],
    createdAt: doc.createdAt,
    messages: messages.map((message) => {
      const thread = threadDocumentId(doc.sourceId, doc.roomId, message.id);

      return {
        id: message.id,
        author: message.author,
        ts: message.ts,
        text: message.text,
        quotes: (message.quotes ?? []).map(({ author, text }) => ({ author, text })),
        files: message.files ?? [],
        attachments: (files.get(message.id) ?? []).map(({ fileId, name, kind, state, description, text }) => ({
          id: fileId, name, kind, state, description, text,
        })),
        reactions: reactionsOf(message),
        edited: Boolean(message.edited),
        threadDocumentId: doc.kind === CHAT_KINDS.day && threads.has(thread) ? thread : null,
      };
    }),
    cited,
  };
};

// Asking about a room

const roomKey = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export interface RoomRef {
  sourceId: number;
  roomId: string;
}

// The rooms a name said in a question means ("qa_dev_talks", "#qadevtalks", "QA dev talks"): those whose name or title it
// is, else those that have it in theirs
export const findRooms = (db: Db, said: string): RoomRef[] => {
  const key = roomKey(said);

  if (key.length < 2) {
    return [];
  }

  const rooms = db.prepare('select source_id as sourceId, room_id as roomId, name, title from chat_rooms').all() as (RoomRef & { name: string, title: string })[];
  const exact = rooms.filter((room) => roomKey(room.name) === key || roomKey(room.title) === key);

  return (exact.length ? exact : rooms.filter((room) => roomKey(room.name).includes(key) || roomKey(room.title).includes(key)))
    .map(({ sourceId, roomId }) => ({ sourceId, roomId }));
};

export const roomRefKey = (room: RoomRef) => `${room.sourceId}:${room.roomId}`;

// The messages with the most reactions in rooms (every room without them) and a period, each with the chunk it's in
// and a line telling it, for the answer: a small model counts names badly
export const topReacted = (db: Db, { rooms, from, to, limit }: { rooms?: RoomRef[], from?: number, to?: number, limit: number }) => {
  const rows = db.prepare(`
    select source_id as sourceId, room_id as roomId, json from chat_messages
    where json like '%"reactions":%' and ts >= ? and ts < ?
      and (? is null or (source_id || ':' || room_id) in (select value from json_each(?)))
  `).all(from ?? 0, to ?? Number.MAX_SAFE_INTEGER, rooms ? 1 : null, JSON.stringify((rooms ?? []).map(roomRefKey))) as
    { sourceId: number, roomId: string, json: string }[];
  const ranked = rows.map((row) => {
    const message = JSON.parse(row.json) as ChatMessage;

    return { ...row, message, count: (message.reactions ?? []).reduce((sum, reaction) => sum + reaction.usernames.length, 0) };
  }).filter((row) => row.count).sort((a, b) => b.count - a.count);
  const found: { chunkId: number, count: number, note: string }[] = [];

  for (const { sourceId, roomId, message, count } of ranked) {
    const documentId = message.threadId
      ? threadDocumentId(sourceId, roomId, message.threadId)
      : dayDocumentId(sourceId, roomId, dayKey(message.ts));
    const doc = db.prepare('select created_at as createdAt from documents where id = ?').get(documentId) as { createdAt: number } | undefined;
    const chunk = doc && db.prepare(`
      select id from chunks where document_id = ? and (start_ms is null or start_ms <= ?) order by ord desc limit 1
    `).get(documentId, message.ts - doc.createdAt) as { id: number } | undefined;

    if (chunk && !found.some((other) => other.chunkId === chunk.id)) {
      found.push({ chunkId: chunk.id, count, note: `A message here has ${count} ${count === 1 ? 'reaction' : 'reactions'}: ${message.author}: "${snippet(message.text, 80)}"` });
    }

    if (found.length === limit) {
      break;
    }
  }

  return found;
};

// What the knowledge base has of a source's rooms, room by room, and of all of them

export interface RoomStats {
  messages: number;
  threads: number;
  // Messages with reactions
  reacted: number;
  images: number;
  imagesRead: number;
  files: number;
  filesRead: number;
}

const NO_STATS: RoomStats = { messages: 0, threads: 0, reacted: 0, images: 0, imagesRead: 0, files: 0, filesRead: 0 };

export const roomStats = (db: Db, sourceId: number) => {
  const stats = new Map<string, RoomStats>();
  const of = (roomId: string) => stats.get(roomId) ?? { ...NO_STATS };

  (db.prepare(`
    select room_id as roomId, count(*) as messages, count(distinct thread_id) as threads,
      sum(json like '%"reactions":%') as reacted
    from chat_messages where source_id = ? group by room_id
  `).all(sourceId) as { roomId: string, messages: number, threads: number, reacted: number }[])
    .forEach(({ roomId, ...counts }) => stats.set(roomId, { ...of(roomId), ...counts }));
  (db.prepare(`
    select room_id as roomId, kind, count(*) as n, sum(state = 'done') as done from chat_attachments where source_id = ? group by room_id, kind
  `).all(sourceId) as { roomId: string, kind: string, n: number, done: number }[]).forEach(({ roomId, kind, n, done }) => stats.set(roomId, {
    ...of(roomId),
    ...(kind === 'image' ? { images: n, imagesRead: done } : { files: n, filesRead: done }),
  }));

  return stats;
};

export const sourceStats = (db: Db, sourceId: number) => [...roomStats(db, sourceId).values()].reduce((total, room) => ({
  messages: total.messages + room.messages,
  threads: total.threads + room.threads,
  reacted: total.reacted + room.reacted,
  images: total.images + room.images,
  imagesRead: total.imagesRead + room.imagesRead,
  files: total.files + room.files,
  filesRead: total.filesRead + room.filesRead,
}), { ...NO_STATS });
