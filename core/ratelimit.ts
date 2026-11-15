// A cloud provider's rate limits, so the background queue waits instead of failing its work: from a refusal (429 and
// the like: Gemini's quota, with when to try again and whether it's the day's), and ahead of one from the headers Groq
// and Anthropic send with every answer (what's left of the requests and tokens, and when they're back)

export interface RateLimit {
  // When the provider may be asked again
  until: number;
  // Its quota for the day is used up, not the minute's
  daily: boolean;
}

// A minute when the provider says nothing of when
const DEFAULT_WAIT_MS = 60_000;
// Ahead of a refusal: fewer tokens left than a call takes, or no request
const TOKENS_HEADROOM = 4000;

type Headers = Record<string, string | undefined>;

interface ApiError {
  statusCode?: number;
  responseHeaders?: Headers;
  responseBody?: string;
  message?: string;
  lastError?: unknown;
  cause?: unknown;
}

// The provider's own error, inside the AI SDK's retries
const apiErrorOf = (error: unknown) => {
  let current = error as ApiError | null | undefined;

  for (let depth = 0; current && depth < 6; depth += 1) {
    if (current.statusCode !== undefined || current.responseBody !== undefined) {
      return current;
    }

    current = (current.lastError ?? current.cause) as ApiError | null | undefined;
  }

  return null;
};

// "37s", "1.5s" (Google's RetryInfo); "2m59.56s", "7.66s", "1h2m" (Groq's resets)
export const durationMs = (text: string | undefined) => {
  const parts = text?.match(/(\d+(?:\.\d+)?)(ms|h|m|s)/g);

  if (!parts) {
    return null;
  }

  const unit: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1000, ms: 1 };

  return Math.round(parts.reduce((sum, part) => {
    const [, value, name] = part.match(/(\d+(?:\.\d+)?)(ms|h|m|s)/)!;

    return sum + (Number(value) * unit[name]);
  }, 0));
};

// The next midnight in California, when Google renews the day's quotas
export const nextPacificMidnight = (now: number) => {
  const pacific = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const part = (type: string) => Number(pacific.find((candidate) => candidate.type === type)?.value ?? 0);
  const sinceMidnight = ((((part('hour') * 60) + part('minute')) * 60) + part('second')) * 1000;

  return now - sinceMidnight + (24 * 3_600_000);
};

const retryAfterMs = (headers: Headers | undefined, now: number) => {
  const ms = headers?.['retry-after-ms'];

  if (ms && Number.isFinite(Number(ms))) {
    return Number(ms);
  }

  const after = headers?.['retry-after'];

  if (!after) {
    return null;
  }

  return Number.isFinite(Number(after)) ? Number(after) * 1000 : Math.max(0, Date.parse(after) - now) || null;
};

// A refusal for the rate or the quota, and until when; null for any other error
export const rateLimitOf = (error: unknown, now = Date.now()): RateLimit | null => {
  const api = apiErrorOf(error);
  const text = `${api?.message ?? ''} ${api?.responseBody ?? ''}`;

  if (api?.statusCode !== 429 && !/RESOURCE_EXHAUSTED|exceeded your current quota|rate limit/i.test(text)) {
    return null;
  }

  // Google says which quota and when: its RetryInfo and QuotaFailure details
  let googleDelay: number | null = null;
  let daily = /PerDay|per day|daily/i.test(text);

  try {
    const body = JSON.parse(api?.responseBody ?? '') as { error?: { details?: { '@type'?: string, retryDelay?: string, violations?: { quotaId?: string }[] }[] } };

    for (const detail of body.error?.details ?? []) {
      googleDelay = durationMs(detail.retryDelay) ?? googleDelay;
      daily ||= (detail.violations ?? []).some((violation) => /PerDay/i.test(violation.quotaId ?? ''));
    }
  } catch {
    // Not Google's, or not JSON
  }

  const wait = retryAfterMs(api?.responseHeaders, now) ?? googleDelay;

  if (daily && (wait === null || wait < 3_600_000)) {
    return { until: nextPacificMidnight(now), daily: true };
  }

  return { until: now + (wait ?? DEFAULT_WAIT_MS), daily: false };
};

// Ahead of a refusal, from an answer's headers: none left of the requests, or too few tokens for another call, waits
// until they're back. Groq's x-ratelimit-*, Anthropic's anthropic-ratelimit-*
export const headroomOf = (headers: Headers | undefined, now = Date.now()): RateLimit | null => {
  if (!headers) {
    return null;
  }

  const number = (name: string) => (headers[name] === undefined ? null : Number(headers[name]));
  const groq = (kind: 'requests' | 'tokens') => ({
    left: number(`x-ratelimit-remaining-${kind}`), reset: durationMs(headers[`x-ratelimit-reset-${kind}`]),
  });
  const anthropic = (kind: 'requests' | 'tokens' | 'input-tokens' | 'output-tokens') => ({
    left: number(`anthropic-ratelimit-${kind}-remaining`),
    reset: headers[`anthropic-ratelimit-${kind}-reset`] ? Math.max(0, Date.parse(headers[`anthropic-ratelimit-${kind}-reset`]!) - now) : null,
  });
  const limits = [
    { ...groq('requests'), floor: 1 }, { ...groq('tokens'), floor: TOKENS_HEADROOM },
    { ...anthropic('requests'), floor: 1 }, { ...anthropic('tokens'), floor: TOKENS_HEADROOM },
    { ...anthropic('input-tokens'), floor: TOKENS_HEADROOM }, { ...anthropic('output-tokens'), floor: 1000 },
  ];
  const waits = limits.filter((limit) => limit.left !== null && limit.left < limit.floor && limit.reset !== null).map((limit) => limit.reset!);

  return waits.length ? { until: now + Math.max(...waits), daily: false } : null;
};
