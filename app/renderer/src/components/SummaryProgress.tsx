import type { SummaryStatus } from '../../../../core/protocol';
import TaskServers from '@/components/TaskServers';
import { useNow, waitText } from '@/lib/activity';
import { formatDuration } from '@/lib/format';
import { summariesLeftMs } from '@/lib/summaries';

// The background summaries of the series' meetings: how many, each server's (the one it makes now, its step, time and
// model, or why it doesn't, and its speed), how long the rest will take with them all, and why none is made while some
// wait

const SummaryProgress = ({ status }: { status: SummaryStatus }) => {
  const working = status.servers.filter((server) => server.work).length;
  const now = useNow(working > 0);
  const leftMs = summariesLeftMs(status, now);
  const waits = status.pending > status.skipped;

  return (
    <div className="space-y-1 text-sm text-muted-foreground">
      <p>
        {status.done.toLocaleString()} made, {status.pending.toLocaleString()} waiting
        {status.skipped > 0 && `, ${status.skipped.toLocaleString()} skipped until a restart`}
        {leftMs !== null && waits && ` · ${formatDuration(leftMs)} left${working > 1 ? ` on ${working} servers` : ''}`}
      </p>
      {(waits || working > 0) && <TaskServers servers={status.servers} verb="summarizing" unit="a meeting" now={now} />}
      {/* A server tells its own reason */}
      {status.waiting && !status.servers.length && <p className="pl-3">{waitText(status.waiting)}</p>}
      {status.error && <p className="pl-3 text-destructive">The last summary failed: {status.error}</p>}
    </div>
  );
};

export default SummaryProgress;
