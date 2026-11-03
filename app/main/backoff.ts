// When the core exits, the main process starts it again with a growing delay: 1 s, 2 s, 4 s... up to a minute. A core
// that ran a minute before it exited starts over from 1 s (docs/PLAN.md, M3)
export const MAX_RESTART_DELAY_MS = 60_000;
export const STABLE_RUN_MS = 60_000;

export const restartDelay = (attempt: number) => Math.min(1000 * (2 ** Math.max(attempt - 1, 0)), MAX_RESTART_DELAY_MS);

// The attempt after an exit, given how long the core ran
export const nextAttempt = (attempt: number, ranMs: number) => (ranMs >= STABLE_RUN_MS ? 1 : attempt + 1);
