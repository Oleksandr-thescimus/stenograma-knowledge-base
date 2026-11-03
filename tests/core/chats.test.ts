import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addTurn, chatHistory, chatTitle, createChat, finishTurn, getChat, interruptRunningTurns } from '../../core/chats.ts';
import { createTestDb, type Db } from './helpers.ts';

// The app's saved chats (core/chats.ts); with sources and citations in tests/core/service.test.ts
describe('chats', () => {
  let db: Db;
  let cleanup: () => void;

  beforeEach(() => {
    ({ db, cleanup } = createTestDb());
  });

  afterEach(() => cleanup());

  it('titles a chat with its first question, on one line', () => {
    expect(chatTitle('  Що\n з   бюджетом? ')).toBe('Що з бюджетом?');
    expect(chatTitle('бюджет '.repeat(20))).toHaveLength(80);
    expect(chatTitle('бюджет '.repeat(20)).endsWith('…')).toBe(true);
  });

  it('gives the rewrite the last answered exchanges, oldest first', () => {
    const chatId = createChat(db, 'q1');
    [1, 2, 3, 4].forEach((i) => finishTurn(db, addTurn(db, chatId, `q${i}`), { answer: `a${i}` }));
    finishTurn(db, addTurn(db, chatId, 'q5'), { answer: '', error: 'Ollama isn\'t running' });
    addTurn(db, chatId, 'q6');

    expect(chatHistory(db, chatId, 3).map((turn) => turn.content)).toEqual(['q2', 'a2', 'q3', 'a3', 'q4', 'a4']);
    expect(createChat(db, 'other')).not.toBe(chatId);
    expect(chatHistory(db, chatId + 1, 3)).toEqual([]);
  });

  it('marks the answers cut off when the app was killed', () => {
    const chatId = createChat(db, 'q1');
    finishTurn(db, addTurn(db, chatId, 'q1'), { answer: 'a1' });
    addTurn(db, chatId, 'q2');

    expect(interruptRunningTurns(db)).toBe(1);
    expect(getChat(db, chatId)!.turns.map((turn) => turn.state)).toEqual(['done', 'error']);
  });
});
