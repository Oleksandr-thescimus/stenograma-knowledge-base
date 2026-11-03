import type { CitedSource, MeetingView } from '../../../../core/protocol';

const lineOf = (message: { user: string, text: string }) => `${message.user}: ${message.text.replace(/\s+/g, ' ').trim()}`;

// The messages the cited chunk holds: found by its first line ("Speaker: text"), else by its start
export const citedRange = (meeting: MeetingView, source: CitedSource) => {
  if (source.documentKind !== 'meeting') {
    return null;
  }

  const lines = source.text.split('\n');
  let first = meeting.messages.findIndex((message) => lineOf(message) === lines[0]);

  if (first < 0 && source.startMs !== null) {
    first = meeting.messages.findIndex((message) => (message.startMs ?? -1) >= source.startMs!);
  }

  return first < 0 ? null : { first, last: first + lines.length - 1 };
};
