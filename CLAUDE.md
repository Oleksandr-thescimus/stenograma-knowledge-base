# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Stenograma KB is a personal knowledge base on this machine: meetings from the StenogramaAI browser extension, email
and messenger chats, searched together, with answers that cite their sources and drafts of replies. An Electron app
runs it. [docs/PLAN.md](docs/PLAN.md) is the plan: requirements, architecture, milestones and the dated decisions.

M0 (spikes) is done but for the checks that need the user; M1 (meetings in the terminal, `yarn kb`) is done. M2 (the
extension pushes meetings) works with Chrome; Firefox and the extension's store release remain. The app is still a
skeleton.

The extension is another repo, [stenograma](https://github.com/Oleksandr-thescimus/stenograma), checked out next to
this one as `../stenograma`. The two meet only at the HTTP API, with no submodule or shared package. Open both with
`claude --add-dir ../stenograma`.

## Commands

Uses yarn (`yarn.lock`).

- `yarn dev`: the app, with hot reload of the renderer.
- `yarn build`: main, preload and renderer into `out/`; `yarn start` runs that build.
- `yarn dist`: an AppImage and a `.deb` in `dist/` (electron-builder, `electron-builder.yml`).
- `yarn lint`, `yarn typecheck` (the Node project `tsconfig.node.json` and the web project `tsconfig.web.json`).
- `yarn test`: Vitest under Electron's Node (`ELECTRON_RUN_AS_NODE=1` with the electron binary), the runtime the core
  has in the app.
- `yarn kb <command>`: the core from the command line, `core/cli/kb.ts` run as TypeScript under Electron's Node
  (`yarn kb --help`): `import` a backup's `data.json`, `search`, `ask`, `eval` on the golden set, `status`, `key`,
  `serve` (the API for the extension), `add-browser` (pairs a browser), `remove`, `cloud`.
  It works on the real knowledge base in `~/.local/share/stenograma-kb/`; `STENOGRAMA_KB_DATA` points it elsewhere.
- `yarn bench [chunks]`: search timings on a throwaway knowledge base of generated chunks (N3: p95 under 300 ms at 100k).

## Layout

- `core/`: the knowledge base itself, without `electron`, so `kb` and the tests run it too.
  - `db.ts` (schema and migrations), `documents.ts` (documents, chunks, FTS rows, embedding jobs), `sources.ts`.
  - `stenograma/`: the protocol's types (`API_VERSION`), the rules of F1, ingesting bundles, reading a backup.
  - `chunk.ts`, `text/normalize.ts` (FTS normalization, Ukrainian endings, name matching), `search.ts` (hybrid).
  - `server.ts`: the HTTP API for the extension (Fastify, secured as N2 says); `browsers.ts`: paired browsers and their
    tokens.
  - `embed/`: providers (Ollama, Gemini), vector tables (bit vectors, rescored from `embedding_cache`), the cache and
    the queue. `llm.ts`, `answer/` (rewrite,
    answers), `secrets.ts` (keyring), `settings.ts`, `lock.ts`, `eval.ts`, `cli/kb.ts`.
  - Node runs these files as they are, stripping the types: `core/package.json` makes them ESM, imports name the
    `.ts` file, type-only imports say `import type`, and there's no enum, namespace or parameter property
    (`erasableSyntaxOnly`).
- `app/main`: Electron's main process.
- `app/preload`: exposes `window.kb` to the renderer through `contextBridge`. Its type, `KbApi` in
  `app/preload/api.ts`, is shared with the renderer.
- `app/renderer`: React, Tailwind and shadcn/ui. `@` is `app/renderer/src`.
  - `src/index.css` holds the palette as the CSS variables shadcn/ui uses: Meet's (dark, the default) and MUI's light
    one, both from the extension's `helpers/theme.ts`.
  - Components come from `npx shadcn@latest add <name>` into `src/components/ui` (`components.json`). Run
    `yarn lint:fix` after it: the registry's code has double quotes and no semicolons. They import `cn` from the `cn`
    package.
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
- The CSP in `app/renderer/index.html` allows only the app's own scripts and styles; only the dev server allows
  inline styles (`electron.vite.config.ts`). Radix components with a scroll lock (Dialog, Select, DropdownMenu) and
  sonner add `<style>` tags, which it blocks: the plan's "The app" says what to do when the first of them comes.
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
