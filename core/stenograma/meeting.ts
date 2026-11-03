import type { Db } from '../db.ts';
import type { MeetingView } from '../protocol.ts';
import { BROWSER_KIND } from '../browsers.ts';
import { formatDay } from '../format.ts';
import { getSummary, textHash } from '../summaries.ts';
import { meetingDocumentId, readRows } from './ingest.ts';
import { getParticipants, getSessionDate, getSessionTitle, pickMessages, pickSummary, pickText, sortActionItems } from './rules.ts';

// A meeting's text for its summary: "Speaker: text", a line each
export const meetingLines = (meeting: Pick<MeetingView, 'messages'>) => meeting.messages
  .map((message) => `${message.user}: ${message.text.replace(/\s+/g, ' ').trim()}`);

// What the meeting is, ahead of its text in a summary's prompt
export const meetingHeader = (meeting: MeetingView) => [
  `${meeting.origin === 'recording' ? 'Recording' : 'Meeting'}: ${meeting.title}`,
  formatDay(meeting.createdAt),
  meeting.participants.length ? `with ${meeting.participants.join(', ')}` : '',
].filter(Boolean).join(' · ');

// A cited meeting from the knowledge base's own copy of its rows, as F1 indexes it: the text it picked, the latest
// summary and the action items. Moments count from the first message with a time, as the chunks' starts do
export const getMeeting = (db: Db, sourceId: number, sessionId: string): MeetingView | null => {
  const { session, transcripts, answers, actionItems } = readRows(db, sourceId, sessionId);

  if (!session) {
    return null;
  }

  const messages = pickMessages(session, transcripts).filter((message) => message.text?.trim());
  const first = messages.find((message) => message.timestamp)?.timestamp;
  const date = getSessionDate(session);
  const source = db.prepare('select kind from sources where id = ?').get(sourceId) as { kind: string } | undefined;

  const view: Omit<MeetingView, 'shortSummary'> = {
    sourceId,
    sessionId,
    title: getSessionTitle(session),
    createdAt: Number.isNaN(date.getTime()) ? 0 : date.getTime(),
    origin: session.origin ?? 'meet',
    participants: getParticipants(session, messages),
    messages: messages.map((message) => ({
      user: message.user || '?',
      text: message.text,
      startMs: message.timestamp && first !== undefined ? message.timestamp - first : null,
      source: message.source,
    })),
    summary: pickSummary(answers)?.text ?? null,
    actionItems: sortActionItems(actionItems).map(({ what, who, due, done }) => ({ what, who, due, done })),
    canOpenInStenograma: source?.kind === BROWSER_KIND,
  };

  return { ...view, shortSummary: getSummary(db, meetingDocumentId(sourceId, sessionId), textHash(meetingLines(view))) };
};

// The version of a meeting its chunks are made of (its createdAt), null for the session's own text or a meeting that's
// gone. Chunks are made again whenever the rows change, so this is the text a citation's moment counts in
export const getIndexedVersion = (db: Db, sourceId: number, sessionId: string) => {
  const { session, transcripts } = readRows(db, sourceId, sessionId);

  return session ? pickText(session, transcripts).version : null;
};
