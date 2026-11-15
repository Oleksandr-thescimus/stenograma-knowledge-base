import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { ensureDataDir, settingsPath } from './paths.ts';
import type { EmbeddingSettings, LlmSettings, Settings } from './protocol.ts';
import { DEFAULT_SERVERS, OLLAMA_URL, serversOf } from './servers.ts';

// The settings file in the data directory. The app's settings page writes it through the core, and it can still be
// edited by hand. Keys are never here: they're in the keyring

export type { LlmSettings, Settings };

export interface StoredSettings extends Settings {
  // The embedding model being built in the background after a change (F7). `embedding` stays the one the search uses
  // until it's done
  embeddingRebuild?: EmbeddingSettings;
  // The background AI work (images, summaries) paused, until then (milliseconds) or until resumed (null): it takes the
  // GPU
  backgroundPaused?: { until: number | null };
}

export const DEFAULT_SETTINGS: Settings = {
  // This computer's Ollama, its qwen3.5:9b answering and reading images; Groq and Gemini without models until set
  servers: DEFAULT_SERVERS,
  // Files of the last 3 months, newest first
  attachments: { describeImages: true, readDocuments: true, months: 3 },
  // A named series's meetings of the last 3 months get a short summary in the background
  summaries: { auto: true, months: 3 },
  // Turned on, reply drafts take the unread messages of the last day; none older than 3 days
  drafts: { unreadDays: 1, maxAgeDays: 3, style: '' },
  // M0 picked bge-m3 on Ollama (docs/PLAN.md, Decisions)
  embedding: { provider: 'ollama', model: 'bge-m3', ollamaUrl: OLLAMA_URL },
  server: { port: 47321 },
  // The app starts at login and stays in the tray (docs/PLAN.md, The app)
  app: { startAtLogin: true },
};

// Written whole to a temporary file first, so a crash never leaves half a file
export const saveSettings = (settings: StoredSettings) => {
  ensureDataDir();
  const path = settingsPath();
  writeFileSync(`${path}.tmp`, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
};

// Reads the settings, writing the defaults the first time so there's a file to edit
export const loadSettings = (): StoredSettings => {
  const path = settingsPath();

  if (!existsSync(path)) {
    saveSettings(DEFAULT_SETTINGS);

    return DEFAULT_SETTINGS;
  }

  const saved = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredSettings>;
  // What older settings kept apart, a model per task, is in the servers now
  const pick = <T extends object>(defaults: T, value: object | undefined): T => Object.fromEntries(Object.keys(defaults)
    .map((key) => [key, (value as Record<string, unknown> | undefined)?.[key] ?? defaults[key as keyof T]])) as T;

  return {
    servers: serversOf(saved as Parameters<typeof serversOf>[0]),
    attachments: pick(DEFAULT_SETTINGS.attachments, saved.attachments),
    summaries: pick(DEFAULT_SETTINGS.summaries, saved.summaries),
    drafts: pick(DEFAULT_SETTINGS.drafts, saved.drafts),
    embedding: { ...DEFAULT_SETTINGS.embedding, ...saved.embedding },
    server: { ...DEFAULT_SETTINGS.server, ...saved.server },
    app: { ...DEFAULT_SETTINGS.app, ...saved.app },
    ...(saved.embeddingRebuild && { embeddingRebuild: { ...DEFAULT_SETTINGS.embedding, ...saved.embeddingRebuild } }),
    // Named imagesPaused before summaries were made in the background too
    ...((saved.backgroundPaused ?? (saved as { imagesPaused?: StoredSettings['backgroundPaused'] }).imagesPaused) && {
      backgroundPaused: saved.backgroundPaused ?? (saved as { imagesPaused?: StoredSettings['backgroundPaused'] }).imagesPaused,
    }),
  };
};
