// The app's protocol (M3): what the renderer asks of the main process and the core, and the events it gets back.
// Types only and no imports, so the renderer's TypeScript project reads this file too.
//
// renderer ──window.kb (preload, IPC)──▶ main ──MessagePort──▶ core (utilityProcess: core/service.ts)

export type LlmProvider = 'groq' | 'gemini' | 'anthropic' | 'ollama-cloud' | 'openai' | 'ollama';
export type EmbeddingProviderName = 'ollama' | 'gemini';
// The providers whose keys the app keeps in the keyring; Gemini's serves its embeddings too. Anthropic's is Claude;
// Ollama Cloud's is Ollama's API at ollama.com, a cloud provider like the others (F8). An OpenAI-compatible API's
// (Cerebras, OpenRouter, Mistral…) is kept by its address: there may be several
export type KeyProvider = 'groq' | 'gemini' | 'anthropic' | 'ollama-cloud' | 'openai';

export interface LlmSettings {
  provider: LlmProvider;
  model: string;
  ollamaUrl: string;
}

// An Ollama server and an OpenAI-compatible API are known by their address (`url`; an LlmSettings's `ollamaUrl`), the
// others by their provider
export type AiServerKind = 'ollama' | 'groq' | 'gemini' | 'anthropic' | 'ollama-cloud' | 'openai';

// Where the models run, in the order the chat tries them: an Ollama-compatible server (this computer's Ollama, an
// Orange Pi's RKLLama through an SSH tunnel), known by its address, or Groq's or Gemini's API with its key in the
// keyring. The first reached with a text model answers the chat; every one with the queue on takes the background work
export interface AiServer {
  name: string;
  kind: AiServerKind;
  // Ollama's API; empty for a cloud provider
  url: string;
  // Its model for text (answers, summaries, drafts) and for images; empty for none
  text: string;
  images: string;
  // Takes the background work: summaries, drafts, images (a cloud provider only of the sources that may go there, F8)
  queue: boolean;
}

export interface EmbeddingSettings {
  provider: EmbeddingProviderName;
  model: string;
  ollamaUrl: string;
}

// A piece of the background AI work being done now: a meeting's summary, an image read, a reply draft
export interface WorkNow {
  // A meeting's title, an image's name, a draft's conversation
  title: string;
  // Its room, its day
  detail: string | null;
  startedAt: number;
  // e.g. qwen3.5-4b, on Orange Pi
  model: string;
  server: string;
  // A summary's model calls: those done of all (the parts' notes, then the summary)
  step?: { done: number, all: number };
}

export type BackgroundTask = 'summaries' | 'images' | 'drafts';

// Why a task's work waits while some is to do, on every server that takes it (server names the first): what the user
// asked for goes first there, or another task's work (drafts, then images, then summaries); the work is paused; the
// server isn't reached, tried again at retryAt; its model doesn't read images, tried again at retryAt or when the
// settings change; no server takes it (none with the queue on has a model for it)
export interface TaskWait {
  reason: 'answer' | BackgroundTask | 'paused' | 'unreachable' | 'noVision' | 'noServer' | 'limited' | 'refused';
  server: string;
  retryAt: number | null;
  // Refused: what the server said (a wrong key, no credits, a model it hasn't)
  error?: string;
}

// A server whose queue takes a task's work, as the task's row on Activity tells it: the one it does now, or why not
// while some waits (null when nothing is in the way), and how fast its model is
export interface TaskServer {
  name: string;
  work: WorkNow | null;
  wait: TaskWait | null;
  // The average time of its model's last ones (a summary, an image, a draft), null before one was timed
  averageMs: number | null;
  // Output tokens a second of its last summary, when the provider counts them
  tokensPerSecond: number | null;
}

// Chat files whose content is read (F3): images by a vision model, documents without one
export interface AttachmentSettings {
  describeImages: boolean;
  // A PDF's text layer, a text file
  readDocuments: boolean;
  // Files of the last this many months are read; 0 for all
  months: number;
}

// Short summaries made in the background for the meetings of a named series (stenograma/series.ts), so a question about
// many of them is answered from one each
export interface SummarySettings {
  auto: boolean;
  // Meetings of the last this many months; 0 for all
  months: number;
}

// Which messages get a reply draft by their age (F9): when drafts are turned on, the unread ones of the last this many
// days; and none older than this many days, as when the app was off
export interface DraftSettings {
  unreadDays: number;
  maxAgeDays: number;
  // How the user writes, for the drafts' model: made by "Describe my style" and edited by the user; empty for none
  style: string;
}

// What the drafts learn the user's style from: their replies, and the drafts they answered (with how
// many were sent as written)
export interface DraftLearning {
  replies: number;
  answered: number;
  asWritten: number;
}

export interface Settings {
  // In the chat's order; Groq and Gemini are always there
  servers: AiServer[];
  attachments: AttachmentSettings;
  summaries: SummarySettings;
  drafts: DraftSettings;
  // The index's model: one, as vectors of two models can't be compared
  embedding: EmbeddingSettings;
  // The API for the extension, on 127.0.0.1 (N2)
  server: { port: number };
  // Set in the tray's menu
  app: { startAtLogin: boolean };
}

// The browser a paired browser source is, for its icon: chosen when it's added, else guessed from its label
export type BrowserKind = 'chrome' | 'firefox' | 'edge' | 'brave' | 'opera' | 'other';

export interface SourceInfo {
  id: number;
  // stenograma-browser, stenograma-backup; later outlook, gmail, telegram...
  kind: string;
  // A browser's label, a backup's file name, an account
  account: string | null;
  // A browser source's browser; null for the others
  browser: BrowserKind | null;
  cloudAllowed: boolean;
  documents: number;
  chunks: number;
  // Its meetings indexed (their summaries are documents too)
  meetings: number;
  lastSyncAt: number | null;
  lastError: string | null;
  // A browser's meetings that another browser sent too, indexed from that browser's copy
  indexedElsewhere: number;
  // Those by the source whose copy is indexed
  copiesIn: { sourceId: number, meetings: number }[];
  // When a browser last called the API, a push or a check that found nothing new; lastSyncAt is its last push
  lastSeenAt: number | null;
  // Its meetings: the newest, the oldest's start, those with a short summary and those of a named series
  latestMeeting: { title: string, createdAt: number } | null;
  firstMeetingAt: number | null;
  summarized: number;
  inSeries: number;
  // Its chunks waiting for the embedding model
  embeddingsPending: number;
  // A messenger's: whether new messages to the user get a reply draft (F9)
  repliesEnabled: boolean;
  // A connector's source (Rocket.Chat): what it reads, and its sync; null for the others
  connector: ConnectorInfo | null;
}

export interface ConnectorInfo {
  // e.g. "olena on chat.example.com · 12 rooms"
  detail: string;
  // What the knowledge base has of it, e.g. "18,304 messages · 1,203 threads · 120 images, 98 read"
  summary: string | null;
  running: boolean;
  // While it runs, e.g. "3 of 12 rooms, 1200 messages"
  progress: string | null;
  // When it syncs next, while it doesn't run
  nextAt: number | null;
  // What the last run's error was, for what to do about it: the token refused or missing, the server not reached
  problem: SyncProblem | null;
  // Its new messages arrive as they're sent (Rocket.Chat's realtime API connected); null for a source not watched
  live: boolean | null;
}

export type SyncProblem = 'auth' | 'network' | 'other';

// Messengers (F3)
export type ChatRoomType = 'channel' | 'group' | 'direct';

// A room the user is in, to choose from
export interface ChatRoomChoice {
  id: string;
  type: ChatRoomType;
  title: string;
  // A discussion's room
  parent: string | null;
  lastMessageAt: number | null;
  // As the server counts them
  members: number | null;
  // What the knowledge base has of it, for a room it reads
  stats: ChatRoomStats | null;
}

export interface ChatRoomStats {
  messages: number;
  threads: number;
  // Messages with reactions
  reacted: number;
  images: number;
  imagesRead: number;
  files: number;
  filesRead: number;
  // When it was last read, or checked for edits
  checkedAt: number | null;
}

// The rooms a messenger source reads: those chosen, or all the user is in of some types, rooms joined later too
export type RoomSelection = { mode: 'chosen', ids: string[] } | { mode: 'all', types: ChatRoomType[] };

export interface ImageChoice {
  sourceId: number;
  fileId: string;
  name: string;
  ts: number;
  room: string;
}

export interface ImageTry {
  text: string | null;
  description: string | null;
  // e.g. ollama qwen3.5:9b
  model: string;
  ms: number;
}

// A Rocket.Chat Personal Access Token with its user's id (My Account → Personal Access Tokens)
export interface RocketChatAccess {
  serverUrl: string;
  userId: string;
  token: string;
}

// How hard a source may work its server
export interface SyncLimits {
  // A sync this often
  intervalMinutes: number;
  // Calls of each kind a minute, at most: Rocket.Chat allows 10 by default per IP address, which colleagues on the same
  // network share
  requestsPerMinute: number;
  // Between two files fetched in the background
  filePauseSeconds: number;
}

export interface RocketChatSetup {
  selection: RoomSelection;
  // Messages from then on are read: milliseconds, 0 for all
  since: number;
  limits: SyncLimits;
}

// A message's file whose content is read: an image's text and what it shows (by a vision model), a document's text
export interface ChatAttachmentView {
  id: string;
  name: string;
  kind: 'image' | 'document';
  state: 'pending' | 'done' | 'failed' | 'skipped';
  description: string | null;
  text: string | null;
}

export interface ChatMessageView {
  id: string;
  author: string;
  ts: number;
  text: string;
  quotes: { author: string, text: string }[];
  files: string[];
  attachments: ChatAttachmentView[];
  // Emoji shortcodes, the most given first, with who reacted
  reactions: { emoji: string, names: string[] }[];
  edited: boolean;
  // The thread this message started, to open
  threadDocumentId: string | null;
}

// A cited conversation from the knowledge base's own copy: a room's day, or a thread
export interface ConversationView {
  documentId: string;
  sourceId: number;
  sourceKind: string;
  kind: 'day' | 'thread';
  title: string;
  // e.g. #general, direct: Olena Koval
  room: string;
  // The room's members, as last read
  members: string[];
  createdAt: number;
  messages: ChatMessageView[];
  // The cited chunk's messages, by index
  cited: { first: number, last: number } | null;
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

// Chat files whose content is read, of the period set
export interface AttachmentStatus {
  pending: number;
  done: number;
  // Failed or left out (too large, a scanned PDF)
  failed: number;
  running: boolean;
  // The last run's error; it's tried again after a while
  error: string | null;
  // The background AI work (images, summaries) paused, until then or until resumed (until null); documents are still
  // read
  paused: { until: number | null } | null;
  // The images: those waiting, the servers reading them (each with the one it reads now), why none is read while some
  // wait
  images: { pending: number, servers: TaskServer[], waiting: TaskWait | null };
}

// The short summaries of named series' meetings, of the period set
export interface SummaryStatus {
  pending: number;
  done: number;
  running: boolean;
  // The servers summarizing the meetings in the background, each with the one it makes now
  servers: TaskServer[];
  // Failed or without text in this run of the core: tried again after a restart
  skipped: number;
  // The last background summary's error
  error: string | null;
  // Why none is being made while some wait
  waiting: TaskWait | null;
}

// Reply drafts (F9): those to review, those still to write, and the one being written
export interface DraftStatus {
  ready: number;
  waiting: number;
  writing: boolean;
  // The last one's error
  error: string | null;
  // The servers writing them, each with the one it writes now; why none is written while some wait
  servers: TaskServer[];
  wait: TaskWait | null;
}

// Why a message got a draft: a direct message, a mention by name, or a reply in a thread the user wrote in
export type DraftReason = 'direct' | 'mention' | 'thread' | 'manual';

export type DraftState = 'waiting' | 'writing' | 'ready' | 'failed';

// A message of the conversation, as the draft's view shows it
export interface DraftMessage {
  id: string;
  author: string;
  text: string;
  ts: number;
  // The user's own
  mine: boolean;
}

// A meeting to try a summary model on (Settings → Meeting summaries)
export interface SummaryTryMeeting {
  sourceId: number;
  sessionId: string;
  title: string;
  createdAt: number;
  // Its lines of text, which the time depends on
  lines: number;
  // Its saved short summary, to compare with
  saved: { text: string, model: string, durationMs: number | null } | null;
}

// A tried summary: its text, and how long it took in how many calls, with the tokens when the provider counts them
export interface SummaryTry {
  llm: string;
  server: string;
  local: boolean;
  text: string;
  ms: number;
  calls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  // Output tokens a second of the calls' time
  tokensPerSecond: number | null;
  // Background work (a summary, an image) ran meanwhile on the same model or GPU, so the time is longer than alone
  shared: boolean;
}

// A conversation a draft can be asked for: a room's main line or a thread, with its last message
export interface DraftableConversation {
  sourceId: number;
  roomId: string;
  threadId: string | null;
  conversation: string;
  last: { author: string, text: string, ts: number };
  // An open draft of it already
  drafted: boolean;
}

// A reply draft to review (Drafts page): the message it answers with the messages before it, and the draft with the
// sources it was given, cited as [n]
export interface DraftView {
  id: number;
  sourceId: number;
  // "#general", "direct: Olena", with "› thread" for a thread
  conversation: string;
  reason: DraftReason;
  state: DraftState;
  // The last few messages, the one answered last
  messages: DraftMessage[];
  text: string;
  sources: CitedSource[];
  llm: string | null;
  // The server it's written on, by its name: "orangepi"
  server: string | null;
  local: boolean;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  // While it waits: how many are written before it
  ahead: number;
  // Asked for by the user ("Draft a reply…", "Write again"): written while the background work is paused too
  asked: boolean;
}

// Where each task's model runs, and whether the servers answer, for Activity and the tray
// What a model call was for: an answer and the rewrite of its question, a meeting's summary (each of its calls), a reply
// draft, an image read, the style's description, chunks embedded, a search's question embedded
export type AiTask = 'answer' | 'rewrite' | 'summary' | 'draft' | 'image' | 'style' | 'embedding' | 'search';

// The totals of model calls: the time is their sum, so calls at once on two servers count twice
export interface UsageRow {
  calls: number;
  // Of them, made by the background work
  background: number;
  ms: number;
  inputTokens: number;
  outputTokens: number;
  // Output tokens a second of the calls that counted them
  tokensPerSecond: number | null;
  // Chunks embedded, images read: a call each else
  items: number;
  errors: number;
}

// The AI's work since then (all of it for null), kept from the first call on
export interface AiUsage {
  since: number | null;
  first: number | null;
  total: UsageRow;
  tasks: (UsageRow & { task: AiTask })[];
  // serverId: an Ollama server's address, else the provider, to list its errors
  models: (UsageRow & { provider: string, model: string, server: string, serverId: string })[];
}

// The errors to list: since then (all for null), of a task or of a model on a server (serverId), or all of them
export interface AiErrorsQuery {
  since: number | null;
  task?: AiTask | null;
  model?: { provider: string, model: string, server: string } | null;
}

// The calls of a period by what they worked on (a meeting's summary takes several), the newest first
export interface AiCallGroup {
  // Its ids, to open its result: meeting:sourceId:sessionId, draft:id, file:sourceId:fileId, turn:id
  item: string;
  // A meeting's title, a draft's conversation, an image's name, a question; null when it's gone
  title: string | null;
  task: AiTask;
  provider: string;
  model: string;
  server: string;
  calls: number;
  ms: number;
  inputTokens: number;
  outputTokens: number;
  errors: number;
  lastAt: number;
}

// What a call made, as it's kept now (a summary made again, an image read again, shows the latest)
export type AiCallResult =
  | { kind: 'summary', text: string, model: string, sourceId: number, sessionId: string, title: string, createdAt: number }
  | { kind: 'draft', text: string, state: string, conversation: string }
  | { kind: 'image', description: string | null, text: string | null, name: string }
  | { kind: 'answer', question: string, text: string, chatId: number }
  // None made yet: being made now, failed (tried again after a restart), or waiting in the queue
  | { kind: 'none', reason: 'working' | 'failed' | 'waiting' };

// A failed model call: its kind, and what it said (cut short; none before 2026-11-14's errors were kept)
export interface AiError {
  startedAt: number;
  ms: number;
  task: AiTask;
  provider: string;
  model: string;
  server: string;
  error: 'unreachable' | 'timeout' | 'aborted' | 'failed';
  message: string | null;
  background: boolean;
  // What it worked on: a meeting's title, a draft's conversation, an image's name and room; null when not kept, or gone
  item: string | null;
}

// What a server (or a cloud provider with background work) does now, and the background work waiting for it
export interface LaneActivity {
  name: string;
  // serverId: its address, or the cloud provider
  id: string;
  kind: AiServerKind;
  // Null for a cloud provider, or a server not asked yet
  reachable: boolean | null;
  // Its queue on, and what of the background work it can take (a text model: summaries and drafts; images)
  queue: boolean;
  takes: BackgroundTask[];
  now: { task: BackgroundTask, work: WorkNow } | null;
  // Busy with what the user asked for: an answer, a summary, a draft asked for
  asked: boolean;
  // Not reached, tried again then
  retryAt: number | null;
  // A cloud provider at its rate limit, or about to be: until then, and whether it's the day's quota
  limited: { until: number, daily: boolean } | null;
}

export interface AiStatus {
  // A server each, in the settings' order
  lanes: LaneActivity[];
  // The chat's model now: the first server reached with a text model
  answers: { model: string, server: string } | null;
}

export interface CoreStatus {
  kbId: string;
  ai: AiStatus;
  dataDir: string;
  sources: SourceInfo[];
  embedding: EmbeddingStatus;
  attachments: AttachmentStatus;
  summaries: SummaryStatus;
  drafts: DraftStatus;
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
}

export interface SearchFilters {
  // A source kind or its family (stenograma)
  sourceKind?: string;
  // Milliseconds; from inclusive, to exclusive
  from?: number;
  to?: number;
  person?: string;
  // A chat room, by its name as said
  room?: string;
  // A meeting series, by its name
  series?: string;
}

// What the rewrite takes from a question besides the query
export type RewriteFilter = 'dates' | 'person' | 'room' | 'rank' | 'series';

// A meeting in a source's list (Sources → its "Meetings"), opened by its source and session
export interface SourceMeeting {
  sessionId: string;
  title: string;
  createdAt: number;
  // The source whose copy is indexed: another browser's, when it sent the meeting too
  indexedIn: number;
  series: string | null;
  summarized: boolean;
}

// A meeting series's meetings: those of a Meet code, or of a weekday and time (with a tolerance), in a period. The most
// specific matcher that fits a meeting wins
export interface SeriesMatcher {
  code?: string;
  // 0 Sunday … 6 Saturday
  weekdays?: number[];
  // HH:MM, local
  time?: string;
  // Minutes either side of the time
  tolerance?: number;
  from?: number;
  to?: number;
}

export interface MeetingSeries {
  id: number;
  name: string;
  matchers: SeriesMatcher[];
}

export interface MeetingSeriesInfo extends MeetingSeries {
  meetings: number;
  // Of them, with a short summary
  summarized: number;
  lastAt: number | null;
}

// The meetings of a Meet code, to name as a series
export interface SeriesSuggestion {
  code: string;
  meetings: number;
  // The weekday and the time (to 15 minutes) most of them have, with their shares
  weekday: number;
  weekdayShare: number;
  time: string;
  timeShare: number;
  firstAt: number;
  lastAt: number;
  // Who speaks most
  participants: string[];
  // The series most of them are in now
  seriesId: number | null;
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
  // meeting, meeting-summary, meeting-actions; chat (a room's day), chat-thread
  documentKind: string;
  // A meeting's session id, a chat's room id
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
  | { kind: 'request', query: string, from?: number, to?: number, person?: string, room?: string, rank?: 'reactions', series?: string }
  // server: where it answers, by its name ("orangepi"); missing in turns saved before it was kept
  | { kind: 'sources', sources: CitedSource[], leftOut: number, warning?: string, llm: string, local: boolean, server?: string }
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
  // The model its last question went to; null for the settings' one
  llm: LlmSettings | null;
  turns: SavedTurn[];
}

// The models listed apart from the chat's: the vision model's and the embeddings'
export type ModelTask = 'images' | 'embeddings';

// A model a chat's questions can go to
export interface ModelChoice {
  provider: LlmProvider;
  model: string;
  // Ollama's and an OpenAI-compatible API's: the server it's on
  ollamaUrl?: string;
  server?: string;
  // Ollama on this computer: it sees every source (F8)
  local: boolean;
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
  | { kind: 'progress', done: number, all: number, llm: string, local: boolean, server?: string }
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
  // The question goes to llm, the chat's model from then on; null for the settings' one. What the rewrite takes from
  // the question but `without` is used, to ask again without a filter it made up
  ask: {
    params: { askId: string, chatId: number | null, question: string, filters: SearchFilters, llm: LlmSettings | null, without?: RewriteFilter[] },
    result: { chatId: number },
  };
  // The models a chat can use: Ollama's that answer, and Groq's and Gemini's when their key is in the keyring
  chatModels: { params: NoParams, result: ModelChoice[] };
  cancelAsk: { params: { askId: string }, result: null };
  chats: { params: NoParams, result: ChatSummary[] };
  chat: { params: { chatId: number }, result: SavedChat | null };
  deleteChat: { params: { chatId: number }, result: null };
  meeting: { params: { sourceId: number, sessionId: string }, result: MeetingView | null };
  // A browser's or a backup's meetings, the newest first
  sourceMeetings: { params: { sourceId: number }, result: SourceMeeting[] };
  // Starts a short summary of a meeting; its parts come as summary events. A source without cloudAllowed gets it from
  // Ollama when a cloud LLM is chosen (F8)
  summarize: { params: { summaryId: string, sourceId: number, sessionId: string }, result: null };
  cancelSummary: { params: { summaryId: string }, result: null };
  // The token is shown once: the knowledge base keeps only its hash
  addBrowser: { params: { label: string, browser?: BrowserKind }, result: { sourceId: number, token: string } };
  // A paired browser's label and browser
  updateBrowser: { params: { sourceId: number, label: string, browser: BrowserKind }, result: null };
  // A paired browser's new token, shown once too: the old one stops working, the source and its meetings stay
  renewBrowserToken: { params: { sourceId: number }, result: { token: string } };
  removeSource: { params: { sourceId: number }, result: null };
  // Checks a token and lists the user's rooms, before the source is added
  rocketChatCheck: { params: RocketChatAccess, result: { user: string, rooms: ChatRoomChoice[] } };
  addRocketChat: { params: RocketChatAccess & RocketChatSetup, result: { sourceId: number } };
  // The rooms to choose from now, with what the source reads
  rocketChatRooms: { params: { sourceId: number }, result: RocketChatSetup & { rooms: ChatRoomChoice[] } };
  // Changes the rooms or the period read, and the token when one is given
  updateRocketChat: { params: RocketChatSetup & { sourceId: number, token?: string }, result: null };
  // A new token when the old one is refused, checked as the same user's, then a sync
  setRocketChatToken: { params: { sourceId: number, token: string }, result: null };
  syncSource: { params: { sourceId: number }, result: null };
  conversation: { params: { documentId: string, startMs: number | null }, result: ConversationView | null };
  // A chat image as a data: URL, from the knowledge base's copy, else fetched now; null when it can't be had
  attachmentImage: { params: { sourceId: number, fileId: string }, result: string | null };
  // The latest images of the chats, to try a vision model on
  recentImages: { params: NoParams, result: ImageChoice[] };
  // Reads an image with a model, as a try: nothing is kept
  tryImageModel: { params: { sourceId: number, fileId: string, model: LlmSettings }, result: ImageTry };
  // The meetings a summary model can be tried on, the newest first
  summaryTryMeetings: { params: NoParams, result: SummaryTryMeeting[] };
  // A meeting's short summary by a model, to compare models: nothing is kept. Stopped with cancelSummary (its tryId)
  trySummary: { params: { tryId: string, sourceId: number, sessionId: string, llm: LlmSettings }, result: SummaryTry };
  // A task's models on every server and Gemini's with its key: those that read images, or that embed; the settings'
  // one first though its server isn't reached
  taskModels: { params: { task: ModelTask }, result: ModelChoice[] };
  // The statistics of the AI's work since then, or of all of it
  aiUsage: { params: { since: number | null }, result: AiUsage };
  // The failed calls of a period, the newest 100
  aiErrors: { params: AiErrorsQuery, result: AiError[] };
  // The calls of a period by what they worked on, the newest 100; and what one made, null when it's gone
  aiCalls: { params: AiErrorsQuery, result: AiCallGroup[] };
  aiCallResult: { params: { item: string }, result: AiCallResult | null };
  // The failed calls the errors list shows, deleted: how many
  deleteAiErrors: { params: AiErrorsQuery, result: { deleted: number } };
  // Every image is read again, with the model set now
  readImagesAgain: { params: NoParams, result: { images: number } };
  // Stops the background AI work (images, summaries) for some minutes, or until resumed (null): the one running is
  // stopped, and Ollama's models let go of
  pauseBackground: { params: { minutes: number | null }, result: null };
  resumeBackground: { params: NoParams, result: null };
  // The named meeting series with their counts, and the meetings by Meet code to name
  meetingSeries: { params: NoParams, result: { series: MeetingSeriesInfo[], suggestions: SeriesSuggestion[] } };
  saveMeetingSeries: { params: { id?: number, name: string, matchers: SeriesMatcher[] }, result: { id: number } };
  deleteMeetingSeries: { params: { id: number }, result: null };
  setCloudAllowed: { params: { sourceId: number, allowed: boolean }, result: null };
  // A messenger's new messages to the user get reply drafts from then on, with its unread ones of the last day
  setRepliesEnabled: { params: { sourceId: number, enabled: boolean }, result: null };
  // The drafts to review or being written, the newest first
  drafts: { params: NoParams, result: DraftView[] };
  // Dismissed: gone from the list. Written again: back in the queue, first
  draftAction: { params: { draftId: number, action: 'dismiss' | 'rewrite' }, result: null };
  draftLink: { params: { draftId: number }, result: string };
  // A messenger's conversations with messages of the last days, the latest first, for a draft asked for by hand
  draftableConversations: { params: NoParams, result: DraftableConversation[] };
  // A draft of a reply to a conversation's last message from someone else, whatever the rules say
  requestDraft: { params: { sourceId: number, roomId: string, threadId: string | null }, result: null };
  draftLearning: { params: NoParams, result: DraftLearning };
  // A server's models for text and for images, to check it and choose them in Settings (saved or not); a cloud
  // provider's with its key
  // error: what a cloud provider said when it refused (a wrong key)
  serverModels: { params: { kind: AiServerKind, url: string }, result: { reachable: boolean, text: string[], images: string[], error?: string } };
  // A saved server's queue on or off (the tray, Activity): server is its serverId
  setServerQueue: { params: { server: string, queue: boolean }, result: null };
  // A description of the user's style from their messages, by the answers' model (Ollama's for chats that may not go
  // to cloud AI); not saved: Settings shows it to edit
  describeStyle: { params: NoParams, result: string };
  // The embedding model is the one chosen, also while it's still being built
  getSettings: { params: NoParams, result: Settings };
  saveSettings: { params: Settings, result: Settings };
  // Whether each key is in the keyring; read only when asked, as the keyring may be locked right after login (N1)
  // Whether each provider's key is in the keyring: by provider, and an OpenAI-compatible API's by "openai:<address>"
  // for the addresses given
  keys: { params: { urls?: string[] }, result: Record<string, boolean> };
  // An OpenAI-compatible API's key is its address's
  setKey: { params: { provider: KeyProvider, key: string, url?: string }, result: null };
  deleteKey: { params: { provider: KeyProvider, url?: string }, result: null };
  // For the main process only: the link that opens a browser's meeting in its extension
  stenogramaLink: { params: { sourceId: number, sessionId: string, startMs: number | null }, result: string };
  // For the main process only: the link to a message in its messenger
  chatLink: { params: { documentId: string, messageId: string }, result: string };
}

// What the renderer may call: the core's methods but the links, with the main process's status and its own methods
export interface AppMethods extends Omit<CoreMethods, 'status' | 'stenogramaLink' | 'chatLink' | 'draftLink'> {
  status: { params: NoParams, result: AppStatus };
  openInStenograma: { params: { sourceId: number, sessionId: string, startMs: number | null }, result: null };
  openInChat: { params: { documentId: string, messageId: string }, result: null };
  // The message a draft answers, in the messenger
  openDraftInChat: { params: { draftId: number }, result: null };
  // Starts the core now instead of waiting for its next restart
  restartCore: { params: NoParams, result: null };
}

export type CoreEvent =
  | { type: 'status', status: CoreStatus }
  | { type: 'ask', askId: string, part: AskPart }
  | { type: 'summary', summaryId: string, part: SummaryPart };

export type AppEvent =
  | { type: 'status', status: AppStatus }
  // From the main process: a page to show, as when a notification is clicked
  | { type: 'navigate', page: 'drafts' }
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
