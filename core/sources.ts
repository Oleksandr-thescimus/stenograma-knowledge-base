import { BROWSER_KIND, browserOf } from './browsers.ts';
import { forgetSourceFiles } from './chat/attachments.ts';
import type { Db } from './db.ts';
import { deleteDocument } from './documents.ts';
import type { BrowserKind } from './protocol.ts';
import { reconcileSessions } from './stenograma/ingest.ts';

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
  // A browser's, else null
  browser: BrowserKind | null;
  documents: number;
  chunks: number;
  meetings: number;
  lastSyncAt: number | null;
  lastError: string | null;
  // A browser's meetings indexed from another browser's copy (stenograma/ingest.ts)
  indexedElsewhere: number;
  // Those by the source whose copy is indexed
  copiesIn: { sourceId: number, meetings: number }[];
  // When a browser last called the API (lastSyncAt is its last push)
  lastSeenAt: number | null;
  // Its meetings: the newest, the oldest's start, those with a short summary and those of a named series
  latestMeeting: { title: string, createdAt: number } | null;
  firstMeetingAt: number | null;
  summarized: number;
  inSeries: number;
  // A messenger's: whether new messages to the user get a reply draft
  repliesEnabled: boolean;
}

// A meeting's document id is stenograma:<source>:<session> (meetingDocumentId)
export const listSources = (db: Db): SourceStatus[] => {
  const copies = db.prepare(`
    select r.source_id as sourceId, d.source_id as indexedIn, count(*) as meetings
    from (select distinct source_id, session_id from stenograma_rows) r
    join sources s on s.id = r.source_id and s.kind = @browser
    join sources o on o.id <> r.source_id and o.kind like 'stenograma%'
    join documents d on d.id = 'stenograma:' || o.id || ':' || r.session_id
    group by r.source_id, d.source_id
  `).all({ browser: BROWSER_KIND }) as { sourceId: number, indexedIn: number, meetings: number }[];

  return (db.prepare(`
    select s.id, s.kind, s.account, s.config, s.cloud_allowed as cloudAllowed, s.last_sync_at as lastSyncAt, s.last_error as lastError,
      s.last_seen_at as lastSeenAt, s.replies_enabled as repliesEnabled,
      (select count(*) from documents d where d.source_id = s.id) as documents,
      (select count(*) from documents d where d.source_id = s.id and d.kind = 'meeting') as meetings,
      (select count(*) from chunks c join documents d on d.id = c.document_id where d.source_id = s.id) as chunks,
      (select min(d.created_at) from documents d where d.source_id = s.id and d.kind = 'meeting') as firstMeetingAt,
      (select json_object('title', d.title, 'createdAt', d.created_at) from documents d where d.source_id = s.id and d.kind = 'meeting'
        order by d.created_at desc limit 1) as latestMeeting,
      (select count(*) from documents d join summaries m on m.document_id = d.id where d.source_id = s.id and d.kind = 'meeting') as summarized,
      (select count(*) from documents d where d.source_id = s.id and d.kind = 'meeting' and d.series_id is not null) as inSeries
    from sources s order by s.id
  `).all() as (Omit<SourceStatus, 'cloudAllowed' | 'browser' | 'latestMeeting' | 'indexedElsewhere' | 'copiesIn' | 'repliesEnabled'>
    & { cloudAllowed: number, config: string, latestMeeting: string | null, repliesEnabled: number })[])
    .map(({ config, latestMeeting, ...row }) => {
      const copiesIn = copies.filter((copy) => copy.sourceId === row.id).map(({ indexedIn, meetings }) => ({ sourceId: indexedIn, meetings }));

      return {
        ...row,
        cloudAllowed: Boolean(row.cloudAllowed),
        repliesEnabled: Boolean(row.repliesEnabled),
        browser: row.kind === BROWSER_KIND ? browserOf(row.account, config) : null,
        latestMeeting: latestMeeting ? JSON.parse(latestMeeting) as { title: string, createdAt: number } : null,
        copiesIn,
        indexedElsewhere: copiesIn.reduce((sum, copy) => sum + copy.meetings, 0),
      };
    });
};

// F8. Turning it off doesn't take back what already went to a cloud provider; turning it on queues nothing new, the
// chunks' jobs are already waiting for a cloud embedding provider
export const setCloudAllowed = (db: Db, sourceId: number, allowed: boolean) => db
  .prepare('update sources set cloud_allowed = ? where id = ?').run(allowed ? 1 : 0, sourceId).changes > 0;

export const markSeen = (db: Db, sourceId: number) => db.prepare('update sources set last_seen_at = ? where id = ?').run(Date.now(), sourceId);

export const markSynced = (db: Db, sourceId: number, error?: string) => db
  .prepare('update sources set last_sync_at = ?, last_error = ? where id = ?').run(Date.now(), error ?? null, sourceId);

// Removes a source with all its documents (F7); its secrets go with it once sources have any (M2+). A meeting another
// browser sent too is indexed from that browser's copy, for the embedding model
export const removeSource = (db: Db, sourceId: number, embedModel: string | null) => db.transaction(() => {
  reconcileSessions(db, sourceId, [], embedModel);
  forgetSourceFiles(db, sourceId);
  (db.prepare('select id from documents where source_id = ?').all(sourceId) as { id: string }[])
    .forEach(({ id }) => deleteDocument(db, id));
  db.prepare('delete from sources where id = ?').run(sourceId);
})();
