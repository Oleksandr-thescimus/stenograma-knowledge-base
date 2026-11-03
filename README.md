# Stenograma KB

A personal knowledge base on your own machine. It collects meetings from the
[StenogramaAI](https://github.com/Oleksandr-thescimus/stenograma) browser extension, email and messenger chats,
answers questions across all of them with citations, and drafts replies that nothing sends until you approve them.

It's at the start: [docs/PLAN.md](docs/PLAN.md) is the plan. Meetings can be searched and asked about from the terminal;
the app is a skeleton.

## Features

**Legend:**  
✅ **Done**  
🚀 **Upcoming**

- ✅ Electron desktop app with a sandboxed renderer, packaged as an AppImage and a `.deb`
- ✅ Meetings imported from a Stenograma backup (`yarn kb import`)
- 🚀 Meetings from the extension (Meet captions and chat, recordings), arriving within 5 minutes
- ✅ Hybrid search (full text + vectors) in Ukrainian and English, filtered by source, date and person (`yarn kb search`)
- ✅ Streamed answers with citations in the terminal (`yarn kb ask`)
- 🚀 Citations that open the source: a meeting at the cited moment, an email, a message
- ✅ Groq, Gemini or Ollama for answers; local embeddings (Ollama's bge-m3) by default
- ✅ Per-source cloud policy: a source's data goes to a cloud LLM only when you allow it
- 🚀 Outlook and Teams chats, Gmail, Telegram, Rocket.Chat and Slack
- 🚀 Reply drafts for new emails and messages within a minute, reviewed in the app and sent only when you approve
- 🚀 Starts at login and keeps syncing from the tray
- 🚀 All data and the index stay on your machine

```sh
yarn install
yarn dev        # the app with hot reload
yarn test       # Vitest under Electron's Node
yarn dist       # AppImage and .deb in dist/
yarn kb --help  # the knowledge base from the terminal: import, search, ask, eval
```
