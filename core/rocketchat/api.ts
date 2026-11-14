// Rocket.Chat's REST API, read only, with a Personal Access Token (docs/PLAN.md, Connectors). Its default rate limit
// is 10 calls a minute per endpoint and client IP (from 7.9), told in X-RateLimit-* headers, with no Retry-After on a
// 429: so a call waits when its endpoint has none left, and a 429 is tried again after the reset. Errors carry the
// status and Rocket.Chat's error code, never what was asked for

export interface RocketChatUser {
  _id: string;
  username: string;
  name?: string;
}

export interface RcSubscription {
  _id: string;
  rid: string;
  name: string;
  fname?: string;
  t: string;
  prid?: string;
  archived?: boolean;
}

export interface RcRoom {
  _id: string;
  t: string;
  lm?: string;
  usersCount?: number;
  _updatedAt?: string;
}

export interface RcAttachment {
  message_link?: string;
  author_name?: string;
  text?: string;
  type?: string;
  title?: string;
  description?: string;
}

export interface RcFile {
  _id: string;
  name: string;
  type?: string;
  size?: number;
  // thumb for an image's thumbnail
  typeGroup?: string;
}

export interface RcMessage {
  _id: string;
  rid: string;
  msg?: string;
  ts: string;
  _updatedAt: string;
  u: { _id: string, username: string, name?: string };
  t?: string;
  tmid?: string;
  tcount?: number;
  // By shortcode, e.g. ":+1:"
  reactions?: Record<string, { usernames: string[] }>;
  editedAt?: string;
  _hidden?: boolean;
  attachments?: RcAttachment[];
  files?: RcFile[];
  file?: RcFile;
}

export interface RcMember {
  _id: string;
  username: string;
  name?: string;
}

export interface SyncPage {
  updated: RcMessage[];
  deleted: { _id: string, _deletedAt: string }[];
  // Null on the last page; missing from a server before 7.1, which has no pages
  cursor?: { next: string | null, previous: string | null };
}

export class RocketChatError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class FileTooLargeError extends Error {}

export interface ApiOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  // Calls of each endpoint a minute, at most, besides the server's own limit
  requestsPerMinute?: number;
  // Tests don't wait out a rate limit
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

const TIMEOUT_MS = 60_000;
const MAX_RATE_LIMITED = 5;
// When a 429 doesn't say when its limit resets
const DEFAULT_RESET_MS = 60_000;

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => {
    clearTimeout(timer);
    reject(signal.reason);
  }, { once: true });
});

// The server's address as typed, without a trailing slash; a path is kept for a server in a subdirectory
export const normalizeServerUrl = (url: string) => {
  const parsed = new URL(url.trim());

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('The server\'s address starts with https://');
  }

  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
};

export const createRocketChatApi = (
  access: { serverUrl: string, userId: string, token: string },
  { fetch: fetchImpl = globalThis.fetch, signal, wait = sleep, now = Date.now, requestsPerMinute }: ApiOptions = {},
) => {
  const base = `${normalizeServerUrl(access.serverUrl)}/api/v1/`;
  // An endpoint with no calls left, until its limit resets
  const resets = new Map<string, number>();
  // The calls of each endpoint in the last minute, for our own limit
  const recent = new Map<string, number[]>();

  const keepOwnLimit = async (endpoint: string) => {
    if (!requestsPerMinute) {
      return;
    }

    const calls = (recent.get(endpoint) ?? []).filter((at) => at > now() - 60_000);

    if (calls.length >= requestsPerMinute) {
      await wait(calls[calls.length - requestsPerMinute] + 60_000 - now(), signal);
    }

    recent.set(endpoint, [...calls, now()].slice(-requestsPerMinute));
  };

  const get = async <T>(endpoint: string, params: Record<string, string | number | undefined> = {}): Promise<T> => {
    const url = new URL(endpoint, base);
    Object.entries(params).forEach(([key, value]) => value !== undefined && url.searchParams.set(key, String(value)));

    for (let limited = 0; ; limited++) {
      const resetAt = resets.get(endpoint);

      if (resetAt !== undefined && resetAt > now()) {
        // eslint-disable-next-line no-await-in-loop
        await wait(resetAt - now() + 100, signal);
      }

      // eslint-disable-next-line no-await-in-loop
      await keepOwnLimit(endpoint);

      let response: Response;

      try {
        // eslint-disable-next-line no-await-in-loop
        response = await fetchImpl(url, {
          headers: { 'X-User-Id': access.userId, 'X-Auth-Token': access.token, Accept: 'application/json' },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        signal?.throwIfAborted();
        throw new RocketChatError(`Rocket.Chat didn't answer (${(error as Error).name === 'TimeoutError' ? 'timed out' : 'no connection'})`, 0);
      }

      const reset = Number(response.headers.get('x-ratelimit-reset'));
      const remaining = response.headers.get('x-ratelimit-remaining');

      if (response.status === 429 || remaining === '0') {
        resets.set(endpoint, reset > now() ? reset : now() + DEFAULT_RESET_MS);
      } else {
        resets.delete(endpoint);
      }

      if (response.status === 429 && limited < MAX_RATE_LIMITED) {
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const body = await response.json().catch(() => null) as { success?: boolean, error?: string, errorType?: string } | null;

      if (response.status === 401) {
        throw new RocketChatError('Rocket.Chat refused the token: make a new one (My Account → Personal Access Tokens)', 401);
      }

      if (!response.ok || body?.success === false) {
        const code = body?.errorType ?? (typeof body?.error === 'string' && /^[\w-]+$/.test(body.error) ? body.error : undefined);
        throw new RocketChatError(`Rocket.Chat answered ${response.status}${code ? ` (${code})` : ''} to ${endpoint}`, response.status, code);
      }

      return body as T;
    }
  };

  // A room's members, a call per 100
  const members = async (roomId: string, type: 'channel' | 'group' | 'direct') => {
    const endpoint = { channel: 'channels.members', group: 'groups.members', direct: 'im.members' }[type];
    const found: RcMember[] = [];

    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const page = await get<{ members: RcMember[], total: number }>(endpoint, { roomId, count: 100, offset: found.length });
      found.push(...page.members);

      if (!page.members.length || found.length >= page.total) {
        return found;
      }
    }
  };

  // A message's file (its path from the server's address), with the token both as headers and as the cookies the web
  // client sends, as servers check one or the other. A file over the limit isn't read whole
  const download = async (path: string, maxBytes: number) => {
    let response: Response;

    try {
      response = await fetchImpl(`${normalizeServerUrl(access.serverUrl)}${path}`, {
        headers: { 'X-User-Id': access.userId, 'X-Auth-Token': access.token, Cookie: `rc_uid=${access.userId}; rc_token=${access.token}` },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      signal?.throwIfAborted();
      throw new RocketChatError(`Rocket.Chat didn't answer (${(error as Error).name === 'TimeoutError' ? 'timed out' : 'no connection'})`, 0);
    }

    if (!response.ok) {
      await response.body?.cancel();
      throw new RocketChatError(`Rocket.Chat answered ${response.status} to a file`, response.status);
    }

    if (Number(response.headers.get('content-length')) > maxBytes) {
      await response.body?.cancel();
      throw new FileTooLargeError(`Larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());

    if (bytes.length > maxBytes) {
      throw new FileTooLargeError(`Larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
    }

    return { bytes, type: response.headers.get('content-type')?.split(';')[0] ?? null };
  };

  return {
    me: () => get<RocketChatUser>('me'),
    members,
    download,
    subscriptions: async () => (await get<{ update: RcSubscription[] }>('subscriptions.get')).update,
    rooms: async () => (await get<{ update: RcRoom[] }>('rooms.get')).update,
    // From 7.1: a page of messages updated, or deleted, after the cursor (milliseconds)
    syncPage: async (roomId: string, type: 'UPDATED' | 'DELETED', next: number, count: number) => (await get<{ result: SyncPage }>(
      'chat.syncMessages', { roomId, type, next, count },
    )).result,
    // Before 7.1: everything updated and deleted since then, at once
    syncSince: async (roomId: string, lastUpdate: number) => (await get<{ result: SyncPage }>(
      'chat.syncMessages', { roomId, lastUpdate: new Date(lastUpdate).toISOString() },
    )).result,
  };
};

export type RocketChatApi = ReturnType<typeof createRocketChatApi>;
