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
- **The core picks what to index.** The extension sends the rows changed since its last push, and the rules of F1 run in
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
- **UI: Tailwind and shadcn/ui (Radix) instead of MUI** ([The app](#the-app)).
  - For: styles are a CSS file, so there's no styling at runtime while an answer streams, and the CSP needs no inline
    styles until the components below come. The components are the repo's own code, with no MUI major upgrades. A
    date range picker is free (MUI's is in the paid MUI X Pro).
  - Against: a stack other than the extension's. Its `helpers/theme.ts` and `components/MarkdownText.tsx` are ported,
    not copied.
  - `cn` from the `cn` package (shadcn's replacement for clsx and tailwind-merge), which the shadcn registry's
    components import. Pinned to 0.5.1: 0.5.2 came out the same day.
- **M0, Electron: the core runs inside it.**
  - better-sqlite3 13.0.3 with sqlite-vec 0.1.9 and FTS5 works under Electron's Node (`tests/sqlite.test.ts`) and in a
    `utilityProcess` of the packaged app, unpacked and as the AppImage. vec0's metadata columns filter inside the
    nearest-neighbour search.
  - better-sqlite3 13 is Node-API with prebuilt binaries, so nothing is rebuilt for Electron. sqlite-vec loads from
    `app.asar.unpacked` ([why](#why-electron-with-a-core-of-its-own)).
  - `@napi-rs/keyring` 2.1.2 stores, reads and deletes a secret on this desktop (gnome-keyring), in a `utilityProcess`
    too.
  - better-sqlite3 adds 27 MB to the package: every platform's binary and its sources. M3 leaves them out with
    electron-builder's `files`.
- **M0, drafts with Ollama.** `qwen3.5:9b` runs 66% on the 6 GB GPU and 34% on the CPU. A draft from a 5000-token
  prompt takes ~37 s cold: 9 s to load, 16 s for the prompt, 11 s for ~110 tokens at ~10 tokens/s. With the model
  loaded it's ~28 s. That's within the minute only with thinking off: with it, there was no reply in 5 minutes.
- **M0, tokens (a first sign):** Ukrainian text gave 2.84 characters per token with qwen's tokenizer, so
  `estimateTokens` (`length / 3`) counts ~5% short. Groq's `usage.prompt_tokens` is still to compare.
- **M0, the golden set:** 22 questions about 15 meetings of the backup of 2026-11-01, each with the session and a quote
  that marks the answering chunk, and a hard paraphrase of each without the passage's words. Claude wrote them from
  passages, so the direct ones share words with the answer; questions in my own words are still to add.
- **M0, embeddings: Ollama's bge-m3 is the default.** Recall@10 on the 3533 chunks of the backup's 184 meetings:

  | | Direct (22) | Paraphrased (22) | All (44) |
  |---|---|---|---|
  | BM25 | 0.95 | 0.18 | 0.57 |
  | bge-m3 | 0.95 | 0.68 | 0.82 |
  | bge-m3 + BM25 at half weight | 1.00 | 0.68 | **0.84** |
  | multilingual-e5-base (q8) | 0.64 | 0.50 | 0.57 |
  | e5-base + BM25 at half weight | 0.86 | 0.64 | 0.75 |

  - Fusion with BM25 at full weight drops paraphrases to 0.59: BM25's noise pushes the right chunk down. So BM25
    counts half in the fusion ([F5](#functional)), to be tuned with `kb eval`.
  - A second vector model in the fusion adds nothing.
  - Speed: bge-m3 on the GPU 8300 characters/s, e5-base on the CPU 4900. An hour of meeting is ~35 000 characters, so
    4 s and 7 s; the whole backup 7.5 and 13 minutes. A year of email and chats (~100k chunks) would take ~3.5 and ~6
    hours.
  - transformers.js with e5-base stays as the fallback for a machine without Ollama, with lower recall.
  - Only 415 of the chunks have a start: older captions have no timestamps, so their citations link to the meeting.
  - Captions repeat phrases ("Ну дивись більшістьНу дивись більшість"). The chunker could drop the repeats in M1.
- **Still open in M0:** Gemini's embeddings (no key yet), the golden set reviewed with questions of my own, Groq's
  token count, the keyring still locked right after login, and access to each source.
- **M1, the core and `kb`.** `kb import`, `search`, `ask` and `eval` work on the backup of 2026-11-01: 184 sessions,
  3539 chunks, embedded in 7 minutes.
  - `kb eval`: recall@10 1.00 direct, 0.68 paraphrased, **0.84** all; MRR 0.58. The same as M0's scripts.
  - Search at 100k generated chunks (`yarn bench`): p95 120 ms, 192 ms with source and date filters, plus ~50–90 ms to
    embed the query with bge-m3. Bit vectors with rescoring (Scale) gave the same `kb eval` as float32.
  - `kb ask` with `qwen3.5:9b` on Ollama: ~55 s with the model cold, rewrite included. Groq and Gemini aren't tried
    yet (no keys).
- **M1 decisions:**
  - `kb` runs `core/*.ts` as they are under Electron's Node, which strips the types, so there's no build step:
    `core/` is ESM with `.ts` imports.
  - AI SDK 6, as the extension, though 7 is out: no code is shared, but the extension's use of it is the reference.
  - `kb search`, `ask` and `eval` open the knowledge base readonly and don't cache the query's embedding, so they run
    next to the app's core. Only `kb import` writes for now, under a lock file the app's core and `kb serve` will take
    too.
  - One `stenograma-backup` source: a newer backup replaces the older one's meetings instead of adding them again.
  - `cloudAllowed` is a column of `sources`, set with `kb cloud <source> on|off` rather than in the settings file.
  - The default LLM in `settings.json` is `qwen3.5:9b` on Ollama, which needs no key; `kb key set` keeps a Groq or
    Gemini key in the keyring. Rewrites and answers on Ollama run without thinking.
  - Not in M1: transformers.js (Ollama is the default), so limiting onnxruntime's threads waits for it.
- **M2, the knowledge base's side.** `kb serve` (Fastify) on `127.0.0.1:47321` by default (`server.port` in
  `settings.json`), with `/status`, `/ingest`, `/ingest/reconcile` and `/stenograma-open`; `kb add-browser` and `kb remove`.
  - A push is `{ apiVersion, bundles }` and a reconcile `{ apiVersion, sessionIds }`; another `apiVersion` gets 409 with
    the server's. `/status` needs the token too and returns `{ kbId, apiVersion, source: { id, label } }`.
  - A browser's token is `skb_` and 32 random bytes, shown once by `kb add-browser`; `sources.token_hash` keeps its
    SHA-256.
  - Besides http(s) origins, `Origin: null` (a sandboxed page) is refused too. Fastify adds no CORS headers.
  - `kb serve` embeds what a push brings right after it. `kb ask` prints a `/stenograma-open` link only for meetings of a
    browser source: an imported one has no browser to open it.
  - `tests/fixtures/kb-ingest.json` is written here first, from the protocol's types; the extension's test builds the
    same push from its fixture rows.
- **M2, the extension's side** (`../stenograma`, on master, not released yet): `changedAt` and its middleware in `db.ts`
  (`version(8)`), `helpers/knowledgeBase.ts` (bundles, push, reconcile, the `alarms` permission), the popup's folded
  "Local knowledge base" block, `contents/stenogramaOpen.ts`, and the history page scrolling to a linked moment.
  - Its `docs/RAG.md` now keeps only its side, with a link here; PRIVACY, PUBLISHING, STORAGE, CLAUDE.md and the next
    store listing say what's new.
  - Its tests build `kb-ingest.json` byte for byte from rows that hold everything never to be sent; 812 tests pass.
  - Sessions go by signatures instead of a cursor ([Sending](#sending-stenograma-data-from-the-extension), step 3).
  - **Still to do by hand:** pair Chrome and Firefox, see a Meet call arrive within 5 minutes, delete one and see the
    other browser's stay, stop `kb serve` and see the popup say so, then the store release of both browsers.
  - Chrome is paired and its meetings arrive (2026-11-03); Firefox and the store releases remain.

2026-11-03:

- **The renderer's CSP allows inline styles** (`style-src 'self' 'unsafe-inline'`), scripts still only the app's own
  ([The app](#the-app)).
  - Radix's scroll lock (Dialog, AlertDialog, Select) and sonner add `<style>` tags. An email's HTML in an
    `<iframe srcdoc>` (M4) keeps the page's policy, and emails hold their styles in inline attributes.
  - A nonce per page load would need the renderer served by a protocol of the app's own, and toasts of its own instead
    of sonner, and M4 would still need another way for emails. Dropping the components with a scroll lock would cost
    focus trapping and fighting shadcn/ui.
  - The risk is a style injected through an HTML injection bug: it could change how the page looks, but not run code, and
    with nothing loaded from elsewhere (`default-src 'self'`) not send anything out.
- **M3, the app** (kb eval: recall@10 0.84, MRR 0.59, as after M1).
  - The core runs in a `utilityProcess` as `core/service.ts`: the lock, the database, the API for the extension, the
    embedding queue, answers and settings. `core/protocol.ts` holds the methods and events, types only, so the renderer
    reads it too. The main process checks every call of the renderer with zod (`app/main/ipc.ts`) and passes it on over
    the `MessagePort`; answers come back in parts, as events.
  - When the core exits, it's started again after 1, 2, 4... up to 60 s, from 1 s again after a minute's run. The window
    shows why it stopped (a lock taken by `kb serve`, an exit code) and "Start now".
  - The core's process is built from its `?modulePath` import, a bundle of its own: as a second entry of the main build,
    the code both used went into the core's bundle, which the main process then loaded, running the core inside it.
  - Closing the window hides it; the tray's Quit stops the core, which closes the API and the database and releases the
    lock. The autostart file is on by default, written only by a packaged app (the dev build's executable is Electron),
    starts the app with `--hidden`, and is marked as the app's, so turning it off never removes another file.
  - The settings file stays the store of the settings, written by the core alone; the settings page goes through it.
    Keys are read from the keyring only when the settings page asks (N1).
  - A new embedding model is `embeddingRebuild` in the settings until it has every chunk: from the cache where it has the
    text, else in the queue, which the chunks pushed meanwhile join before each run. Then it becomes `embedding`, and the
    search switches. The old model's vectors and cache stay, so going back costs no embedding.
  - Gemini's embeddings take the Gemini key of the LLM, in `kb` too (before, `kb` passed none).
  - An embedding run stops at the first failed batch and the queue is tried again a minute later, so the status says
    "Ollama isn't running" at once instead of after ~30 s of retries.
  - The chats are kept with the knowledge base (`chats`, `chat_turns`) and listed in the sidebar, to open, go on with
    or delete; "New chat" only starts another. A turn keeps the question, what the rewrite made of it, the sources'
    ids and the answer, saved as its parts come; one the app stopped in the middle of says so. A cited chunk's text
    isn't kept: it's read again while its document is there, and a citation of a meeting removed since (in its browser,
    or with its source) shows as removed while the answer stays. At first the chat lived in the page only, which "New
    chat" and a restart lost.
  - The rewrite sees the chat's last three exchanges, read by the core; filters set by hand win over its dates and
    person but it still runs, so a follow-up question is completed; the answer gets the completed question besides the
    one asked.
  - A cited meeting opens in the app from its own copy, at the cited messages (found by the chunk's first line, else by
    its start), with "Open in Stenograma" for a browser's meetings.
  - "Sync now" per source comes with the connectors (M4): a browser pushes on its own, and its popup has "Sync now".
  - The package leaves out other platforms' binaries of better-sqlite3 and the keyring and better-sqlite3's sources: an
    AppImage of 129 MB and a `.deb` of 104 MB. The icons are the extension's (168 px, scaled up to 512).
  - Checked on a made-up knowledge base, the built app and the packaged one: an answer from Ollama with citations, the
    meeting view at the cited moment, "Add a browser" with a token the API takes, the Select without CSP violations, the
    core killed and back within a second, the window closed with the API still answering, and Quit releasing the lock.
  - **Still to do by hand:** after a reboot the app starts in the tray, waits for the keyring and then syncs; "Open in
    Stenograma" opens the history page at the moment. With the app installed, `kb serve` and `kb import` can't run next
    to it (the lock): pushes go to the app.
- **The roadmap after M3**, from a brainstorm of the app's features.
  - [M3.5](#m35-the-app-day-to-day) comes before M4: it improves the app as it's used now, with meetings only.
  - Later: a quick-ask window on a global shortcut, a weekly digest, and a brief before a meeting (after M4, with
    Outlook's calendar).
  - Not taken for now: "forget this meeting" in the knowledge base only (a list of exclusions checked on every push),
    checking and pulling Ollama's models from the settings, and encrypting the database (SQLCipher with sqlite-vec,
    little gain on an encrypted disk).
- **"Summarize" in the meeting view**, built ahead of M3.5: only 10 of the 436 meetings in the knowledge base have the
  extension's summary, so the view of a cited meeting rarely had one.
  - A short summary of the whole meeting (5–7 bullet points in its language: topics, decisions, who took on what),
    streamed. The button is there also when the extension's summary is, as that one is often long.
  - The summary and its progress are in the view's header, which doesn't scroll: the text below opens at the cited
    moment. It can be folded to a line, which the window remembers.
  - Kept with the meeting (`summaries`) and the hash of its text: opened again, it shows at once, marked stale once the
    text changes, with "Summarize again". It goes with the meeting, and isn't indexed.
  - A meeting longer than the model's input (Groq's free tier: 4000 tokens; Ollama: an 8192-token context, set for the
    call, as its default 4096 would cut a part off) is summarized in parts, one call at a time for the per-minute
    limits, and their notes are combined, again while they don't fit. The view shows the step, and after a minute says
    that Gemini takes a whole meeting at once. The meetings are ~6k tokens on average, the longest ~95k.
  - F8: with a cloud LLM chosen, a meeting whose source doesn't allow it is summarized by Ollama on this computer with
    its default model (`qwen3.5:9b`), as drafts will be; the error says so when Ollama doesn't answer.
  - Closing the view stops it, and a stopped summary isn't kept.

2026-11-12:

- **A browser's lost token is replaced, not shown again.** "New token" in Sources (`kb new-token <source>`) gives a
  paired browser a new token for the same source: its meetings, vectors and the chats' citations stay, and the old
  token stops working. The knowledge base still keeps only the token's hash.
  - Showing it again would mean keeping the token itself, and would make it easy to paste one token into two browsers,
    whose reconciles would then delete each other's meetings. The tokens already given out are hashes only anyway.
- **A meeting that several browsers send is indexed once** (a backup restored in Chrome and in Firefox). Before, it was
  found twice, and its copies took two of an answer's few places (6 on Groq's free tier).
  - Each browser's rows are kept. The copy indexed is the one that came last, as the extension sends a session only
    when it changed in that browser; one with the same rows (by content, their keys in any order) leaves the indexed
    copy, so a browser sending everything again after a new token changes nothing.
  - When the indexed copy goes (deleted in its browser, or the browser removed), the copy of the browser paired last
    takes over. The short summary moves to it; saved chats show the old copy's citations as removed.
  - Skipping the later copy at a push wasn't taken: a meeting deleted in the first browser would then leave the
    knowledge base while the other still had it, as the extension doesn't send a session again until it changes, and
    the other browser's changes to it would be lost.
  - Sources tells how many of a browser's meetings are found through another browser's copy. "Open in Stenograma" opens
    the indexed copy, in its own browser.
  - An imported backup stays apart: it's removed once a browser is paired (F7).
  - A migration cut the copies indexed before to one: that of the browser that sent last. In the knowledge base then,
    Chrome and Firefox2 had 252 sessions in common, all with the same rows, and Firefox2's copies were kept.
- **Rocket.Chat is the first connector**, ahead of M3.5 and M4, as it's the messenger used every day. It brings the
  connectors' base (each source on a 5-minute timer, "Sync now", a failed run tried again later, twice as late each
  time up to an hour) and the chat chunker of F3. Its auth is the simplest, a pasted token, so the base is built without
  an OAuth flow.
  - A Personal Access Token with the user's id, checked with `me` before the source is added; it's kept in the keyring
    under the knowledge base's id too. It has the user's full access, which can't be narrowed, so `kb` still has no
    code that writes. A refused token is replaced with "Edit".
  - The rooms read: those chosen (the default), or all the user is in of the types ticked (channels, private groups,
    direct messages), rooms joined later too; livechat rooms never. The period read is chosen (the last 1–12 months, or
    everything); an earlier start reads the rooms again, a later one drops the messages before it. Both change with
    "Edit". A room no longer chosen, or left, goes with its messages.
  - Each run lists the subscriptions and the rooms' last message (`rooms.get`), and reads the rooms with a new one;
    every room every 6 hours, for edits and deletions. `chat.syncMessages` gives the messages updated after a room's
    cursor, thread replies too, and those deleted: in pages from 7.1 (`type=UPDATED|DELETED`, `next`), at once before.
    A room not read for 28 days is read whole, as the server forgets deleted messages after 30.
  - Rocket.Chat allows 10 calls a minute per endpoint by default (enforced from 7.9): a call waits when none are left,
    and a 429 is tried again after the reset. That limit is per IP address, shared by colleagues on the same network,
    so a source keeps its own, lower one: 5 calls a minute of each kind by default. With it, the first read takes about a
    minute per 5 rooms, or per 5,000 messages.
  - A source's load is set with "Edit" ("Load on the server"): how often it syncs (5, 15, 30 or 60 minutes), its calls
    a minute of each kind (1–30), and the pause between files fetched in the background (3 s by default; images wait
    on the model anyway, documents don't). Files are fetched one at a time, those shown in the app too.
  - A message is kept as its author, text, the messages it quotes (the server's attachments with `message_link`; the
    `[ ](link)` in the text is dropped) and its files' names. System messages, deleted ones shown as such (`rm`) and
    end-to-end encrypted ones aren't kept.
  - A room's day is a document, and a thread another, with its first message: its replies stay together (F3), and
    every chunk's header names the room, and a thread's also what it started with, so a reply keeps its context in an
    answer. A quoted message is a `> Author: text` line before its reply, which the search doesn't count as the
    quoted person speaking. The answer's prompt says how to read both.
  - A cited conversation opens in the app from its own copy, at the cited messages, with its threads and "Open in
    Rocket.Chat" (a permalink by the room's type and name). A chunk's time is the time of day.
  - Off for cloud AI by default (F8).
  - Each room's members are read once a day (`channels.members`, `groups.members`, `im.members`, a call per 100) and
    shown with a cited conversation. In a room of up to 20 people they're its documents' participants too, so the
    person filter finds the conversations someone is in though they didn't write; in a larger one, such as #general
    with the whole company (~55 people), membership tells nothing, and only those who wrote are. The chunks don't change
    with them, so nothing is embedded again.
  - The answer's context lists a room's members once, with its first source ("Room members (14): …"), as the messages
    name only those who wrote: "who's in the PMO course?" is answered when that room's messages are found. Which rooms
    someone is in isn't answered; a document of each room's members, found by the search, would do it.
  - Reactions are kept with their people, named by the rooms' members and the messages' authors (`chat_users`; a
    reaction gives usernames): "[reactions: 👍 Olena Koval, Andrii Melnyk; ✅ Taras]" in the message's line, at most 5
    names an emoji, and under the message in the conversation view. A 👍 from the right person is often the decision.
    Those who reacted are the document's participants. A reaction doesn't change a room's last message, so it's read in
    the check every 6 hours, or with the room's next message.
  - Not caught: a message deleted on a server that keeps history but doesn't show deletions (it's hidden, and reported
    by no call).
  - Still to do: the check on the real server (its version, and that the admin allows tokens), and 3–5 golden set
    questions about it with `kb eval`.
- **Images and files in chats are read**, in the background, newest first, after answers and summaries (they use the
  same model). In a work chat a screenshot often holds the point: an error, a ticket, figures.
  - An image (PNG, JPEG, WebP, GIF up to 10 MB) goes to a vision model: its text word for word, and what it shows in a
    sentence or two. The default is the answers' `qwen3.5:9b`, which reads images; ~20 s an image on this machine's
    6 GB GPU once loaded. Its own settings: on or off, Ollama's vision models or Gemini, and the period (the last
    3 months by default). Gemini only reads the chats that may go to cloud AI; the others' images go to Ollama's
    default (F8, as summaries).
  - What it read goes into the message's line, "[image name, described by AI: … Text in it: …]", so the search finds
    the screenshot by its error and the answer can use it; a text over 600 characters is a document of its own too.
    The answer's prompt and the conversation view say it's by AI.
  - A PDF's text layer and a text file (up to 30 MB) are read without a model, each a document of its own (`chat-file`)
    that opens its message. A scanned PDF has no text and is left out. Word and Excel files aren't read yet.
  - The settings try the model, as set and before it's saved, on one of the chats' latest images, keeping nothing; "Read
    all images again" reads them with the model saved.
  - Images are kept next to the knowledge base (`attachments/<source>/<file>`, mode 0600) and shown in the conversation
    view as `data:` URLs, which the CSP already allows; SVG isn't read or shown. A document's file isn't kept.
  - A file is fetched with the token as headers and as the cookies (`rc_uid`, `rc_token`) Rocket.Chat's web client
    sends, as servers check one or the other: unchecked on a real server yet.
  - A model or server that isn't there stops the run, tried again a minute later, without counting against the file;
    another failure counts, and a file is marked failed after 3.
  - `ollama-ai-provider-v2` sent an image's bytes as a JSON object, which Ollama refused: images go as base64.
- **A chat room, and the most reactions, in questions.** "Which message in qa_dev_talks got the most reactions?" isn't
  a search: the chunks most like it say nothing of counts, and the answer sees 8 of the room's thousands. So the
  rewrite also gives the room a question names and `"rank": "reactions"`.
  - The room is found by its name or title however written ("qa_dev_talks", "#qadevtalks", "QA dev talks") and limits
    the search to its documents: all its chunks ranked by their float vectors, as the index's nearest of every source
    hold few of one room. A room set by hand ("Chat room" in the filters) wins; one no room is called gives a warning.
  - With the ranking, the sources are the chunks of the room's messages with the most reactions in the period, each with
    a line saying how many ("A message here has 35 reactions: …"): a small model counts names badly.
  - Other counts ("who wrote the most", "how many messages a week") would need tools for the model (function calling),
    not taken yet.
- **A Rocket.Chat source tells what it has.** Its card sums its messages, threads, messages with reactions, images and
  files (how many read); "Edit" shows each room's members (the server's count) and, for a room it reads, the same counts
  and when it was last synced.
- **Reading images can be paused** (for an hour, four, or until resumed: in Settings, on Sources, and from the tray),
  as the vision model takes the GPU while the user works on something else. The image being read is stopped without
  counting against it, and Ollama lets go of the model at once (`keep_alive: 0`) instead of after 5 minutes; documents
  are still read. The pause is kept in the settings file, so it outlasts a restart, and ends by itself.
- **A chat's model is chosen in the chat**, and "Ask again with…" under an answer, ahead of M3.5. The list next to the
  question has Ollama's models that answer (not its embedding models or rerankers), and Groq's and Gemini's, listed by
  their APIs when their key is in the keyring (for 10 minutes). A chat keeps the model of its last question
  (`chats.llm`); a new one takes the settings'. Each answer says which model gave it. A cloud model still sees only the
  sources that may go to cloud AI (F8).
  - A small model (`gemma3:4b`) made up a date range in the rewrite and found nothing: the filters undone in one click
    (M3.5) matter more with a choice of models.

2026-11-13:

- **The chat's composer is one frame**, as in other chat apps: the question above, and its bar below with the filters
  on the left (set in a popover, each active one a chip with ✕) and the chat's model on the right, next to sending
  (🖥 on this computer, ☁ in the cloud). "New chat" left it: the sidebar's + and Ctrl+N start one. Under an answer,
  the model that gave it, and "Ask again with…" in the same style.
- **What the rewrite took from a question is chips** under "Searched for" (the days, the person, the room, "by the most
  reactions"): ✕ asks again without it (`ask`'s `without`), as when a small model made up a date range. Filters set by
  hand still win.

- **Meeting series.** Questions such as "what was discussed at the lead meetings last month" need to know which meetings
  are the lead meetings: in the knowledge base then, 16 of 303 Meet calls had Meet's name and 10 the user's, the others
  only their code. A recurring calendar event keeps its Meet code: 23 codes, and 8 of 4+ meetings held 280 of them.
  - A series is a name and matchers: a Meet code, a weekday and time (±20 min by default), a period. The most specific
    that fits a meeting wins, so a code used for different meetings (a team's own room) is told apart by its times.
    Sources → "Meeting series" lists the meetings by code (how many, the weekday and time most have, who speaks), to
    name once.
  - The series's name is the meeting's title ("Lead meeting · Planning" with its own), in its chunks' header, and
    `documents.series_id`. A series saved or deleted indexes every meeting again; only the chunks whose header changed
    are embedded again.
  - The rewrite is given the series' names and returns one ("лід мітинги" → "Lead meeting"); "Meeting series" in the
    filters sets it by hand. It's a chip with ✕, as the others.
  - A question about a series gets a source for each of its meetings in the period, the newest first (at most 30): its
    short summary, or the extension's, else its 2 chunks most like the query. The top chunks of all its meetings would
    leave most of them out.
  - The meetings of a named series get a short summary in the background (Settings → "Meeting summaries": on, the last 3
    months by default), as "Summarize" makes them, after the images and documents and paused with them ("the background
    AI work", from Activity or the tray).
  - Short summaries are indexed now, as `meeting-short-summary` documents made by AI, and found by any question (the
    Decisions of 2026-11-03 had them kept but not indexed).
  - **Their progress is shown** (Activity, from 2026-11-14; Sources → Index and Settings before), as on Ollama a long meeting is several minutes of calls:
    the meeting being summarized, its step (a part's notes or the summary), its time so far and its model (on this
    computer or in the cloud); the average time of the model's last 10 summaries and the time left by it, with the
    output tokens a second; the meetings skipped until a restart, the last error; and, when none is made while some
    wait, why (an answer goes first, the chats' files are read first, paused, the model not reached and when it's tried
    again). `summaries` keeps each one's time and calls for the average; the core's log has each call's time and
    tokens. The sidebar's line adds the time left ("Summarizing meetings: 14 left, ~1 h 20 min").
  - **"Try a model"** under them summarizes a meeting with another model, to compare: each try's summary with its
    time, calls, tokens and tokens a second, next to the saved one; nothing is kept (`trySummary`, stopped as
    "Summarize" is). F8 holds: a meeting that may not go to cloud AI is tried only with Ollama. A try counts as a
    summary asked for, so the background work doesn't start another meanwhile, and one already running is noted.

- **The Sources page.** One "Add a source" opens tiles of what can be added (a browser with Stenograma, Rocket.Chat),
  each going on to its own steps; an empty page shows the same tiles. Another source is a tile more, not a button more.
  - Sources, "Meeting series" and "Index" (the embeddings, the background AI work and its pause, the API's address) are
    tabs: the series no longer push the index down. (From 2026-11-14 the series are in Settings → Meetings and the index
    is the Activity page.)
  - A card shows its icon, its state as a dot (synced, syncing, waiting for a browser's first push, failed), what it has
    in the units of its kind (meetings, rooms, messages) instead of documents and chunks, and its cloud switch with the
    explanation in a tooltip. Rare actions (rename, a new token, rooms and period, remove) are in its "⋯" menu.
  - A meetings source's card also says when its browser last checked in without sending ("Sent 14:47 · checked 19:40,
    nothing new": a push calls `/status` first, which keeps `last_seen_at`, while "Sent" is the last `/ingest`), so
    an extension that doesn't reach the app is told apart from one with nothing new; its meetings' period, the newest
    one, those with a short summary and in series, its chunks waiting for embeddings, and the meetings indexed from
    another browser's copy by that browser's name.
  - "⋯ → Meetings…" lists a browser's or a backup's meetings, the newest first, filtered by title, series or date, and
    opens one in the meeting view (as a citation does, from the copy that's indexed, which a summary is kept with). It's
    there to see what the knowledge base has; chats aren't listed, Rocket.Chat shows them.
  - Icons: the browsers' and Rocket.Chat's marks, from Simple Icons (CC0), drawn inline as the CSP loads nothing. Edge
    has none there, so a globe. A browser source's browser is chosen when it's added (`sources.config.browser`), else
    guessed from its label ("Firefox2" is a Firefox); "Rename" changes both (`updateBrowser`).
  - Adding a browser shows the extension's steps (its popup's "Local knowledge base", the URL only when the port isn't
    the extension's default) and waits for the browser's first push: "Firefox is connected: 120 meetings". "New token"
    does the same.
  - A connector's error comes with what fixes it: the runner keeps the last run's `problem` (`auth`: the token refused or
    missing from the keyring; `network`: the server not reached; `other`), and the card offers "Enter a new token" or
    "Try again", with the next try's time. The new token has a method of its own, `setRocketChatToken`, as "Rooms and
    period" can't list the rooms with the refused one.

2026-11-14:

- **The AI's work is kept for its statistics**, a row per model call (`ai_calls`): the AI SDK's middleware around every
  language model the core makes (`wrapLanguageModel`), and a wrapper of the embedding provider, so no call site counts
  by itself; a stream is kept at its `finish` part, as the SDK may not read on after it. A row per call rather than a
  day's totals, so any statistic can come later (the slowest calls, by hour); a year of them, then a day's totals
  forever. Activity shows a period's totals by task and by model (calls, time, tokens in and out, tokens/s, chunks,
  errors); charts may come from the same rows. The time is the calls' own, so work on two servers at once counts
  twice, and each retry is a call.
- **Reply drafts for Rocket.Chat go ahead of M3.5 and M4**, as Rocket.Chat itself did (2026-11-12): the user is
  mentioned there daily, and the drafts are what the plan is for. Only what M7 says for copying by hand: nothing is
  sent, the token can already send but no code does.
  - "Draft replies" on the source's card (`sources.replies_enabled`, off by default). Turned on, the unread messages to
    the user of the last day get a draft (`chat_rooms.read_at` is the subscription's `ls`), and from then on every new
    one, read or not, as the user may read a message before its draft is written. None older than 3 days gets one, as
    when the app was off. Both are days in Settings → "Reply drafts" (`drafts.unreadDays`, `drafts.maxAgeDays`).
  - "Draft a reply…" asks for one by hand, for a conversation's last message from someone else in those days, whatever
    the rules say: to check the drafts without someone writing to the user, or for a message they missed. Such a draft
    closes only when the user writes after asking for it.
  - A message is to the user (F9): a direct message, a mention by name (`mentions` kept from 2026-11-14, `@username` in
    the text of messages kept before; `@all` and `@here` don't count), or a reply in a thread the user started or wrote
    in. Only the rooms the source reads count. A conversation (a thread, or a room's main line) has one open draft, for
    its last message to the user: a later one supersedes it.
  - Found after each sync (every 5 minutes at first; in seconds over Rocket.Chat's realtime API from 2026-11-15), and written before
    the images and summaries, one at a time, paused with them. A draft the user asked for ("Draft a reply…", "Write
    again"; `drafts.asked`) is written while paused too, as an answer in the chat is; a paused one says so. A draft closes when the user writes in its conversation
    after its message, in Rocket.Chat or anywhere it syncs from.
  - A draft is the conversation up to the message (a thread's first message and last replies, or the room's last 20 of
    two days) and the knowledge base's search for the messages to the user since they last wrote, its own chunks left
    out; at most 6 sources, cited as [n]. F8 as summaries: Ollama writes it when the chats may not go to cloud AI, in an
    8192-token context.
  - "Reply drafts" in the sidebar, with the count to review: each draft with its messages, the text to edit, its
    sources, "Copy" (without the [n] marks), "Open in Rocket.Chat", "Write again" and "Dismiss". A notification says
    how many are ready, never the message.
- **Settings in tabs, and an Activity page** (replacing the Sources page's "Meeting series" and "Index" tabs): Settings
  had grown into one long page mixing models, background jobs and their progress, with the progress shown twice
  (Settings and Index) and the series apart from the summaries they're for.
  - Settings has tabs: "AI models" (the servers with their models, queues and keys; the index's embedding model; from
    2026-11-14's later decision below), "Meetings" (summaries, their
    "Compare models on a meeting", and the meeting series), "Chats" (what is read of the files, reading the images
    again and a try of the vision model; reply drafts) and
    "General" (the extension's port, the data's folder). One Save for all the tabs, a tab with changes not saved marked;
    the keys are saved at once, as before, and say so. Each model keeps its own Ollama address, as the LLM may be on
    another machine than the embeddings (an Orange Pi through a tunnel). The tries of a model open on a click.
    The embeddings' model is chosen with the same picker as the chat's, from every server's models that embed and
    Gemini's with its key (`taskModels`); a model not listed can't be typed any more: one that isn't on a server can't
    run there.
  - "Activity" in the sidebar, next to Settings: a row each for the index, the chats' files, the meetings' summaries,
    the reply drafts and the extension's API, with their progress and errors, the data's folder, and the pause of the
    background AI work at the top (it pauses the drafts too, and says so). The status line opens it, or Sources for a
    source to fix. Settings shows no progress but a model's rebuild, with a link to it. As the background work runs on
    several servers at once, the AI servers row says what each does now (the task, its meeting, image or conversation,
    the time so far) or that it's busy with what was asked, isn't reached or is idle, with what waits for it; the
    images and the drafts show the one done now, the average time of the last ten by the model set (kept in memory
    only) and what's left, as the summaries do; and each task says why it waits on its own server (`TaskWait`: what was
    asked, another task's work there, the pause, the server not reached, a model that doesn't read images).
  - The Sources page is the sources only, without tabs.
- **Reply drafts learn the user's style** from what they wrote, without training a model (a LoRA was weighed: too
  heavy on a 6 GB GPU, again for every model, the NPU's included, and it wouldn't bring the facts anyway):
  - Each draft's prompt has up to 8 of the user's replies to the most similar messages: their message after someone
    else's in the same conversation within an hour, with the ones written within 3 minutes after it as one reply;
    ranked by the same person, the same room, shared words and how recent. None from the conversation given. About
    2400 of them in the real chats; picked in ~200 ms.
  - A draft the user answered keeps that message (`drafts.sent_message_id`): the last 3 rewritten before sending are
    in the prompt as "Draft / Sent", and Settings says how many were sent as written, a measure of the drafts.
  - "Your style" in Settings → Chats → Reply drafts (`drafts.style`): a description of how they write, made by
    "Describe my style" (the answers' model reads their latest 200 messages; Ollama's unless every chat may go to
    cloud AI) and edited by the user, in the drafts' system prompt.
  - Examples and corrections take at most 1200 tokens of the prompt; they come only from the draft's own source, so
    F8 holds as for its conversation.
- **AI servers, a model per task, and a background queue per server**, for the Orange Pi 5 Plus's NPU
  (`docs/orangepi-npu-setup.md`: RKLLama with Ollama's API, through an SSH tunnel at `127.0.0.1:11435`; Qwen3.5
  2B/4B/9B and Gemma 4 E2B, no embedding or vision model):
  - Settings → AI models lists the servers (`servers`: name, address, its model for the background work), this
    computer's first, each checked as it's typed. A model keeps its server's address (`ollamaUrl`), so F8's loopback
    rule, the chats' own models and the providers stay as they were; a server's new address moves its models.
  - "Models" sets which model does what: answers, summaries (`summaries.llm`) and reply drafts (`drafts.llm`), these
    two "Same as answers" by default; the embeddings and the vision model choose a server (or Gemini) instead of an
    address. The chat's model list is grouped by server.
  - The background work runs a queue per lane, a server or a cloud provider (`core/servers.ts`): the Orange Pi
    summarizes while this computer reads images and answers. Work gives way only to what the user asked for on the
    same lane. A kind of work moved meanwhile waits for the lane still doing it.
  - A server not reached stops its lane; the servers are asked every 30 seconds (`/api/version`) and a lane runs again
    as soon as its server answers. What the user asks for (an answer, "Summarize", a draft asked for, "Describe my
    style") goes to the fallback's model (`fallback`, this computer's qwen3.5:9b by default; "None" to say it isn't
    reached) when its server isn't reached; the background work waits instead of taking this computer's GPU.
  - Moving the background work in one go: "Background AI on" in the tray (summaries and drafts), or each on Activity,
    to a server's model (`moveBackground`). Activity shows the servers and where each task runs.
- **The models are set on the servers, and the background work shares one queue** (later the same day: the "Models"
  rows repeated what the servers said, and this computer sat idle while every task was on the Orange Pi). The above's
  per-task models, `fallback` and moving the work are gone:
  - Each server (`servers`, in order) has its kind (`ollama`, `groq`, `gemini`), an address for Ollama's, a model for
    text (answers, summaries, drafts, the style) and one for images (none for Groq), both chosen from what it lists,
    and its queue on or off. Groq, Gemini and Claude (`anthropic`, added the same day through `@ai-sdk/anthropic`, as
    the others go through the AI SDK; its models listed by Anthropic's `/v1/models`, every one reading images) are
    always in the list, their keys set on their rows (the Keys card is gone); their queue is off by default, and on it takes only the work of sources that may go to cloud AI (F8).
  - The chat answers with the first server's text model; when its server isn't reached, the next one's in order takes
    what the user asks for, so the order is the fallback. A chat's own model stays as it was.
  - Every server with its queue on runs a lane of the background queue and takes the next draft, image or meeting it
    has a model for (drafts, then images, then summaries); what a lane took is claimed in memory, so no two take the
    same. A draft whose server isn't reached waits again for another. Settings older than this are made into servers
    from their per-task models (`serversOf`).
  - The embeddings stay one model for the index (vectors of two models can't be compared), chosen under the servers.
  - The tray and Activity turn a server's queue on or off (`setServerQueue`); Activity shows what each server does and
    takes, and why a task waits on all of them (or that no server takes it).
  - Each task's row on Activity (summaries, images, drafts) lists the servers whose queue takes it (`TaskServer`, from
    2026-11-15): the one each does now, with a summary's step, or why it doesn't, and its model's average time (and a
    summary's tokens/s); what's left is counted with all of them at work, each at its model's speed. Before, a task
    showed only the first server's work, and one average for all.
  - One text model per server: the Orange Pi's NPU keeps one model loaded, and two would swap back and forth.
  - A cloud provider's rate limit (`core/ratelimit.ts`) stops only its lane, never the work: a refusal (429, Gemini's
    `RESOURCE_EXHAUSTED`) puts the draft, meeting or image back to wait and the lane until the provider's `Retry-After`
    or Google's `retryDelay`, or, for a day's quota, its next midnight in California; Groq's and Anthropic's limit
    headers stop the lane before a refusal, when no request or too few tokens are left. Gemini sends no such headers,
    so its limits are known only from its refusals. Activity says until when.
- **Rocket.Chat's new messages arrive as they're sent** (2026-11-15), over its realtime API (DDP on the server's
  `/websocket`, as its web client uses; `core/rocketchat/realtime.ts`), as 5 minutes was too long a wait for a reply
  draft. Polling once a minute (constant load on the server, still a minute) and polling only `subscriptions.get` with
  `updatedSince` every 30 s were weighed.
  - It logs in with the source's token as a resume token and subscribes to the user's `stream-notify-user`
    (`rooms-changed`, `subscriptions-changed`, thread replies included). The rooms that changed, gathered for 1.5 s,
    are read at once without listing the rooms (`syncRooms`: one `chat.syncMessages` a room), then the drafts are
    found, first in the queue. A room not kept yet (a new direct message) runs the whole sync.
  - Polling stays, for what a change doesn't tell and as the fallback: every 30 minutes while connected, at the
    source's interval while not, and at once after a reconnection. A ping every 30 s finds a dropped connection (a
    laptop's sleep); it connects again after 5 s, twice as late each time up to 5 minutes. A refused token is tried
    again the same way, with a new one once given.
  - The source's calls a minute count every read, the live ones too, across its runs (`createApiLimits`, one per
    source): more rooms changed in a minute than it allows wait for the next one.
  - No new service: the same server and token. Node's own `WebSocket` (Electron 45's Node 24), no package. What
    arrives is never logged (a room's change carries its last message). The source's card says "Live".
- **Ollama Cloud is a cloud provider** (2026-11-15), next to Groq, Gemini and Claude in Settings → AI models: Ollama's
  own API at `https://ollama.com/api` with the user's key as a bearer token (keyring `llm:ollama-cloud`, or
  `yarn kb key set ollama-cloud`), through the same `ollama-ai-provider-v2`. Not an Ollama server with an address: it
  isn't the user's, so F8 holds it to the sources that may go to cloud AI, and its key needs the keyring. Its models
  come from `/api/tags`, those that read images from each one's `/api/show` capabilities. No `think: false` and no
  `num_ctx` (its models have their own); no rate-limit headers known, so its limits show only as refusals.
- **A server that refuses all its work stops its queue, not the work** (2026-11-15): Ollama Cloud without credits
  answered 402 to every call, and each meeting it took was skipped until a restart, 42 in a minute, so the other
  servers had none left. A 401, 402, 403, 404 or 410 (a wrong key, no credits, no access, a model it hasn't or
  retired; `serverRefusalOf`) now puts the meeting, draft or image back to wait for the other servers and stops that
  server's lane for 30 minutes, or until its models or key change. Activity says what the server answered.
- **OpenAI-compatible APIs as servers** (2026-11-15), for the free cloud tiers like Groq's: Cerebras, OpenRouter,
  Mistral, NVIDIA, SambaNova, GitHub Models (presets in Settings → AI models), or any other by its address. One kind
  (`openai`) instead of a provider each, through `@ai-sdk/openai-compatible` (2.0.88, the AI SDK 6 line). Like an
  Ollama server it's known by its address (`url`, an LlmSettings's `ollamaUrl`), so there may be several; its key is
  the address's (keyring `llm:openai:<address>`, `yarn kb key set openai <address>`). Always a cloud provider (F8),
  even at a loopback address; added with its queue off. Models from `GET <address>/models`; those that read images
  from OpenRouter's `input_modalities`, any when the API doesn't say. Free tiers' terms differ: some keep the
  prompts or train on them (OpenRouter's `:free` models, Mistral's Experiment plan), which the sources' "May go to
  cloud AI" should weigh.
- **Room to think for cloud models** (2026-11-15): Qwen 3 and gpt-oss on Cerebras think before they answer, and the
  thinking counts against the cap on output, so on a long meeting a part's notes (1024) or the summary (1536) were
  all thinking and came back empty ("The model gave no summary"). OpenAI-compatible APIs and Ollama Cloud now get
  Claude's 16000 too (`withRoomToThink`, `core/llm.ts`). An empty answer (`EmptyAnswerError`), notes included, stops
  that server's summaries like a refusal instead of skipping meeting after meeting.

## Why Electron, with a core of its own

Email and messengers need a process of their own on the machine: a browser can't poll sources while it's closed, and an
MV3 service worker can't run a backfill that takes hours. Reply drafts need more than a process: a review queue at hand
without a browser tab, a notification when a draft is ready, a tray icon. That's what Electron adds.

The core is still a package that doesn't import Electron (`core/` of this repo): storage, connectors, the
pipeline, search, answers, drafts and the HTTP API for the extension. The app (`app/`) runs it in a `utilityProcess` and
talks to it over a `MessagePort`; `kb search` and `kb eval` run the same core from the command line.

Running the core inside the app means:

- **The sidebar's status line** shows the one thing most worth knowing, in this order: a source whose sync failed
  (with why: a new token needed, the server not reached), the extension unable to send, the index or the reading of
  images stopped by an error, the work going on (indexing, a model's rebuild, images and files, meeting summaries, with
  how much is left), the background AI paused, else "Up to date" (not a count of chunks). Its tooltip has the whole
  state, and a click opens where it's seen and fixed (Sources for a source, else Activity, from 2026-11-14). A routine sync isn't shown: it would blink
  every few minutes.
- **Starting at login** is a checkbox in the tray's menu, no longer in Settings: the app stays there. Saving Settings
  keeps it as the tray set it.
- Syncing, polling and the extension's pushes work only while the app runs, so it starts at login and closing the
  window leaves it in the tray. The extension shows that the knowledge base isn't running and tries again at its next
  alarm.
- Native modules need no build for Electron: better-sqlite3 (from 13), `@napi-rs/keyring` and `onnxruntime-node` use
  Node-API with prebuilt binaries, and `sqlite-vec` is a loadable SQLite extension.
  - In a packaged app electron-builder puts their binaries in `app.asar.unpacked` by itself. But `sqlite-vec`'s
    `getLoadablePath()` points inside `app.asar`, which SQLite's `dlopen` can't read, so the core loads it from the
    `app.asar.unpacked` path.
  - Tests and `kb eval` run under Electron's Node (`ELECTRON_RUN_AS_NODE=1`), the runtime the core has in the app.

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
  - React, Tailwind and shadcn/ui (Radix).
    - Meet's palette from the extension's `helpers/theme.ts` is shadcn's CSS variables in
      `app/renderer/src/index.css`.
    - The extension's `components/MarkdownText.tsx` (raw HTML shown as text) is ported to Tailwind's typography
      plugin (`prose`).
  - `contextIsolation` and `sandbox` on, no `nodeIntegration`; the preload exposes a short list of IPC calls.
  - A CSP of `'self'`, with inline styles allowed; `setWindowOpenHandler` denies new windows and `will-navigate` is
    blocked.
    - Radix's scroll lock (Dialog, Select, DropdownMenu, through `react-remove-scroll`) and sonner's toasts add
      `<style>` tags, which that CSP blocked. So styles may be inline, scripts not
      ([Decisions](#decisions), 2026-11-03).
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
    `http://127.0.0.1:<port>/stenograma-open?source=…&session=…&v=…&t=…` in the default browser. There a content script
    of the extension (matching that path; `http://127.0.0.1/*` is already a host permission, so no new install warning)
    checks that the source is this browser's, asks the background to open the history page at the meeting
    (`openExtensionPage`) and closes the tab.
  - `v` is the version the meeting's chunks are made of (its `createdAt`; none for the session's own text), from
    `getIndexedVersion` (`core/stenograma/meeting.ts`), and `t` the moment, counted from that text's first message. A
    recording is indexed from its latest done version while its own text is often empty (transcription off), so
    without `v` the history page would show another text than the one cited. It opens that version on the Text tab
    (its own text when the version was deleted since) and scrolls to the moment.
  - A meeting pushed by another browser can only be shown in the app.
  - "Summarize" makes a short summary of the meeting, kept with it ([Decisions](#decisions), 2026-11-03).

## Requirements

### Functional

- **F1. Stenograma.**
  - Meet calls (captions and chat) and recordings of the recorder page.
  - The extension sends a session's rows (step 1 of [Sending](#sending-stenograma-data-from-the-extension)). The core
    keeps them and picks what to index by the rules below, so a change to the rules is a core update, and the core
    indexes its copy again without a push.
  - A session that several browsers send is indexed once, from the copy that changed last ([Decisions](#decisions),
    2026-11-12).
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
  - Attachments aren't indexed in v1, only their names. A chat's images and documents are ([Decisions](#decisions),
    2026-11-12).
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
  - Hybrid: BM25 (FTS5) plus vectors, merged with reciprocal rank fusion, BM25 at half weight (M0).
  - Filters: source, date range, person. They're set by hand or taken from the question (F6).
  - A date range filters. A person only raises the rank of chunks whose author or participants match, since one person
    is written differently in Meet, email and Telegram and there's no people directory in v1. Names are compared
    lower-cased, with Cyrillic transliterated to Latin and the usual spellings merged (g/h, kh/h, y/j/i, doubled
    letters): "Олег" matches "Oleg" and "Oleh", "Юлія" matches "Yulija". A chunk where the person speaks is raised
    more than one from a meeting they were in.
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
  - Connect, disconnect and remove a source (with all its documents and tokens). A paired browser is a source too, and
    gets a new token when its own is lost.
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
    `cloudAllowed` gets its draft from Ollama, with thinking off (M0); when Ollama isn't running it gets none, and the
    queue says why.
  - Sending goes through the source as a reply in the same thread (the Reply column of [Connectors](#connectors)). A
    log keeps what was sent: ids, time, conversation.
  - Drafts need new messages within a minute, not 5–15. Sources with live connections use them (Slack Socket Mode,
    Rocket.Chat's realtime API, done 2026-11-15; Telegram updates); the others are polled every minute.
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
    meetings): `~/.local/share/stenograma-kb/eval/golden-set.json`, mode 0600.
  - M0 starts it with meetings, read from `data.json` of a Stenograma backup; each connector adds a few questions
    about its source.
  - Target recall@10 ≥ 0.8. The set picks the embedding model and is a regression check.

### Not in v1

Zoom ([below](#later-zoom-recordings)), WhatsApp / Viber (chat export files), attachments, Teams channels (need admin
consent), a reranker, webhooks instead of polling (reply drafts use live connections where a source has them), sending
without approval, a people directory that joins one person's names across sources, a shared team knowledge base.

## Architecture

```
 Extension ──push (alarms)─────────▶ ┐
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
    browser, the hash of its token and lastSeenAt (its last call to the API, a push or not).
  - `documents`: `id` = `<source>:<nativeId>`, kind, threadId (the conversation), title, author, participants,
    createdAt, updatedAt, url, madeByAI.
  - `chunks`: documentId, ord, text with a context header ("[Email · subject · from · date]"), textHash, startMs for
    transcripts.
  - `stenograma_rows`: the rows a browser pushed (source, table, key, JSON), so the core can index them again when the
    rules of F1 change, without a push, and another browser's copy of a session can take over.
  - `chat_rooms` (a messenger's rooms read, with their cursors, members and when the user last read them) and `chat_messages` (each message as the
    chunker reads it: author, text, quotes, files, its thread), so a room is indexed again without a sync. A room's day
    is a document (`chat`), a thread another (`chat-thread`), and a file's text a third (`chat-file`).
  - `chat_attachments`: a message's image or document whose content is read, with its state (pending, done, failed,
    skipped), what was read (text, an image's description) and the model.
  - `chunks_fts`.
  - `vec_<model>`: a vector table per embedding model, so the model can change without downtime. It holds bit vectors
    (the signs), and `sourceKind` and `createdAt` are its metadata columns.
  - `embedding_cache`: model, textHash, vector (float32). Also where the search rescores its candidates from.
  - `jobs`: the embedding queue, with retries.
  - `chats` and `chat_turns`: the app's chats; a turn's question, request, cited sources (ids, without the chunks'
    text), answer and state; from M3.5 its tokens.
  - `llm_usage` (M3.5): tokens in and out per day and model, and the number of calls.
  - `summaries`: the app's short summary of a document (a meeting), with the hash of the text it summarized, the
    model, and how long it took in how many calls (null for those made before 2026-11-13); it goes with its document.
  - `drafts` (2026-11-14, Rocket.Chat first): source, conversation (room and thread), the message replied to, why it
    got one (`direct`, `mention`, `thread`), text, the sources it was given, model, `server` (its name then, shown
    with the model; 2026-11-15), error, state (`waiting`, `writing`,
    `ready`, `failed`; closed as `dismissed`, `replied`, `superseded`; `sent` from M8), createdAt, `asked`, and
    `sent_message_id` (the user's message that answered it, for their style); and `sent_log` (M8).
  - `ai_calls` (2026-11-14): a row per model call, each try of it, for the AI's statistics: when, ms, task (`answer`,
    `rewrite`, `summary`, `draft`, `image`, `style`, `embedding`, `search`), provider, model, server (an Ollama
    address, else the provider), input and output tokens as the provider counts them, items (chunks embedded), error
    (`unreachable`, `timeout`, `aborted`, `failed`) with what it said cut to 300 characters (`error_message`, from
    2026-11-14, for the list of errors a number of them opens; the database keeps the sources themselves, so it holds
    nothing new, and it's never logged; a list's errors can be deleted, the failed calls themselves, so they don't
    count as calls that answered), what it worked on by its ids (`item`: `meeting:…`, `draft:…`, `file:…`,
    `turn:…`, named in that list; a number of calls opens them by item, each with its result as its own table keeps it
    now: the summary, the draft, the image's reading, the answer, so nothing is kept twice), background. Never the
    call's text. Kept a year, then
    folded into `ai_call_days` (a day's totals by task, model, server and background), so a period's statistics count
    both.
- **Embeddings.** One provider interface with three implementations:
  - Ollama `bge-m3` (1024 dimensions, the best of these for Ukrainian);
  - transformers.js in the core (multilingual-e5, no Ollama needed). It needs the `query:` / `passage:` prefixes, and
    reads at most 512 tokens, which the ~400-token chunks stay under;
  - Gemini `gemini-embedding-001` with `outputDimensionality: 768` (3072 by default, four times the storage).

  M0 picked Ollama's bge-m3 as the default ([Decisions](#decisions)); transformers.js is for a machine without
  Ollama. Gemini API's free tier may use what it's sent to improve
  Google's products, so email and chats go to it only on a paid tier or with `cloudAllowed`. Groq has no embeddings.
- **BM25 for Ukrainian.**
  - FTS5 with `unicode61`. Text and queries are normalized first: the apostrophes `'`, `’` and `` ` `` become `ʼ`
    (U+02BC). `unicode61` takes `ʼ` as a letter, while `'` and `’` split "п'ять" into "п" and "ять".
  - A query word of 5+ letters loses one ending from a fixed Ukrainian list, the longest that leaves at least
    4 letters, and is matched as a prefix ("бюджету" → `бюджет*`).
  - Checked on the golden set; the fallback is the `trigram` tokenizer.
- **Scale.**
  - Roughly 100k chunks for a year of email and chats: about 400 MB of float32 vectors in `embedding_cache` and 13 MB
    of bit vectors in `vec_<model>`.
  - Source and date filters are metadata columns of `vec0` (sqlite-vec 0.1.6+), so they apply inside the
    nearest-neighbour search. Filtering a top 50 afterwards can leave nothing.
  - A float32 scan of 100k vectors took ~250 ms, more than N3 allows, and `int8` was slower still in sqlite-vec 0.1.9.
    So `vec0` searches bit vectors by Hamming distance for 400 candidates, and their float vectors from
    `embedding_cache` rank them (M1).
- **API for the extension.**
  - `POST /ingest`: session bundles (step 1 of [Sending](#sending-stenograma-data-from-the-extension)).
  - `POST /ingest/reconcile`: every session id the browser still has; the rest of its documents is deleted.
  - `GET /status`, with the knowledge base's id (a new one makes the extension send everything again) and `apiVersion`.
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
  - Shared UI files would import `react` from the extension's `node_modules`, and the app's own code from its own,
    giving two copies of React in the renderer. The extension's UI is MUI too, and the app's is Tailwind.
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
  - Copied once, then the app's own: `INPUT_TOKEN_BUDGET` with `estimateTokens` from `background.ts`. The palette of
    `helpers/theme.ts` and `components/MarkdownText.tsx` are ported to Tailwind ([The app](#the-app)).
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
| Rocket.Chat | Personal access token (`X-User-Id`, `X-Auth-Token`) | `subscriptions.get` and `rooms.get` (each room's last message), then `chat.syncMessages` for the rooms with a new one: pages of `type=UPDATED` from a cursor (7.1+), `lastUpdate` before; every room every 6 hours | `type=DELETED` pages (the server keeps them 30 days) | `chat.sendMessage` (`tmid` in a thread) | The server version; whether the admin allows personal access tokens; the rate limit (10 calls a minute per endpoint by default) |
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
     restore bring it from Meet or a backup, so it can be older than the last push and the item would never be sent.
   - `getSessionSize` leaves `changedAt` out, like `customName`. Meet's copy never has it, so otherwise every sync
     would send the session again.
3. **Which sessions go.** On each alarm a session goes when its signature differs from the one sent last: the keys of
   its transcripts, answers and action items, and the latest `changedAt` of it and them, read from the keys and the
   `changedAt` indexes without the rows.
   - That covers a change (a later `changedAt`), a deleted version or answer (it leaves no `changedAt`, but other keys)
     and a new session. Sessions from before `version(8)` have no `changedAt` and go once.
   - A signature is kept only after the core accepted its batch; batches are up to ~2 MB, the oldest changes first. A
     knowledge base with another id clears them, so everything goes again.
   - Planned at first: a cursor (the largest `changedAt` sent, minus a minute of overlap) besides the keys. Its overlap
     sent the last changed session again on every push, and the signatures make it unneeded (M2).
4. **Deletions.** On each alarm the extension hashes the list of its session ids. When the hash differs from the last
   one sent, it sends the list to `/ingest/reconcile`. The tombstones can't be used for this: deletions made on Meet
   (`ARCHIVE_DELETE_*`) leave none in the extension's database, transcript versions have none, and a restore removes
   them.
5. **Push from the background.**
   - `helpers/knowledgeBase.ts` in `background.ts` runs on a `chrome.alarms` alarm every 5 minutes (a permission
     without an install warning), and on "Sync now".
   - It sends with `fetch`; `http://127.0.0.1/*` is already in `host_permissions`.
   - While the app isn't running the request fails: nothing is marked as sent, the status says so, and the next alarm
     tries again.
6. **One source per browser.**
   - The app's "Add a browser" makes a Stenograma source with its own token, which is pasted into the popup.
   - Chrome and Firefox keep separate histories, and a reconcile from one must not delete the other's meetings.
   - After reinstalling the extension, pasting the same token continues the same source, and the reconcile removes
     what the browser no longer has. A lost token is replaced by a new one for the same source ("New token" in Sources).
7. **Chunking, in the core.**
   - Transcript chunks are at most ~400 tokens (about a minute of talk), cut on message boundaries from the start. As
     a live meeting grows, earlier chunks stay the same and only the last ones are embedded again (N5).
   - Each chunk keeps its start, so an answer can link to the moment in the meeting.
   - The context header holds only what doesn't change during a meeting (kind, title, date), not the list of
     participants. A rename changes every header and so embeds that meeting again.
   - Messages without a `timestamp` give chunks without a start, linked to the meeting.
8. **Setting.**
   - A folded "Local knowledge base" block in the popup, kept in `chrome.storage.local` under `knowledgeBase` (the
     token belongs to this machine): URL, token, a switch (off by default), the last push's status, the knowledge base's
     id and this browser's source id there, the signatures sent last and the hash of the session list.
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
| M3.5 | The app, day to day | The meetings and their action items browsed without the LLM, the problems it sees told, the index's progress, the tokens used, answers rated into the golden set, a theme | 7–9 days |
| M4 | Microsoft 365 | Outlook mail and Teams chats are searched with the meetings | 4–5 days |
| M5 | Gmail | Gmail too | 2–3 days |
| M6 | Messengers | Telegram, Rocket.Chat and Slack too | 5–8 days |
| M7 | Reply drafts | Drafts for new emails and messages within a minute, reviewed in the app and copied into the source by hand | 5–7 days |
| M8 | Sending replies | An approved draft is sent from the app, in the same thread | 3–5 days |
| Later | Improvements | Reranker, quick ask, weekly digest, a brief before a meeting, "ask the knowledge base" in the Meet panel, Zoom | as needed |

- M0 → M1 → M2 → M3 → M3.5 in this order. M4–M6 can go in any order after M3.5. Microsoft goes first: one sign-in covers
  two sources, and it brings both the email and the chat chunker. M7 and M8 use the sources connected by then.
  Rocket.Chat went first, before M3.5, with the connectors' base and the chat chunker ([Decisions](#decisions),
  2026-11-12).
- Every change to the extension is in M2, so there's one store release, and its review runs while M3 is built.
- Meetings alone (M0–M3.5) take 23–32 days; all of it takes 42–60.

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
  - `cloudAllowed` (F8), set with `kb cloud` until M3.
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
- **Packaging:** an AppImage and a `.deb` with electron-builder, without other platforms' native binaries.

Exit, by hand:

- after a reboot the app starts in the tray, waits for the keyring and then syncs;
- closing the window keeps it syncing;
- killing the core's process brings it back;
- "Open in Stenograma" opens the history page at the moment.

### M3.5. The app, day to day

What makes the app worth opening every day while it has meetings only, and what tells when it stops getting them.

- **The rewrite's filters, undone in one click** (done: Decisions, 2026-11-13). "Searched for" shows the dates and the person taken from the question
  as chips with a ✕. Removing one asks again without it. A small local model can make up a date range for a question
  without one, and the meetings it hides can't be seen (M3, `qwen3.5:4b`).
- **Problems told, not found out from a missing citation.** A notification and the tray's icon when:
  - a paired browser has sent nothing for some hours of a working day;
  - Ollama doesn't answer;
  - the embedding queue makes no progress;
  - the extension's port is taken.
- **The index's progress.** The Activity page's index row shows, besides the chunks still to embed:
  - a progress bar for the queue, as for a model's rebuild, with the speed (chunks a minute) and the time left;
  - what's waiting, per source;
  - the last runs: when, how many chunks, how long, and the error of a failed one.
- **Meetings.** A page with every meeting, the latest first, searched by its words (FTS, no LLM), each opening in the
  meeting view. It shows that a meeting arrived, and finds one while the LLM is down or an answer is in doubt.
- **Action items.** The action items of all meetings in one list (the extension's AI output, `meeting-actions`),
  filtered by person (with "mine"), period and overdue, each opening its meeting. Read only: whether one is done is
  the extension's, and changing it here would split the two.
- **Answers rated.** 👍 or 👎 on an answer; "Add to the golden set" keeps the question with the sources it should find
  in `eval/golden-set.json` in the data directory, never in the repo (N6). It grows the golden set from real questions,
  which M0 left to do.
- **Ask again, copy.** "Ask again with…" another configured model, as when Ollama is down or the answer is weak (done:
  Decisions, 2026-11-12).
  "Copy" gives the answer with the meetings' titles and dates in place of `[n]`, to paste into a chat or an email.
- **Tokens.** Under each answer, the tokens it used, in and out (the rewrite and the answer), kept with the chat. In
  the settings, the totals of today and of this month per model, in a table of their own (`llm_usage`), so deleting a
  chat doesn't lower them. Embeddings aren't counted: Gemini's give no count (`usage` is undefined in
  `@ai-sdk/google`).
- **Chats:** search and rename; shortcuts (Ctrl+N a new chat, Ctrl+K search, Esc stops an answer).
- **Theme:** system, dark (Meet's, the default) or light (the extension's light palette), in the settings. It's applied
  before the window shows, the window's background too, so there's no flash of the other one.

Exit:

- the tests: the problems the notifications watch, the index's progress (speed, time left, per source) with a fake
  provider, the tokens of an answer kept with its turn and summed per day and model (also after the chat is deleted),
  the meetings' and action items' lists with their filters, the golden set written in the data directory with mode
  0600;
- by hand: a made-up date range removed with its chip finds the hidden meeting; Ollama stopped gives a notification;
  the theme follows the system and switches without a restart.

### M4–M6. Sources

| | Sources | Also brings |
|---|---|---|
| M4 | Outlook and Teams chats, on one MSAL session | The loopback OAuth callback; the email chunker with quote and signature stripping, and sender exclusion (F2); the chat chunker with threads (F3); emails shown in the app as text or in a sandboxed iframe |
| M5 | Gmail | The Gmail categories left out (F2); a resync by date after a 404 |
| M6 | Telegram, Slack, each merged on its own (Rocket.Chat went first: Decisions, 2026-11-12) | Telegram's sign-in (phone, code, 2FA) and chat allowlist; a pasted Slack token |

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

- A reranker.
- **Quick ask:** a small window on a global shortcut (Ctrl+Shift+Space) with a question field, from anywhere. Electron's
  global shortcuts work on X11 but not on Wayland.
- **A weekly digest:** on Friday, the decisions of the week, my action items and the overdue ones, as a notification
  opening a chat. Made by the LLM, so F8 applies.
- **A brief before a meeting** (after M4): 10 minutes before a calendar event, what was last discussed with its people.
  Needs Outlook's calendar, a scope (`Calendars.Read`) the M4 sign-in doesn't ask for.
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
