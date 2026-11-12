// The app's protocol (M3): what the renderer asks of the main process and the core, and the events it gets back.
// Types only and no imports, so the renderer's TypeScript project reads this file too.
//
// renderer ──window.kb (preload, IPC)──▶ main ──MessagePort──▶ core (utilityProcess: core/service.ts)

export type LlmProvider = 'groq' | 'gemini' | 'ollama';
export type EmbeddingProviderName = 'ollama' | 'gemini';
// The providers whose keys the app keeps in the keyring; Gemini's serves its embeddings too
export type KeyProvider = 'groq' | 'gemini';

export interface LlmSettings {
  provider: LlmProvider;
  model: string;
  ollamaUrl: string;
}

export interface EmbeddingSettings {
  provider: EmbeddingProviderName;
  model: string;
  ollamaUrl: string;
}

export interface Settings {
  embedding: EmbeddingSettings;
  llm: LlmSettings;
  // The API for the extension, on 127.0.0.1 (N2)
  server: { port: number };
  app: { startAtLogin: boolean };
}

export interface SourceInfo {
  id: number;
  // stenograma-browser, stenograma-backup; later outlook, gmail, telegram...
  kind: string;
  // A browser's label, a backup's file name, an account
  account: string | null;
  cloudAllowed: boolean;
  documents: number;
  chunks: number;
  lastSyncAt: number | null;
  lastError: string | null;
  // A browser's meetings that another browser sent too, indexed from that browser's copy
  indexedElsewhere: number;
}

export interface EmbeddingStatus {
  // The model the search uses, e.g. ollama:bge-m3
  model: string;
  // Chunks it still has to embed (of sources with cloudAllowed only, for a cloud model)
  pending: number;
  running: boolean;
  // The last run's error; the queue is tried again after a while
  error: string | null;
  // A model being built in the background after a change (F7); the search switches to it when it's done
  rebuild: { model: string, pending: number, total: number } | null;
}

export interface ServerStatus {
  port: number;
  listening: boolean;
  error: string | null;
}

export interface CoreStatus {
  kbId: string;
  dataDir: string;
  sources: SourceInfo[];
  embedding: EmbeddingStatus;
  server: ServerStatus;
}

// The core's process, as the main process sees it
export interface ProcessStatus {
  state: 'starting' | 'running' | 'restarting' | 'stopped';
  // Why it last stopped: the core's own error (the lock taken by kb serve) or its exit code
  error: string | null;
  restarts: number;
  // When it starts again, while restarting
  retryAt: number | null;
}

export interface AppStatus {
  process: ProcessStatus;
  // The core's last status; null until it first starts
  core: CoreStatus | null;
  // Only a packaged app writes the autostart file
  canStartAtLogin: boolean;
}

export interface SearchFilters {
  // A source kind or its family (stenograma)
  sourceKind?: string;
  // Milliseconds; from inclusive, to exclusive
  from?: number;
  to?: number;
  person?: string;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface CitedSource {
  n: number;
  chunkId: number;
  documentId: string;
  sourceId: number;
  sourceKind: string;
  // meeting, meeting-summary, meeting-actions
  documentKind: string;
  // A meeting's session id
  threadId: string | null;
  title: string;
  createdAt: number;
  // From the meeting's first message
  startMs: number | null;
  madeByAi: boolean;
  // Empty in a saved chat when the chunk is gone, as after the meeting was sent again
  text: string;
  // In a saved chat: the document is gone (removed in its browser, or with its source), so it no longer opens
  removed?: boolean;
}

// An answer arrives in parts, as events
export type AskPart =
  // What the rewrite made of the question, with the filters set by hand applied
  | { kind: 'request', query: string, from?: number, to?: number, person?: string }
  | { kind: 'sources', sources: CitedSource[], leftOut: number, warning?: string, llm: string, local: boolean }
  | { kind: 'text', text: string }
  | { kind: 'done' }
  | { kind: 'error', message: string };

// The chats are kept with the knowledge base (core/chats.ts)
export interface ChatSummary {
  id: number;
  title: string;
  updatedAt: number;
}

export interface SavedTurn {
  id: number;
  question: string;
  request: Extract<AskPart, { kind: 'request' }> | null;
  sources: Extract<AskPart, { kind: 'sources' }> | null;
  answer: string;
  // running while its answer comes (it's saved when done)
  state: 'running' | 'done' | 'error';
  error: string | null;
  createdAt: number;
}

export interface SavedChat {
  id: number;
  title: string;
  turns: SavedTurn[];
}

export interface MeetingMessage {
  user: string;
  text: string;
  // From the first message with a time, as a chunk's start
  startMs: number | null;
  source?: string;
}

export interface MeetingActionItem {
  what: string;
  who?: string;
  due?: string;
  done: boolean;
}

// A short summary the app made of a meeting ("Summarize" in its view), kept with it
export interface ShortSummary {
  text: string;
  // provider model, e.g. groq openai/gpt-oss-120b
  model: string;
  createdAt: number;
  // The meeting's text changed since
  stale: boolean;
}

// A summary arrives in parts, as events
export type SummaryPart =
  // Calls done of all those needed (more than one for a meeting summarized in parts); all may grow
  | { kind: 'progress', done: number, all: number, llm: string, local: boolean }
  | { kind: 'text', text: string }
  | { kind: 'done', summary: ShortSummary }
  | { kind: 'stopped' }
  | { kind: 'error', message: string };

// A cited meeting from the knowledge base's own copy (The app: meetings in answers)
export interface MeetingView {
  sourceId: number;
  sessionId: string;
  title: string;
  createdAt: number;
  origin: 'meet' | 'recording';
  participants: string[];
  messages: MeetingMessage[];
  // The extension's summary, and the app's own short one
  summary: string | null;
  shortSummary: ShortSummary | null;
  actionItems: MeetingActionItem[];
  // Only a browser's meetings open in the extension
  canOpenInStenograma: boolean;
}

type NoParams = Record<string, never>;

export interface CoreMethods {
  status: { params: NoParams, result: CoreStatus };
  // Starts an answer in a chat, a new one without chatId; its parts come as ask events. The rewrite sees the chat's last
  // exchanges
  ask: { params: { askId: string, chatId: number | null, question: string, filters: SearchFilters }, result: { chatId: number } };
  cancelAsk: { params: { askId: string }, result: null };
  chats: { params: NoParams, result: ChatSummary[] };
  chat: { params: { chatId: number }, result: SavedChat | null };
  deleteChat: { params: { chatId: number }, result: null };
  meeting: { params: { sourceId: number, sessionId: string }, result: MeetingView | null };
  // Starts a short summary of a meeting; its parts come as summary events. A source without cloudAllowed gets it from
  // Ollama when a cloud LLM is chosen (F8)
  summarize: { params: { summaryId: string, sourceId: number, sessionId: string }, result: null };
  cancelSummary: { params: { summaryId: string }, result: null };
  // The token is shown once: the knowledge base keeps only its hash
  addBrowser: { params: { label: string }, result: { sourceId: number, token: string } };
  // A paired browser's new token, shown once too: the old one stops working, the source and its meetings stay
  renewBrowserToken: { params: { sourceId: number }, result: { token: string } };
  removeSource: { params: { sourceId: number }, result: null };
  setCloudAllowed: { params: { sourceId: number, allowed: boolean }, result: null };
  // The embedding model is the one chosen, also while it's still being built
  getSettings: { params: NoParams, result: Settings };
  saveSettings: { params: Settings, result: Settings };
  // Whether each key is in the keyring; read only when asked, as the keyring may be locked right after login (N1)
  keys: { params: NoParams, result: Record<KeyProvider, boolean> };
  setKey: { params: { provider: KeyProvider, key: string }, result: null };
  deleteKey: { params: { provider: KeyProvider }, result: null };
  // For the main process only: the link that opens a browser's meeting in its extension
  stenogramaLink: { params: { sourceId: number, sessionId: string, startMs: number | null }, result: string };
}

// What the renderer may call: the core's methods but the link, with the main process's status and its own methods
export interface AppMethods extends Omit<CoreMethods, 'status' | 'stenogramaLink'> {
  status: { params: NoParams, result: AppStatus };
  openInStenograma: { params: { sourceId: number, sessionId: string, startMs: number | null }, result: null };
  // Starts the core now instead of waiting for its next restart
  restartCore: { params: NoParams, result: null };
}

export type CoreEvent =
  | { type: 'status', status: CoreStatus }
  | { type: 'ask', askId: string, part: AskPart }
  | { type: 'summary', summaryId: string, part: SummaryPart };

export type AppEvent =
  | { type: 'status', status: AppStatus }
  | { type: 'ask', askId: string, part: AskPart }
  | { type: 'summary', summaryId: string, part: SummaryPart };

// Between the main process and the core
export type CoreRequest =
  | { id: number, method: keyof CoreMethods, params: unknown }
  | { stop: true };

export type CoreMessage =
  | { id: number, result: unknown }
  | { id: number, error: string }
  | { event: CoreEvent }
  | { ready: true }
  // It couldn't start (the lock is taken, the database can't be opened) and exits
  | { fatal: string };
