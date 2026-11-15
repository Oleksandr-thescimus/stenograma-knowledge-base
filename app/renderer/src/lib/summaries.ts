import type { SummaryStatus } from '../../../../core/protocol';
import { leftMs } from './activity';

// The time the waiting summaries will take, the servers at work together, by the average of their models' last ones.
// Null before a summary was timed, or with none to make
export const summariesLeftMs = (status: SummaryStatus, now: number) => leftMs(status.pending - status.skipped, status.servers, now);

// The model call going on: a part's notes, or the summary when it's the last
export const summaryStep = ({ done, all }: { done: number, all: number }) => (done + 1 >= all
  ? `writing the summary${all > 1 ? ` (step ${all} of ${all})` : ''}`
  : `notes, step ${done + 1} of ${all}`);
