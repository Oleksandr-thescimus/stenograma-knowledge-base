import { useState, type ReactNode } from 'react';
import { Cpu, FileText, FolderOpen, Layers, Loader2, MessageSquareReply, NotebookText, Plug } from 'lucide-react';
import { cn } from 'cn';
import type { BackgroundTask, CoreStatus, LaneActivity, TaskServer } from '../../../../core/protocol';
import AiUsageCard, { type CallLinks } from '@/components/AiUsageCard';
import BackgroundPause from '@/components/BackgroundPause';
import SummaryProgress from '@/components/SummaryProgress';
import TaskServers from '@/components/TaskServers';
import { Switch } from '@/components/ui/switch';
import { leftMs, taskVerb, useNow, waitText, workTiming } from '@/lib/activity';
import { formatDuration, formatTime, formatWhen } from '@/lib/format';
import { errorMessage, useAppStatus } from '@/lib/kb';

// What the knowledge base does in the background, a row each: the AI servers (what each does now, and what waits for
// it), the index, the chats' images and files, the meetings' summaries, the reply drafts (each with the one done now,
// how long the rest takes, and why it waits), the extension's API, and where the data is; then the statistics of the
// AI's work. The pause of the background AI work is at the top; each server's queue is turned on or off here, as in
// Settings. The sidebar's status line opens this page

const Row = ({ icon: Icon, title, busy, error, aside, children }: {
  icon: typeof Layers, title: string, busy?: boolean, error?: boolean, aside?: ReactNode, children: ReactNode,
}) => (
  <section className="flex gap-3 border-b py-4 last:border-b-0">
    <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
    <div className="min-w-0 flex-1 space-y-1 text-sm">
      <h3 className="flex items-center gap-2 font-medium">
        {title}
        {busy && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="Working" />}
        {error && <span className="size-2 rounded-full bg-destructive" aria-label="An error" />}
      </h3>
      <div className="space-y-1 text-muted-foreground">{children}</div>
    </div>
    {aside && <div className="shrink-0">{aside}</div>}
  </section>
);

const Dot = ({ reachable }: { reachable: boolean | null }) => (
  <span className={cn('inline-block size-2 rounded-full', { 'bg-success': reachable, 'bg-destructive': reachable === false, 'bg-muted-foreground/50': reachable === null })} />
);

// How long the rest takes, the servers at work together: " · 35 min left on 2 servers"
const leftText = (pending: number, servers: TaskServer[], now: number) => {
  const left = leftMs(pending, servers, now);
  const working = servers.filter((server) => server.work).length;

  return left !== null && left > 0 ? ` · ${formatDuration(left)} left${working > 1 ? ` on ${working} servers` : ''}` : '';
};

const TAKES: Record<BackgroundTask, string> = { drafts: 'drafts', images: 'images', summaries: 'summaries' };

// A server's line: what it does now, or why it doesn't, what it takes, and its queue on or off
const LaneLine = ({ lane, now, onError }: { lane: LaneActivity, now: number, onError: (message: string) => void }) => {
  let doing = lane.queue ? 'idle' : 'queue off';

  if (lane.now) {
    doing = `${taskVerb(lane.now.task)} ${lane.now.work.title} · ${workTiming(lane.now.work, now).replace(/ on .*$/, '')}`;
  } else if (lane.limited) {
    doing = lane.limited.daily
      ? `daily quota used, until ${formatWhen(lane.limited.until)}`
      : `at its rate limit, goes on at ${formatTime(lane.limited.until)}`;
  } else if (lane.asked) {
    doing = 'busy with what you asked for';
  } else if (lane.retryAt || lane.reachable === false) {
    // A cloud provider without its key, or not reached
    doing = lane.kind !== 'ollama' && !lane.retryAt ? 'no key' : `not reached${lane.retryAt ? `, tried again at ${formatTime(lane.retryAt)}` : ''}`;
  }

  return (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5">
          {/* Grey while its queue is off: it takes nothing, whether it answers or not */}
          <Dot reachable={lane.queue ? lane.reachable : null} />
          <span className="text-foreground">{lane.name}</span>
          <span className="truncate">: {doing}</span>
        </p>
        <p className="pl-3.5 text-xs">Takes {lane.takes.map((task) => TAKES[task]).join(', ')}{lane.kind !== 'ollama' && ', of the sources that may go to cloud AI'}</p>
      </div>
      <Switch
        checked={lane.queue}
        aria-label={`${lane.name}'s background queue`}
        onCheckedChange={(queue) => window.kb.invoke('setServerQueue', { server: lane.id, queue }).catch((reason: unknown) => onError(errorMessage(reason)))}
      />
    </div>
  );
};

const Activity = ({ core }: { core: CoreStatus }) => {
  const { embedding, attachments, summaries, drafts, server, ai } = core;
  const [error, setError] = useState<string | null>(null);
  const { images } = attachments;
  const now = useNow(ai.lanes.some((lane) => lane.now));
  const readingImages = images.pending > 0 || images.servers.some((one) => one.work);
  const writingDrafts = drafts.waiting > 0 || drafts.servers.some((one) => one.work);

  return (
    <div className="rounded-lg border bg-card px-4">
      {/* Only the servers shown, with a model for some of the work: a cloud provider set up but unused doesn't count */}
      <Row icon={Cpu} title="AI servers" error={ai.lanes.some((lane) => lane.takes.length > 0 && lane.reachable === false)}>
        <div className="grid gap-2 xl:grid-cols-2 xl:gap-x-8">
          {ai.lanes.filter((lane) => lane.takes.length > 0).map((lane) => <LaneLine key={lane.id} lane={lane} now={now} onError={setError} />)}
        </div>
        <p>
          {ai.answers && `Answers: ${ai.answers.model} on ${ai.answers.server}. `}
          Every server with its queue on takes the next summary, draft or image it has a model for.
        </p>
        {error && <p className="text-destructive">{error}</p>}
      </Row>
      <Row icon={Layers} title="Index" busy={embedding.running || Boolean(embedding.rebuild)} error={Boolean(embedding.error)}>
        <p>
          {embedding.model}
          {embedding.pending > 0 ? ` · ${embedding.pending.toLocaleString()} chunks waiting` : ' · up to date'}
        </p>
        {embedding.rebuild && (
          <p>
            Building {embedding.rebuild.model}: {(embedding.rebuild.total - embedding.rebuild.pending).toLocaleString()}
            {' of '}
            {embedding.rebuild.total.toLocaleString()} chunks. The search switches to it when it&apos;s done.
          </p>
        )}
        {embedding.error && (
          <p className="text-destructive">
            {embedding.error}. It&apos;s tried again in a minute; meanwhile new chunks are found by their words only.
          </p>
        )}
      </Row>
      <Row icon={FileText} title="Images and files in chats" busy={attachments.running} error={Boolean(attachments.error)}>
        <p>
          {attachments.done.toLocaleString()} read · {attachments.pending.toLocaleString()} waiting
          {images.pending > 0 && images.pending < attachments.pending && ` (${images.pending.toLocaleString()} images)`}
          {attachments.failed > 0 && ` · ${attachments.failed.toLocaleString()} not read`}
          {leftText(images.pending, images.servers, now)}
        </p>
        {readingImages && <TaskServers servers={images.servers} verb="reading" unit="an image" now={now} />}
        {images.waiting && !images.servers.length && <p className="pl-3">{waitText(images.waiting)}</p>}
        {attachments.error && images.waiting?.reason !== 'noVision' && <p className="text-destructive">{attachments.error}. It&apos;s tried again in a minute.</p>}
      </Row>
      <Row
        icon={NotebookText}
        title="Meeting summaries"
        busy={summaries.running}
        error={Boolean(summaries.error)}
      >
        <SummaryProgress status={summaries} />
      </Row>
      <Row
        icon={MessageSquareReply}
        title="Reply drafts"
        busy={drafts.writing}
        error={Boolean(drafts.error)}
      >
        <p>
          {drafts.ready.toLocaleString()} to review · {drafts.waiting.toLocaleString()} waiting
          {leftText(drafts.waiting, drafts.servers, now)}
        </p>
        {writingDrafts && <TaskServers servers={drafts.servers} verb="writing to" unit="a draft" now={now} />}
        {drafts.wait && !drafts.servers.length && <p className="pl-3">{waitText(drafts.wait)}</p>}
        {drafts.error && <p className="text-destructive">The last draft failed: {drafts.error}</p>}
      </Row>
      <Row icon={Plug} title="The extension" error={!server.listening}>
        {server.listening
          ? <p>Stenograma in the browser sends its meetings to http://127.0.0.1:{server.port}</p>
          : <p className="text-destructive">The extension can&apos;t send: {server.error}</p>}
      </Row>
      <Row icon={FolderOpen} title="Data">
        <p className="font-mono text-xs">{core.dataDir}</p>
      </Row>
    </div>
  );
};

const ActivityPage = ({ links }: { links: CallLinks }) => {
  const status = useAppStatus();
  const core = status?.core;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-4 p-6 xl:max-w-6xl">
        <h2 className="text-xl">Activity</h2>
        {core ? (
          <>
            <div className="rounded-lg border bg-card p-4"><BackgroundPause status={core.attachments} /></div>
            <Activity core={core} />
            <AiUsageCard links={links} />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">The activity is shown while the knowledge base runs.</p>
        )}
      </div>
    </div>
  );
};

export default ActivityPage;
