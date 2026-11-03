import { describe, expect, it } from 'vitest';
import { getSessionDate, getSessionTitle, pickMessages, pickSummary } from '../../core/stenograma/rules.ts';
import type { AssistantAnswer, Session, Transcript } from '../../core/stenograma/types.ts';

const version = (createdAt: number, status: Transcript['status'] = 'done'): Transcript => ({
  sessionId: 's', createdAt, status, messages: [{ user: 'Others', text: `version ${createdAt}` }],
});

const summary = (createdAt: number, extra: Partial<AssistantAnswer> = {}): AssistantAnswer => ({
  sessionId: 's', createdAt, kind: 'summary', text: `summary ${createdAt}`, ...extra,
});

describe('F1: what of a session is indexed', () => {
  it('takes a Meet call\'s captions, even when it has a version', () => {
    const session: Session = { sessionId: 's', stenogramaArray: [{ user: 'Olena', text: 'caption', source: 'caption' }] };

    expect(pickMessages(session, [version(1)])).toEqual(session.stenogramaArray);
  });

  it('takes the latest done version of a Meet call without captions', () => {
    const session: Session = { sessionId: 's', stenogramaArray: [{ user: 'Olena', text: 'chat only', source: 'chat' }] };

    expect(pickMessages(session, [version(1), version(3), version(5, 'transcribing')])[0].text).toBe('version 3');
  });

  it('takes a recording\'s latest done version, else its own text', () => {
    const recording: Session = { sessionId: 's', origin: 'recording', stenogramaArray: [{ user: 'You', text: 'own', source: 'mic' }] };

    expect(pickMessages(recording, [version(2), version(1)])[0].text).toBe('version 2');
    expect(pickMessages(recording, [version(4, 'failed')])[0].text).toBe('own');
  });

  it('takes only the latest summary of the whole meeting', () => {
    const picked = pickSummary([
      summary(1),
      summary(2),
      summary(3, { messageCount: 12 }),
      summary(4, { missedMinutes: 5 }),
      { ...summary(5), kind: 'answer' },
    ]);

    expect(picked?.text).toBe('summary 2');
  });

  it('titles a session as the extension does, from both kinds of ids', () => {
    expect(getSessionTitle({ sessionId: '2026/07/02 11:27:57 -> /qzo-oori-agq', stenogramaArray: [] })).toBe('qzo-oori-agq');
    expect(getSessionTitle({ sessionId: '/btq-whja-uzz -> 1/21/2025 6:34:20 PM', stenogramaArray: [] })).toBe('btq-whja-uzz');
    expect(getSessionTitle({ sessionId: '2026/10/22 14:18:47 -> /meet/ujk-zfrt-yds', stenogramaArray: [] })).toBe('ujk-zfrt-yds');
    expect(getSessionTitle({ sessionId: 'x', meetTitle: 'Planning', customName: 'Budget', stenogramaArray: [] })).toBe('Budget');
  });

  it('dates a session from its id in local time', () => {
    expect(getSessionDate({ sessionId: '2026/07/02 11:27:57 -> /qzo-oori-agq', stenogramaArray: [] }))
      .toEqual(new Date(2026, 6, 2, 11, 27, 57));
    expect(getSessionDate({ sessionId: '/btq-whja-uzz -> 1/21/2025 6:34:20 PM', stenogramaArray: [] }))
      .toEqual(new Date(2025, 0, 21, 18, 34, 20));
  });
});
