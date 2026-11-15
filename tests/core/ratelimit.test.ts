import { describe, expect, it } from 'vitest';
import { durationMs, headroomOf, nextPacificMidnight, rateLimitOf } from '../../core/ratelimit.ts';

// A cloud provider's rate limits: from its refusals, through the AI SDK's retries, and from the headers it answers with

const NOW = Date.UTC(2026, 10, 14, 18, 0, 0);

// As the AI SDK gives up after its tries
const refused = (statusCode: number, responseBody: string, responseHeaders: Record<string, string> = {}) => Object.assign(new Error('Failed after 3 attempts'), {
  lastError: Object.assign(new Error(statusCode === 429 ? 'You exceeded your current quota' : 'Internal Server Error'), { statusCode, responseBody, responseHeaders }),
});

const google = (quotaId: string, retryDelay?: string) => JSON.stringify({
  error: {
    code: 429,
    status: 'RESOURCE_EXHAUSTED',
    details: [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId }] },
      ...(retryDelay ? [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }] : []),
    ],
  },
});

describe('rate limits', () => {
  it('reads Google\'s quota refusal: the minute\'s with when to try again, the day\'s until midnight in California', () => {
    expect(rateLimitOf(refused(429, google('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '37s')), NOW)).toEqual({ until: NOW + 37_000, daily: false });
    expect(rateLimitOf(refused(429, google('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '20s')), NOW)).toEqual({ until: nextPacificMidnight(NOW), daily: true });
    // 18:00 UTC is 10:00 in California in November: 14 hours to its midnight
    expect(nextPacificMidnight(NOW)).toBe(NOW + (14 * 3_600_000));
  });

  it('waits as long as a Retry-After says, a minute when nothing does; any other error isn\'t a limit', () => {
    expect(rateLimitOf(refused(429, '{}', { 'retry-after': '12' }), NOW)).toEqual({ until: NOW + 12_000, daily: false });
    expect(rateLimitOf(refused(429, 'Too Many Requests'), NOW)).toEqual({ until: NOW + 60_000, daily: false });
    expect(rateLimitOf(refused(500, 'Internal Server Error'), NOW)).toBeNull();
    expect(rateLimitOf(new TypeError('fetch failed'), NOW)).toBeNull();
  });

  it('waits ahead of a refusal when an answer says none is left of the requests, or too few tokens', () => {
    expect(durationMs('2m59.56s')).toBe(179_560);
    expect(headroomOf({ 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '2m59.56s' }, NOW)).toEqual({ until: NOW + 179_560, daily: false });
    expect(headroomOf({ 'x-ratelimit-remaining-tokens': '900', 'x-ratelimit-reset-tokens': '7.66s', 'x-ratelimit-remaining-requests': '50' }, NOW))
      .toEqual({ until: NOW + 7660, daily: false });
    expect(headroomOf({
      'anthropic-ratelimit-input-tokens-remaining': '100', 'anthropic-ratelimit-input-tokens-reset': new Date(NOW + 30_000).toISOString(),
    }, NOW)).toEqual({ until: NOW + 30_000, daily: false });
    expect(headroomOf({ 'x-ratelimit-remaining-requests': '10', 'x-ratelimit-remaining-tokens': '9000' }, NOW)).toBeNull();
    expect(headroomOf(undefined, NOW)).toBeNull();
  });
});
