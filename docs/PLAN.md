# RAG knowledge base (planned)

A personal knowledge base that collects meeting transcripts from StenogramaAI, plus emails and messenger chats, so the
assistant can answer questions across all of them ("what did Olena say about the budget last week", "when did we agree
on the release") and draft replies to new emails and messages.

## Decisions

2026-10-22:

- **Audience: a personal tool.** It isn't published to a store, so it may need its own install or the user's own OAuth
  apps.
- **Sources in v1:** Stenograma meetings, Gmail / Google Workspace, Outlook / Microsoft 365, Microsoft Teams chats,
  Telegram (personal chats), Rocket.Chat. Zoom and WhatsApp / Viber come later.
- **Embeddings:** local by default, a cloud provider when chosen.
- **Stenograma data:** the extension pushes it to the knowledge base when the option is turned on in the popup.

2026-11-02:

- **UI: an Electron desktop app** with the chat, the sources and their status, and the review of reply drafts. The core
  runs inside it, in a `utilityProcess` ([why](#why-electron-with-a-core-of-its-own)).
- **Slack** joins the v1 sources, once M0 shows the workspace allows it.
- **Reply drafts** (M7 and M8, after the RAG): the app drafts replies to new emails and messages from the whole
  knowledge base; nothing is sent until it's approved in the app ([F9](#functional)).
- **Which Stenograma text is indexed:** a Meet call's own text (captions with speaker names, and chat), a recording's
  latest finished transcript version; of AI output, only the latest summary of the whole meeting and the action items
  ([F1](#functional)).
- **Dates and people from the question** are in v1: the call that rewrites follow-up questions returns them too
  ([F6](#functional)).
- **A repository of its own**, `stenograma-knowledge-base`, next to the extension's and not linked to it: no
  submodule, subtree or git dependency. The extension and the app meet only at the HTTP API
  ([Repositories](#repositories)). It was made the same day, ahead of M1, and this plan moved into it.
- **The core picks what to index.** The extension sends the rows changed since its cursor, and the rules of F1 run in
  the core, so changing them needs no extension release.
- **`cloudAllowed` by default:** on for a browser source (the extension already sends meetings to Groq and Gemini), off
  for email and chats until it's turned on ([F8](#functional)). M0 checks only that a tenant or workspace lets the app
  in, not whether the company lets its data go to a cloud LLM.
- **Drafts for a source without `cloudAllowed`:** when a cloud LLM is chosen, Ollama makes them. When Ollama isn't
  running there's no draft, and the queue says why ([F9](#functional)).
- **Groq's free tier:** a second question within a minute waits for the rate limit, and the chat shows the wait
  ([N3](#non-functional)).
- **Languages: Ukrainian and English.** Russian is dropped: no Russian patterns for quoted replies, no `ё` → `е`
  folding and no Russian endings in BM25 ([F2, F5](#functional), [BM25](#architecture)).
- **The skeleton of the repo**, ahead of M1: electron-vite with main, preload and renderer in `app/`, TypeScript,
  ESLint with the extension's rules, Vitest under Electron's Node, CI, and electron-builder for an AppImage and a
  `.deb`.
  - Electron 45.2.1, whose Node 24.22.1 has the fix for Node2Shell (CVE-2026-111497).
  - ESLint 9, since eslint-plugin-react doesn't support 10. TypeScript 5.9, since typescript-eslint supports only
    TypeScript below 6.1.
  - `@vitejs/plugin-react` pinned to 6.1.2: 6.2.0 and 6.2.1 came out the day the repo was made.

## Why Electron, with a core of its own

Email and messengers need a process of their own on the machine: a browser can't poll sources while it's closed, and an
MV3 service worker can't run a backfill that takes hours. Reply drafts need more than a process: a review queue at hand
without a browser tab, a notification when a draft is ready, a tray icon. That's what Electron adds.

The core is still a package that doesn't import Electron (`core/` of this repo): storage, connectors, the
pipeline, search, answers, drafts and the HTTP API for the extension. The app (`app/`) runs it in a `utilityProcess` and
talks to it over a `MessagePort`; `kb search` and `kb eval` run the same core from the command line.

Running the core inside the app means:

- Syncing, polling and the extension's pushes work only while the app runs, so it starts at login and closing the
  window leaves it in the tray. The extension shows that the knowledge base isn't running and tries again at its next
  alarm.
- Native modules are built for Electron's Node. Only `better-sqlite3` needs it (electron-builder's `install-app-deps`):
  `sqlite-vec` is a loadable SQLite extension, `@napi-rs/keyring` and `onnxruntime-node` use N-API. Tests and `kb eval`
  run under Electron's Node (`ELECTRON_RUN_AS_NODE=1`), so one build serves both.

Alternatives considered:

- **A separate Node service (systemd) with Electron as the UI only**: syncs while the app is closed and needs no
  Electron build of `better-sqlite3`, but it's two things to install and run.
- **A web UI served by the core on `127.0.0.1`**: no tray or notifications for reply drafts; links to meetings would
  need `tabs/history.html` to be web-accessible, and Firefox's extension URL has a random UUID per install.
- **Chat on the extension's history page**: emails, chats and replies don't belong in the published extension.
- **Everything in the extension** (IndexedDB index, connectors in the background): the personal connectors and their
  tokens (Telegram session, Graph) would end up in the published extension, and polling would work only while the
  browser is open.
- **Postgres + pgvector in Docker**: works, but one SQLite file is simpler to run and back up for one user.
- **n8n / AnythingLLM / Open WebUI**: a prototype in an evening, but there's less control over chunking and metadata,
  and no reply review.
- **Tauri**: a smaller app, but the core is TypeScript on the AI SDK, so it would run as a Node sidecar next to a Rust
  shell.

### The app

- **Renderer.**
  - React and MUI, starting from copies of the extension's `helpers/theme.ts` (Meet's palette) and
    `components/MarkdownText.tsx` (raw HTML shown as text).
  - `contextIsolation` and `sandbox` on, no `nodeIntegration`; the preload exposes a short list of IPC calls.
  - A CSP of `'self'`; `setWindowOpenHandler` denies new windows and `will-navigate` is blocked.
- **Untrusted content.** Emails and messages are written by other people.
  - They're shown as the text that was indexed, or as HTML in an `<iframe sandbox>` without scripts and with remote
    images blocked (tracking pixels).
  - Links open in the browser with `shell.openExternal`, `http(s):` and `mailto:` only.
- **Linux.**
  - Autostart is a `~/.config/autostart/*.desktop` file: `app.setLoginItemSettings` does nothing on Linux.
  - The tray needs AppIndicator support (Ubuntu has it; plain GNOME needs the extension).
  - `app.requestSingleInstanceLock()` keeps one instance.
  - Packaged with electron-builder as an AppImage or `.deb`, unsigned, without auto-update.
  - The `.deb` installs an AppArmor profile, so the Chromium sandbox works with Ubuntu 24.04's restriction of
    unprivileged user namespaces. The AppImage has no profile and starts only where that restriction is off
    (`kernel.apparmor_restrict_unprivileged_userns=0`, as on this machine now), so the `.deb` is the one to install.
- **Meetings in answers.**
  - The app shows a cited meeting from its own copy, at the cited moment.
  - It can't open `chrome-extension://` or `moz-extension://` pages. So "Open in Stenograma" opens
    `http://127.0.0.1:<port>/stenograma-open?source=…&session=…&t=…` in the default browser. There a content script of
    the extension (matching that path; `http://127.0.0.1/*` is already a host permission, so no new install warning)
    checks that the source is this browser's, asks the background to open the history page at the meeting
    (`openExtensionPage`) and closes the tab.
  - The history page opens a session from its hash today; it also needs to scroll to the moment.
  - A meeting pushed by another browser can only be shown in the app.

## Requirements

### Functional

- **F1. Stenograma.**
  - Meet calls (captions and chat) and recordings of the recorder page.
  - The extension sends a session's rows (step 1 of [Sending](#sending-stenograma-data-from-the-extension)). The core
    keeps them and picks what to index by the rules below, so a change to the rules is a core update, and the core
    indexes its copy again without a push.
  - One text per session, so a meeting isn't found twice:
    - a Meet call's own text (speaker names from the captions, and chat);
    - its latest `done` version from `transcripts` only when it has no captions, since a version made from the audio
      has only "You" / "Others" and no chat, which would lose who said what;
    - a recording's latest `done` version, else its own text.
  - The title as `getSessionTitle` gives it: the name given on the history page, else Meet's, else the code.
  - Per session, the latest summary of the whole meeting (`kind: 'summary'` without `messageCount` or
    `missedMinutes`) and its action items as one list, both marked in the chunk header as made by AI.
  - Kept but not indexed:
    - answers to questions;
    - summaries of a selection or of "What did I miss?";
    - summaries replaced by a later one (Regenerate);
    - the versions not picked above.
  - Never sent: any answer's `request` (the prompt and the whole transcript), audio, `pendingUtterances`,
    `recording.diagnostics`, the messages' `userIconUrl`.
  - Changes and deletions reach the knowledge base within 5 minutes while the browser and the app are open.
- **F2. Email (Gmail, Outlook).**
  - One document per message, linked to its thread.
  - Quoted replies and signatures are stripped, with UA/EN patterns ("Від:", "On … wrote:", "-----Original
    Message-----").
  - Backfill of the last 12 months (configurable), without Spam, Trash, Promotions and Social.
  - Senders can be excluded; the status lists the senders with the most documents, to find noise (notifications,
    newsletters).
  - Attachments aren't indexed in v1, only their names.
- **F3. Messengers (Teams chats, Telegram, Rocket.Chat, Slack).**
  - Messages are grouped into chunks per conversation and time window: a pause over 30 minutes starts a new chunk, at
    most ~400 tokens each.
  - Threads (`tmid` in Rocket.Chat, `thread_ts` in Slack, replies in Teams) stay together.
  - Telegram indexes only an allowlist of chats (nothing by default); the other sources take an exclude list.
- **F4. Incremental sync.**
  - Each source keeps a cursor and fetches only what's new.
  - Edits update a document, deletions remove it.
  - A restart continues from the cursor.
  - "Sync now", and a status per source: last sync, document count, last error, embedding queue.
- **F5. Search.**
  - Hybrid: BM25 (FTS5) plus vectors, merged with reciprocal rank fusion.
  - Filters: source, date range, person. They're set by hand or taken from the question (F6).
  - A date range filters. A person only raises the rank of chunks whose author or participants match, since one person
    is written differently in Meet, email and Telegram and there's no people directory in v1. Names are compared
    lower-cased, with Cyrillic transliterated to Latin.
  - Ukrainian and English, mixed.
- **F6. Answers.**
  - Streamed, with `[n]` citations linking to the source (a meeting at the cited moment, an email, a message).
  - It says so when the sources don't contain the answer.
  - Before the search, one LLM call turns the question and the conversation into JSON `{ query, from, to, person }`.
    The prompt has today's date and the time zone, so "last week" becomes dates. When the JSON can't be read, the
    question is searched as it is.
  - The same LLM providers as the extension: Groq, Gemini, Ollama. Their keys are entered in the app; the extension's
    stay in the browser.
- **F7. Management.**
  - Connect, disconnect and remove a source (with all its documents and tokens). A paired browser is a source too.
  - Change the embedding model, with the index rebuilt in the background.
  - Rebuild the whole index.
- **F8. Cloud policy per source.**
  - `cloudAllowed` per source. A new browser source has it on, a new email or chat source off.
  - Without it, the source's content goes neither to cloud embeddings (it's then found by BM25 only) nor into the
    context of a cloud LLM.
  - Ollama counts as local only at a loopback address.
- **F9. Reply drafts** ([M7 and M8](#m7-reply-drafts)).
  - Which messages get a draft:
    - new emails and messages addressed to me (direct messages, mentions, emails with me in To) get a draft, made from
      the conversation and a search of the whole knowledge base;
    - automated mail (`List-Unsubscribe`, no-reply senders), conversations marked "don't draft" and group chats without
      a mention get none.
  - A notification and a review queue in the app: edit, make again, dismiss or send. Nothing is sent without "Send", and
    there's no automatic sending.
  - The review shows the recipients, with a warning for another domain, and the sources the draft used, marking those
    that aren't the conversation itself. The incoming message is written by someone else and can ask for anything
    ("add the latest budget figures"), and the approval is what stops it.
  - F8 applies: with a cloud LLM, only `cloudAllowed` sources go into the draft. A message from a source without
    `cloudAllowed` gets its draft from Ollama; when Ollama isn't running it gets none, and the queue says why.
  - Sending goes through the source as a reply in the same thread (the Reply column of [Connectors](#connectors)). A
    log keeps what was sent: ids, time, conversation.
  - Drafts need new messages within a minute, not 5–15. Sources with live connections use them (Slack Socket Mode,
    Rocket.Chat's realtime API, Telegram updates); the others are polled every minute.
  - Write access is asked for when replies are turned on for a source, not when it's connected.

### Non-functional

- **N1. Privacy.**
  - All data and the index stay on the machine (`~/.local/share/stenograma-kb/`, mode 0700).
  - Logs hold ids, counts and lengths only, as in [CLAUDE.md](../CLAUDE.md#privacy).
  - Secrets (OAuth refresh tokens and MSAL's token cache, the Telegram session, the Rocket.Chat and Slack tokens) go to
    the OS keyring (`@napi-rs/keyring`, libsecret on Linux), else to a file with mode 0600 and a warning.
  - At login the keyring may still be locked when the app starts. Secrets are read when first needed, and a source
    waits until they can be.
- **N2. Localhost API security.** The API is only for the extension; the app's own UI uses IPC.
  - Listens on `127.0.0.1` only, on a port fixed in the app's settings.
  - Each paired browser has its own bearer token (F7).
  - The `Host` header is checked against DNS rebinding.
  - No CORS headers. The extension's background sends with a host permission, which CORS doesn't apply to, and
    Firefox's extension origin is a random `moz-extension://<uuid>` per install, so an origin allowlist couldn't work.
    Requests with a web page's `Origin` (`http:` / `https:`) are refused.
  - `/stenograma-open` takes no token and its page holds no data.
- **N3. Performance.**
  - Search p95 under 300 ms at 100k chunks; the first answer token under 3 s with Gemini or a paid Groq tier.
  - Groq's free tier allows about 8000 tokens a minute, and an answer with its rewrite takes about 7000. So a second
    question within a minute waits for `retry-after` (the AI SDK already does), and the chat shows the wait.
  - Backfill runs in the background with progress; on CPU it may take hours.
- **N4. Context budget.**
  - Retrieved context fits the provider's input budget. On Groq's free tier the whole input is 4000 tokens
    (`INPUT_TOKEN_BUDGET` in `background.ts`), which leaves ~2.5k for context: 6 chunks of at most ~400 tokens.
  - The core has its own copy of `INPUT_TOKEN_BUDGET` and `estimateTokens` from `background.ts`. `estimateTokens`
    counts `length / 3`, which may count Ukrainian short, and a short count gives a 413 from Groq; M0 checks it.
  - Chunks are picked to fit. They're never condensed with `condenseToBudget`, whose notes would lose the citations.
- **N5. Reliability.**
  - Idempotent upserts by `id`.
  - A chunk is embedded only when its text is new: embeddings are cached by model and text hash, so a live meeting
    pushed every 5 minutes embeds only its new chunks.
  - Retries with backoff that honour `Retry-After` (Graph, Slack), `FLOOD_WAIT` (Telegram) and Gmail quotas.
- **N6. Quality.**
  - A private golden set of ~30 questions with their expected sources, kept outside the repo (it's about real
    meetings).
  - M0 starts it with meetings, read from `data.json` of a Stenograma backup; each connector adds a few questions
    about its source.
  - Target recall@10 ≥ 0.8. The set picks the embedding model and is a regression check.

### Not in v1

Zoom ([below](#later-zoom-recordings)), WhatsApp / Viber (chat export files), attachments, Teams channels (need admin
consent), a reranker, webhooks instead of polling (reply drafts use live connections where a source has them), sending
without approval, a people directory that joins one person's names across sources, a shared team knowledge base.

## Architecture

```
 Extension ──push (alarms, cursor)──▶ ┐
 Gmail API ─────poll historyId──────▶ │  kb core (Electron utilityProcess)
 Graph: mail delta, Teams chats ────▶ ├─▶ normalize → chunk → embedding queue → SQLite
 Telegram (GramJS) ─────────────────▶ │        (FTS5 + sqlite-vec)
 Rocket.Chat, Slack ────────────────▶ ┘                 │
                                         hybrid search + LLM → answers, reply drafts
                                                        │ IPC
                          Electron app: chat, sources and status, review of drafts ──send──▶ the source
```

- **Stack.**
  - Electron with its own Node; better-sqlite3 with sqlite-vec and FTS5; Fastify for the extension's API.
  - The AI SDK the extension uses (`ai`, `@ai-sdk/google`, `@ai-sdk/groq`, `ollama-ai-provider-v2`, `embedMany`).
  - `@huggingface/transformers` for local embeddings in the core.
  - `@azure/msal-node`, `telegram` (GramJS), `@slack/web-api` and `@slack/socket-mode`, `html-to-text`.
- **Schema.**
  - `sources`: kind, account, config, cursor, cloudAllowed, repliesEnabled, enabled, lastSyncAt, lastError; for a
    browser, the hash of its token.
  - `documents`: `id` = `<source>:<nativeId>`, kind, threadId (the conversation), title, author, participants,
    createdAt, updatedAt, url, madeByAI.
  - `chunks`: documentId, ord, text with a context header ("[Email · subject · from · date]"), textHash, startMs for
    transcripts.
  - `stenograma_rows`: the rows a browser pushed (source, table, key, JSON), so the core can index them again when the
    rules of F1 change, without a push.
  - `chunks_fts`.
  - `vec_<model>`: a vector table per embedding model, so the model can change without downtime. `sourceKind` and
    `createdAt` are its metadata columns.
  - `embedding_cache`: model, textHash, vector.
  - `jobs`: the embedding queue, with retries.
  - `drafts`: source, conversation, the message replied to, text, the chunks used, status (`pending`, `sent`,
    `dismissed`), createdAt; and `sent_log`.
- **Embeddings.** One provider interface with three implementations:
  - Ollama `bge-m3` (1024 dimensions, the best of these for Ukrainian);
  - transformers.js in the core (multilingual-e5, no Ollama needed). It needs the `query:` / `passage:` prefixes, and
    reads at most 512 tokens, which the ~400-token chunks stay under;
  - Gemini `gemini-embedding-001` with `outputDimensionality: 768` (3072 by default, four times the storage).

  The default is picked in M0 with the golden set. Gemini API's free tier may use what it's sent to improve
  Google's products, so email and chats go to it only on a paid tier or with `cloudAllowed`. Groq has no embeddings.
- **BM25 for Ukrainian.**
  - FTS5 with `unicode61`. Text and queries are normalized first: the apostrophes `'`, `’` and `` ` `` become `ʼ`
    (U+02BC). `unicode61` takes `ʼ` as a letter, while `'` and `’` split "п'ять" into "п" and "ять".
  - A query word of 5+ letters loses one ending from a fixed Ukrainian list, the longest that leaves at least
    4 letters, and is matched as a prefix ("бюджету" → `бюджет*`).
  - Checked on the golden set; the fallback is the `trigram` tokenizer.
- **Scale.**
  - Roughly 100k chunks for a year of email and chats, about 400 MB of float32 vectors.
  - Source and date filters are metadata columns of `vec0` (sqlite-vec 0.1.6+), so they apply inside the
    nearest-neighbour search. Filtering a top 50 afterwards can leave nothing.
  - If search is slower than N3, store `int8` vectors in sqlite-vec and rescore the top results.
- **API for the extension.**
  - `POST /ingest`: session bundles (step 1 of [Sending](#sending-stenograma-data-from-the-extension)).
  - `POST /ingest/reconcile`: every session id the browser still has; the rest of its documents is deleted.
  - `GET /status`, with the knowledge base's id (a new one resets the extension's cursor) and `apiVersion`.
  - `POST /search`, for a later "ask the knowledge base" in the Meet panel.
  - `GET /stenograma-open` ([The app](#the-app)).
  - `/auth/{microsoft,google}/callback` for loopback OAuth.

### Repositories

The knowledge base is this repo, `stenograma-knowledge-base`, checked out next to the extension's
([stenograma](https://github.com/Oleksandr-thescimus/stenograma), `../stenograma`).

- **Layout.** `core/` (no Electron) and `app/` (Electron main, preload, renderer), with one `package.json`, tsconfig,
  Vitest config and CI. ESLint takes the extension's rules, with Node globals for `core/` and the main process. Tags
  and releases are its own.
- **Why not in the extension's repo:**
  - The extension in the stores and the app are updated separately, so the API between them is versioned anyway. One
    commit changing both sides would help only until the first release.
  - The extension repo's release machinery is the extension's: `v*` tags, `yarn release`, `git archive` for the AMO
    source package, `eslint .` and a tsconfig over every file. Each would need an exception for the app, and
    Electron's native modules would slow its CI.
  - Shared UI files would import `react` and `@mui/material` from the extension's `node_modules`, and the app's own
    code from its own, giving two copies of React and MUI in the renderer.
  - It's the published extension's repo. Its privacy policy says data goes only to the AI providers the user chose,
    and code reading Outlook, Telegram and Slack next to it would confuse users and store reviewers.
- **Not linked.** A submodule, subtree or git dependency would share only the payload types. It would cost clones with
  `--recurse-submodules`, a pointer moved on every change, or (as a git dependency) the extension's whole dependency
  tree. Instead:
  - The core owns the protocol: the payload types and `apiVersion`. The extension has its own copy of the types in
    `helpers/knowledgeBase.ts`.
  - **A contract fixture.** An extension test builds a push from fixture rows and compares it with
    `tests/fixtures/kb-ingest.json`. The core keeps a copy of that file and tests that it ingests it. A change to the
    payload changes the fixture, and its diff is the reminder to raise `apiVersion` and copy the file over.
  - Copied once, then the app's own: `helpers/theme.ts`, `components/MarkdownText.tsx`, and `INPUT_TOKEN_BUDGET` with
    `estimateTokens` from `background.ts`.
- **Working on both sides** in Claude Code: the two repos side by side, and `claude --add-dir ../stenograma` (or
  `/add-dir`) here.
- **Docs.** This plan lives here, and the extension's privacy rules are in this repo's
  [CLAUDE.md](../CLAUDE.md#privacy). The extension's `docs/RAG.md` keeps only its side
  ([Sending](#sending-stenograma-data-from-the-extension)) and a link here.

## Connectors

Each connector turns its data into documents and decides only **what is new or changed since its cursor**; the rest of
the pipeline is shared. The first run is a backfill. Later runs are incremental, polling every 5–15 minutes (no public
URL needed), or every minute and over live connections for sources with reply drafts (F9).

| Source | Auth | Incremental | Deletions | Reply (F9) | Check in M0 |
|---|---|---|---|---|---|
| Outlook | MSAL public client (own Entra app, loopback redirect), `Mail.Read` | Every mail folder but Junk Email, Deleted Items and Drafts (`mailFolders` with `childFolders`, since rules move mail into subfolders), each with its own `messages/delta` link; new folders are found on each run | `@removed` in the delta | `createReply`, then `send` (`Mail.Send`) | Whether the tenant lets users register an app and consent without an admin |
| Teams | The same MSAL session, `Chat.Read` | `/me/chats?$expand=lastMessagePreview`, then `/me/chats/{id}/messages` with `$filter=lastModifiedDateTime gt …` only for chats with a newer last message. Edits and deletions don't change the preview, so chats active in the last 7 days are read again daily | `deletedDateTime` | `POST /chats/{id}/messages` (`ChatMessage.Send`) | The same; channels later (admin consent) |
| Gmail | Own GCP "Desktop app" OAuth client, `gmail.readonly` | `history.list` from `historyId`; on 404 (history expired) a resync by date | `messagesDeleted` | `messages.send` with `threadId` and `In-Reply-To` / `References` (`gmail.send`) | Workspace: an Internal app (no verification, no 7-day token expiry). Personal Gmail: External set to "In production", with the unverified-app screen (in Testing, refresh tokens last 7 days) |
| Telegram | GramJS with api_id / api_hash from my.telegram.org; phone, code and 2FA entered in the app | `minId` per chat; the last 7 days scanned again for edits | Only live events, plus the 7-day rescan | `sendMessage` with `replyTo` | FLOOD_WAIT limits. The session is full access to the account, so keyring only. A login through a new api_id can get an account limited, so request rates stay low; the fallback is Telegram Desktop's JSON export of chosen chats |
| Rocket.Chat | Personal access token (`X-User-Id`, `X-Auth-Token`), or login with TOTP | `subscriptions.get`, then `chat.syncMessages?roomId=…&lastUpdate=…` per room | `result.deleted` | `chat.sendMessage` (`tmid` in a thread) | The server version (the syncMessages API changed); whether the admin allows personal access tokens |
| Slack | Own Slack app with user scopes (`channels:history`, `groups:history`, `im:history`, `mpim:history`, `users:read`; `chat:write` for replies), installed from its settings page. Its user token (`xoxp-…`) and, for live events, an app-level token (`xapp-…`) are pasted into the app, so no OAuth flow is needed | `users.conversations`, then `conversations.history?oldest=…` per conversation; threads with `conversations.replies` | `message_deleted` events while connected, plus a rescan of the last 7 days | `chat.postMessage` with `thread_ts` | Whether an admin has to approve the app. Whether the much lower limits announced in 2025 for apps outside the Marketplace (`conversations.history` / `conversations.replies`) apply to an app made for its own workspace |

Private Telegram chats have no links to a message, so their citations show the message's text.

## Sending Stenograma data from the extension

1. **What's sent.** Per session, under this browser's source (step 6), one bundle of its rows:
   - the `sessions` row, without `recording.diagnostics` and the messages' `userIconUrl`;
   - its `transcripts` rows with status `done` (a version being made changes with every utterance);
   - its `assistantAnswers` rows, without `request`;
   - its `actionItems` rows.

   The core replaces what it had of the session with the bundle, so a row missing from it is deleted, and picks what
   to index (F1). It makes the documents `stenograma:<source>:<sessionId>` (the meeting's text, title, participants,
   start and end, `origin`), `…:summary` and `…:actions` (one list: what, who, due, done). Audio and `pendingUtterances`
   are never sent.
2. **Track changes.**
   - A Dexie DBCore middleware in `db.ts` stamps `changedAt` on every add and put of `sessions`, `transcripts`,
     `assistantAnswers` and `actionItems` (also those that `update` and `modify` make), only in the extension's own
     database. `version(8)` indexes it.
   - It's a field of its own. `actionItems.updatedAt` is the time of the user's change, and the archive sync and a
     restore bring it from Meet or a backup, so it can be older than the cursor and the item would never be sent.
   - `getSessionSize` leaves `changedAt` out, like `customName`. Meet's copy never has it, so otherwise every sync
     would send the session again.
3. **Which sessions go.** On each alarm a session goes when:
   - `changedAt` of its row, or of one of its transcripts, answers or action items, is after the cursor;
   - or the keys of its transcripts, answers and action items differ from those last sent. A deleted version or
     answer leaves no `changedAt`, and only keys are read, which is cheap. The keys sent last are kept in the setting.

   The cursor is the largest `changedAt` sent, minus a minute of overlap, since repeats are cheap (N5). It moves only
   after the core accepted a batch; batches are up to ~2 MB. With no cursor (the first push, or a knowledge base with
   another id) the whole tables are read, so rows from before `version(8)` need no stamp.
4. **Deletions.** On each alarm the extension hashes the list of its session ids. When the hash differs from the last
   one sent, it sends the list to `/ingest/reconcile`. The tombstones can't be used for this: deletions made on Meet
   (`ARCHIVE_DELETE_*`) leave none in the extension's database, transcript versions have none, and a restore removes
   them.
5. **Push from the background.**
   - `helpers/knowledgeBase.ts` in `background.ts` runs on a `chrome.alarms` alarm every 5 minutes (a permission
     without an install warning), and on "Sync now".
   - It sends with `fetch`; `http://127.0.0.1/*` is already in `host_permissions`.
   - While the app isn't running the request fails: the cursor stays, the status says so, and the next alarm tries
     again.
6. **One source per browser.**
   - The app's "Add a browser" makes a Stenograma source with its own token, which is pasted into the popup.
   - Chrome and Firefox keep separate histories, and a reconcile from one must not delete the other's meetings.
   - After reinstalling the extension, pasting the same token continues the same source, and the reconcile removes
     what the browser no longer has.
7. **Chunking, in the core.**
   - Transcript chunks are at most ~400 tokens (about a minute of talk), cut on message boundaries from the start. As
     a live meeting grows, earlier chunks stay the same and only the last ones are embedded again (N5).
   - Each chunk keeps its start, so an answer can link to the moment in the meeting.
   - The context header holds only what doesn't change during a meeting (kind, title, date), not the list of
     participants. A rename changes every header and so embeds that meeting again.
   - Messages without a `timestamp` give chunks without a start, linked to the meeting.
8. **Setting.**
   - A folded "Local knowledge base" block in the popup, kept in `chrome.storage.local` under `knowledgeBase` (the
     token belongs to this machine): URL, token, a switch (off by default), the last push's status, the cursor and the
     keys sent last.
   - The backup leaves it out, like every setting. After a restore the next push sends what's missing.

The same change updates the extension's docs:
[PRIVACY.md](https://github.com/Oleksandr-thescimus/stenograma/blob/master/docs/PRIVACY.md) (a new place data goes:
localhost only, chosen by the user),
[PUBLISHING.md](https://github.com/Oleksandr-thescimus/stenograma/blob/master/docs/PUBLISHING.md) (the `alarms`
justification, and later the `127.0.0.1` content script),
[STORAGE.md](https://github.com/Oleksandr-thescimus/stenograma/blob/master/docs/STORAGE.md) (the `knowledgeBase` key,
`changedAt`, and the knowledge base's directory, where pushed meetings go), its `CLAUDE.md` and
[STORE_LISTING.md](https://github.com/Oleksandr-thescimus/stenograma/blob/master/docs/STORE_LISTING.md) ("Next
version").

## Milestones

Each milestone ends with something that can be used, so the work can stop after any of them. Sizes are working days
for one person, not counting the wait for a store review.

| | Milestone | What works after it | Size |
|---|---|---|---|
| M0 | Spikes | Nothing yet: the embedding model, Electron and each source are go or no-go | 2–3 days |
| M1 | Meetings in the terminal | `kb ask` answers about meetings imported from a backup, with citations | 5–7 days |
| M2 | Meetings arrive by themselves | The extension pushes changes and deletions within 5 minutes (an extension release) | 4–6 days |
| M3 | The desktop app | Chat, sources and status in the app, which starts at login and stays in the tray | 5–7 days |
| M4 | Microsoft 365 | Outlook mail and Teams chats are searched with the meetings | 4–5 days |
| M5 | Gmail | Gmail too | 2–3 days |
| M6 | Messengers | Telegram, Rocket.Chat and Slack too | 5–8 days |
| M7 | Reply drafts | Drafts for new emails and messages within a minute, reviewed in the app and copied into the source by hand | 5–7 days |
| M8 | Sending replies | An approved draft is sent from the app, in the same thread | 3–5 days |
| Later | Improvements | Reranker, int8 vectors, "ask the knowledge base" in the Meet panel, Zoom | as needed |

- M0 → M1 → M2 → M3 in this order. M4–M6 can go in any order after M3. Microsoft goes first: one sign-in covers
  two sources, and it brings both the email and the chat chunker. M7 and M8 use the sources connected by then.
- Every change to the extension is in M2, so there's one store release, and its review runs while M3 is built.
- Meetings alone (M0–M3) take 16–23 days; all of it takes 35–51.

**Done, for every milestone:**

- Its items in [Verification](#verification) pass, in the CI of each repo it changes.
- `kb eval` is no worse than after the previous milestone; the result is written in its dated line in
  [Decisions](#decisions), with anything that changed from this plan.
- Docs are current: this plan and this repo's CLAUDE.md, and for a change to the extension also its CLAUDE.md,
  STORAGE.md, PRIVACY.md, PUBLISHING.md and the "Next version" of STORE_LISTING.md.
- Logs hold ids, counts and lengths only.

### M0. Spikes

Finds what can't work before any code depends on it.

- **Golden set** (N6): ~20 questions about meetings, with the sessions and moments that answer them, from a backup's
  `data.json`.
- **Embeddings:** bge-m3, multilingual-e5 and Gemini compared on the golden set with a throwaway script (FTS5 and
  vectors, nothing else); the time to embed an hour-long meeting with Ollama on this machine's GPU (6 GB) and with
  transformers.js on its CPU.
- **Tokens:** `estimateTokens` compared with Groq's `usage.prompt_tokens` on a Ukrainian meeting (N4).
- **Drafts with Ollama:** whether `qwen3.5:9b`, which doesn't fit wholly into the 6 GB GPU, makes a draft within a
  minute (F9).
- **Electron:**
  - better-sqlite3 loading sqlite-vec (`vec0` with metadata columns) in a `utilityProcess` of a packaged AppImage, and
    under `ELECTRON_RUN_AS_NODE=1` in Vitest;
  - `@napi-rs/keyring` on this desktop, also while the keyring is still locked right after login.
- **Access** for each source: the last column of [Connectors](#connectors).

Exit: a dated entry in Decisions with:

- the default embedding model and its recall@10;
- each source as go, needs an admin, or a fallback (Telegram's JSON export). A source that can't be reached moves to
  [Not in v1](#not-in-v1);
- the core inside Electron confirmed. If it doesn't work, the core runs as the separate Node service from
  [the alternatives](#why-electron-with-a-core-of-its-own), and M3 changes with it.

### M1. Meetings in the terminal

Questions about meetings are answered with citations, before any UI or change to the extension.

- **The repo** ([Repositories](#repositories)): done ahead of M0 (`package.json`, tsconfig, ESLint, Vitest under
  Electron's Node, CI, this plan and the CLAUDE.md with the privacy rules).
- **The core:**
  - schema and migrations, without `drafts` and `sent_log`;
  - the rules of F1 over the rows of a bundle, kept in `stenograma_rows`;
  - the transcript chunker (step 7 of [Sending](#sending-stenograma-data-from-the-extension)); the email and chat
    chunkers come with their connectors;
  - the embedding provider chosen in M0, and Gemini; the cache and the queue (N5);
  - onnxruntime limited to a few threads (`intraOpNumThreads`), or the embeddings in a worker, so a backfill doesn't
    push search past N3;
  - FTS5 normalization and hybrid search with filters (F5);
  - the rewrite and answers (F6), within the budget (N4);
  - `cloudAllowed` (F8), set in the settings file until M3.
- **Settings and secrets.** A settings file in the data directory, LLM keys in the keyring (N1). The core that syncs
  holds a lock file there: `kb search` and `kb ask` only read, and `kb import` and `kb serve` refuse to run next to the
  app. Caching a query's embedding in `embedding_cache` would make `kb search` and `kb ask` write too, so either
  queries aren't cached or that write goes through WAL with a `busy_timeout`: decided here.
- **CLI:**
  - `kb import <data.json>`: a backup's meetings, made into bundles like a push's and indexed the same way, as a source
    of kind `stenograma-backup`;
  - `kb search` and `kb ask`, which streams the answer and lists each citation's meeting and moment;
  - `kb eval`.

Exit:

- recall@10 ≥ 0.8 on the meeting questions; search p95 under 300 ms on 100k generated chunks (N3);
- the `kb` tests of chunkers, apostrophes, the rewrite, fusion, filters and the embedding cache.

### M2. Meetings arrive by themselves

New, changed and deleted meetings reach the knowledge base with nothing to do by hand.

- **`kb`:**
  - Fastify on `127.0.0.1`: `/ingest`, `/ingest/reconcile`, `/status` and `/stenograma-open`, secured as in N2;
  - browser sources with their own tokens (F7);
  - `kb serve` and `kb add-browser`, which run the API and pair a browser from the terminal until M3. The app's "Add a
    browser" calls the same function.
- **A versioned API.** The extension in the stores and `kb` are updated separately, so `/status` returns `apiVersion`.
  The extension sends nothing to a version it doesn't know, and the popup says to update one of them.
- **The contract fixture** on both sides ([Repositories](#repositories)).
- **The extension:**
  - steps 1–6 and 8 of [Sending](#sending-stenograma-data-from-the-extension);
  - the content script for `/stenograma-open`, and the history page scrolling to the cited moment ([The
    app](#the-app));
  - the docs listed after step 8.
- **Removing the backup source.** Once a browser is paired, the `stenograma-backup` source from `kb import` is removed
  (F7), or every meeting is found twice. `kb add-browser` offers to do it.
- `kb ask` prints a `/stenograma-open` link for each citation, which opens the meeting from the terminal.

Exit:

- the extension's tests of the middleware, the bundle, push and reconcile; the `kb` tests of `/ingest`, of the
  fixture, and of reconcile touching one browser only;
- by hand: Chrome and Firefox paired; a Meet call shows up in `kb search` within 5 minutes; a deleted meeting is gone
  and the other browser's stay; with `kb` stopped the popup says so, and after a start the push catches up;
- an extension release submitted to both stores.

### M3. The desktop app

The app takes over from the terminal.

- **The main process (`app/`):**
  - the single instance lock, the tray and the autostart file;
  - the core in a `utilityProcess` over a `MessagePort`. When the core exits, the main process starts it again, with a
    growing delay, and shows the error in the status.
- **Chat:** streamed answers with citations, filters set by hand, the meeting view at the cited moment, and "Open in
  Stenograma".
- **Sources:**
  - "Add a browser" (the token);
  - status and "Sync now" per source (F4);
  - removing a source, and the `cloudAllowed` switch (F8);
  - the embedding model, rebuilt in the background when changed (F7);
  - the LLM provider, model and keys.
- **Renderer security** as in [The app](#the-app).
- **Packaging:** an AppImage and a `.deb` with electron-builder (`install-app-deps` for better-sqlite3).

Exit, by hand:

- after a reboot the app starts in the tray, waits for the keyring and then syncs;
- closing the window keeps it syncing;
- killing the core's process brings it back;
- "Open in Stenograma" opens the history page at the moment.

### M4–M6. Sources

| | Sources | Also brings |
|---|---|---|
| M4 | Outlook and Teams chats, on one MSAL session | The loopback OAuth callback; the email chunker with quote and signature stripping, and sender exclusion (F2); the chat chunker with threads (F3); emails shown in the app as text or in a sandboxed iframe |
| M5 | Gmail | The Gmail categories left out (F2); a resync by date after a 404 |
| M6 | Telegram, Rocket.Chat, Slack, each merged on its own | Telegram's sign-in (phone, code, 2FA) and chat allowlist; pasted Rocket.Chat and Slack tokens |

**A connector is done when:**

- it backfills with progress and a date limit, continues from its cursor, and handles edits and deletions as its row in
  [Connectors](#connectors) says;
- after a restart it continues from the cursor, and its retries honour the source's limits (N5);
- the app shows its status and "Sync now", and removing it deletes its documents and secrets (for Telegram it also ends
  the session);
- it asks for read access only (write access comes in M8);
- its tests run its chunker on fixtures and a fake API for the cursor and deletions;
- the golden set has 3–5 questions about it, and `kb eval` is run.

### M7. Reply drafts

Drafts appear within a minute and are reviewed in the app. They're copied into the source by hand, so no write access
is asked for yet, and the drafts' quality is checked before anything can be sent.

- Which messages get a draft (F9).
- Live connections (Slack Socket Mode, Rocket.Chat's realtime API, Telegram updates), and polling every minute for the
  others.
- The `drafts` table; a notification for a new draft.
- The review queue: edit, make again, dismiss, copy, and open the conversation in the source.
- The sources a draft used, marking those from outside the conversation; F8 for the LLM.
- The Telegram session and the Rocket.Chat token can already send. So `kb` has no code that sends before M8.

Exit:

- the `kb` tests: a draft made with a cloud LLM uses only `cloudAllowed` sources, and a message from a source without
  `cloudAllowed` gets its draft from Ollama, or none with the reason when Ollama isn't running;
- by hand:
  - a new email and a chat message each get a draft within a minute;
  - a message asking for something from elsewhere ("send me the latest budget figures") shows those sources marked.

### M8. Sending replies

- Write access asked for when replies are turned on for a source:
  - `Mail.Send` and `ChatMessage.Send` (Microsoft, incremental consent);
  - `gmail.send` (Google, consent again);
  - `chat:write` (Slack: the app is installed again and the new token pasted).
- Sending as a reply in the same thread (the Reply column of [Connectors](#connectors)), and `sent_log`.
- In the review, the recipients, with a warning for another domain. "Send" is the only way anything is sent.

Exit:

- the `kb` test: only the approve call sends;
- by hand: for each source, a reply goes into the same thread, and Dismiss sends nothing.

### Later

- A reranker; `int8` vectors when search is slower than N3.
- "Ask the knowledge base" in the Meet panel (`POST /search`), with an extension release.
- [Zoom recordings](#later-zoom-recordings); the rest of [Not in v1](#not-in-v1).

## Risks

- **Corporate tenants and workspaces** (Microsoft 365, Google Workspace, Slack) may not let users register or install
  apps, or consent without an admin. Check in M0, before writing connectors.
- **Company policy on cloud LLMs.** M0 checks only that the app gets access, not that the company allows its email and
  chats to go to Groq or Gemini. So `cloudAllowed` is off for them until it's turned on (F8).
- **The Telegram session is full access to the account.**
  - It lives in the keyring only, and "Disconnect" also ends the session on Telegram's side.
  - A login through a new api_id can get an account limited, so request rates stay low. The fallback is the JSON
    export of Telegram Desktop.
- **Reply drafts search the whole knowledge base.** An incoming message can ask the draft to include anything, and the
  approval is the only barrier. So the review shows the recipients and every source the draft used, marking those from
  outside the conversation, and nothing is sent automatically.
- **Other people's data.** Their emails and messages stay on the machine and reach a cloud provider only with
  `cloudAllowed`.
- **The app has to run.** With the core inside it, nothing syncs and the extension can't push while it's closed. It
  starts at login and stays in the tray.
- **Untrusted HTML in Electron.** A renderer that ran an email's script with Node access would give it the machine. So
  the renderer is sandboxed without `nodeIntegration`, and emails are shown as text or in a sandboxed iframe.
- **The first indexing on CPU takes hours.** Limit it by date, show progress, and keep search working while it runs.
- **Ukrainian morphology in BM25.** Prefixes first; trigram or a stemmer if the golden set shows misses.

## Verification

- **This repo (Vitest, under Electron's Node):**
  - the rules of F1:
    - a Meet call with a version indexes its captions, one without captions the version, and a recording its
      version;
    - only the latest summary of the whole meeting is indexed;
    - a bundle without a row deletes it;
  - it ingests `kb-ingest.json`, the extension's contract fixture;
  - chunkers on fixtures: an email with UA/EN quotes, Teams HTML, a Telegram chat with pauses, a Slack thread;
  - a meeting that grows keeps its earlier chunks, and only new texts are embedded;
  - "п'ять", "п’ять" and "пʼять" find each other;
  - the rewrite: "минулого тижня" with a fixed today gives the right dates, and broken JSON searches the question as it
    is;
  - reciprocal rank fusion; source and date filters inside the vector search;
  - cursors and deletions with fake connectors; a reconcile touches only its own browser's documents;
  - a draft is sent only by the approve call, and a draft made with a cloud LLM uses only `cloudAllowed` sources;
  - a message from a source without `cloudAllowed` gets its draft from Ollama when a cloud LLM is chosen;
  - an integration test on a temporary SQLite file;
  - `/ingest` gives 401 without the token, and 403 with a foreign `Host` or a web page's `Origin`.
- **Extension (`yarn test`):**
  - the middleware stamps `changedAt` in the extension's database only, also on `update`; `getSessionSize` ignores it,
    so the archive sync doesn't send sessions again;
  - the bundle:
    - it has the session, its `done` versions, its answers and its action items;
    - no `request`, `recording.diagnostics` or `userIconUrl`, no audio and no `pendingUtterances`;
    - built from the fixture rows it matches `tests/fixtures/kb-ingest.json`;
  - a deleted version or answer sends its session again, and a deleted session goes to the reconcile at the next alarm;
  - push and reconcile with a mocked `fetch`: the cursor stays after a failure and resets for a knowledge base with
    another id;
  - the popup setting; the `/stenograma-open` content script opens the history page only for this browser's source.
- **`kb eval`:** recall@10 and MRR on the golden set after any change to chunking or the model.
- **By hand:**
  - Pair Chrome and Firefox. A Meet call shows up in search within 5 minutes, and deleting a meeting in one browser
    doesn't remove the other's.
  - Deleting the session on the history page removes it from search.
  - "Open in Stenograma" from an answer opens the history page at the meeting.
  - Close the app: the popup says the knowledge base isn't running. After starting it, the push catches up.
  - Each connector: connect and backfill; a new email or message appears; editing and deleting it updates and removes
    it.
  - Kill the app during a backfill: after a restart it continues from the cursor.
  - Reply drafts: a new email and a chat message get drafts within a minute. Send replies in the same thread, and
    Dismiss sends nothing.

## Later: Zoom recordings

The Zoom desktop client is out of reach of a browser extension, so Zoom meetings are collected from **local
recordings**. This works on the free (Basic) plan. The layout below was checked with Zoom 6.2.3 on Ubuntu.

### Setup

1. Zoom → **Settings → Recording**: check the save folder (default `~/Documents/Zoom`).
2. Enable **"Record a separate audio file for each participant"**. It works on Linux and gives one audio track per
   speaker, so no diarization is needed.
3. In a meeting: **Record → Record on this computer**. After the meeting ends, Zoom converts the recording, which takes
   a few seconds to minutes.

Only the **host** (or a participant the host allowed to record) can record locally. Other meetings can be recorded with
the recorder page ([RECORDING.md](https://github.com/Oleksandr-thescimus/stenograma/blob/master/docs/RECORDING.md)),
which works with any call app.

### What Zoom writes

One folder per meeting, named `<yyyy-MM-dd HH.mm.ss> <meeting topic>`:

```
~/Documents/Zoom/2026-10-15 15.41.40 Oleksandr P's Zoom Meeting/
├── double_click_to_convert_01.zoom   # raw recording chunks, written during the meeting
├── double_click_to_convert_02.zoom
├── double_click_to_convert_03.zoom
├── zoomver.tag                       # list of the .zoom chunks
├── recording.conf                    # conversion status (see below)
├── video<N>.mp4                      # video + mixed audio (H.264, AAC 48 kHz stereo)
├── audio<N>.m4a                      # mixed audio of everyone (AAC 48 kHz stereo)
├── video<N>.vtt                      # transcript with timestamps (WebVTT)
└── Audio Record/
    └── audio<ParticipantName><n><N>.m4a   # one track per participant
```

`recording.conf` shows when conversion is done:

```json
{"items":[{"audio":"audio1600496770.m4a","prefix":"","process":100,"video":"video1600496770.mp4"}],"magic_number":"600496770"}
```

The `.vtt` transcript has timestamps but **no speaker names**:

```
00:00:06.720 --> 00:00:07.720
Hello

00:00:08.540 --> 00:00:10.540
1, 2, 3
```

### Ingestion flow

1. **Watch** the recordings folder (in the `kb` core).
2. **Wait for conversion.** Process a meeting folder only when `recording.conf` has `"process":100` for every item.
   Ignore the `.zoom` chunks: they are raw data that Zoom converts itself.
3. **Get text.**
   - Per-participant tracks in `Audio Record/` exist: transcribe each track with **faster-whisper** / **whisper.cpp**
     and merge the segments by timestamp. The speaker name comes from the file name.
   - Otherwise: use the `.vtt` transcript if it's present, or transcribe the mixed `audio<N>.m4a` and run diarization
     (pyannote).
   - The Zoom `.vtt` has no speakers and its quality depends on Zoom, so per-participant Whisper is preferred when the
     tracks exist. The `.vtt` is a cheap fallback.
4. **Normalize** to a document with id `zoom:<folder name>`. The meeting start time and topic come from the folder
   name, participants from the `Audio Record/` file names.
5. **Chunk** like Stenograma transcripts, keeping the start timestamp in each chunk so an answer can link to "recording
   at 12:34".
6. **Index** only text and a path to the recording, never the audio or video itself.
7. **Mark processed** by storing the folder name with a hash of `recording.conf`, so the folder isn't processed twice.
