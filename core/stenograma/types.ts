// The extension's rows as a push or a backup brings them (step 1 of the plan's Sending). The core owns this protocol;
// the extension keeps a copy of these types in helpers/knowledgeBase.ts and checks API_VERSION from /status.
// Fields the core doesn't use are left out: they may be in the JSON, and are kept with the row.
export const API_VERSION = 1;

export interface StenogramaMessage {
  user: string;
  text: string;
  timestamp?: number;
  // Missing on captions saved before chat capture existed. 'mic' and 'system' are the two tracks of a recording
  source?: 'caption' | 'chat' | 'mic' | 'system';
  messageId?: string;
}

export interface Session {
  sessionId: string;
  stenogramaArray: StenogramaMessage[];
  // The name given on the history page or when recording
  customName?: string;
  // The meeting's name in Meet
  meetTitle?: string;
  startDate?: string;
  endDate?: string;
  // Missing on Meet sessions
  origin?: 'meet' | 'recording';
}

// Another transcription of a session's audio; only 'done' ones are sent
export interface Transcript {
  sessionId: string;
  createdAt: number;
  status: 'preparing' | 'transcribing' | 'done' | 'failed';
  messages: StenogramaMessage[];
}

export interface AssistantAnswer {
  sessionId: string;
  createdAt: number;
  kind: 'summary' | 'answer';
  // A summary of a selection has it
  messageCount?: number;
  // "What did I miss?" has it
  missedMinutes?: number;
  text: string;
}

export interface ActionItem {
  sessionId: string;
  createdAt: number;
  what: string;
  who?: string;
  due?: string;
  done: boolean;
}

// A session with all its rows. The core replaces what it had of the session with it, so a row missing here is deleted
export interface SessionBundle {
  session: Session;
  transcripts: Transcript[];
  assistantAnswers: AssistantAnswer[];
  actionItems: ActionItem[];
}
