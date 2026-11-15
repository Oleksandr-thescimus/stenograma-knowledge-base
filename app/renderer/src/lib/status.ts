import type { AppStatus, CoreStatus, SourceInfo, SummaryStatus } from '../../../../core/protocol';
import { formatDuration, formatWhen, sourceName } from './format';
import { summariesLeftMs } from './summaries';

// The sidebar's line: the one thing about the knowledge base most worth knowing now, first what needs the user (a source
// whose sync failed, the index stopped), then the work going on in the background, else "Up to date". Its tooltip has
// the whole state, and a click opens where it's seen and fixed. A routine sync isn't shown: it would blink every few
// minutes

// The page a click opens: Sources for a source to fix, else Activity
export type StatusPage = 'sources' | 'activity';

export type Tone = 'ok' | 'busy' | 'idle' | 'error';

export interface StatusSummary {
  tone: Tone;
  text: string;
  // The page it opens; null for the core not running, which the banner shows
  page: StatusPage | null;
  // The whole state, a line each
  details: string[];
}


const failedSources = (core: CoreStatus) => core.sources.filter((source) => source.connector && source.lastError && !source.connector.running);

// Short for the line, whole for the tooltip
const problemText = (source: SourceInfo, short = false) => {
  switch (source.connector?.problem) {
    case 'auth':
      return short ? 'new token needed' : 'its token was refused, a new one is needed';
    case 'network':
      return short ? 'offline' : 'its server wasn\'t reached';
    default:
      return 'sync failed';
  }
};

const left = (n: number) => `${n.toLocaleString()} left`;

// ", ~1 h 20 min" for the summaries waiting, by the model's average
const summaryLeft = (summaries: SummaryStatus) => {
  const ms = summariesLeftMs(summaries, Date.now());

  return ms ? `, ~${formatDuration(ms)}` : '';
};

const detailsOf = (core: CoreStatus) => {
  const { embedding, attachments, summaries, server } = core;

  return [
    ...failedSources(core).map((source) => `${sourceName(source)}: ${problemText(source)}`),
    ...core.ai.lanes.filter((lane) => lane.takes.length > 0 && lane.reachable === false).map((lane) => `${lane.name}: not reached`),
    embedding.pending > 0
      ? `Indexing: ${left(embedding.pending)}${embedding.error ? ', stopped by an error' : ''}`
      : 'Index: up to date',
    embedding.rebuild && `Building ${embedding.rebuild.model}: ${left(embedding.rebuild.pending)}`,
    `Images and files: ${attachments.done.toLocaleString()} read, ${attachments.pending.toLocaleString()} waiting`
      + `${attachments.failed ? `, ${attachments.failed.toLocaleString()} not read` : ''}${attachments.error ? ', stopped by an error' : ''}`,
    `Meeting summaries: ${summaries.done.toLocaleString()} made, ${summaries.pending.toLocaleString()} waiting`
      + `${summaries.skipped ? `, ${summaries.skipped.toLocaleString()} skipped` : ''}${summaryLeft(summaries)}`,
    (core.drafts.ready > 0 || core.drafts.waiting > 0)
      && `Reply drafts: ${core.drafts.ready.toLocaleString()} to review, ${core.drafts.waiting.toLocaleString()} waiting`,
    attachments.paused && `Background AI paused ${attachments.paused.until ? `until ${formatWhen(attachments.paused.until)}` : 'until resumed'}`,
    server.listening ? `The extension sends to port ${server.port}` : 'The extension can\'t send',
  ].filter((line): line is string => Boolean(line));
};

// The first that applies, in this order
const headlineOf = (core: CoreStatus): Omit<StatusSummary, 'details'> => {
  const { embedding, attachments, summaries, server } = core;
  const failed = failedSources(core);
  const paused = Boolean(attachments.paused);

  if (failed.length === 1) {
    return { tone: 'error', text: `${sourceName(failed[0])}: ${problemText(failed[0], true)}`, page: 'sources' };
  }

  if (failed.length > 1) {
    return { tone: 'error', text: `${failed.length} sources not syncing`, page: 'sources' };
  }

  if (!server.listening) {
    return { tone: 'error', text: 'The extension can\'t send', page: 'activity' };
  }

  if (embedding.error && embedding.pending > 0) {
    return { tone: 'error', text: 'Indexing stopped by an error', page: 'activity' };
  }

  if (attachments.error && attachments.pending > 0 && !paused) {
    return { tone: 'error', text: 'Reading images stopped by an error', page: 'activity' };
  }

  if (embedding.pending > 0) {
    return { tone: 'busy', text: `Indexing: ${left(embedding.pending)}`, page: 'activity' };
  }

  if (embedding.rebuild) {
    const { pending, total } = embedding.rebuild;

    return { tone: 'busy', text: `Building the new index: ${Math.floor(((total - pending) / Math.max(total, 1)) * 100)}%`, page: 'activity' };
  }

  if (attachments.pending > 0 && !paused) {
    return { tone: 'busy', text: `Reading images and files: ${left(attachments.pending)}`, page: 'activity' };
  }

  // A meeting skipped after a failure waits for a restart, not for work going on
  if (summaries.pending > summaries.skipped && !paused) {
    return { tone: 'busy', text: `Summarizing meetings: ${left(summaries.pending)}${summaryLeft(summaries)}`, page: 'activity' };
  }

  if (paused && attachments.pending + summaries.pending > 0) {
    return { tone: 'idle', text: 'Background AI paused', page: 'activity' };
  }

  return { tone: 'ok', text: 'Up to date', page: 'activity' };
};

export const describeStatus = (status: AppStatus | null): StatusSummary => {
  if (!status || status.process.state === 'starting') {
    return { tone: 'busy', text: 'Starting…', page: null, details: [] };
  }

  if (status.process.state !== 'running' || !status.core) {
    return { tone: 'error', text: 'Not running', page: null, details: [] };
  }

  return { ...headlineOf(status.core), details: detailsOf(status.core) };
};
