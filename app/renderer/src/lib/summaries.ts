import type { SummaryStatus } from '../../../../core/protocol';

// The time the waiting summaries will take, by the average of the model's last ones: the one being made counts what's
// left of it. Null before a summary was timed, or with none to make
export const summariesLeftMs = (status: SummaryStatus, now: number) => {
  const { averageMs, current } = status;
  const waiting = status.pending - status.skipped - (current ? 1 : 0);

  if (averageMs === null || (waiting <= 0 && !current)) {
    return null;
  }

  return (Math.max(0, waiting) * averageMs) + (current ? Math.max(0, averageMs - (now - current.startedAt)) : 0);
};

// The model call going on: a part's notes, or the summary when it's the last
export const summaryStep = ({ done, all }: { done: number, all: number }) => (done + 1 >= all
  ? `writing the summary${all > 1 ? ` (step ${all} of ${all})` : ''}`
  : `notes, step ${done + 1} of ${all}`);
