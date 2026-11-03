import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { ensureDataDir, settingsPath } from './paths.ts';
import type { EmbeddingSettings, LlmSettings, Settings } from './protocol.ts';

// The settings file in the data directory. The app's settings page writes it through the core, and it can still be
// edited by hand. Keys are never here: they're in the keyring

export type { LlmSettings, Settings };

export interface StoredSettings extends Settings {
  // The embedding model being built in the background after a change (F7). `embedding` stays the one the search uses
  // until it's done
  embeddingRebuild?: EmbeddingSettings;
}

const OLLAMA_URL = 'http://127.0.0.1:11434';

export const DEFAULT_SETTINGS: Settings = {
  // M0 picked bge-m3 on Ollama (docs/PLAN.md, Decisions)
  embedding: { provider: 'ollama', model: 'bge-m3', ollamaUrl: OLLAMA_URL },
  llm: { provider: 'ollama', model: 'qwen3.5:9b', ollamaUrl: OLLAMA_URL },
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

  return {
    embedding: { ...DEFAULT_SETTINGS.embedding, ...saved.embedding },
    llm: { ...DEFAULT_SETTINGS.llm, ...saved.llm },
    server: { ...DEFAULT_SETTINGS.server, ...saved.server },
    app: { ...DEFAULT_SETTINGS.app, ...saved.app },
    ...(saved.embeddingRebuild && { embeddingRebuild: { ...DEFAULT_SETTINGS.embedding, ...saved.embeddingRebuild } }),
  };
};
