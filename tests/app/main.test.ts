import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { desktopEntry, quoteExecArg, syncAutostart } from '../../app/main/autostart.ts';
import { MAX_RESTART_DELAY_MS, nextAttempt, restartDelay } from '../../app/main/backoff.ts';
import { checkCall } from '../../app/main/ipc.ts';
import { DEFAULT_SETTINGS } from '../../core/settings.ts';

describe('restarting the core', () => {
  it('waits longer after each exit, up to a minute', () => {
    expect([1, 2, 3, 4, 7, 20].map(restartDelay)).toEqual([1000, 2000, 4000, 8000, MAX_RESTART_DELAY_MS, MAX_RESTART_DELAY_MS]);
  });

  it('starts over after a core that ran a minute', () => {
    expect(nextAttempt(5, 2000)).toBe(6);
    expect(nextAttempt(5, 120_000)).toBe(1);
  });
});

describe('starting at login', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kb-autostart-'));
    path = join(dir, 'autostart', 'stenograma-kb.desktop');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('quotes the executable as the Desktop Entry spec says, as the .deb\'s path has a space', () => {
    expect(quoteExecArg('/opt/Stenograma KB/stenograma-kb')).toBe('"/opt/Stenograma KB/stenograma-kb"');
    expect(quoteExecArg('/a/"b"/$c`d`\\e')).toBe('"/a/\\"b\\"/\\$c\\`d\\`\\\\e"');
    expect(desktopEntry('/opt/Stenograma KB/stenograma-kb')).toContain('Exec="/opt/Stenograma KB/stenograma-kb" --hidden\n');
  });

  it('writes the file when on, again when the AppImage moved, and removes it when off', () => {
    syncAutostart(true, '/home/me/Apps/kb.AppImage', path);

    expect(readFileSync(path, 'utf8')).toContain('Exec="/home/me/Apps/kb.AppImage" --hidden');

    syncAutostart(true, '/home/me/kb.AppImage', path);

    expect(readFileSync(path, 'utf8')).toContain('Exec="/home/me/kb.AppImage" --hidden');

    syncAutostart(false, '/home/me/kb.AppImage', path);

    expect(existsSync(path)).toBe(false);
  });

  it('never removes a file it didn\'t write', () => {
    syncAutostart(true, '/x', path);
    writeFileSync(path, '[Desktop Entry]\nExec=something-else\n');
    syncAutostart(false, '/x', path);

    expect(existsSync(path)).toBe(true);
  });
});

// The renderer is untrusted: what it passes is checked before it reaches the core
describe('the renderer\'s calls', () => {
  it('passes a known method with its params', () => {
    expect(checkCall('setCloudAllowed', { sourceId: 3, allowed: false })).toEqual({ method: 'setCloudAllowed', params: { sourceId: 3, allowed: false } });
    expect(checkCall('status', undefined)).toEqual({ method: 'status', params: {} });
    expect(checkCall('saveSettings', DEFAULT_SETTINGS).method).toBe('saveSettings');
  });

  it('refuses the main process\'s own link method, unknown methods and inherited names', () => {
    expect(() => checkCall('stenogramaLink', { sourceId: 1, sessionId: 's', startMs: null })).toThrow('Unknown method');
    expect(() => checkCall('toString', {})).toThrow('Unknown method');
    expect(() => checkCall({ method: 'status' }, {})).toThrow('Unknown method');
  });

  it('refuses params of the wrong type, out of range, or with more fields than the method takes', () => {
    expect(() => checkCall('removeSource', { sourceId: '1' })).toThrow();
    expect(() => checkCall('removeSource', { sourceId: -1 })).toThrow();
    expect(() => checkCall('removeSource', { sourceId: 1, all: true })).toThrow();
    expect(() => checkCall('renewBrowserToken', { sourceId: 1, token: 'skb_chosen' })).toThrow();
    expect(() => checkCall('saveSettings', { ...DEFAULT_SETTINGS, server: { port: 22 } })).toThrow();
    expect(() => checkCall('saveSettings', { ...DEFAULT_SETTINGS, llm: { ...DEFAULT_SETTINGS.llm, ollamaUrl: 'not a url' } })).toThrow();
    expect(() => checkCall('openInStenograma', { sourceId: 1, sessionId: 's', startMs: 1, url: 'file:///etc/passwd' })).toThrow();
  });
});
