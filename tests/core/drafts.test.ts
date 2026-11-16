import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { noneAffected, saveMessages, saveRoom, setRoomReadAt } from '../../core/chat/store.ts';
import type { ChatMessage } from '../../core/chat/types.ts';
import { detectDrafts, findAddressed, latestFromOthers, mentionsUser } from '../../core/drafts/detect.ts';
import { getDraft, listOpenDrafts, requestDraft, updateDraft } from '../../core/drafts/store.ts';
import { corrections, draftOutcomes, formatStyle, replyExamples, styleSample } from '../../core/drafts/style.ts';
import { askedText, conversationOf, prepareDraft } from '../../core/drafts/write.ts';
import type { SearchHit } from '../../core/search.ts';
import { DEFAULT_SETTINGS, type LlmSettings } from '../../core/settings.ts';
import { answersLlm } from '../../core/servers.ts';
import { findOrCreateSource } from '../../core/sources.ts';
import { withoutCitations } from '../../app/renderer/src/lib/drafts.ts';
import { createTestDb, type Db } from './helpers.ts';

// The chat's model of the default settings: this computer's Ollama
const DEFAULT_LLM = answersLlm(DEFAULT_SETTINGS);

// Reply drafts (F9): which messages to the user get one, when it closes, and what the model is given

const NOW = Date.parse('2026-11-14T12:00:00Z');
const MINUTE = 60_000;
const ME = 'olena';

describe('reply drafts', () => {
  let db: Db;
  let cleanup: () => void;
  let sourceId: number;
  let n = 0;

  beforeEach(() => {
    ({ db, cleanup } = createTestDb());
    sourceId = findOrCreateSource(db, 'rocketchat', 'olena@chat.example.com').id;
    saveRoom(db, sourceId, { id: 'general', type: 'channel', name: 'general', title: 'general' });
    saveRoom(db, sourceId, { id: 'dm', type: 'direct', name: 'andrii', title: 'Andrii Melnyk' });
    n = 0;
  });

  afterEach(() => cleanup());

  const post = (roomId: string, text: string, minutesAgo: number, extra: Partial<ChatMessage> = {}) => {
    n += 1;
    const message: ChatMessage = {
      id: `m${n}`, roomId, ts: NOW - (minutesAgo * MINUTE), author: 'Andrii Melnyk', username: 'andrii', text, ...extra,
    };
    saveMessages(db, sourceId, [message], noneAffected());

    return message;
  };
  const mine = (roomId: string, text: string, minutesAgo: number, extra: Partial<ChatMessage> = {}) => post(roomId, text, minutesAgo, {
    author: 'Olena Koval', username: ME, ...extra,
  });
  // Drafts on since an hour ago
  const setup = { sourceId: 0, username: ME, since: NOW - (60 * MINUTE), unreadDays: 1, maxAgeDays: 3, now: NOW };
  const found = () => findAddressed(db, { ...setup, sourceId }).map(({ message, reason }) => [message.id, reason]);

  it('finds direct messages, mentions by name and replies in the user\'s threads, not @all or others\' talk', () => {
    // Writing in the room after a mention answers it: the thread is started before
    const root = mine('general', 'Хто бере інцидент?', 40, { startsThread: true });
    post('dm', 'Скинь звіт, будь ласка', 30);
    post('general', 'Всім привіт', 29);
    post('general', '@all реліз о 15:00', 28);
    post('general', '@olena глянь PR', 27, { mentions: [ME] });
    post('general', 'Я візьму', 10, { threadId: root.id });
    post('general', 'Тоді я завтра', 9, { threadId: 'someone-elses-thread' });

    expect(found()).toEqual([['m2', 'direct'], ['m5', 'mention'], ['m6', 'thread']]);
  });

  it('reads a mention in the text of a message kept before mentions were, not in an email or a longer name', () => {
    expect(mentionsUser({ text: 'Привіт @olena!' }, ME)).toBe(true);
    expect(mentionsUser({ text: 'olena@example.com' }, ME)).toBe(false);
    expect(mentionsUser({ text: '@olena.k глянь' }, ME)).toBe(false);
  });

  it('takes a conversation\'s last message to the user, and none the user answered after', () => {
    post('dm', 'Ти тут?', 40);
    post('dm', 'Скинь звіт', 39);
    post('general', '@olena глянь PR', 30, { mentions: [ME] });
    mine('general', 'Гляну після обіду', 25);

    expect(found()).toEqual([['m2', 'direct']]);
  });

  it('takes the unread of the last day from before drafts were on, and later ones read or not', () => {
    post('dm', 'Старе, прочитане', 3 * 60);
    post('dm', 'Старе, непрочитане', 2 * 60);
    setRoomReadAt(db, sourceId, 'dm', NOW - (2.5 * 60 * MINUTE));

    expect(found()).toEqual([['m2', 'direct']]);

    setRoomReadAt(db, sourceId, 'dm', NOW - (1.5 * 60 * MINUTE));
    expect(found()).toEqual([]);

    post('dm', 'Нове, вже прочитане', 30);
    setRoomReadAt(db, sourceId, 'dm', NOW);
    expect(found()).toEqual([['m3', 'direct']]);
  });

  it('in a room chosen for it, drafts every message from others once its conversation is quiet, and its unread from before', () => {
    const chosen = (since: number) => db.prepare('update chat_rooms set drafts_all_since = ? where source_id = ? and room_id = ?').run(since, sourceId, 'general');
    post('general', 'Старе, прочитане', 50);
    post('general', 'Хтось знає, де логи?', 20);
    setRoomReadAt(db, sourceId, 'general', NOW - (40 * MINUTE));
    // Not chosen: others' talk
    expect(found()).toEqual([]);

    // Chosen 30 minutes ago: the read one from before doesn't count, the unread does
    chosen(NOW - (30 * MINUTE));
    expect(found()).toEqual([['m2', 'room']]);

    // A burst: the conversation isn't quiet yet, so it waits, and says when to look again
    post('general', 'Бо прод лежить', 1);
    const quietAt: number[] = [];
    expect(detectDrafts(db, { ...setup, sourceId, onQuietAt: (at) => quietAt.push(at) })).toBe(0);
    expect(quietAt).toEqual([NOW + MINUTE]);

    // Quiet now: one draft, for the burst's last message
    expect(detectDrafts(db, { ...setup, sourceId, now: NOW + (2 * MINUTE) })).toBe(1);
    expect(listOpenDrafts(db).map((draft) => [draft.messageId, draft.reason])).toEqual([['m3', 'room']]);

    // A mention there is drafted at once, as anywhere
    post('general', '@olena ти глянеш?', 0, { mentions: [ME] });
    expect(found()).toEqual([['m4', 'mention']]);
  });

  it('adds a draft once, supersedes it by a later message, and closes it when the user answers', () => {
    post('dm', 'Скинь звіт', 30);
    expect(detectDrafts(db, { ...setup, sourceId })).toBe(1);
    expect(detectDrafts(db, { ...setup, sourceId })).toBe(0);
    const [first] = listOpenDrafts(db);
    updateDraft(db, first.id, { state: 'ready', text: 'Скину ввечері' });

    post('dm', 'І презентацію теж', 20);
    expect(detectDrafts(db, { ...setup, sourceId })).toBe(1);
    expect(getDraft(db, first.id)?.state).toBe('superseded');
    expect(listOpenDrafts(db).map((draft) => [draft.messageId, draft.state])).toEqual([['m2', 'waiting']]);

    mine('dm', 'Ок, скину', 10);
    expect(detectDrafts(db, { ...setup, sourceId })).toBe(0);
    expect(listOpenDrafts(db)).toEqual([]);
  });

  it('takes the unread ones of the days set, and none older than the days set', () => {
    post('dm', 'Позавчора, непрочитане', 2 * 24 * 60);

    expect(found()).toEqual([]);
    expect(findAddressed(db, { ...setup, sourceId, unreadDays: 3 }).map(({ message }) => message.id)).toEqual(['m1']);
    expect(findAddressed(db, { ...setup, sourceId, unreadDays: 3, maxAgeDays: 1 })).toEqual([]);
  });

  it('drafts by hand a conversation\'s last message from someone else, closed only by what the user writes after', () => {
    post('general', 'Хто бере інцидент?', 40);
    mine('general', 'Я', 30);
    const [latest] = latestFromOthers(db, sourceId, ME, 0);

    expect(latest).toMatchObject({ roomId: 'general', threadId: null, message: { id: 'm1' } });
    expect(found()).toEqual([]);

    const id = requestDraft(db, { sourceId, roomId: 'general', threadId: null, messageId: 'm1' }, NOW);
    expect(getDraft(db, id)).toMatchObject({ reason: 'manual', state: 'waiting' });
    // Answered before it was asked for: it stays
    detectDrafts(db, { ...setup, sourceId });
    expect(getDraft(db, id)?.state).toBe('waiting');

    // Dismissed, then asked for again: the same one, waiting again
    updateDraft(db, id, { state: 'dismissed' });
    expect(requestDraft(db, { sourceId, roomId: 'general', threadId: null, messageId: 'm1' }, NOW + 1)).toBe(id);
    expect(getDraft(db, id)?.state).toBe('waiting');

    mine('general', 'Вже взяла', -5);
    detectDrafts(db, { ...setup, sourceId, now: NOW + (10 * MINUTE) });
    expect(getDraft(db, id)?.state).toBe('replied');
  });

  it('keeps a dismissed draft dismissed', () => {
    post('dm', 'Скинь звіт', 30);
    detectDrafts(db, { ...setup, sourceId });
    updateDraft(db, listOpenDrafts(db)[0].id, { state: 'dismissed' });

    expect(detectDrafts(db, { ...setup, sourceId })).toBe(0);
    expect(listOpenDrafts(db)).toEqual([]);
  });

  describe('the user\'s style', () => {
    it('takes the user\'s replies (in a message or a few) to the most similar messages, the same person\'s first, none of the conversation given', () => {
      saveRoom(db, sourceId, { id: 'dev', type: 'channel', name: 'dev', title: 'dev' });
      post('dev', 'Хто гляне деплой на стейджі?', 600, { author: 'Iryna Bondar', username: 'iryna' });
      mine('dev', 'я гляну', 599);
      post('dev', 'Скинь звіт за тиждень', 500);
      mine('dev', 'ок, ввечері скину', 499);
      // Written right after: the same reply
      mine('dev', 'або завтра зранку', 498);
      // Too late after the message to be its reply
      post('dev', 'Як справи з релізом?', 400, { author: 'Iryna Bondar', username: 'iryna' });
      mine('dev', 'Пізніше', 200);
      post('dm', 'Скинь, будь ласка, звіт', 30);
      mine('dm', 'скину', 29);
      const asked = post('dm', 'І презентацію скинь', 10);

      expect(replyExamples(db, sourceId, ME, asked, NOW - (40 * MINUTE), NOW).map((example) => example.reply)).toEqual(['ок, ввечері скину\nабо завтра зранку', 'я гляну']);
      expect(replyExamples(db, sourceId, ME, asked, NOW - (20 * MINUTE), NOW, 1)).toEqual([{ author: 'Andrii Melnyk', message: 'Скинь, будь ласка, звіт', reply: 'скину' }]);
      expect(styleSample(db, [{ sourceId, username: ME }])).toEqual(['скину', 'Пізніше', 'або завтра зранку', 'ок, ввечері скину', 'я гляну']);
    });

    it('keeps what the user sent to a draft, and gives the drafts they rewrote', () => {
      post('dm', 'Скинь звіт', 30);
      detectDrafts(db, { ...setup, sourceId });
      const [draft] = listOpenDrafts(db);
      updateDraft(db, draft.id, { state: 'ready', text: 'Добрий день! Звіт надішлю сьогодні ввечері [1].' });
      const sent = mine('dm', 'ввечері скину', 10);
      detectDrafts(db, { ...setup, sourceId });

      expect(db.prepare('select sent_message_id as sent from drafts where id = ?').get(draft.id)).toEqual({ sent: sent.id });
      expect(corrections(db, sourceId)).toEqual([{ draft: 'Добрий день! Звіт надішлю сьогодні ввечері [1].', sent: 'ввечері скину' }]);
      expect(draftOutcomes(db, sourceId)).toEqual({ answered: 1, asWritten: 0 });

      const text = formatStyle([{ author: 'Andrii Melnyk', message: 'Ти тут?', reply: 'так' }], corrections(db, sourceId));
      expect(text).toContain('Andrii Melnyk: Ти тут?\nThe user: так');
      expect(text).toContain('Draft: Добрий день!');
      expect(text).toContain('Sent: ввечері скину');
    });

    it('counts a draft sent as written, its citation marks aside', () => {
      post('dm', 'Скинь звіт', 30);
      detectDrafts(db, { ...setup, sourceId });
      updateDraft(db, listOpenDrafts(db)[0].id, { state: 'ready', text: 'Скину ввечері [1]' });
      mine('dm', 'скину ввечері', 10);
      detectDrafts(db, { ...setup, sourceId });

      expect(draftOutcomes(db, sourceId)).toEqual({ answered: 1, asWritten: 1 });
      expect(corrections(db, sourceId)).toEqual([]);
    });
  });

  describe('what the model is given', () => {
    const hit = (over: Partial<SearchHit>): SearchHit => ({
      chunkId: 1, documentId: 'd', documentKind: 'meeting', sourceId: 99, sourceKind: 'stenograma-browser', threadId: 's', title: 'Lead meeting',
      createdAt: NOW - (86_400_000 * 3), startMs: null, header: 'Meeting: Lead meeting', text: 'Бюджет погодили на 10k', madeByAi: false,
      participants: [], score: 1, ...over,
    });
    const GROQ: LlmSettings = { ...DEFAULT_LLM, provider: 'groq', model: 'openai/gpt-oss-120b' };

    it('the conversation up to the message, and the sources but its own chunks and, for a cloud LLM, those not allowed', () => {
      mine('general', 'Хто знає бюджет?', 50);
      const asked = post('general', '@olena який бюджет погодили?', 40, { mentions: [ME] });
      post('general', 'Пізніше повідомлення', 5);
      const draft = { sourceId, roomId: 'general', threadId: null, messageId: asked.id };
      const messages = conversationOf(db, draft);

      expect(messages.map((message) => message.id)).toEqual(['m1', 'm2']);
      expect(askedText(messages, ME)).toBe('@olena який бюджет погодили?');

      const meeting = hit({ chunkId: 1 });
      const ownDay = hit({ chunkId: 2, sourceId, threadId: 'general', documentKind: 'chat', createdAt: NOW - (60 * MINUTE) });
      const local = prepareDraft(db, DEFAULT_LLM, draft, messages, ME, [meeting, ownDay]);

      expect(local.sources.map((source) => source.hit.chunkId)).toEqual([1]);
      expect(local.prompt).toContain('Olena Koval (the user)');
      expect(local.prompt).toContain('[1] Meeting: Lead meeting');
      expect(local.system).not.toContain('How the user writes');

      const styled = prepareDraft(db, DEFAULT_LLM, draft, messages, ME, [meeting], { description: '- Коротко, без привітань', examples: 'EXAMPLES' });
      expect(styled.system).toContain('How the user writes, in their own words:\n- Коротко, без привітань');
      expect(styled.prompt.indexOf('EXAMPLES')).toBeLessThan(styled.prompt.indexOf('Conversation in'));

      // The meeting's source doesn't allow cloud AI
      db.prepare('insert into sources (id, kind, account, cloud_allowed, created_at) values (99, \'stenograma-browser\', \'Chrome\', 0, 0)').run();
      expect(prepareDraft(db, GROQ, draft, messages, ME, [meeting]).sources).toEqual([]);
    });

    it('is copied without its citation marks', () => {
      expect(withoutCitations('Бюджет погодили на 10k [1][2], деталі в протоколі [3].')).toBe('Бюджет погодили на 10k, деталі в протоколі.');
    });
  });
});
