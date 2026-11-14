import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chunkConversation } from '../../core/chat/chunk.ts';
import { findRooms, getConversation, topReacted } from '../../core/chat/store.ts';
import type { ChatMessage } from '../../core/chat/types.ts';
import { formatChunkStart, formatDay } from '../../core/format.ts';
import { createRocketChatApi } from '../../core/rocketchat/api.ts';
import { createRocketChatConnector } from '../../core/rocketchat/connector.ts';
import { toChatMessage } from '../../core/rocketchat/convert.ts';
import {
  changePeriod, createRocketChatSource, messageLink, readConfig, syncRocketChat, writeConfig, type RocketChatConfig,
} from '../../core/rocketchat/sync.ts';
import { search } from '../../core/search.ts';
import { listSources, removeSource } from '../../core/sources.ts';
import { createTestDb, type Db } from './helpers.ts';
import { createFakeRocketChat, SERVER, TOKEN, USER, type FakeRocketChat } from './rocketchat-fake.ts';

const ALL: RocketChatConfig['selection'] = { mode: 'all', types: ['channel', 'group', 'direct'] };
const message = (id: string, ts: number, text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id, roomId: 'r', ts, author: 'Olena', text, ...extra,
});

describe('a conversation\'s chunks (F3)', () => {
  it('start again after a pause of more than 30 minutes, and keep a quoted message before its reply', () => {
    const chunks = chunkConversation('[Chat]', [
      message('1', 0, 'Бюджет погодили?'),
      message('2', 10 * 60_000, 'Так', { author: 'Andrii', quotes: [{ author: 'Olena', text: 'Бюджет погодили?' }] }),
      message('3', 60 * 60_000, 'Сервери замовили', { files: ['рахунок.pdf'], startsThread: true }),
    ]);

    expect(chunks.map(({ ord, text, startMs }) => ({ ord, text, startMs }))).toEqual([
      { ord: 0, text: 'Olena: Бюджет погодили?\n> Olena: Бюджет погодили?\nAndrii: Так', startMs: 0 },
      { ord: 1, text: 'Olena: Сервери замовили [file: рахунок.pdf] [started a thread]', startMs: 60 * 60_000 },
    ]);
  });

  it('tell a chat chunk\'s time of day, and the day when a thread goes on after it', () => {
    const createdAt = new Date(2026, 10, 10, 9, 0).getTime();

    expect(formatChunkStart({ documentKind: 'chat', createdAt, startMs: 65 * 60_000 })).toBe(' at 10:05');
    expect(formatChunkStart({ documentKind: 'chat-thread', createdAt, startMs: 24 * 3600_000 })).toBe(' on 2026-11-11 at 09:00');
    expect(formatChunkStart({ documentKind: 'meeting', createdAt, startMs: 65_000 })).toBe(' at 1:05');
  });
});

describe('Rocket.Chat\'s messages', () => {
  it('leave out system, deleted and encrypted messages, and the quote links in the text', () => {
    const base = { rid: 'r', ts: '2026-11-10T11:00:00Z', _updatedAt: '2026-11-10T11:00:00Z', u: { _id: 'u', username: 'olena' } };

    expect(toChatMessage({ ...base, _id: 'a', msg: 'joined', t: 'uj' })).toBeNull();
    expect(toChatMessage({ ...base, _id: 'b', msg: '', t: 'rm' })).toBeNull();
    expect(toChatMessage({ ...base, _id: 'c', msg: 'xyz', t: 'e2e' })).toBeNull();
    expect(toChatMessage({
      ...base,
      _id: 'd',
      msg: '[ ](https://chat.example.com/channel/general?msg=a1)\nТак',
      attachments: [
        { message_link: 'https://chat.example.com/channel/general?msg=a1', author_name: 'Andrii', text: 'Погодили?' },
        { type: 'file', title: 'план.pdf', description: 'Остання версія' },
      ],
    })).toEqual({
      id: 'd', roomId: 'r', ts: Date.parse(base.ts), author: 'olena', username: 'olena', text: 'Так\nОстання версія',
      quotes: [{ author: 'Andrii', text: 'Погодили?', messageId: 'a1' }], files: ['план.pdf'],
    });
  });
});

describe('syncing Rocket.Chat (F3, F4)', () => {
  let db: Db;
  let cleanup: () => void;
  let server: FakeRocketChat;
  let sourceId: number;

  const configure = (config: Partial<RocketChatConfig> = {}) => {
    sourceId = createRocketChatSource(db, 'olena@chat.example.com', {
      serverUrl: SERVER, userId: USER._id, username: USER.username, selection: ALL, since: 0, ...config,
    });
  };

  beforeEach(() => {
    ({ db, cleanup } = createTestDb());
    server = createFakeRocketChat();
    server.addRoom('general', 'c', 'general');
    server.addRoom('team', 'p', 'team', 'Team');
    server.addRoom('dm', 'd', 'andrii', 'Andrii Melnyk');
    server.addRoom('support', 'l', 'visitor');
    configure();
  });

  afterEach(() => cleanup());

  const sync = (options: { pageSize?: number, fake?: FakeRocketChat } = {}) => {
    const fake = options.fake ?? server;
    const api = createRocketChatApi({ serverUrl: SERVER, userId: USER._id, token: TOKEN }, { fetch: fake.fetch });

    return syncRocketChat({ db, sourceId, api, embedModel: null, now: fake.now, pageSize: options.pageSize });
  };

  const documents = () => db.prepare('select id, kind, title from documents order by id').all() as { id: string, kind: string, title: string }[];
  const chunksOf = (documentId: string) => db.prepare('select header, text, start_ms as startMs from chunks where document_id = ? order by ord')
    .all(documentId) as { header: string, text: string, startMs: number }[];
  const day = (id: string) => `chat:${sourceId}:general:${formatDay(Date.parse('2026-11-10T11:00:00Z'))}`.replace('general', id);

  const postBudgetTalk = () => {
    server.post('general', 'm1', 'Бюджет на квартал погодили?');
    server.post('general', 'm2', 'Так, у пʼятницю', { tmid: 'm1', author: { username: 'olena', name: 'Olena Koval' } });
    server.post('general', 'm3', '[ ](https://chat.example.com/channel/general?msg=m1) Тоді закуповуємо сервери', {
      author: { username: 'olena', name: 'Olena Koval' },
      attachments: [{ message_link: 'https://chat.example.com/channel/general?msg=m1', author_name: 'Andrii Melnyk', text: 'Бюджет на квартал погодили?' }],
    });
    server.post('general', 'm4', 'olena', { t: 'uj' });
  };

  it('reads a room\'s day and each thread as documents, with the quoted message and the thread\'s start in the chunks', async () => {
    postBudgetTalk();
    server.post('dm', 'd1', 'Скинь таблицю');

    expect(await sync()).toEqual({ changed: true, rooms: 3, messages: 4 });

    const thread = `chat:${sourceId}:general:thread:m1`;
    expect(documents()).toEqual([
      { id: day('dm'), kind: 'chat', title: 'direct: Andrii Melnyk' },
      { id: day('general'), kind: 'chat', title: '#general' },
      { id: thread, kind: 'chat-thread', title: 'Thread in #general: Бюджет на квартал погодили?' },
    ]);
    expect(chunksOf(day('general'))).toEqual([{
      header: `[Rocket.Chat · #general · ${formatDay(Date.parse('2026-11-10T11:00:00Z'))}]`,
      text: 'Andrii Melnyk: Бюджет на квартал погодили? [started a thread]\n> Andrii Melnyk: Бюджет на квартал погодили?\nOlena Koval: Тоді закуповуємо сервери',
      startMs: 0,
    }]);
    expect(chunksOf(thread)[0].header).toContain('thread of 2026-11-10 · Andrii Melnyk: Бюджет на квартал погодили?]');
    expect(chunksOf(thread)[0].text).toBe('Andrii Melnyk: Бюджет на квартал погодили?\nOlena Koval: Так, у пʼятницю');
    // A room is read whole the first time, a call each; livechat rooms never. A cloud LLM doesn't see it until it's
    // allowed (F8)
    expect(server.calls.filter((call) => call === 'chat.syncMessages')).toHaveLength(3);
    expect(listSources(db)[0]).toMatchObject({ kind: 'rocketchat', cloudAllowed: false });
  });

  it('finds a quote\'s reply by its speaker only, not by whom it quotes', async () => {
    postBudgetTalk();
    await sync();

    const { hits } = await search(db, 'сервери', { person: 'Olena' });
    expect(hits[0].documentId).toBe(day('general'));
  });

  it('goes on from its cursors: a new message, an edit and a deletion, reading only the room with a new message', async () => {
    postBudgetTalk();
    server.post('team', 't1', 'Реліз у четвер');
    await sync();
    server.calls.length = 0;

    server.edit('m1', 'Бюджет на рік погодили?');
    server.remove('m3');
    server.post('general', 'm5', 'Рахунок прийшов', { minutes: 5 });
    await sync();

    expect(server.calls).toEqual(['subscriptions.get', 'rooms.get', 'chat.syncMessages', 'chat.syncMessages']);
    expect(chunksOf(day('general')).map((chunk) => chunk.text)).toEqual([
      'Andrii Melnyk: Бюджет на рік погодили? [started a thread]\nAndrii Melnyk: Рахунок прийшов',
    ]);
    expect(chunksOf(`chat:${sourceId}:general:thread:m1`)[0].header).toContain('Andrii Melnyk: Бюджет на рік погодили?]');
  });

  it('checks a room without a new message for edits every few hours', async () => {
    server.post('team', 't1', 'Реліз у четвер');
    await sync();
    server.edit('t1', 'Реліз у пʼятницю');
    await sync();

    expect(chunksOf(day('team'))[0].text).toBe('Andrii Melnyk: Реліз у четвер');

    server.wait(7 * 3600_000);
    await sync();

    expect(chunksOf(day('team'))[0].text).toBe('Andrii Melnyk: Реліз у пʼятницю');
  });

  it('reads a room in pages', async () => {
    Array.from({ length: 25 }, (_, n) => server.post('general', `p${n}`, `Повідомлення ${n}`));
    await sync({ pageSize: 10 });

    expect(chunksOf(day('general')).map((chunk) => chunk.text).join('\n').split('\n')).toHaveLength(25);
  });

  it('reads a server before 7.1 at once', async () => {
    const old = createFakeRocketChat({ legacy: true });
    old.addRoom('general', 'c', 'general');
    old.post('general', 'm1', 'Привіт');
    old.post('general', 'm2', 'Бувай', { minutes: 1 });
    await sync({ fake: old });
    old.remove('m2');
    old.post('general', 'm3', 'Ще одне', { minutes: 1 });
    await sync({ fake: old });

    expect(chunksOf(day('general')).map((chunk) => chunk.text)).toEqual(['Andrii Melnyk: Привіт\nAndrii Melnyk: Ще одне']);
  });

  it('waits out a rate limit and goes on', async () => {
    server.post('general', 'm1', 'Привіт');
    server.limited.add('subscriptions.get');
    await sync();

    expect(server.calls.filter((call) => call === 'subscriptions.get')).toHaveLength(2);
    expect(documents()).toHaveLength(1);
  });

  it('reads only the chosen rooms, and a room no longer chosen or left goes with its documents', async () => {
    writeConfig(db, sourceId, { ...readConfig(db, sourceId), selection: { mode: 'chosen', ids: ['general', 'team'] } });
    server.post('general', 'm1', 'Привіт');
    server.post('team', 't1', 'Реліз у четвер');
    server.post('dm', 'd1', 'Скинь таблицю');
    await sync();

    expect(documents().map((doc) => doc.title)).toEqual(['#general', '#Team']);

    writeConfig(db, sourceId, { ...readConfig(db, sourceId), selection: { mode: 'chosen', ids: ['team'] } });
    server.leaveRoom('team');
    await sync();

    expect(documents()).toEqual([]);
    expect(db.prepare('select count(*) as n from chat_messages').get()).toEqual({ n: 0 });
  });

  it('names a renamed room in every chunk', async () => {
    server.post('team', 't1', 'Реліз у четвер');
    await sync();
    server.renameRoom('team', 'Release team');
    await sync();

    expect(chunksOf(day('team'))[0].header).toContain('#Release team');
  });

  it('drops what\'s before a later start of the period, and reads the rooms again from an earlier one', async () => {
    server.post('general', 'old', 'Старе');
    server.post('general', 'new', 'Нове', { minutes: 3 * 24 * 60 });
    await sync();
    const later = Date.parse('2026-11-12T00:00:00Z');
    changePeriod(db, sourceId, later, null);

    expect(documents()).toHaveLength(1);
    expect(db.prepare('select message_id as id from chat_messages').all()).toEqual([{ id: 'new' }]);

    changePeriod(db, sourceId, 0, null);
    await sync();

    expect(documents()).toHaveLength(2);
  });

  const participantsOf = (documentId: string) => JSON.parse((db.prepare('select participants from documents where id = ?')
    .get(documentId) as { participants: string }).participants) as string[];

  it('counts the members of a room of up to 20 as its documents\' participants, those who wrote only in a larger one', async () => {
    server.setMembers('team', ['Olena Koval', 'Andrii Melnyk', 'Taras Bondarenko']);
    server.setMembers('general', ['Taras Bondarenko', ...Array.from({ length: 149 }, (_, n) => `Person ${n}`)]);
    server.post('team', 't1', 'Реліз у четвер');
    server.post('general', 'g1', 'Всім привіт');
    await sync();

    expect(participantsOf(day('team'))).toEqual(['Andrii Melnyk', 'Olena Koval', 'Taras Bondarenko']);
    expect(participantsOf(day('general'))).toEqual(['Andrii Melnyk']);
    // Read in pages of 100, and shown with the conversation
    expect(getConversation(db, day('general'), null)!.members).toHaveLength(150);
    expect((await search(db, 'реліз', { person: 'Taras' })).hits[0].documentId).toBe(day('team'));
  });

  it('reads the members again a day later, with the same chunks', async () => {
    server.setMembers('team', ['Olena Koval', 'Taras Bondarenko']);
    server.post('team', 't1', 'Реліз у четвер');
    await sync();
    const chunkIds = db.prepare('select id from chunks order by id').all();
    server.setMembers('team', ['Olena Koval']);
    await sync();

    expect(participantsOf(day('team'))).toContain('Taras Bondarenko');

    server.wait(25 * 3600_000);
    await sync();

    expect(participantsOf(day('team'))).toEqual(['Andrii Melnyk', 'Olena Koval']);
    expect(db.prepare('select id from chunks order by id').all()).toEqual(chunkIds);
  });

  it('names who reacted to a message, with the emoji, and counts them as participants', async () => {
    server.post('team', 't1', 'Реліз у четвер', { author: { username: 'andrii', name: 'Andrii Melnyk' } });
    server.react('t1', ':+1:', 'olena');
    server.react('t1', ':+1:', 'andrii');
    server.react('t1', ':white_check_mark:', 'taras');
    server.setMembers('team', []);
    await sync();

    // olena and andrii are named by the room's members and the messages' authors; taras by no one yet
    expect(chunksOf(day('team'))[0].text).toBe('Andrii Melnyk: Реліз у четвер [reactions: 👍 Olena Koval, Andrii Melnyk; ✅ taras]');
    expect(participantsOf(day('team'))).toEqual(['Andrii Melnyk', 'Olena Koval', 'taras']);
    expect(getConversation(db, day('team'), null)!.messages[0].reactions).toEqual([
      { emoji: '+1', names: ['Olena Koval', 'Andrii Melnyk'] }, { emoji: 'white_check_mark', names: ['taras'] },
    ]);

    // A reaction later doesn't change the room's last message: it's read in the check every few hours
    server.react('t1', ':eyes:', 'olena');
    server.wait(7 * 3600_000);
    await sync();

    expect(chunksOf(day('team'))[0].text).toContain('👀 Olena Koval');
  });

  it('finds a room as a question names it, searches it only, and ranks its messages by their reactions', async () => {
    server.renameRoom('team', 'QA dev talks');
    server.post('team', 't1', 'Реліз у четвер');
    server.post('team', 't2', 'Реліз переносимо, тестування не встигає', { minutes: 60 });
    server.post('general', 'g1', 'Реліз мобільного застосунку в понеділок', { minutes: 120 });
    ['olena', 'andrii', 'taras'].forEach((username) => server.react('t2', ':+1:', username));
    server.react('t1', ':eyes:', 'olena');
    ['olena', 'andrii', 'taras', 'maria'].forEach((username) => server.react('g1', ':tada:', username));
    await sync();

    const team = [{ sourceId, roomId: 'team' }];
    expect(['qa_dev_talks', '#qadevtalks', 'QA Dev Talks', 'dev talks'].map((said) => findRooms(db, said))).toEqual([team, team, team, team]);
    expect(findRooms(db, 'nonexistent')).toEqual([]);

    const { hits } = await search(db, 'реліз', { rooms: team });
    expect(new Set(hits.map((hit) => hit.threadId))).toEqual(new Set(['team']));

    // The most reacted of the room first, wherever in the period; the other room's isn't counted
    const reacted = topReacted(db, { rooms: team, limit: 8 });
    expect(reacted.map(({ count, note }) => ({ count, note }))).toEqual([
      { count: 3, note: 'A message here has 3 reactions: Andrii Melnyk: "Реліз переносимо, тестування не встигає"' },
      { count: 1, note: 'A message here has 1 reaction: Andrii Melnyk: "Реліз у четвер"' },
    ]);
    expect(topReacted(db, { limit: 1 })[0].count).toBe(4);
  });

  it('removes its messages with the source', async () => {
    postBudgetTalk();
    await sync();
    removeSource(db, sourceId, null);

    expect(db.prepare('select (select count(*) from chat_messages) + (select count(*) from chat_rooms) + (select count(*) from documents) as n').get())
      .toEqual({ n: 0 });
  });

  it('shows a cited conversation with the cited chunk\'s messages, its threads, and a link to each message', async () => {
    server.post('general', 'm1', 'Бюджет на квартал погодили?');
    server.post('general', 'm2', 'Так', { tmid: 'm1' });
    server.post('general', 'm3', 'Сервери замовили', { minutes: 45 });
    await sync();
    const [, second] = chunksOf(day('general'));
    const view = getConversation(db, day('general'), second.startMs);

    expect(view).toMatchObject({ kind: 'day', room: '#general', cited: { first: 1, last: 1 } });
    expect(view!.messages.map((viewed) => [viewed.id, viewed.threadDocumentId])).toEqual([
      ['m1', `chat:${sourceId}:general:thread:m1`], ['m3', null],
    ]);
    expect(messageLink(readConfig(db, sourceId), { id: 'general', type: 'channel', name: 'general', title: 'general' }, 'm3'))
      .toBe('https://chat.example.com/channel/general?msg=m3');
    expect(messageLink({ serverUrl: SERVER }, { id: 'dm', type: 'direct', name: 'andrii', title: 'Andrii' }, 'd1'))
      .toBe('https://chat.example.com/direct/dm?msg=d1');
  });

  it('keeps its own limit of calls a minute, below the server\'s, and syncs as often as set', async () => {
    let now = 0;
    const waits: number[] = [];
    const api = createRocketChatApi({ serverUrl: SERVER, userId: USER._id, token: TOKEN }, {
      fetch: server.fetch,
      requestsPerMinute: 2,
      now: () => now,
      wait: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    });
    await api.me();
    await api.me();
    await api.me();
    await api.subscriptions();

    // The third call of an endpoint waits out the minute; another endpoint has its own
    expect(waits).toEqual([60_000]);

    const connector = createRocketChatConnector({ db, getToken: () => TOKEN, embedModel: () => null, fetch: server.fetch });
    expect(connector.intervalMs(sourceId)).toBe(5 * 60_000);
    writeConfig(db, sourceId, { ...readConfig(db, sourceId), limits: { intervalMinutes: 30, requestsPerMinute: 5, filePauseSeconds: 3 } });
    expect(connector.intervalMs(sourceId)).toBe(30 * 60_000);
  });

  it('says when the token is refused', async () => {
    const api = createRocketChatApi({ serverUrl: SERVER, userId: USER._id, token: 'wrong' }, { fetch: server.fetch });

    await expect(syncRocketChat({ db, sourceId, api, embedModel: null })).rejects.toThrow('refused the token');
  });
});
