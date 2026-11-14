import type { ChatAttachment, ChatMessage, ChatRoom } from '../chat/types.ts';
import type { ChatRoomChoice, ChatRoomType } from '../protocol.ts';
import type { RcMessage, RcRoom, RcSubscription } from './api.ts';

// Rocket.Chat's rooms and messages as the knowledge base keeps them (chat/types.ts)

const ROOM_TYPES: Record<string, ChatRoomType> = { c: 'channel', p: 'group', d: 'direct' };

// Livechat rooms (l) are left out: they're customers', not the user's conversations
export const isReadableRoom = (subscription: Pick<RcSubscription, 't'>) => subscription.t in ROOM_TYPES;

// A discussion is a room of its own (prid), named by its title (fname); a direct message by the other people's names
export const toRoom = (subscription: RcSubscription): ChatRoom => ({
  id: subscription.rid,
  type: ROOM_TYPES[subscription.t],
  name: subscription.name,
  title: subscription.fname || subscription.name,
});

export const toRoomChoices = (subscriptions: RcSubscription[], rooms: RcRoom[]): ChatRoomChoice[] => {
  const titles = new Map(subscriptions.map((subscription) => [subscription.rid, subscription.fname || subscription.name]));
  const byId = new Map(rooms.map((room) => [room._id, room]));

  return subscriptions.filter(isReadableRoom).map((subscription) => ({
    id: subscription.rid,
    type: ROOM_TYPES[subscription.t],
    title: subscription.fname || subscription.name,
    parent: subscription.prid ? titles.get(subscription.prid) ?? null : null,
    lastMessageAt: byId.get(subscription.rid)?.lm ? Date.parse(byId.get(subscription.rid)!.lm!) : null,
    members: byId.get(subscription.rid)?.usersCount ?? null,
    stats: null,
  })).sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
};

// A quote is "[ ](link)" in the text, which the server turns into an attachment with the quoted message
const QUOTE_LINK = /\[ \]\([^)\s]*\)\s*/g;
const messageIdOf = (link: string) => /[?&]msg=([^&#]+)/.exec(link)?.[1];

// Null for what isn't a message of a person: system messages (t), deleted ones shown as such (rm), end-to-end
// encrypted ones (e2e), whose text the server can't read, and old versions of an edited one (_hidden)
export const toChatMessage = (message: RcMessage): ChatMessage | null => {
  if (message.t || message._hidden) {
    return null;
  }

  const attachments = message.attachments ?? [];
  const quotes = attachments.filter((attachment) => attachment.message_link).map((attachment) => ({
    author: attachment.author_name || '?',
    text: attachment.text ?? '',
    messageId: messageIdOf(attachment.message_link!),
  }));
  const fileAttachments = attachments.filter((attachment) => attachment.type === 'file');
  // An image's thumbnail is a file of its own, left out
  const uploads = (message.files ?? (message.file ? [message.file] : []))
    .filter((file) => file.typeGroup !== 'thumb' && !file.name.startsWith('thumb-'));
  const files = [...new Set([
    ...uploads.map((file) => file.name),
    ...fileAttachments.map((attachment) => attachment.title).filter((title): title is string => Boolean(title)),
  ])];
  const captions = fileAttachments.map((attachment) => attachment.description?.trim()).filter(Boolean);
  const sent = uploads.map((file): ChatAttachment => ({
    id: file._id,
    name: file.name,
    ...(file.type && { type: file.type }),
    ...(file.size ? { size: file.size } : {}),
    path: `/file-upload/${encodeURIComponent(file._id)}/${encodeURIComponent(file.name)}`,
  }));
  const text = [(message.msg ?? '').replace(QUOTE_LINK, '').trim(), ...captions].filter(Boolean).join('\n');

  // The most given first
  const reactions = Object.entries(message.reactions ?? {})
    .map(([emoji, { usernames }]) => ({ emoji: emoji.replace(/^:|:$/g, ''), usernames }))
    .filter((reaction) => reaction.usernames.length)
    .sort((a, b) => b.usernames.length - a.usernames.length);

  if (!text && !quotes.length && !files.length) {
    return null;
  }

  return {
    id: message._id,
    roomId: message.rid,
    ...(message.tmid && { threadId: message.tmid }),
    ts: Date.parse(message.ts),
    author: message.u.name || message.u.username,
    username: message.u.username,
    ...(reactions.length && { reactions }),
    text,
    ...(quotes.length && { quotes }),
    ...(files.length && { files }),
    ...(sent.length && { attachments: sent }),
    ...(message.tcount && { startsThread: true }),
    ...(message.editedAt && { edited: true }),
  };
};
