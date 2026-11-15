# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Stenograma KB is a personal knowledge base on this machine: meetings from the StenogramaAI browser extension, email
and messenger chats, searched together, with answers that cite their sources and drafts of replies. An Electron app
runs it. [docs/PLAN.md](docs/PLAN.md) is the plan: requirements, architecture, milestones and the dated decisions.
[docs/rag.md](docs/rag.md) explains, in Ukrainian, how the search and answers work step by step: keep it current when they
change.

M0 (spikes) is done but for the checks that need the user; M1 (meetings in the terminal, `yarn kb`) is done. M2 (the
extension pushes meetings) works with Chrome; Firefox and the extension's store release remain. M3 (the app: chat,
sources, settings, tray) is built; its checks by hand remain (the plan's Decisions of 2026-11-03). Rocket.Chat, the
first connector, went ahead of M3.5 (Decisions of 2026-11-12); its check on a real server and golden set remain. Its
reply drafts, M7 copied by hand, went ahead too (Decisions of 2026-11-14). M3.5 (the app, day to day) comes next,
before M4.

The extension is another repo, [stenograma](https://github.com/Oleksandr-thescimus/stenograma), checked out next to
this one as `../stenograma`. The two meet only at the HTTP API, with no submodule or shared package. Open both with
`claude --add-dir ../stenograma`.

## Commands

Uses yarn (`yarn.lock`).

- `yarn dev`: the app, with hot reload of the renderer. It holds the knowledge base's lock, so `kb serve` and
  `kb import` can't run next to it (and the app's core waits while they run); `STENOGRAMA_KB_DATA` points it elsewhere.
- `yarn build`: main, preload and renderer into `out/`; `yarn start` runs that build.
- `yarn dist`: an AppImage and a `.deb` in `dist/` (electron-builder, `electron-builder.yml`).
- `yarn lint`, `yarn typecheck` (the Node project `tsconfig.node.json` and the web project `tsconfig.web.json`).
- `yarn test`: Vitest under Electron's Node (`ELECTRON_RUN_AS_NODE=1` with the electron binary), the runtime the core
  has in the app.
- `yarn kb <command>`: the core from the command line, `core/cli/kb.ts` run as TypeScript under Electron's Node
  (`yarn kb --help`): `import` a backup's `data.json`, `search`, `ask`, `eval` on the golden set, `status`, `key`,
  `serve` (the API for the extension, as the app runs it), `add-browser` (pairs a browser), `new-token` (a paired
  browser's new token), `sync` (a Rocket.Chat source once; the app adds it), `remove`, `cloud`.
  It works on the real knowledge base in `~/.local/share/stenograma-kb/`; `STENOGRAMA_KB_DATA` points it elsewhere.
- `yarn bench [chunks]`: search timings on a throwaway knowledge base of generated chunks (N3: p95 under 300 ms at 100k).

## Layout

- `core/`: the knowledge base itself, without `electron`, so `kb` and the tests run it too.
  - `db.ts` (schema and migrations), `documents.ts` (documents, chunks, FTS rows, embedding jobs), `sources.ts`.
  - `stenograma/`: the protocol's types (`API_VERSION`), the rules of F1, ingesting bundles, reading a backup.
  - `chunk.ts`, `text/normalize.ts` (FTS normalization, Ukrainian endings, name matching), `search.ts` (hybrid).
  - `server.ts`: the HTTP API for the extension (Fastify, secured as N2 says); `browsers.ts`: paired browsers and their
    tokens.
  - `service.ts`: the core as the app runs it (the lock, the database, the API, the embedding queue with a model's
    rebuild, answers in parts, settings and keys), answering the methods of `protocol.ts`. `protocol.ts` is types only,
    with no imports, so the renderer's project reads it too. `chats.ts`: the saved chats. `stenograma/meeting.ts`: a
    cited meeting from the kept rows, and a source's list of meetings; `summaries.ts` keeps its short summary, made by `answer/summary.ts` (by hand, or in
    the background for a series's meetings) and indexed with it. `stenograma/series.ts`: meeting series by Meet code or
    weekday and time, named by the user, in the meetings' titles and `documents.series_id`.
  - `connectors/runner.ts`: the sources a connector syncs, each on its timer, "Sync now", backoff after a failure, and
    the rooms a watched source says changed, read at once.
  - `chat/`: messengers whatever the source (F3): `types.ts` (a message as kept), `store.ts` (`chat_rooms`,
    `chat_messages`, and their documents: a room's day, a thread, a file's text), `chunk.ts` (30-minute pauses, quotes
    as `> ` lines), `attachments.ts` (the files whose content is read, kept next to the database, never in the global
    data directory, so a test's never touch the real ones) and `read.ts` (an image by a vision model, a PDF with
    `unpdf`). The service reads them in a queue, after answers.
  - `drafts/`: reply drafts (F9, M7; Rocket.Chat's first): `detect.ts` (which messages are to the user and still
    unanswered, after each sync), `store.ts` (the `drafts` table), `style.ts` (the user's style: their replies to
    similar messages, the drafts they rewrote, a description of how they write) and `write.ts` (the conversation, the
    search's sources and the style as the prompt). The service writes them first in its background queue; nothing is sent.
  - `rocketchat/`: the REST API with its rate limits (`api.ts`), its rooms and messages as `chat/` keeps them
    (`convert.ts`), a run of the sync with each room's cursors (`sync.ts`), the realtime API that tells which rooms
    changed (`realtime.ts`, DDP over a WebSocket; the tests give a fake one, or none), and the runner's connector. Its token is in
    the keyring under the knowledge base's id (`tokenSecretName`); the service takes `secrets` and `fetch`, which the
    tests replace (`tests/core/rocketchat-fake.ts`), so they never touch the real keyring or network.
  - `servers.ts`: the AI servers (Ollama's API: this computer's, an Orange Pi's through a tunnel; Groq's and
    Gemini's and Claude's and Ollama Cloud's; OpenAI-compatible APIs such as Cerebras or OpenRouter, known by their
    address, their key kept by it), in the chat's order, each with its text and image models and its background queue (a lane each,
    sharing the work), settings older than them made into servers, and whether a server answers.
  - `ratelimit.ts`: a cloud provider's rate limits, from its refusals and its answers' headers, which the queue waits
    out.
  - `usage.ts`: the AI's statistics: a row per model call (`ai_calls`, never its text), kept by the service's
    wrappers of every model and embedding provider, folded into a day's totals after a year.
  - `embed/`: providers (Ollama, Gemini), vector tables (bit vectors, rescored from `embedding_cache`), the cache and
    the queue. `llm.ts`, `answer/` (rewrite, answers, summaries), `secrets.ts` (keyring), `settings.ts`, `lock.ts`,
    `eval.ts`, `cli/kb.ts`.
  - Node runs these files as they are, stripping the types: `core/package.json` makes them ESM, imports name the
    `.ts` file, type-only imports say `import type`, and there's no enum, namespace or parameter property
    (`erasableSyntaxOnly`).
- `app/main`: Electron's main process: the window, the tray and `autostart.ts` (the `.desktop` file), `core.ts` (runs
  the core and starts it again after an exit, `backoff.ts`), `ipc.ts` (checks each call of the renderer).
- `app/core-host`: the core's `utilityProcess`, running `core/service.ts` over its parentPort. The main process imports
  it with `?modulePath`, so it's a bundle of its own: as a second entry of the main build, shared code made the main
  process load the core's bundle and run the core inside it.
- `app/preload`: exposes `window.kb` to the renderer through `contextBridge`: `invoke(method, params)` and `onEvent`.
  Its type, `KbApi` in `app/preload/api.ts`, is shared with the renderer. A new method goes into `core/protocol.ts`
  (`AppMethods`, and `CoreMethods` when the core answers it) and gets its zod schema in `app/main/ipc.ts`.
- `app/renderer`: React, Tailwind and shadcn/ui. `@` is `app/renderer/src`: `pages/` (chat, reply drafts, sources,
  activity: the background work; settings, in tabs), `components/`, `lib/` (`kb.tsx`: the status and events of `window.kb`). It imports from `core/` only
  `protocol.ts` and `format.ts`, which `tsconfig.web.json` lists.
  - `src/index.css` holds the palette as the CSS variables shadcn/ui uses: Meet's (dark, the default) and MUI's light
    one, both from the extension's `helpers/theme.ts`.
  - Components come from `npx shadcn@latest add <name>` into `src/components/ui` (`components.json`). Run
    `yarn lint:fix` after it: the registry's code has double quotes and no semicolons. They import `cn` from the `cn`
    package. lint:fix turns `[class*='size-']` in a class string into `[class*=\'size-\']`, which Tailwind doesn't
    read as the same class: write it `[class*=size-]`.
- `resources/`: the icons (the extension's), which the main process imports with `?asset` and the package includes.
- `tests/`: Vitest. `tests/core/helpers.ts` makes a knowledge base in a temporary file and a fake embedding provider.
  `tests/fixtures/kb-ingest.json` is the contract with the extension: its test builds a push from fixture rows and
  compares it with its copy of this file, and `tests/core/server.test.ts` ingests it. A change to the payload changes
  both copies and raises `API_VERSION` (`core/stenograma/types.ts`).

electron-vite reads the entries from `electron.vite.config.ts`, since they aren't in its default `src/`.

Packages go to `devDependencies`, so Vite bundles them. `dependencies` is only for what can't be bundled: native
modules and loadable extensions (better-sqlite3, sqlite-vec, `@napi-rs/keyring`). electron-vite leaves those external
and electron-builder packs them into the app, in `app.asar.unpacked`. SQLite can't load an extension from inside
`app.asar`, so in a packaged app sqlite-vec is loaded from its `app.asar.unpacked` path, not with `sqliteVec.load()`.

## The renderer is untrusted

It will show emails and messages written by other people, so:

- `contextIsolation` and `sandbox` stay on and `nodeIntegration` off. The renderer reaches the main process only
  through `window.kb`, so keep that a short list of calls with checked arguments.
- The CSP in `app/renderer/index.html` allows only the app's own scripts, and nothing loaded from elsewhere. Inline
  styles are allowed, for Radix's scroll lock and sonner, and for emails in a sandboxed iframe (the plan's Decisions of
  2026-11-03).
- `window.kb.invoke` is the renderer's only way to the core: the main process checks the method and its params
  (`app/main/ipc.ts`, strict zod schemas) and builds links itself (`openInStenograma` takes ids, not a URL).
- No new windows and no navigation away from the app's page. Links open in the default browser, `http(s):` and
  `mailto:` only.
- A packaged app never loads `ELECTRON_RENDERER_URL`.
- An email's HTML is shown only in an `<iframe sandbox>` without scripts and with remote images blocked.

## Privacy

Meetings, emails, messages, the index and the tokens are private data, the user's and the data of the people who
wrote them.

- Don't log their contents (`console.log`, error messages, URLs from them). Log ids, counts and lengths instead.
- Don't send them to a new external service or host without discussing it first. They go only to the AI providers
  chosen in the app, and only from sources with `cloudAllowed` (F8 in the plan).
- Data stays in `~/.local/share/stenograma-kb/` (mode 0700). Secrets go to the OS keyring (N1 in the plan).
- The golden set (`eval/golden-set.json` there) quotes real meetings, so it never goes into the repo; tests use made-up
  text.

## Keeping docs current

When a change makes this file or `docs/PLAN.md` wrong (commands, layout, rules, schema), update them in the same
change. A decision that changes the plan gets a dated line in the plan's Decisions.

## Code style

ESLint (`eslint.config.mjs`) is the source of truth, with the extension's rules: single quotes, semicolons and 2-space
indentation. There's no Prettier.
