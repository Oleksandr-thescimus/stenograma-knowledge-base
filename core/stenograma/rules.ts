import type { ActionItem, AssistantAnswer, Session, StenogramaMessage, Transcript } from './types.ts';

// What of a session is indexed (F1). It runs over the rows the core keeps, so a change here re-indexes them without a
// push from the extension.

const isCaption = (message: StenogramaMessage) => !message.source || message.source === 'caption';

const latestFirst = <T extends { createdAt: number }>(rows: T[]) => [...rows].sort((a, b) => b.createdAt - a.createdAt);

// One text per session, so a meeting isn't found twice. A Meet call's own text, or its latest done version when it has
// no captions: a version made from the audio has only "You" / "Others" and no chat, which would lose who said what.
// A recording's latest done version, else its own text
export const pickMessages = (session: Session, transcripts: Transcript[]) => {
  const [latestDone] = latestFirst(transcripts.filter((transcript) => transcript.status === 'done'));

  if ((session.origin ?? 'meet') === 'meet') {
    return session.stenogramaArray.some(isCaption) || !latestDone ? session.stenogramaArray : latestDone.messages;
  }

  return latestDone?.messages ?? session.stenogramaArray;
};

// The latest summary of the whole meeting: not of a selection, not "What did I miss?", not one replaced by Regenerate
export const pickSummary = (answers: AssistantAnswer[]) => latestFirst(answers.filter((answer) => answer.kind === 'summary'
  && answer.messageCount === undefined && answer.missedMinutes === undefined))[0];

export const sortActionItems = (items: ActionItem[]) => [...items].sort((a, b) => a.createdAt - b.createdAt);

// Meet codes look like abc-defg-hij, in ids "yyyy/MM/dd HH:mm:ss -> /abc-defg-hij" (also "/meet/abc-…") and, in older
// ones, "/abc-defg-hij -> M/D/YYYY h:mm:ss AM"
const MEET_CODE = /^\/?(?:meet\/)?([a-z]{3}-[a-z]{4}-[a-z]{3})$/;

// As the extension's getSessionTitle: the given name, else Meet's, else the code
export const getSessionTitle = (session: Session) => {
  const code = session.sessionId.split(' -> ').map((part) => MEET_CODE.exec(part.trim())?.[1]).find(Boolean);

  return session.customName || session.meetTitle || code || session.sessionId;
};

// When the session started: startDate, else the time in its id (local time, as the extension writes it)
export const getSessionDate = (session: Session) => {
  if (session.startDate) {
    return new Date(session.startDate);
  }

  const older = /->\s*(\d{1,2}\/\d{1,2}\/\d{4}.*)$/.exec(session.sessionId);

  if (older) {
    return new Date(older[1]);
  }

  const current = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}:\d{2}:\d{2})/.exec(session.sessionId);

  return current ? new Date(`${current[1]}-${current[2]}-${current[3]}T${current[4]}`) : new Date(Number.NaN);
};

// People who spoke or wrote; Meet doesn't tell who only listened. A recording has only "You" and "Others"
export const getParticipants = (session: Session, messages: StenogramaMessage[]) => (session.origin === 'recording'
  ? []
  : [...new Set(messages.filter((message) => message.text?.trim()).map((message) => message.user))]);
