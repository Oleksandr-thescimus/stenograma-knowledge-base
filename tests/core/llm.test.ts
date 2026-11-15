import { describe, expect, it } from 'vitest';
import { isTimedOut } from '../../core/llm.ts';

// A model that takes long (a summary's part on an Orange Pi) is told from a server that isn't there

describe('a model call that took too long', () => {
  it('is known through the AI SDK\'s retries and wrappers by undici\'s timeout', () => {
    const undici = Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' });
    const fetchFailed = new TypeError('fetch failed', { cause: undici });
    const apiCall = new Error('Cannot connect to API: fetch failed', { cause: fetchFailed });

    expect(isTimedOut(Object.assign(new Error('Failed after 3 attempts'), { lastError: apiCall }))).toBe(true);
    expect(isTimedOut(new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }))).toBe(false);
    expect(isTimedOut(null)).toBe(false);
  });
});
