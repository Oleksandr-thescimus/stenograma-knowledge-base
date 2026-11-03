import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBrowserSource } from '../../core/browsers.ts';
import { getKbId } from '../../core/db.ts';
import { buildServer, stenogramaOpenUrl } from '../../core/server.ts';
import { meetingDocumentId } from '../../core/stenograma/ingest.ts';
import { API_VERSION } from '../../core/stenograma/types.ts';
import { bundle, createTestDb, message, type Db } from './helpers.ts';

const PORT = 47321;
const HOST = `127.0.0.1:${PORT}`;
// The extension's contract fixture: a push built from its fixture rows (docs/PLAN.md, Repositories)
const FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/kb-ingest.json', import.meta.url), 'utf8'));

describe('the API for the extension (N2)', () => {
  let db: Db;
  let cleanup: () => void;
  let server: ReturnType<typeof buildServer>;
  let chrome: { id: number, token: string };
  let firefox: { id: number, token: string };

  beforeEach(() => {
    ({ db, cleanup } = createTestDb());
    const paired = [createBrowserSource(db, 'Chrome'), createBrowserSource(db, 'Firefox')];
    [chrome, firefox] = paired.map(({ source, token }) => ({ id: source.id, token }));
    server = buildServer({ db, port: PORT, embedModel: () => null });
  });

  afterEach(async () => {
    await server.close();
    cleanup();
  });

  const call = (method: 'GET' | 'POST', url: string, options: { token?: string, host?: string, origin?: string, body?: unknown } = {}) => server.inject({
    method,
    url,
    headers: {
      host: options.host ?? HOST,
      ...(options.token && { authorization: `Bearer ${options.token}` }),
      ...(options.origin && { origin: options.origin }),
    },
    ...(options.body !== undefined && { payload: options.body as object }),
  });

  const documentsOf = (sourceId: number) => (db.prepare('select id, kind from documents where source_id = ? order by id').all(sourceId) as
    { id: string, kind: string }[]);

  it('gives 401 without a token or with an unknown one', async () => {
    expect((await call('GET', '/status')).statusCode).toBe(401);
    expect((await call('GET', '/status', { token: 'skb_unknown' })).statusCode).toBe(401);
  });

  it('gives 403 to another Host, against DNS rebinding', async () => {
    expect((await call('GET', '/status', { token: chrome.token, host: `evil.example:${PORT}` })).statusCode).toBe(403);
    expect((await call('GET', '/status', { token: chrome.token, host: '127.0.0.1:8080' })).statusCode).toBe(403);
    expect((await call('GET', '/status', { token: chrome.token, host: `localhost:${PORT}` })).statusCode).toBe(200);
  });

  it('gives 403 to a web page\'s Origin, and lets the extension in without CORS headers', async () => {
    for (const origin of ['https://evil.example', 'http://127.0.0.1:3000', 'null']) {
      // eslint-disable-next-line no-await-in-loop
      expect((await call('GET', '/status', { token: chrome.token, origin })).statusCode).toBe(403);
    }

    const fromExtension = await call('GET', '/status', { token: chrome.token, origin: 'chrome-extension://abcdefghijklmnop' });

    expect(fromExtension.statusCode).toBe(200);
    expect(fromExtension.headers['access-control-allow-origin']).toBeUndefined();
    expect((await call('GET', '/status', { token: firefox.token, origin: 'moz-extension://0b5d-4f3c' })).statusCode).toBe(200);
  });

  it('tells the knowledge base\'s id, the API version and the browser\'s source', async () => {
    expect((await call('GET', '/status', { token: firefox.token })).json()).toEqual({
      kbId: getKbId(db), apiVersion: API_VERSION, source: { id: firefox.id, label: 'Firefox' },
    });
  });

  it('ingests the extension\'s contract fixture by the rules of F1', async () => {
    const response = await call('POST', '/ingest', { token: chrome.token, body: FIXTURE });
    const meeting = meetingDocumentId(chrome.id, '2026/10/20 10:00:00 -> /abc-defg-hij');
    const recording = meetingDocumentId(chrome.id, '2026/10/21 14:00:00 -> recording');

    expect(response.json()).toEqual({ accepted: 2 });
    // The answer to a question isn't indexed; the recording has no summary or action items
    expect(documentsOf(chrome.id)).toEqual([
      { id: meeting, kind: 'meeting' }, { id: `${meeting}:actions`, kind: 'meeting-actions' },
      { id: `${meeting}:summary`, kind: 'meeting-summary' }, { id: recording, kind: 'meeting' },
    ]);
    // The recording's latest done version, not its own text
    expect(db.prepare('select text from chunks where document_id = ?').get(recording)).toEqual({
      text: 'You: Коли буде поставка серверів?\nOthers: Поставка наступного тижня, у вівторок.',
    });
    expect(documentsOf(firefox.id)).toEqual([]);
  });

  it('refuses another API version and malformed bundles', async () => {
    expect((await call('POST', '/ingest', { token: chrome.token, body: { ...FIXTURE, apiVersion: API_VERSION + 1 } })).statusCode).toBe(409);
    expect((await call('POST', '/ingest', { token: chrome.token, body: { apiVersion: API_VERSION, bundles: [{ session: {} }] } })).statusCode).toBe(400);
  });

  it('lets a reconcile touch only its own browser\'s documents', async () => {
    await call('POST', '/ingest', { token: chrome.token, body: { apiVersion: API_VERSION, bundles: [bundle('chrome-session', [message('A', 'Привіт')])] } });
    await call('POST', '/ingest', { token: firefox.token, body: { apiVersion: API_VERSION, bundles: [bundle('firefox-session', [message('B', 'Привіт')])] } });

    const response = await call('POST', '/ingest/reconcile', { token: chrome.token, body: { apiVersion: API_VERSION, sessionIds: [] } });

    expect(response.json()).toEqual({ removed: 1 });
    expect(documentsOf(chrome.id)).toEqual([]);
    expect(documentsOf(firefox.id)).toHaveLength(1);
  });

  it('serves /stenograma-open without a token, as a page holding no data', async () => {
    const url = stenogramaOpenUrl(PORT, chrome.id, '2026/10/20 10:00:00 -> /abc-defg-hij', 15_000);
    const response = await call('GET', url.replace(`http://${HOST}`, ''));

    expect(url).toBe(`http://${HOST}/stenograma-open?source=${chrome.id}&session=2026%2F10%2F20+10%3A00%3A00+-%3E+%2Fabc-defg-hij&t=15000`);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['content-security-policy']).toBe('default-src \'none\'');
    expect(response.body).not.toContain('abc-defg-hij');
  });
});
