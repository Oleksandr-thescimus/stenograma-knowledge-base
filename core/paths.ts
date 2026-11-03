import { chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Everything the knowledge base keeps, readable by the user only (N1): ~/.local/share/stenograma-kb.
// STENOGRAMA_KB_DATA moves it, which the tests do
export const dataDir = () => process.env.STENOGRAMA_KB_DATA
  || join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'stenograma-kb');

export const dbPath = () => join(dataDir(), 'kb.sqlite');
export const settingsPath = () => join(dataDir(), 'settings.json');
export const lockPath = () => join(dataDir(), 'kb.lock');
// The private golden set (N6)
export const goldenSetPath = () => join(dataDir(), 'eval', 'golden-set.json');

export const ensureDataDir = () => {
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  chmodSync(dataDir(), 0o700);

  return dataDir();
};
