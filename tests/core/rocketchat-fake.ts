import type { RcMember, RcMessage, RcSubscription } from '../../core/rocketchat/api.ts';

// A Rocket.Chat server for the tests: the user, their rooms and messages, and chat.syncMessages in pages (from 7.1) or
// at once (before). Every write moves the server's clock a second on, as _updatedAt and _deletedAt

export const USER = { _id: 'u-olena', username: 'olena', name: 'Olena Koval' };
export const TOKEN = 'rc-token';
export const SERVER = 'https://chat.example.com';

// Midday, so a test's local day is the same in any time zone of Europe
const START = Date.parse('2026-11-10T11:00:00Z');

interface Deleted {
  _id: string;
  rid: string;
  _deletedAt: string;
}

export const createFakeRocketChat = ({ legacy = false } = {}) => {
  let clock = START;
  const subscriptions: RcSubscription[] = [];
  const messages = new Map<string, RcMessage>();
  const deleted: Deleted[] = [];
  // Each room's members; the user and Andrii unless set
  const members = new Map<string, RcMember[]>();
  const ANDRII = { _id: 'u-andrii', username: 'andrii', name: 'Andrii Melnyk' };
  const calls: string[] = [];
  // Endpoints that answer 429 once
  const limited = new Set<string>();
  // Files under /file-upload/<id>/<name>
  const uploads = new Map<string, { bytes: Uint8Array, type: string }>();
  const tick = () => new Date(clock += 1000).toISOString();

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json', ...headers },
  });

  const lastMessageOf = (rid: string) => [...messages.values()].filter((message) => message.rid === rid)
    .reduce<string | undefined>((max, message) => (!max || message.ts > max ? message.ts : max), undefined);

  const page = <T>(items: T[], at: (item: T) => string, after: number, count: number) => {
    const sorted = items.filter((item) => Date.parse(at(item)) > after).sort((a, b) => Date.parse(at(a)) - Date.parse(at(b)));
    const taken = sorted.slice(0, count);

    return { taken, next: sorted.length > count ? String(Date.parse(at(taken.at(-1)!))) : null };
  };

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const endpoint = url.pathname.replace(/^.*\/api\/v1\//, '');
    const query = Object.fromEntries(url.searchParams);
    calls.push(endpoint);

    // Files check the cookies the web client sends
    if (url.pathname.startsWith('/file-upload/')) {
      const upload = uploads.get(decodeURIComponent(url.pathname.split('/')[2]));

      if (headers.get('Cookie') !== `rc_uid=${USER._id}; rc_token=${TOKEN}`) {
        return new Response('Forbidden', { status: 403 });
      }

      return upload
        ? new Response(upload.bytes, { headers: { 'content-type': upload.type, 'content-length': String(upload.bytes.length) } })
        : new Response('Not found', { status: 404 });
    }

    if (headers.get('X-User-Id') !== USER._id || headers.get('X-Auth-Token') !== TOKEN) {
      return json({ status: 'error', message: 'You must be logged in to do this.' }, 401);
    }

    if (limited.delete(endpoint)) {
      return json({ success: false, error: 'Error, too many requests.' }, 429, { 'x-ratelimit-reset': String(Date.now() + 10), 'x-ratelimit-remaining': '0' });
    }

    switch (endpoint) {
      case 'me':
        return json({ ...USER, success: true });
      case 'subscriptions.get':
        return json({ update: subscriptions, remove: [], success: true });
      case 'rooms.get':
        return json({
          update: subscriptions.map((subscription) => ({
            _id: subscription.rid, t: subscription.t, lm: lastMessageOf(subscription.rid), usersCount: (members.get(subscription.rid) ?? [USER, ANDRII]).length,
          })),
          remove: [],
          success: true,
        });
      case 'channels.members':
      case 'groups.members':
      case 'im.members': {
        const all = members.get(query.roomId) ?? [USER, ANDRII];
        const offset = Number(query.offset ?? 0);

        return json({ members: all.slice(offset, offset + Number(query.count ?? 50)), offset, total: all.length, success: true });
      }
      case 'chat.syncMessages': {
        const inRoom = [...messages.values()].filter((message) => message.rid === query.roomId);
        const deletedInRoom = deleted.filter((message) => message.rid === query.roomId);

        if (query.type) {
          if (legacy) {
            return json({ success: false, error: 'The required "lastUpdate" query param is missing.' }, 400);
          }

          const count = Number(query.count);
          const result = query.type === 'UPDATED'
            ? (({ taken, next }) => ({ updated: taken, deleted: [], cursor: { next, previous: null } }))(page(inRoom, (message) => message._updatedAt, Number(query.next), count))
            : (({ taken, next }) => ({ updated: [], deleted: taken.map(({ _id, _deletedAt }) => ({ _id, _deletedAt })), cursor: { next, previous: null } }))(
              page(deletedInRoom, (message) => message._deletedAt, Number(query.next), count),
            );

          return json({ result, success: true });
        }

        const since = Date.parse(query.lastUpdate);

        return json({
          result: {
            updated: inRoom.filter((message) => Date.parse(message._updatedAt) > since),
            deleted: deletedInRoom.filter((message) => Date.parse(message._deletedAt) > since).map(({ _id, _deletedAt }) => ({ _id, _deletedAt })),
          },
          success: true,
        });
      }
      default:
        return json({ success: false, error: 'error-not-found' }, 404);
    }
  };

  return {
    fetch,
    calls,
    limited,
    now: () => clock,
    // Moves the clock, as time passes between syncs
    wait: (ms: number) => {
      clock += ms;
    },
    addRoom: (rid: string, t: 'c' | 'p' | 'd' | 'l', name: string, fname?: string) => {
      subscriptions.push({ _id: `s-${rid}`, rid, t, name, ...(fname && { fname }) });
    },
    renameRoom: (rid: string, fname: string) => {
      subscriptions.find((subscription) => subscription.rid === rid)!.fname = fname;
    },
    // A message with a file, and its thumbnail as the server keeps an image's
    upload: (rid: string, id: string, msg: string, file: { id: string, name: string, type: string, bytes: Uint8Array }) => {
      uploads.set(file.id, { bytes: file.bytes, type: file.type });
      const at = tick();
      const message: RcMessage = {
        _id: id, rid, msg, ts: at, _updatedAt: at, u: { _id: 'u', username: 'andrii', name: 'Andrii Melnyk' },
        files: [
          { _id: file.id, name: file.name, type: file.type, size: file.bytes.length },
          ...(file.type.startsWith('image/') ? [{ _id: `${file.id}-thumb`, name: `thumb-${file.name}`, type: file.type, typeGroup: 'thumb' }] : []),
        ],
        attachments: [{ type: 'file', title: file.name }],
      };
      messages.set(id, message);

      return message;
    },
    setMembers: (rid: string, names: string[]) => {
      members.set(rid, names.map((name, n) => ({ _id: `u-${n}`, username: `user${n}`, name })));
    },
    leaveRoom: (rid: string) => {
      subscriptions.splice(subscriptions.findIndex((subscription) => subscription.rid === rid), 1);
    },
    post: (rid: string, id: string, msg: string, extra: Partial<RcMessage> & { author?: { username: string, name?: string }, minutes?: number } = {}) => {
      const { author, minutes, ...rest } = extra;

      if (minutes) {
        clock += minutes * 60_000;
      }

      const at = tick();
      const message: RcMessage = { _id: id, rid, msg, ts: at, _updatedAt: at, u: { _id: 'u', ...(author ?? { username: 'andrii', name: 'Andrii Melnyk' }) }, ...rest };
      messages.set(id, message);

      if (message.tmid) {
        const parent = messages.get(message.tmid)!;
        messages.set(parent._id, { ...parent, tcount: (parent.tcount ?? 0) + 1, _updatedAt: tick() });
      }

      return message;
    },
    // A reaction updates the message, not the room's last message
    react: (id: string, emoji: string, username: string) => {
      const message = messages.get(id)!;
      const reactions = { ...message.reactions };
      reactions[emoji] = { usernames: [...(reactions[emoji]?.usernames ?? []), username] };
      messages.set(id, { ...message, reactions, _updatedAt: tick() });
    },
    edit: (id: string, msg: string) => {
      const message = messages.get(id)!;
      const at = tick();
      messages.set(id, { ...message, msg, editedAt: at, _updatedAt: at });
    },
    remove: (id: string) => {
      const message = messages.get(id)!;
      messages.delete(id);
      deleted.push({ _id: id, rid: message.rid, _deletedAt: tick() });
    },
  };
};

export type FakeRocketChat = ReturnType<typeof createFakeRocketChat>;
