import {
  deleteMessages, dropBefore, getRoom, indexAffected, listRooms, markMembersRead, messageIds, noneAffected, reindexRoom, removeRoom,
  roomsWithReactions, saveMessages, saveRoom, saveUsers, setRoomCursor, setRoomMembers, type Affected, type IndexContext,
} from '../chat/store.ts';
import type { ChatMessage, ChatRoom } from '../chat/types.ts';
import type { Db } from '../db.ts';
import type { RoomSelection, SyncLimits } from '../protocol.ts';
import { findOrCreateSource, findSource } from '../sources.ts';
import { RocketChatError, type RcMessage, type RocketChatApi, type SyncPage } from './api.ts';
import { isReadableRoom, toChatMessage, toRoom } from './convert.ts';

// Rocket.Chat as a source (F3, F4; docs/PLAN.md, Connectors). Each run lists the user's rooms, reads those chosen
// that have a new message, and every few hours the others too, for edits and deletions: chat.syncMessages gives the
// messages updated after a room's cursor (thread replies too), and those deleted, in pages from 7.1, at once before

export const ROCKETCHAT_KIND = 'rocketchat';
export const ROCKETCHAT_LABEL = 'Rocket.Chat';

export interface RocketChatConfig {
  serverUrl: string;
  userId: string;
  username: string;
  selection: RoomSelection;
  // Messages from then on are read (milliseconds; 0 for all)
  since: number;
  // Missing in a source added before them: the defaults
  limits?: SyncLimits;
}

// Gentle by default: half the calls Rocket.Chat allows from an address, and a pause between files
export const DEFAULT_LIMITS: SyncLimits = { intervalMinutes: 5, requestsPerMinute: 5, filePauseSeconds: 3 };

export const limitsOf = (config: RocketChatConfig): SyncLimits => ({ ...DEFAULT_LIMITS, ...config.limits });

interface RoomCursor {
  // The latest _updatedAt and _deletedAt read, in the server's time
  updated: number;
  deleted: number;
  // The room's last message when it was read, to tell a room with a new one
  lastMessage: number | null;
  // When it was last read whole or checked for edits and deletions
  checkedAt: number;
}

// Messages a call; at 10 calls a minute a room of 20,000 messages takes two minutes
const PAGE_SIZE = 1000;
// A room without a new message is checked for edits and deletions this often
const RECHECK_MS = 6 * 3600_000;
// Rocket.Chat forgets deleted messages after 30 days: a room not read for longer is read whole again
const TRASH_KEPT_MS = 28 * 86_400_000;
// A room's members are read again this often
const MEMBERS_EVERY_MS = 86_400_000;

export const readConfig = (db: Db, sourceId: number) => JSON.parse((db.prepare('select config from sources where id = ?')
  .get(sourceId) as { config: string }).config) as RocketChatConfig;

export const writeConfig = (db: Db, sourceId: number, config: RocketChatConfig) => db
  .prepare('update sources set config = ? where id = ?').run(JSON.stringify(config), sourceId);

export const isSelected = (selection: RoomSelection, room: Pick<ChatRoom, 'id' | 'type'>) => (selection.mode === 'chosen'
  ? selection.ids.includes(room.id)
  : selection.types.includes(room.type));

export const messageLink = (config: Pick<RocketChatConfig, 'serverUrl'>, room: ChatRoom, messageId: string) => {
  const path = room.type === 'direct'
    ? `direct/${encodeURIComponent(room.id)}`
    : `${room.type === 'channel' ? 'channel' : 'group'}/${encodeURIComponent(room.name)}`;

  return `${config.serverUrl}/${path}?msg=${encodeURIComponent(messageId)}`;
};

export interface SyncContext {
  db: Db;
  sourceId: number;
  api: RocketChatApi;
  embedModel: string | null;
  signal?: AbortSignal;
  // e.g. "3 of 12 rooms, 1200 messages"
  progress?: (text: string) => void;
  // After a room whose documents changed, to embed them
  onChange?: () => void;
  now?: () => number;
  // Tests read small pages
  pageSize?: number;
}

const readCursor = (json: string | null | undefined) => (json ? JSON.parse(json) as RoomCursor : null);

// A page's messages as kept: those of the period, and earlier ones only as a thread's first message. What's no longer a
// message of a person (deleted and shown as such, an old version) is deleted
const applyUpdated = (db: Db, sourceId: number, since: number, updated: RcMessage[], affected: Affected, learned: { count: number }) => {
  const kept: ChatMessage[] = [];
  const gone: string[] = [];

  for (const message of updated) {
    const converted = toChatMessage(message);

    if (!converted) {
      gone.push(message._id);
    } else if (converted.ts >= since || converted.startsThread) {
      kept.push(converted);
    }
  }

  learned.count += saveMessages(db, sourceId, kept, affected);
  deleteMessages(db, sourceId, gone, affected);

  return kept.length;
};

const latest = (values: string[], fallback: number) => values.reduce((max, value) => Math.max(max, Date.parse(value)), fallback);

interface RoomRun {
  context: SyncContext;
  config: RocketChatConfig;
  // Set once a server without pages (before 7.1) is found
  legacy: { value: boolean };
  // People whose names were learned in the run: rooms read before may name them by username in a reaction
  learned: { count: number };
  onMessages: (count: number) => void;
}

const readRoom = async ({ context, config, legacy, learned, onMessages }: RoomRun, room: ChatRoom, lastMessage: number | null) => {
  const { db, sourceId, api, signal } = context;
  const now = context.now?.() ?? Date.now();
  const before = readCursor(getRoom(db, sourceId, room.id)?.cursor);
  // A new room, or one whose deleted messages the server may have forgotten, is read whole
  const whole = !before || now - before.checkedAt > TRASH_KEPT_MS;
  const affected = noneAffected();
  const seen = new Set<string>();
  let updated = whole ? config.since : before.updated;
  let deleted = whole ? config.since : before.deleted;

  const takePage = (page: SyncPage) => {
    page.updated.forEach((message) => seen.add(message._id));
    onMessages(applyUpdated(db, sourceId, config.since, page.updated, affected, learned));
    deleteMessages(db, sourceId, page.deleted.map((message) => message._id), affected);
    updated = latest(page.updated.map((message) => message._updatedAt), updated);
    deleted = latest(page.deleted.map((message) => message._deletedAt), deleted);
  };

  const readPages = async (type: 'UPDATED' | 'DELETED') => {
    // A millisecond back, as a page ends after the last one it holds; what's read again is the same
    let next = Math.max(0, (type === 'UPDATED' ? updated : deleted) - 1);

    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const page = await api.syncPage(room.id, type, next, context.pageSize ?? PAGE_SIZE);
      takePage(page);
      const following = page.cursor?.next ? Number(page.cursor.next) - 1 : null;

      if (following === null || following <= next || !(page.updated.length + page.deleted.length)) {
        return;
      }

      next = following;
      signal?.throwIfAborted();
    }
  };

  if (!legacy.value) {
    try {
      await readPages('UPDATED');
    } catch (error) {
      // A server before 7.1 wants lastUpdate instead
      if (!(error instanceof RocketChatError && error.status === 400)) {
        throw error;
      }

      legacy.value = true;
    }
  }

  if (legacy.value) {
    takePage(await api.syncSince(room.id, Math.max(0, updated - 1)));
  } else if (!whole) {
    await readPages('DELETED');
  }

  if (whole && before) {
    // What the server no longer has, though it may have forgotten deleting it
    deleteMessages(db, sourceId, messageIds(db, sourceId, room.id, config.since).filter((id) => !seen.has(id)), affected);
  }

  indexAffected(db, sourceId, room.id, affected, { label: ROCKETCHAT_LABEL, since: config.since, embedModel: context.embedModel });
  setRoomCursor(db, sourceId, room.id, { updated, deleted, lastMessage, checkedAt: now } satisfies RoomCursor);

  return affected.days.size + affected.threads.size > 0;
};

export const indexContext = (config: RocketChatConfig, embedModel: string | null): IndexContext => ({
  label: ROCKETCHAT_LABEL, since: config.since, embedModel,
});

// One run: the rooms, then the messages of those due. Returns whether documents changed
export const syncRocketChat = async (context: SyncContext) => {
  const { db, sourceId, api, signal } = context;
  const now = context.now?.() ?? Date.now();
  const config = readConfig(db, sourceId);
  const subscriptions = await api.subscriptions();
  const lastMessages = new Map((await api.rooms()).map((room) => [room._id, room.lm ? Date.parse(room.lm) : null]));
  const wanted = subscriptions.filter(isReadableRoom).map(toRoom).filter((room) => isSelected(config.selection, room));
  const wantedIds = new Set(wanted.map((room) => room.id));
  let changed = false;

  // A room no longer chosen, or left, goes with its messages
  for (const room of listRooms(db, sourceId).filter((known) => !wantedIds.has(known.id))) {
    removeRoom(db, sourceId, room.id);
    changed = true;
  }

  const due = wanted.filter((room) => {
    const cursor = readCursor(getRoom(db, sourceId, room.id)?.cursor);

    return !cursor || cursor.lastMessage !== (lastMessages.get(room.id) ?? null) || now - cursor.checkedAt > RECHECK_MS;
  });

  for (const room of wanted) {
    if (saveRoom(db, sourceId, room)) {
      // Renamed: every chunk's header names it
      reindexRoom(db, sourceId, room.id, indexContext(config, context.embedModel));
      changed = true;
    }
  }

  let messages = 0;
  const run: RoomRun = { context, config, legacy: { value: false }, learned: { count: 0 }, onMessages: (count) => (messages += count) };

  for (const [index, room] of due.entries()) {
    signal?.throwIfAborted();
    context.progress?.(`${index} of ${due.length} rooms${messages ? `, ${messages} messages` : ''}`);

    // eslint-disable-next-line no-await-in-loop
    if (await readRoom(run, room, lastMessages.get(room.id) ?? null)) {
      changed = true;
      context.onChange?.();
    }
  }

  // The members of the rooms not read for a day, after the messages, which matter more. In a small room they're its
  // documents' participants (chat/store.ts): when they change, the documents are written again, with the same chunks
  const membersDue = wanted.filter((room) => {
    const membersAt = getRoom(db, sourceId, room.id)?.membersAt;

    return membersAt === null || membersAt === undefined || now - membersAt > MEMBERS_EVERY_MS;
  });

  for (const [index, room] of membersDue.entries()) {
    signal?.throwIfAborted();
    context.progress?.(`the members of ${index} of ${membersDue.length} rooms`);
    let members: string[] | null = null;

    try {
      // eslint-disable-next-line no-await-in-loop
      const found = await api.members(room.id, room.type);
      run.learned.count += saveUsers(db, sourceId, found.map((member) => ({ username: member.username, name: member.name ?? '' })));
      members = found.map((member) => member.name || member.username);
    } catch (error) {
      // Not allowed in this room: tried again in a day. Any other error stops the run
      if (!(error instanceof RocketChatError && [400, 403, 404].includes(error.status))) {
        throw error;
      }
    }

    if (members === null) {
      markMembersRead(db, sourceId, room.id, now);
    } else if (setRoomMembers(db, sourceId, room.id, members, now)) {
      reindexRoom(db, sourceId, room.id, indexContext(config, context.embedModel));
      changed = true;
    }
  }

  // New names: the reactions of rooms read before them name their people now. Only the chunks of those lines change
  if (run.learned.count) {
    roomsWithReactions(db, sourceId).filter((roomId) => wantedIds.has(roomId))
      .forEach((roomId) => reindexRoom(db, sourceId, roomId, indexContext(config, context.embedModel)));
    changed = true;
  }

  return { changed, rooms: due.length, messages };
};

// The token is in the keyring under the knowledge base's id too, so a test's or another knowledge base's source never
// reads or deletes this one's
export const tokenSecretName = (kbId: string, sourceId: number) => `rocketchat:${kbId}:${sourceId}`;

// A Rocket.Chat account as a source, off for cloud AI by default (F8)
export const createRocketChatSource = (db: Db, account: string, config: RocketChatConfig) => {
  if (findSource(db, ROCKETCHAT_KIND, account)) {
    throw new Error(`${account} is a source already: its rooms are changed in its menu, "Rooms and period"`);
  }

  const source = findOrCreateSource(db, ROCKETCHAT_KIND, account);
  writeConfig(db, source.id, config);

  return source.id;
};

// A new period: an earlier start reads every room whole again; a later one drops what's before it
export const changePeriod = (db: Db, sourceId: number, since: number, embedModel: string | null) => {
  const config = readConfig(db, sourceId);

  if (since < config.since) {
    db.prepare('update chat_rooms set cursor = null where source_id = ?').run(sourceId);
  } else if (since > config.since) {
    db.transaction(() => listRooms(db, sourceId).forEach((room) => {
      dropBefore(db, sourceId, room.id, since);
      reindexRoom(db, sourceId, room.id, indexContext({ ...config, since }, embedModel));
    }))();
  }

  writeConfig(db, sourceId, { ...config, since });
};
