import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { findBrowserByToken } from './browsers.ts';
import { getKbId, type Db } from './db.ts';
import { markSynced, type Source } from './sources.ts';
import { ingestBundles, reconcileSessions } from './stenograma/ingest.ts';
import { API_VERSION, type SessionBundle } from './stenograma/types.ts';

// The HTTP API for the extension (docs/PLAN.md, API for the extension; N2). The app's own UI talks over IPC instead.
// - Listens on 127.0.0.1 only, on the port of the settings.
// - Each paired browser has its own bearer token, and its pushes and reconciles touch its own source only.
// - The Host header must be this server's, against DNS rebinding.
// - No CORS headers: the extension's background sends with a host permission, which CORS doesn't apply to. A request
//   with a web page's Origin (http:, https:, or null from a sandboxed page) is refused.
// - /stenograma-open takes no token, and its page holds no data.

// The extension sends batches of up to ~2 MB (step 3 of Sending)
const BODY_LIMIT = 8 * 1024 * 1024;

export interface ServerOptions {
  db: Db;
  port: number;
  // The model new chunks are queued for; it changes when a rebuilt model takes over (F7)
  embedModel: () => string | null;
  // After a push or a reconcile, e.g. to embed the new chunks
  onChange?: () => void;
  // Ids and counts only
  log?: (line: string) => void;
}

declare module 'fastify' {
  interface FastifyRequest {
    browser?: Source;
  }
}

const SESSION_BUNDLE = {
  type: 'object',
  required: ['session', 'transcripts', 'assistantAnswers', 'actionItems'],
  properties: {
    session: {
      type: 'object',
      required: ['sessionId', 'stenogramaArray'],
      properties: { sessionId: { type: 'string', minLength: 1 }, stenogramaArray: { type: 'array' } },
    },
    transcripts: { type: 'array' },
    assistantAnswers: { type: 'array' },
    actionItems: { type: 'array' },
  },
} as const;

// No data in it: the extension's content script for this path reads the URL, checks the source is its browser's and
// opens the meeting on its history page (docs/PLAN.md, The app)
const OPEN_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Stenograma</title></head>
<body><p>Opening the meeting in Stenograma…</p>
<p>When nothing happens, this browser's Stenograma isn't the one the meeting came from, or it isn't paired.</p></body></html>
`;

const refuse = (reply: FastifyReply, status: number, error: string) => reply.code(status).send({ error });

export const buildServer = ({ db, port, embedModel, onChange, log = () => undefined }: ServerOptions) => {
  const server = Fastify({ logger: false, bodyLimit: BODY_LIMIT });
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  server.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!hosts.has(request.headers.host ?? '')) {
      return refuse(reply, 403, 'Host not allowed');
    }

    const { origin } = request.headers;

    if (origin && !/^(chrome|moz)-extension:\/\//.test(origin)) {
      return refuse(reply, 403, 'Only the extension may call this API');
    }

    if (request.url.startsWith('/stenograma-open')) {
      return undefined;
    }

    const token = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1];
    const browser = token ? findBrowserByToken(db, token) : undefined;

    if (!browser) {
      return refuse(reply, 401, 'Unknown token: add this browser in the app\'s Sources (or with yarn kb add-browser)');
    }

    request.browser = browser;

    return undefined;
  });

  server.get('/status', async (request) => ({
    kbId: getKbId(db),
    apiVersion: API_VERSION,
    source: { id: request.browser!.id, label: request.browser!.account },
  }));

  server.post<{ Body: { apiVersion: number, bundles: SessionBundle[] } }>('/ingest', {
    schema: {
      body: {
        type: 'object',
        required: ['apiVersion', 'bundles'],
        properties: { apiVersion: { type: 'integer' }, bundles: { type: 'array', items: SESSION_BUNDLE } },
      },
    },
  }, async (request, reply) => {
    if (request.body.apiVersion !== API_VERSION) {
      return reply.code(409).send({ error: 'Unsupported apiVersion', apiVersion: API_VERSION });
    }

    const sourceId = request.browser!.id;
    ingestBundles(db, sourceId, request.body.bundles, embedModel());
    markSynced(db, sourceId);
    log(`ingest: source ${sourceId}, ${request.body.bundles.length} sessions`);
    onChange?.();

    return { accepted: request.body.bundles.length };
  });

  server.post<{ Body: { apiVersion: number, sessionIds: string[] } }>('/ingest/reconcile', {
    schema: {
      body: {
        type: 'object',
        required: ['apiVersion', 'sessionIds'],
        properties: { apiVersion: { type: 'integer' }, sessionIds: { type: 'array', items: { type: 'string' } } },
      },
    },
  }, async (request, reply) => {
    if (request.body.apiVersion !== API_VERSION) {
      return reply.code(409).send({ error: 'Unsupported apiVersion', apiVersion: API_VERSION });
    }

    const sourceId = request.browser!.id;
    const removed = reconcileSessions(db, sourceId, request.body.sessionIds);
    log(`reconcile: source ${sourceId}, ${request.body.sessionIds.length} sessions kept, ${removed} removed`);

    if (removed) {
      onChange?.();
    }

    return { removed };
  });

  server.get('/stenograma-open', async (_request, reply) => reply
    .header('content-security-policy', 'default-src \'none\'')
    .type('text/html; charset=utf-8')
    .send(OPEN_PAGE));

  return server;
};

// The link that opens a meeting of a browser source at a moment, through that browser's extension
export const stenogramaOpenUrl = (port: number, sourceId: number, sessionId: string, startMs?: number | null) => {
  const params = new URLSearchParams({ source: String(sourceId), session: sessionId });

  if (startMs !== null && startMs !== undefined) {
    params.set('t', String(startMs));
  }

  return `http://127.0.0.1:${port}/stenograma-open?${params}`;
};
