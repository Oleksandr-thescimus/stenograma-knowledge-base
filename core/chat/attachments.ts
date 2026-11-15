import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Db } from '../db.ts';
import type { ChatAttachment, ChatMessage } from './types.ts';

// The files of chat messages whose content is read (F3): an image's text and what it shows, by a vision model, and a
// document's text (PDF, plain text). Each is a row, pending until it's read, newest first. An image is kept next to the
// knowledge base (attachments/<source>/<file>), to show it in the conversation; a document only as its text

export type AttachmentKind = 'image' | 'document';
export type AttachmentState = 'pending' | 'done' | 'failed' | 'skipped';

// Formats a vision model reads (an SVG could carry scripts, and the renderer is untrusted)
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif)$/i;
const DOCUMENT_TYPES = new Set(['application/pdf', 'text/plain', 'text/markdown', 'text/csv']);
const DOCUMENT_EXTENSIONS = /\.(pdf|txt|md|csv)$/i;

// Larger files aren't read
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 30 * 1024 * 1024;

export const attachmentKind = (file: Pick<ChatAttachment, 'name' | 'type'>): AttachmentKind | null => {
  if (file.type ? IMAGE_TYPES.has(file.type) : IMAGE_EXTENSIONS.test(file.name)) {
    return 'image';
  }

  if (file.type ? DOCUMENT_TYPES.has(file.type) : DOCUMENT_EXTENSIONS.test(file.name)) {
    return 'document';
  }

  return null;
};

export interface AttachmentRow {
  sourceId: number;
  roomId: string;
  messageId: string;
  fileId: string;
  name: string;
  type: string | null;
  size: number | null;
  path: string;
  kind: AttachmentKind;
  ts: number;
  state: AttachmentState;
  text: string | null;
  description: string | null;
  model: string | null;
  error: string | null;
  attempts: number;
}

const COLUMNS = `source_id as sourceId, room_id as roomId, message_id as messageId, file_id as fileId, name, type, size, path,
  kind, ts, state, text, description, model, error, attempts`;

// Files sit next to the knowledge base, so a test's never touch the real ones
const sourceDir = (db: Db, sourceId: number) => join(dirname(db.name), 'attachments', String(sourceId));
export const attachmentFile = (db: Db, sourceId: number, fileId: string) => join(sourceDir(db, sourceId), fileId.replace(/[^\w-]/g, '_'));

export const keepFile = (db: Db, sourceId: number, fileId: string, bytes: Uint8Array) => {
  mkdirSync(sourceDir(db, sourceId), { recursive: true, mode: 0o700 });
  writeFileSync(attachmentFile(db, sourceId, fileId), bytes, { mode: 0o600 });
};

export const readKeptFile = (db: Db, sourceId: number, fileId: string) => {
  const path = attachmentFile(db, sourceId, fileId);

  return existsSync(path) ? readFileSync(path) : null;
};

// A message's files of a kind that's read, pending; a file already there keeps what was read of it
export const registerAttachments = (db: Db, sourceId: number, message: ChatMessage) => {
  const insert = db.prepare(`
    insert or ignore into chat_attachments (source_id, room_id, message_id, file_id, name, type, size, path, kind, ts)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const file of message.attachments ?? []) {
    const kind = attachmentKind(file);

    if (kind) {
      insert.run(sourceId, message.roomId, message.id, file.id, file.name, file.type ?? null, file.size ?? null, file.path, kind, message.ts);
    }
  }
};

const dropRows = (db: Db, rows: { sourceId: number, fileId: string }[]) => {
  for (const { sourceId, fileId } of rows) {
    rmSync(attachmentFile(db, sourceId, fileId), { force: true });
    db.prepare('delete from chat_attachments where source_id = ? and file_id = ?').run(sourceId, fileId);
  }
};

// A deleted message's files go, with what was read of them; the ids of its documents' files, whose documents go too
export const forgetMessageFiles = (db: Db, sourceId: number, messageId: string) => {
  const rows = db.prepare(`select ${COLUMNS} from chat_attachments where source_id = ? and message_id = ?`).all(sourceId, messageId) as AttachmentRow[];
  dropRows(db, rows);

  return rows.filter((row) => row.kind === 'document').map((row) => row.fileId);
};

export const forgetRoomFiles = (db: Db, sourceId: number, roomId: string) => dropRows(db, db
  .prepare('select source_id as sourceId, file_id as fileId from chat_attachments where source_id = ? and room_id = ?')
  .all(sourceId, roomId) as { sourceId: number, fileId: string }[]);

export const forgetSourceFiles = (db: Db, sourceId: number) => rmSync(sourceDir(db, sourceId), { recursive: true, force: true });

export const getAttachment = (db: Db, sourceId: number, fileId: string) => db
  .prepare(`select ${COLUMNS} from chat_attachments where source_id = ? and file_id = ?`).get(sourceId, fileId) as AttachmentRow | undefined;

// The files of messages, by message, for their chunks and the conversation view
export const attachmentsOf = (db: Db, sourceId: number, messageIds: string[]) => {
  const rows = messageIds.length ? db.prepare(`
    select ${COLUMNS} from chat_attachments where source_id = ? and message_id in (select value from json_each(?))
  `).all(sourceId, JSON.stringify(messageIds)) as AttachmentRow[] : [];
  const byMessage = new Map<string, AttachmentRow[]>();
  rows.forEach((row) => byMessage.set(row.messageId, [...(byMessage.get(row.messageId) ?? []), row]));

  return byMessage;
};

export interface PendingFilter {
  kinds: AttachmentKind[];
  // Files sent before it wait: the period read is shorter than the messages'
  since: number;
  // Taken by another server's queue, as sourceId:fileId
  exclude?: string[];
  // Only of the sources that may go to cloud AI (F8): for a cloud server's queue
  cloudOnly?: boolean;
}

// The next file to read: the newest
export const nextPending = (db: Db, { kinds, since, exclude = [], cloudOnly = false }: PendingFilter) => (kinds.length ? db.prepare(`
  select ${COLUMNS} from chat_attachments a
  where state = 'pending' and ts >= ? and kind in (select value from json_each(?))
    and (source_id || ':' || file_id) not in (select value from json_each(?))
    and (? = 0 or exists (select 1 from sources s where s.id = a.source_id and s.cloud_allowed = 1))
  order by ts desc limit 1
`).get(since, JSON.stringify(kinds), JSON.stringify(exclude), cloudOnly ? 1 : 0) : undefined) as AttachmentRow | undefined;

export const countAttachments = (db: Db, { kinds, since }: PendingFilter) => {
  const rows = db.prepare(`
    select state, count(*) as n from chat_attachments where ts >= ? and kind in (select value from json_each(?)) group by state
  `).all(since, JSON.stringify(kinds)) as { state: AttachmentState, n: number }[];
  const of = (state: AttachmentState) => rows.find((row) => row.state === state)?.n ?? 0;

  return { pending: of('pending'), done: of('done'), failed: of('failed') + of('skipped') };
};

export const saveRead = (
  db: Db, sourceId: number, fileId: string, read: { state: AttachmentState, text?: string | null, description?: string | null, model?: string | null, error?: string | null },
) => db.prepare(`
  update chat_attachments set state = ?, text = ?, description = ?, model = ?, error = ?, attempts = attempts + 1
  where source_id = ? and file_id = ?
`).run(read.state, read.text ?? null, read.description ?? null, read.model ?? null, read.error ?? null, sourceId, fileId);

// A failure that may pass (the model isn't running): counted, and the file stays pending until its last attempt
export const failRead = (db: Db, sourceId: number, fileId: string, error: string, maxAttempts: number) => db.prepare(`
  update chat_attachments set attempts = attempts + 1, error = ?, state = case when attempts + 1 >= ? then 'failed' else state end
  where source_id = ? and file_id = ?
`).run(error, maxAttempts, sourceId, fileId);

// The latest images of the chats, to try a vision model on
export const recentImages = (db: Db, limit: number) => db.prepare(`
  select ${COLUMNS} from chat_attachments where kind = 'image' order by ts desc limit ?
`).all(limit) as AttachmentRow[];

// Images read again with another model: those done go back to pending
export const readImagesAgain = (db: Db) => db.prepare('update chat_attachments set state = \'pending\', attempts = 0, error = null where kind = \'image\' and state <> \'pending\'').run().changes;
