import { useEffect, useState } from 'react';
import type { SummaryStatus } from '../../../../core/protocol';
import { formatDay, formatDuration, formatTime } from '@/lib/format';
import { summariesLeftMs, summaryStep } from '@/lib/summaries';

// The background summaries of the series' meetings: how many, the one being made (its step, time and model), how long
// the rest will take, and why none is made while some wait

const WAITING: Record<NonNullable<SummaryStatus['waitingFor']>, string> = {
  answer: 'Waiting: an answer or a summary you asked for goes first',
  files: 'Waiting: the images and files of chats are read first',
  paused: 'Waiting: the background AI work is paused',
  unreachable: 'Waiting: the model wasn\'t reached',
};

const SummaryProgress = ({ status }: { status: SummaryStatus }) => {
  const [now, setNow] = useState(Date.now());
  const { current } = status;

  // The time of the one being made, a second at a time
  useEffect(() => {
    if (!current) {
      return undefined;
    }

    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);

    return () => clearInterval(timer);
  }, [current]);

  const leftMs = summariesLeftMs(status, now);
  const speed = [
    status.averageMs !== null && `about ${formatDuration(status.averageMs)} a meeting`,
    leftMs !== null && `${formatDuration(leftMs)} left`,
    status.tokensPerSecond !== null && `${status.tokensPerSecond} tokens/s`,
  ].filter(Boolean).join(' · ');

  return (
    <div className="space-y-1 text-sm text-muted-foreground">
      <p>
        Meeting summaries: {status.done.toLocaleString()} made, {status.pending.toLocaleString()} waiting
        {status.skipped > 0 && `, ${status.skipped.toLocaleString()} skipped until a restart`}
      </p>
      {current && (
        <p className="pl-3">
          Summarizing <span className="text-foreground">{current.title}</span> ({formatDay(current.createdAt)}): {summaryStep(current)}
          {' · '}
          {formatDuration(now - current.startedAt)} so far · {current.llm}{current.local && ', on this computer'}
        </p>
      )}
      {speed && status.pending > status.skipped && <p className="pl-3">{speed}</p>}
      {status.waitingFor && (
        <p className="pl-3">
          {WAITING[status.waitingFor]}
          {status.retryAt && `, tried again at ${formatTime(status.retryAt)}`}
        </p>
      )}
      {status.error && <p className="pl-3 text-destructive">The last summary failed: {status.error}</p>}
    </div>
  );
};

export default SummaryProgress;
