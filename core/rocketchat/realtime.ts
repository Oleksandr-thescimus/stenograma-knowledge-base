import type { RoomChange } from '../chat/types.ts';
import { normalizeServerUrl } from './api.ts';

// Rocket.Chat's realtime API (DDP over a WebSocket, as its web client uses), so a new message reaches the knowledge
// base and its reply draft in seconds instead of at the next sync: logged in with the same token (a Personal Access
// Token is a resume token too), it tells which rooms changed (the user's stream-notify-user: rooms-changed when a
// room's last message changes, subscriptions-changed when its unread count or the user's reading does, thread replies
// too). Pinged every half a minute, so a laptop's sleep or a dropped network is found, and connected again after a
// while, twice as late each time up to five minutes. What arrives is never logged: a room's change carries its last
// message

export interface RealtimeOptions {
  serverUrl: string;
  userId: string;
  // Read at each connection, so a new one is used once given
  getToken: () => string | undefined;
  onRooms: (changes: RoomChange[]) => void;
  // Connected again after it was cut: what was missed is read by a sync
  onReconnect: () => void;
  // Connected, or no longer
  onState?: (connected: boolean) => void;
  webSocket?: typeof WebSocket;
  log?: (line: string) => void;
  // Tests make them short
  pingMs?: number;
  firstRetryMs?: number;
  gatherMs?: number;
}

const PING_MS = 30_000;
const FIRST_RETRY_MS = 5000;
const MAX_RETRY_MS = 5 * 60_000;
// Changes a moment apart are told together
const GATHER_MS = 1500;

// https://chat.example.com/sub → wss://chat.example.com/sub/websocket
export const realtimeUrl = (serverUrl: string) => `${normalizeServerUrl(serverUrl).replace(/^http/, 'ws')}/websocket`;

// DDP's EJSON date ({ $date: ms }), or an ISO string
const timeOf = (value: unknown) => {
  if (typeof value === 'string') {
    const ms = Date.parse(value);

    return Number.isNaN(ms) ? undefined : ms;
  }

  const ms = (value as { $date?: unknown } | null)?.$date;

  return typeof ms === 'number' ? ms : undefined;
};

// A rooms-changed or subscriptions-changed event's room, with what it tells of it
export const roomChangeOf = (eventName: string, record: unknown): RoomChange | null => {
  const fields = record as { _id?: unknown, rid?: unknown, lm?: unknown, ls?: unknown } | null;

  if (eventName.endsWith('/rooms-changed') && typeof fields?._id === 'string') {
    const lastMessage = timeOf(fields.lm);

    return { roomId: fields._id, ...(lastMessage !== undefined && { lastMessage }) };
  }

  if (eventName.endsWith('/subscriptions-changed') && typeof fields?.rid === 'string') {
    const readAt = timeOf(fields.ls);

    return { roomId: fields.rid, ...(readAt !== undefined && { readAt }) };
  }

  return null;
};

export const createRealtime = ({
  serverUrl, userId, getToken, onRooms, onReconnect, onState = () => undefined, webSocket = globalThis.WebSocket, log = () => undefined,
  pingMs = PING_MS, firstRetryMs = FIRST_RETRY_MS, gatherMs = GATHER_MS,
}: RealtimeOptions) => {
  let socket: WebSocket | null = null;
  let stopped = false;
  let connected = false;
  // Connected once: a later connection is a reconnection
  let wasConnected = false;
  let failures = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let gatherTimer: ReturnType<typeof setTimeout> | null = null;
  let answered = true;
  let ids = 0;
  const gathered = new Map<string, RoomChange>();

  const setConnected = (value: boolean) => {
    if (connected !== value) {
      connected = value;
      onState(value);
    }
  };

  const send = (message: object) => socket?.send(JSON.stringify(message));

  const flush = () => {
    gatherTimer = null;
    const changes = [...gathered.values()];
    gathered.clear();

    if (changes.length) {
      onRooms(changes);
    }
  };

  const gather = (change: RoomChange) => {
    gathered.set(change.roomId, { ...gathered.get(change.roomId), ...change });
    gatherTimer ??= setTimeout(flush, gatherMs);
  };

  const cleanUp = () => {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }

    if (socket) {
      const old = socket;
      socket = null;
      old.onopen = null;
      old.onmessage = null;
      old.onclose = null;
      old.onerror = null;

      try {
        old.close();
      } catch {
        // Closed already
      }
    }

    setConnected(false);
  };

  const scheduleRetry = () => {
    if (stopped || retryTimer) {
      return;
    }

    const delay = Math.min(firstRetryMs * (2 ** failures), MAX_RETRY_MS);
    failures += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
  };

  const drop = (why: string) => {
    log(`realtime: ${why}`);
    cleanUp();
    scheduleRetry();
  };

  function connect() {
    const token = getToken();

    if (stopped) {
      return;
    }

    if (!token) {
      drop('no token in the keyring');

      return;
    }

    let opened: WebSocket;

    try {
      opened = new webSocket(realtimeUrl(serverUrl));
    } catch {
      drop('can\'t connect');

      return;
    }

    socket = opened;
    const loginId = `login-${(ids += 1)}`;
    answered = true;

    opened.onopen = () => send({ msg: 'connect', version: '1', support: ['1'] });
    opened.onerror = () => undefined;
    opened.onclose = () => drop('connection closed');
    opened.onmessage = (event: MessageEvent) => {
      let message: { msg?: string, id?: string, error?: { error?: unknown }, collection?: string, fields?: { eventName?: string, args?: unknown[] } };

      try {
        message = JSON.parse(String(event.data)) as typeof message;
      } catch {
        return;
      }

      answered = true;

      if (message.msg === 'ping') {
        send({ msg: 'pong' });
      } else if (message.msg === 'connected') {
        send({ msg: 'method', method: 'login', id: loginId, params: [{ resume: token }] });
      } else if (message.msg === 'result' && message.id === loginId) {
        if (message.error) {
          // The token refused: the sync tells it, and it's tried again later, perhaps with a new one
          drop(`login refused (${String(message.error.error ?? '?')})`);

          return;
        }

        for (const event of ['rooms-changed', 'subscriptions-changed']) {
          send({ msg: 'sub', id: `sub-${(ids += 1)}`, name: 'stream-notify-user', params: [`${userId}/${event}`, false] });
        }

        failures = 0;
        setConnected(true);
        log('realtime: connected');

        if (wasConnected) {
          onReconnect();
        }

        wasConnected = true;
        pingTimer = setInterval(() => {
          // Not a word since the last ping: the connection is gone (asleep, or the network dropped)
          if (!answered) {
            drop('no answer to a ping');

            return;
          }

          answered = false;
          send({ msg: 'ping' });
        }, pingMs);
      } else if (message.msg === 'changed' && message.collection === 'stream-notify-user') {
        const [, record] = message.fields?.args ?? [];
        const change = roomChangeOf(message.fields?.eventName ?? '', record);

        if (change) {
          gather(change);
        }
      }
    };
  }

  connect();

  return {
    connected: () => connected,
    stop: () => {
      stopped = true;

      if (retryTimer) {
        clearTimeout(retryTimer);
      }

      if (gatherTimer) {
        clearTimeout(gatherTimer);
      }

      cleanUp();
    },
  };
};

export type Realtime = ReturnType<typeof createRealtime>;
