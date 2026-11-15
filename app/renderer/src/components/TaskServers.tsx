import type { TaskServer } from '../../../../core/protocol';
import { serverWaitText } from '@/lib/activity';
import { formatDuration } from '@/lib/format';
import { summaryStep } from '@/lib/summaries';

// The servers whose queue takes a task's work, a line each (Activity): the one it does now, its step, time and model,
// or why it doesn't; under it, how fast its model is

const TaskServers = ({ servers, verb, unit, now }: { servers: TaskServer[], verb: string, unit: string, now: number }) => (
  <div className="space-y-1.5 pl-3">
    {servers.map((server) => {
      const { work } = server;
      const speed = [
        server.averageMs !== null && `about ${formatDuration(server.averageMs)} ${unit}`,
        server.tokensPerSecond !== null && `${server.tokensPerSecond} tokens/s`,
      ].filter(Boolean).join(' · ');
      let doing = 'idle';

      if (work) {
        doing = '';
      } else if (server.wait) {
        doing = serverWaitText(server.wait);
      }

      return (
        <div key={server.name}>
          <p>
            <span className="text-foreground">{server.name}</span>
            {': '}
            {work ? (
              <>
                {verb} <span className="text-foreground">{work.title}</span>
                {work.detail && ` (${work.detail})`}
                {work.step && `: ${summaryStep(work.step)}`}
                {` · ${formatDuration(now - work.startedAt)} so far · ${work.model}`}
              </>
            ) : doing}
          </p>
          {speed && <p className="text-xs">{speed}</p>}
        </div>
      );
    })}
  </div>
);

export default TaskServers;
