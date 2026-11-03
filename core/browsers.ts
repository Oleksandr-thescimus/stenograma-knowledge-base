import { createHash, randomBytes } from 'node:crypto';
import type { Db } from './db.ts';
import type { Source } from './sources.ts';

// A paired browser is a Stenograma source with its own bearer token (step 6 of the plan's Sending, N2): Chrome's and
// Firefox's histories stay apart, and a reconcile from one never deletes the other's meetings. The knowledge base keeps
// only the token's hash; pasting the same token after reinstalling the extension continues the same source

export const BROWSER_KIND = 'stenograma-browser';

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export const createBrowserSource = (db: Db, label: string): { source: Source, token: string } => {
  const token = `skb_${randomBytes(32).toString('base64url')}`;
  const id = Number(db.prepare('insert into sources (kind, account, cloud_allowed, token_hash, created_at) values (?, ?, 1, ?, ?)')
    .run(BROWSER_KIND, label, hashToken(token), Date.now()).lastInsertRowid);

  return { source: { id, kind: BROWSER_KIND, account: label, cloudAllowed: true }, token };
};

export const findBrowserByToken = (db: Db, token: string): Source | undefined => {
  const row = db.prepare('select id, kind, account, cloud_allowed as cloudAllowed from sources where kind = ? and token_hash = ? and enabled = 1')
    .get(BROWSER_KIND, hashToken(token)) as (Omit<Source, 'cloudAllowed'> & { cloudAllowed: number }) | undefined;

  return row && { ...row, cloudAllowed: Boolean(row.cloudAllowed) };
};
