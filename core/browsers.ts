import { createHash, randomBytes } from 'node:crypto';
import type { Db } from './db.ts';
import type { BrowserKind } from './protocol.ts';
import type { Source } from './sources.ts';

// A paired browser is a Stenograma source with its own bearer token (step 6 of the plan's Sending, N2): Chrome's and
// Firefox's histories stay apart, and a reconcile from one never deletes the other's meetings. The knowledge base keeps
// only the token's hash; pasting the same token after reinstalling the extension continues the same source, and so does
// a new token made for it when that one is lost (the old one stops working)

export const BROWSER_KIND = 'stenograma-browser';

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

const newToken = () => `skb_${randomBytes(32).toString('base64url')}`;

// Its browser as the user chose it, else as its label says: "Firefox2" is a Firefox, "Work laptop" isn't known
const GUESSES: [RegExp, BrowserKind][] = [[/edge/i, 'edge'], [/firefox/i, 'firefox'], [/brave/i, 'brave'], [/opera/i, 'opera'], [/chrom/i, 'chrome']];

export const browserOf = (label: string | null, config: string) => {
  const chosen = (JSON.parse(config) as { browser?: BrowserKind }).browser;

  return chosen ?? GUESSES.find(([pattern]) => pattern.test(label ?? ''))?.[1] ?? 'other';
};

export const createBrowserSource = (db: Db, label: string, browser?: BrowserKind): { source: Source, token: string } => {
  const token = newToken();
  const id = Number(db.prepare('insert into sources (kind, account, config, cloud_allowed, token_hash, created_at) values (?, ?, ?, 1, ?, ?)')
    .run(BROWSER_KIND, label, JSON.stringify(browser ? { browser } : {}), hashToken(token), Date.now()).lastInsertRowid);

  return { source: { id, kind: BROWSER_KIND, account: label, cloudAllowed: true }, token };
};

// A new token for a paired browser, its old one no longer taken; undefined when the source isn't a browser
export const renewBrowserToken = (db: Db, sourceId: number): string | undefined => {
  const token = newToken();

  return db.prepare('update sources set token_hash = ? where id = ? and kind = ?').run(hashToken(token), sourceId, BROWSER_KIND).changes
    ? token
    : undefined;
};

// A paired browser's label and browser; false when the source isn't a browser
export const updateBrowser = (db: Db, sourceId: number, label: string, browser: BrowserKind) => {
  const row = db.prepare('select config from sources where id = ? and kind = ?').get(sourceId, BROWSER_KIND) as { config: string } | undefined;

  return Boolean(row) && db.prepare('update sources set account = ?, config = ? where id = ?')
    .run(label, JSON.stringify({ ...JSON.parse(row!.config) as object, browser }), sourceId).changes > 0;
};

export const findBrowserByToken = (db: Db, token: string): Source | undefined => {
  const row = db.prepare('select id, kind, account, cloud_allowed as cloudAllowed from sources where kind = ? and token_hash = ? and enabled = 1')
    .get(BROWSER_KIND, hashToken(token)) as (Omit<Source, 'cloudAllowed'> & { cloudAllowed: number }) | undefined;

  return row && { ...row, cloudAllowed: Boolean(row.cloudAllowed) };
};
