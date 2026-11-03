# Stenograma KB

A personal knowledge base on your own machine. It collects meetings from the
[StenogramaAI](https://github.com/Oleksandr-thescimus/stenograma) browser extension, email and messenger chats,
answers questions across all of them with citations, and drafts replies that nothing sends until you approve them.

[docs/PLAN.md](docs/PLAN.md) is the plan. Meetings arrive from the extension and can be searched and asked about in
the app or from the terminal; email and chats come next.

## Features

**Legend:**  
✅ **Done**  
🚀 **Upcoming**  
💡 **Later**, not scheduled yet

- ✅ Electron desktop app with a sandboxed renderer, packaged as an AppImage and a `.deb`
- ✅ Chat with streamed answers and saved chats, sources with their status and cloud policy, and settings for models and keys
- ✅ Meetings imported from a Stenograma backup (`yarn kb import`)
- ✅ Meetings from the extension (Meet captions and chat, recordings), arriving within 5 minutes (in the extension's
  next release)
- ✅ Hybrid search (full text + vectors) in Ukrainian and English, filtered by source, date and person (`yarn kb search`)
- ✅ Streamed answers with citations in the terminal (`yarn kb ask`)
- ✅ Citations that open the meeting at the cited moment, in the app or in the extension
- ✅ A short summary of a cited meeting on demand, kept with it; long meetings summarized in parts
- 🚀 Citations that open an email or a message
- 🚀 Meetings and their action items browsed in the app without an LLM, and the dates and person taken from a question
  undone in one click
- 🚀 Notifications when meetings stop arriving or the local AI doesn't answer
- 🚀 The index's progress: the queue with its speed and time left, per source, and the last runs
- 🚀 Answers rated into a private golden set, asked again with another model, or copied with their sources
- 🚀 The tokens each answer used, and the totals of the day and the month per model
- 🚀 Light and dark themes
- 🚀 Chats searched and renamed, and keyboard shortcuts
- ✅ Groq, Gemini or Ollama for answers; local embeddings (Ollama's bge-m3) by default
- ✅ Per-source cloud policy: a source's data goes to a cloud LLM only when you allow it
- 🚀 Outlook and Teams chats, Gmail, Telegram, Rocket.Chat and Slack
- 🚀 Reply drafts for new emails and messages within a minute, reviewed in the app and sent only when you approve
- ✅ Starts at login and keeps syncing from the tray
- ✅ All data and the index stay on your machine
- 💡 A quick-ask window on a global shortcut
- 💡 A weekly digest of decisions and action items
- 💡 A brief before a meeting: what was last discussed with its people (with Outlook's calendar)

```sh
yarn install
yarn dev        # the app with hot reload
yarn test       # Vitest under Electron's Node
yarn dist       # AppImage and .deb in dist/
yarn kb --help  # the knowledge base from the terminal: import, search, ask, eval
```
