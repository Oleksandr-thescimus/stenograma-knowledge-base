import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Entry } from '@napi-rs/keyring';
import { dataDir, ensureDataDir } from './paths.ts';

// Secrets (LLM keys now; OAuth tokens and sessions later) go to the OS keyring, libsecret on Linux (N1). Without one,
// they go to a file readable by the user only, with a warning. Read when first needed: at login the keyring may still
// be locked

const SERVICE = 'stenograma-kb';
const fallbackPath = () => join(dataDir(), 'secrets.json');

let warned = false;
const warnFallback = (error: unknown) => {
  if (!warned) {
    console.warn(`The keyring isn't available (${(error as Error).message}); secrets are kept in ${fallbackPath()}, mode 0600`);
    warned = true;
  }
};

const readFallback = () => (existsSync(fallbackPath()) ? JSON.parse(readFileSync(fallbackPath(), 'utf8')) as Record<string, string> : {});

const writeFallback = (secrets: Record<string, string>) => {
  ensureDataDir();
  writeFileSync(fallbackPath(), JSON.stringify(secrets), { mode: 0o600 });
};

export const getSecret = (name: string) => {
  try {
    return new Entry(SERVICE, name).getPassword() ?? readFallback()[name];
  } catch (error) {
    warnFallback(error);

    return readFallback()[name];
  }
};

export const setSecret = (name: string, value: string) => {
  try {
    new Entry(SERVICE, name).setPassword(value);
  } catch (error) {
    warnFallback(error);
    writeFallback({ ...readFallback(), [name]: value });
  }
};

export const deleteSecret = (name: string) => {
  try {
    new Entry(SERVICE, name).deletePassword();
  } catch (error) {
    warnFallback(error);
  }

  const { [name]: _deleted, ...rest } = readFallback();

  if (existsSync(fallbackPath())) {
    writeFallback(rest);
  }
};
