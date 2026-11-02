import { describe, expect, it } from 'vitest';

// Native modules (better-sqlite3) are built for Electron's Node, so `yarn test` runs Vitest with the electron binary
// and ELECTRON_RUN_AS_NODE=1, and its workers inherit both
describe('test runtime', () => {
  it('is Electron\'s Node', () => {
    expect(process.versions.electron).toBeTruthy();
  });
});
