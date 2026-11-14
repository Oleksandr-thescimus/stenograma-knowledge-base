// Dates and moments as people read them: local time

export const formatDay = (ms: number) => {
  if (!ms) {
    return 'unknown date';
  }

  const date = new Date(ms);

  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

// " at 12:34" into a meeting, or nothing when the chunk has no start
export const formatMoment = (ms: number | null | undefined) => {
  if (ms === null || ms === undefined) {
    return '';
  }

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);

  return ` at ${minutes}:${String(seconds % 60).padStart(2, '0')}`;
};

// The emoji of a reaction's common shortcodes (Rocket.Chat's, as Slack's); another one stays :code:
const EMOJI: Record<string, string> = {
  '+1': '👍', thumbsup: '👍', '-1': '👎', thumbsdown: '👎', heart: '❤️', joy: '😂', rofl: '🤣', smile: '😄', smiley: '😃',
  grinning: '😀', laughing: '😆', sweat_smile: '😅', slight_smile: '🙂', wink: '😉', heart_eyes: '😍', sunglasses: '😎',
  thinking: '🤔', cry: '😢', sob: '😭', scream: '😱', white_check_mark: '✅', heavy_check_mark: '✔️', ballot_box_with_check: '☑️',
  x: '❌', warning: '⚠️', eyes: '👀', fire: '🔥', tada: '🎉', pray: '🙏', ok_hand: '👌', clap: '👏', muscle: '💪',
  raised_hands: '🙌', handshake: '🤝', rocket: '🚀', 100: '💯', star: '⭐', point_up: '☝️', saluting_face: '🫡',
  heavy_plus_sign: '➕', question: '❓', exclamation: '❗',
};

export const emojiOf = (shortcode: string) => EMOJI[shortcode] ?? `:${shortcode}:`;

// Messenger documents (chat/store.ts): a room's day, a thread
export const isChatDocument = (documentKind: string) => ['chat', 'chat-thread', 'chat-file'].includes(documentKind);

const clock = (date: Date) => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

// Where a chunk starts: " at 12:34" into a meeting; in a chat the time of day, and the day too when a thread goes on
// after the day it started
export const formatChunkStart = (chunk: { documentKind: string, createdAt: number, startMs: number | null }) => {
  if (!isChatDocument(chunk.documentKind) || chunk.startMs === null) {
    return formatMoment(chunk.startMs);
  }

  const at = chunk.createdAt + chunk.startMs;
  const day = formatDay(at);

  return day === formatDay(chunk.createdAt) ? ` at ${clock(new Date(at))}` : ` on ${day} at ${clock(new Date(at))}`;
};
