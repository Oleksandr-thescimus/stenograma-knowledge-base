import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSyncRunner, type SyncRunner } from '../../core/connectors/runner.ts';
import { createRocketChatConnector } from '../../core/rocketchat/connector.ts';
import { createRealtime, realtimeUrl, roomChangeOf, type Realtime } from '../../core/rocketchat/realtime.ts';
import { createRocketChatSource } from '../../core/rocketchat/sync.ts';
import { createTestDb, type Db } from './helpers.ts';
import { createFakeRocketChat, SERVER, TOKEN, USER, type FakeRocketChat } from './rocketchat-fake.ts';

// Rocket.Chat's realtime API (DDP) as a fake server's sockets: it logs in with the token as a resume token, takes the
// subscriptions, answers pings unless told not to, and sends the user's stream's changes
const createFakeDdp = () => {
  const sockets: FakeSocket[] = [];
  let answersPings = true;
  let token = TOKEN;

  class FakeSocket {
    url: string;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    subs: string[] = [];

    constructor(url: string) {
      this.url = url;
      sockets.push(this);
      setTimeout(() => this.onopen?.(), 0);
    }

    receive(message: object) {
      setTimeout(() => !this.closed && this.onmessage?.({ data: JSON.stringify(message) }), 0);
    }

    send(data: string) {
      const message = JSON.parse(data) as { msg: string, id?: string, method?: string, params?: unknown[] };

      if (message.msg === 'connect') {
        this.receive({ msg: 'connected', session: 's' });
      } else if (message.msg === 'method' && message.method === 'login') {
        const [{ resume }] = message.params as { resume: string }[];
        this.receive(resume === token
          ? { msg: 'result', id: message.id, result: { id: USER._id, token: resume } }
          : { msg: 'result', id: message.id, error: { error: 403, reason: 'You\'ve been logged out by the server.' } });
      } else if (message.msg === 'sub') {
        this.subs.push(String(message.params?.[0]));
      } else if (message.msg === 'ping' && answersPings) {
        this.receive({ msg: 'pong' });
      }
    }

    close() {
      this.closed = true;
    }

    // The server cuts it
    cut() {
      this.closed = true;
      this.onclose?.();
    }
  }

  const open = () => sockets.filter((socket) => !socket.closed);

  return {
    WebSocket: FakeSocket as unknown as typeof WebSocket,
    sockets,
    open,
    setToken: (value: string) => {
      token = value;
    },
    stopAnswering: () => {
      answersPings = false;
    },
    change: (event: string, record: object) => open().forEach((socket) => socket.receive({
      msg: 'changed', collection: 'stream-notify-user', id: 'id', fields: { eventName: `${USER._id}/${event}`, args: ['updated', record] },
    })),
  };
};

describe('Rocket.Chat\'s realtime API', () => {
  let realtime: Realtime | null = null;

  afterEach(() => realtime?.stop());

  it('is at the server\'s /websocket, a subdirectory kept', () => {
    expect(realtimeUrl('https://chat.example.com/')).toBe('wss://chat.example.com/websocket');
    expect(realtimeUrl('http://10.0.0.5:3000/chat')).toBe('ws://10.0.0.5:3000/chat/websocket');
  });

  it('tells a room\'s last message and the user\'s reading from the changes, as EJSON dates or strings', () => {
    expect(roomChangeOf('u/rooms-changed', { _id: 'r1', lm: { $date: 1000 }, lastMessage: { msg: 'private' } })).toEqual({ roomId: 'r1', lastMessage: 1000 });
    expect(roomChangeOf('u/subscriptions-changed', { rid: 'r2', ls: '2026-11-10T11:00:00.000Z' })).toEqual({ roomId: 'r2', readAt: Date.parse('2026-11-10T11:00:00Z') });
    expect(roomChangeOf('u/subscriptions-changed', { rid: 'r3' })).toEqual({ roomId: 'r3' });
    expect(roomChangeOf('u/notification', { rid: 'r4' })).toBeNull();
  });

  it('logs in with the token, takes the user\'s rooms\' changes and tells them together, a room once', async () => {
    const ddp = createFakeDdp();
    const onRooms = vi.fn();
    const onState = vi.fn();
    realtime = createRealtime({
      serverUrl: SERVER, userId: USER._id, getToken: () => TOKEN, onRooms, onReconnect: vi.fn(), onState, webSocket: ddp.WebSocket, gatherMs: 20,
    });

    await vi.waitFor(() => expect(realtime!.connected()).toBe(true));
    expect(ddp.sockets[0].url).toBe('wss://chat.example.com/websocket');
    expect(ddp.sockets[0].subs).toEqual([`${USER._id}/rooms-changed`, `${USER._id}/subscriptions-changed`]);
    expect(onState).toHaveBeenCalledWith(true);

    ddp.change('rooms-changed', { _id: 'dm', lm: { $date: 5000 } });
    ddp.change('subscriptions-changed', { rid: 'dm', ls: { $date: 4000 } });
    ddp.change('rooms-changed', { _id: 'general' });

    await vi.waitFor(() => expect(onRooms).toHaveBeenCalledTimes(1));
    expect(onRooms).toHaveBeenCalledWith([{ roomId: 'dm', lastMessage: 5000, readAt: 4000 }, { roomId: 'general' }]);
  });

  it('connects again after it was cut or its pings went unanswered, and says so; a refused token isn\'t connected', async () => {
    const ddp = createFakeDdp();
    const onReconnect = vi.fn();
    let token = 'old';
    ddp.setToken('new');
    realtime = createRealtime({
      serverUrl: SERVER, userId: USER._id, getToken: () => token, onRooms: vi.fn(), onReconnect, webSocket: ddp.WebSocket, firstRetryMs: 10, pingMs: 30,
    });

    // Refused: tried again later, with the token given meanwhile
    await vi.waitFor(() => expect(ddp.sockets.length).toBeGreaterThan(1));
    expect(realtime.connected()).toBe(false);
    token = 'new';
    await vi.waitFor(() => expect(realtime!.connected()).toBe(true), { timeout: 3000 });
    expect(onReconnect).not.toHaveBeenCalled();

    ddp.open()[0].cut();
    expect(realtime.connected()).toBe(false);
    await vi.waitFor(() => expect(onReconnect).toHaveBeenCalledTimes(1));

    const before = ddp.sockets.length;
    ddp.stopAnswering();
    await vi.waitFor(() => expect(ddp.sockets.length).toBeGreaterThan(before));
  });
});

describe('Rocket.Chat\'s new messages as they\'re sent', () => {
  let db: Db;
  let cleanup: () => void;
  let server: FakeRocketChat;
  let sourceId: number;
  let runner: SyncRunner;

  beforeEach(() => {
    ({ db, cleanup } = createTestDb());
    server = createFakeRocketChat({ start: Date.now() - 60_000 });
    server.addRoom('general', 'c', 'general');
    server.addRoom('dm', 'd', 'andrii', 'Andrii Melnyk');
    server.post('dm', 'm1', 'Привіт');
    sourceId = createRocketChatSource(db, 'olena@chat.example.com', {
      serverUrl: SERVER, userId: USER._id, username: USER.username, selection: { mode: 'all', types: ['channel', 'group', 'direct'] }, since: 0,
    });
  });

  const messageIds = (roomId: string) => (db.prepare('select message_id as id from chat_messages where source_id = ? and room_id = ? order by ts')
    .all(sourceId, roomId) as { id: string }[]).map((row) => row.id);

  afterEach(async () => {
    await runner.stop();
    cleanup();
  });

  it('reads only the room that changed, at once, syncs whole for a room not kept yet, and is synced whole rarely while live', async () => {
    const ddp = createFakeDdp();
    const afterSync = vi.fn();
    runner = createSyncRunner({
      db,
      connectors: [createRocketChatConnector({
        db, getToken: () => TOKEN, embedModel: () => null, fetch: server.fetch, webSocket: ddp.WebSocket, afterSync, realtime: { gatherMs: 10 },
      })],
      onStatus: () => undefined,
      onChange: () => undefined,
    });
    runner.start();

    await vi.waitFor(() => expect(runner.info(sourceId)).toMatchObject({ running: false, live: true }));
    await vi.waitFor(() => expect(afterSync).toHaveBeenCalledTimes(1));
    // The whole sync every half an hour while live, not every 5 minutes
    expect(runner.info(sourceId)!.nextAt! - Date.now()).toBeGreaterThan(25 * 60_000);
    server.calls.length = 0;

    const message = server.post('dm', 'm2', 'Глянеш PR?');
    ddp.change('rooms-changed', { _id: 'dm', lm: { $date: Date.parse(message.ts) } });

    await vi.waitFor(() => expect(afterSync).toHaveBeenCalledTimes(2));
    expect(messageIds('dm')).toEqual(['m1', 'm2']);
    // No listing of the rooms: the room's messages only
    expect(server.calls.filter((call) => call !== 'chat.syncMessages')).toEqual([]);

    // A room not kept yet: the whole sync lists it
    server.addRoom('new', 'd', 'maria', 'Maria');
    server.post('new', 'm3', 'Hi');
    ddp.change('subscriptions-changed', { rid: 'new' });
    await vi.waitFor(() => expect(server.calls).toContain('subscriptions.get'));
    await vi.waitFor(() => expect(messageIds('new')).toEqual(['m3']));
  });
});
