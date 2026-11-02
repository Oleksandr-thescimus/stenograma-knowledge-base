# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Stenograma KB is a personal knowledge base on this machine: meetings from the StenogramaAI browser extension, email
and messenger chats, searched together, with answers that cite their sources and drafts of replies. An Electron app
runs it. [docs/PLAN.md](docs/PLAN.md) is the plan: requirements, architecture, milestones and the dated decisions.

Only the app's skeleton exists so far; the next milestone is M0 (spikes).

The extension is another repo, [stenograma](https://github.com/Oleksandr-thescimus/stenograma), checked out next to
this one as `../stenograma`. The two meet only at the HTTP API, with no submodule or shared package. Open both with
`claude --add-dir ../stenograma`.

## Commands

Uses yarn (`yarn.lock`).

- `yarn dev`: the app, with hot reload of the renderer.
- `yarn build`: main, preload and renderer into `out/`; `yarn start` runs that build.
- `yarn dist`: an AppImage and a `.deb` in `dist/` (electron-builder, `electron-builder.yml`).
- `yarn lint`, `yarn typecheck` (the Node project `tsconfig.node.json` and the web project `tsconfig.web.json`).
- `yarn test`: Vitest under Electron's Node (`ELECTRON_RUN_AS_NODE=1` with the electron binary), because native
  modules are built for Electron's ABI by `electron-builder install-app-deps` (postinstall).

## Layout

- `core/`: the knowledge base itself: storage, connectors, the pipeline, search, answers, drafts and the HTTP API for
  the extension. It never imports `electron`, so the `kb` commands and the tests run it in plain Node. Not started.
- `app/main`: Electron's main process.
- `app/preload`: exposes `window.kb` to the renderer through `contextBridge`. Its type, `KbApi` in
  `app/preload/api.ts`, is shared with the renderer.
- `app/renderer`: React, Tailwind and shadcn/ui. `@` is `app/renderer/src`.
  - `src/index.css` holds the palette as the CSS variables shadcn/ui uses: Meet's (dark, the default) and MUI's light
    one, both from the extension's `helpers/theme.ts`.
  - Components come from `npx shadcn@latest add <name>` into `src/components/ui` (`components.json`). Run
    `yarn lint:fix` after it: the registry's code has double quotes and no semicolons. They import `cn` from the `cn`
    package.
- `tests/`: Vitest.

electron-vite reads the entries from `electron.vite.config.ts`, since they aren't in its default `src/`.

Packages go to `devDependencies`, so Vite bundles them. `dependencies` is only for what can't be bundled, such as
native modules (better-sqlite3): electron-vite leaves those external and electron-builder packs them into the app.

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

## Keeping docs current

When a change makes this file or `docs/PLAN.md` wrong (commands, layout, rules, schema), update them in the same
change. A decision that changes the plan gets a dated line in the plan's Decisions.

## Code style

ESLint (`eslint.config.mjs`) is the source of truth, with the extension's rules: single quotes, semicolons and 2-space
indentation. There's no Prettier.
