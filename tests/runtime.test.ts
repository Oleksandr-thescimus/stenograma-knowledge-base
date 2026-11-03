import { describe, expect, it } from 'vitest';

// The core runs in Electron's Node in the app, so the tests do too: `yarn test` runs Vitest with the electron binary
// and ELECTRON_RUN_AS_NODE=1, and its workers inherit both
describe('test runtime', () => {
  it('is Electron\'s Node', () => {
    expect(process.versions.electron).toBeTruthy();
  });
});
