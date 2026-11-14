import type { ChatRoomType } from '../protocol.ts';

// A messenger's messages as the knowledge base keeps them (F3), whatever the source: the connector turns its own into
// these, and the chunker and the conversation view read only these

export type { ChatRoomType };

export interface ChatRoom {
  id: string;
  type: ChatRoomType;
  // As in the room's links (Rocket.Chat's name)
  name: string;
  // As people see it: a channel's name, a direct message's other people, a discussion's title
  title: string;
}

// A message quoted in a reply ("reply with quote", or a link to a message pasted in it)
export interface ChatQuote {
  author: string;
  text: string;
  messageId?: string;
}

// A file sent with a message, as the messenger serves it
export interface ChatAttachment {
  // The messenger's file id
  id: string;
  name: string;
  // MIME type, e.g. image/png
  type?: string;
  size?: number;
  // Where the messenger serves it, from its server's address
  path: string;
}

// An emoji reaction to a message: the emoji's shortcode (+1, white_check_mark, or a server's own), and who reacted, by
// username; their names are found when a room's documents are written (chat_users)
export interface ChatReaction {
  emoji: string;
  usernames: string[];
}

export interface ChatMessage {
  id: string;
  roomId: string;
  // A reply in a thread: the id of the thread's first message
  threadId?: string;
  ts: number;
  // The name people see, else the username
  author: string;
  username?: string;
  text: string;
  quotes?: ChatQuote[];
  // File names
  files?: string[];
  // The files themselves, to read an image's text and a document's (chat/attachments.ts)
  attachments?: ChatAttachment[];
  reactions?: ChatReaction[];
  // The first message of a thread with replies
  startsThread?: boolean;
  edited?: boolean;
}
