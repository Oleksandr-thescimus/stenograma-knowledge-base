import type { Db } from './db.ts';
import { deleteDocument } from './documents.ts';

export interface Source {
  id: number;
  kind: string;
  account: string | null;
  cloudAllowed: boolean;
}

// F8 by default: a browser's meetings already go to the extension's Groq or Gemini, so they may go to the cloud; email
// and chats may not until it's turned on
const cloudAllowedByDefault = (kind: string) => kind.startsWith('stenograma');

export const findSource = (db: Db, kind: string, account: string) => {
  const row = db.prepare('select id, kind, account, cloud_allowed as cloudAllowed from sources where kind = ? and account = ?')
    .get(kind, account) as (Omit<Source, 'cloudAllowed'> & { cloudAllowed: number }) | undefined;

  return row && { ...row, cloudAllowed: Boolean(row.cloudAllowed) };
};

export const findOrCreateSource = (db: Db, kind: string, account: string): Source => findSource(db, kind, account) ?? {
  id: Number(db.prepare('insert into sources (kind, account, cloud_allowed, created_at) values (?, ?, ?, ?)')
    .run(kind, account, cloudAllowedByDefault(kind) ? 1 : 0, Date.now()).lastInsertRowid),
  kind,
  account,
  cloudAllowed: cloudAllowedByDefault(kind),
};

// The only source of its kind, its account set to the latest one: a newer backup replaces the older one's meetings
// instead of adding them again
export const findOrCreateOnlySource = (db: Db, kind: string, account: string): Source => {
  const existing = db.prepare('select id from sources where kind = ?').get(kind) as { id: number } | undefined;

  if (existing) {
    db.prepare('update sources set account = ? where id = ?').run(account, existing.id);
  }

  return findOrCreateSource(db, kind, account);
};

export interface SourceStatus extends Source {
  documents: number;
  chunks: number;
  lastSyncAt: number | null;
  lastError: string | null;
}

export const listSources = (db: Db) => (db.prepare(`
  select s.id, s.kind, s.account, s.cloud_allowed as cloudAllowed, s.last_sync_at as lastSyncAt, s.last_error as lastError,
    (select count(*) from documents d where d.source_id = s.id) as documents,
    (select count(*) from chunks c join documents d on d.id = c.document_id where d.source_id = s.id) as chunks
  from sources s order by s.id
`).all() as (Omit<SourceStatus, 'cloudAllowed'> & { cloudAllowed: number })[]).map((row) => ({ ...row, cloudAllowed: Boolean(row.cloudAllowed) }));

// F8. Turning it off doesn't take back what already went to a cloud provider; turning it on queues nothing new, the
// chunks' jobs are already waiting for a cloud embedding provider
export const setCloudAllowed = (db: Db, sourceId: number, allowed: boolean) => db
  .prepare('update sources set cloud_allowed = ? where id = ?').run(allowed ? 1 : 0, sourceId).changes > 0;

export const markSynced = (db: Db, sourceId: number, error?: string) => db
  .prepare('update sources set last_sync_at = ?, last_error = ? where id = ?').run(Date.now(), error ?? null, sourceId);

// Removes a source with all its documents (F7); its secrets go with it once sources have any (M2+)
export const removeSource = (db: Db, sourceId: number) => db.transaction(() => {
  (db.prepare('select id from documents where source_id = ?').all(sourceId) as { id: string }[])
    .forEach(({ id }) => deleteDocument(db, id));
  db.prepare('delete from sources where id = ?').run(sourceId);
})();
