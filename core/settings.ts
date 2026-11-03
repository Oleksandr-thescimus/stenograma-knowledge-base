import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { EmbeddingSettings } from './embed/provider.ts';
import { ensureDataDir, settingsPath } from './paths.ts';

// The settings file in the data directory, until the app's settings (M3). Keys are never here: they're in the keyring

export interface LlmSettings {
  provider: 'groq' | 'gemini' | 'ollama';
  model: string;
  ollamaUrl: string;
}

export interface Settings {
  embedding: EmbeddingSettings;
  llm: LlmSettings;
}

const OLLAMA_URL = 'http://127.0.0.1:11434';

export const DEFAULT_SETTINGS: Settings = {
  // M0 picked bge-m3 on Ollama (docs/PLAN.md, Decisions)
  embedding: { provider: 'ollama', model: 'bge-m3', ollamaUrl: OLLAMA_URL },
  llm: { provider: 'ollama', model: 'qwen3.5:9b', ollamaUrl: OLLAMA_URL },
};

// Reads the settings, writing the defaults the first time so there's a file to edit
export const loadSettings = (): Settings => {
  const path = settingsPath();

  if (!existsSync(path)) {
    ensureDataDir();
    writeFileSync(path, `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`, { mode: 0o600 });

    return DEFAULT_SETTINGS;
  }

  const saved = JSON.parse(readFileSync(path, 'utf8')) as Partial<Settings>;

  return {
    embedding: { ...DEFAULT_SETTINGS.embedding, ...saved.embedding },
    llm: { ...DEFAULT_SETTINGS.llm, ...saved.llm },
  };
};
