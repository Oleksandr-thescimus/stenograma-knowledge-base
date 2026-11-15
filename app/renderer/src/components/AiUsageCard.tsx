import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { cn } from 'cn';
import type { AiCallGroup, AiCallResult, AiError, AiErrorsQuery, AiTask, AiUsage, CitedSource, UsageRow } from '../../../../core/protocol';
import MeetingDialog from '@/components/MeetingDialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatDay, formatDuration, formatWhen } from '@/lib/format';
import { errorMessage } from '@/lib/kb';

// The statistics of the AI's work (Activity): of a period, by task and by model, from every model call kept by the core
// (core/usage.ts): their number, time, tokens, speed and errors. Listed again every half a minute while shown. A number
// of errors opens them: when, which call, its kind and what it said. A number of calls opens what they worked on (a
// meeting, a draft, an image, a question), each with its result as kept now, and a way to where it lives

const PERIODS = [
  { value: 'today', label: 'Today' },
  { value: '7', label: 'The last 7 days' },
  { value: '30', label: 'The last 30 days' },
  { value: '365', label: 'The last 12 months' },
  { value: 'all', label: 'All' },
];

const sinceOf = (period: string) => {
  if (period === 'all') {
    return null;
  }

  const date = new Date();
  date.setHours(0, 0, 0, 0);

  if (period !== 'today') {
    date.setDate(date.getDate() - Number(period) + 1);
  }

  return date.getTime();
};

const TASKS: Record<AiTask, string> = {
  answer: 'Answers',
  rewrite: 'Questions rewritten',
  summary: 'Meeting summaries',
  draft: 'Reply drafts',
  image: 'Images read',
  style: 'Style described',
  embedding: 'Indexing',
  search: 'Searches',
};

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

const tokens = (row: UsageRow) => (row.inputTokens || row.outputTokens
  ? `${compact.format(row.inputTokens)} / ${compact.format(row.outputTokens)}`
  : '—');

const KINDS: Record<AiError['error'], string> = {
  unreachable: 'not reached', timeout: 'took too long', aborted: 'stopped', failed: 'failed',
};

// Under a second in milliseconds: a call refused at once
const callTime = (ms: number) => (ms < 1000 ? `${ms} ms` : formatDuration(ms));

// The same error on the same model one after another (its tries, the next items) is shown once, with how many
const grouped = (errors: AiError[]) => errors.reduce<{ error: AiError, count: number, first: number }[]>((groups, error) => {
  const last = groups.at(-1);

  if (last && last.error.task === error.task && last.error.model === error.model && last.error.server === error.server
    && last.error.error === error.error && last.error.message === error.message && last.error.item === error.item) {
    last.count += 1;
    last.first = error.startedAt;
  } else {
    groups.push({ error, count: 1, first: error.startedAt });
  }

  return groups;
}, []);

// The errors of a row (a task, a model on a server) or of all, the newest first
const ErrorsDialog = ({ title, query, onClose, onDeleted }: { title: string, query: AiErrorsQuery, onClose: () => void, onDeleted: () => void }) => {
  const [errors, setErrors] = useState<AiError[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  // The failed calls of this list gone from the statistics, after a second click
  const remove = async () => {
    try {
      await window.kb.invoke('deleteAiErrors', query);
      onDeleted();
      onClose();
    } catch (reason) {
      setFailure(errorMessage(reason));
    }
  };

  useEffect(() => {
    window.kb.invoke('aiErrors', query).then(setErrors).catch((reason: unknown) => setFailure(errorMessage(reason)));
  }, [query]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl xl:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Errors: {title}</DialogTitle>
          <DialogDescription>The newest 100 of the period; the same error one after another is shown once.</DialogDescription>
        </DialogHeader>
        {Boolean(errors?.length) && (
          <div className="flex items-center gap-2 text-sm">
            {confirming ? (
              <>
                <span className="flex-1 text-muted-foreground">Delete every failed call of this list and period from the statistics?</span>
                <Button size="sm" variant="destructive" onClick={remove}>Delete</Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
              </>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>Delete these errors</Button>
            )}
          </div>
        )}
        <div className="max-h-[60vh] space-y-2 overflow-y-auto text-sm">
          {failure && <p className="text-destructive">{failure}</p>}
          {!errors && !failure && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
          {errors?.length === 0 && <p className="text-muted-foreground">None kept call by call: those over a year old are in the totals only.</p>}
          {errors && grouped(errors).map(({ error: item, count, first }) => (
            <div key={`${item.startedAt}-${item.task}-${item.model}`} className="space-y-0.5 rounded-md border p-2">
              <p className="text-xs text-muted-foreground">
                {count > 1 ? `${formatWhen(first)}–${formatWhen(item.startedAt)}` : formatWhen(item.startedAt)}
                {' · '}
                {TASKS[item.task] ?? item.task} · {item.model} on {item.server} · {callTime(item.ms)}
                {item.background && ' · background'}
              </p>
              {item.item && <p className="truncate">{item.item}</p>}
              <p>
                <span className="text-destructive">{KINDS[item.error]}</span>
                {count > 1 && <span className="text-muted-foreground"> ×{count}</span>}
                {item.message
                  ? <span className="break-words">: {item.message}</span>
                  : <span className="text-muted-foreground"> (what it said wasn&apos;t kept before this version)</span>}
              </p>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
};

// The meeting view takes a cited source: this one cites no chunk, so it opens at the top
const meetingSource = (result: Extract<AiCallResult, { kind: 'summary' }>): CitedSource => ({
  n: 0,
  chunkId: 0,
  documentId: '',
  sourceId: result.sourceId,
  sourceKind: 'stenograma',
  documentKind: 'meeting-list',
  threadId: result.sessionId,
  title: result.title,
  createdAt: result.createdAt,
  startMs: null,
  madeByAi: false,
  text: '',
});

export interface CallLinks {
  onOpenChat: (chatId: number) => void;
  onOpenDrafts: () => void;
}

// A group's result, read when it's opened
const CallResult = ({ item, links, onMeeting }: { item: string, links: CallLinks, onMeeting: (source: CitedSource) => void }) => {
  const [result, setResult] = useState<AiCallResult | null | undefined>(undefined);

  useEffect(() => {
    window.kb.invoke('aiCallResult', { item }).then(setResult).catch(() => setResult(null));
  }, [item]);

  if (result === undefined) {
    return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
  }

  if (result === null) {
    return <p className="text-muted-foreground">It&apos;s gone from the knowledge base.</p>;
  }

  if (result.kind === 'none') {
    const texts = {
      working: 'Being made now: a long meeting takes a call per part, then one for the summary.',
      failed: 'None made: it failed, and is tried again after a restart. Its errors are in the Errors column.',
      waiting: 'None made yet: it waits in the queue.',
    };

    return <p className="text-muted-foreground">{texts[result.reason]}</p>;
  }

  const text = (value: string) => <p className="max-h-64 overflow-y-auto rounded bg-muted p-2 whitespace-pre-wrap">{value || '—'}</p>;

  switch (result.kind) {
    case 'summary':
      return (
        <div className="space-y-2">
          {text(result.text)}
          <p className="text-xs text-muted-foreground">As kept now, by {result.model.replace(/^\S+ /, '')}</p>
          <Button size="sm" variant="outline" onClick={() => onMeeting(meetingSource(result))}>Open the meeting</Button>
        </div>
      );
    case 'draft':
      return (
        <div className="space-y-2">
          {text(result.text)}
          <p className="text-xs text-muted-foreground">{result.conversation} · {result.state}</p>
          <Button size="sm" variant="outline" onClick={() => links.onOpenDrafts()}>Open Reply drafts</Button>
        </div>
      );
    case 'image':
      return (
        <div className="space-y-2">
          <p><span className="font-medium">Description:</span> {result.description ?? '—'}</p>
          <div><span className="font-medium">Text in it:</span>{text(result.text ?? '')}</div>
        </div>
      );
    default:
      return (
        <div className="space-y-2">
          <p className="font-medium">{result.question}</p>
          {text(result.text)}
          <Button size="sm" variant="outline" onClick={() => links.onOpenChat(result.chatId)}>Open the chat</Button>
        </div>
      );
  }
};

// The calls of a row (a task, a model on a server) by what they worked on, the newest first, each opened in place
const CallsDialog = ({ title, query, links, onClose }: { title: string, query: AiErrorsQuery, links: CallLinks, onClose: () => void }) => {
  const [groups, setGroups] = useState<AiCallGroup[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [meeting, setMeeting] = useState<CitedSource | null>(null);

  useEffect(() => {
    window.kb.invoke('aiCalls', query).then(setGroups).catch((reason: unknown) => setFailure(errorMessage(reason)));
  }, [query]);

  const go = (action: () => void) => () => {
    onClose();
    action();
  };

  return (
    <>
      <Dialog open onOpenChange={(next) => !next && onClose()}>
        <DialogContent className="sm:max-w-2xl xl:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Calls: {title}</DialogTitle>
            <DialogDescription>The newest 100 of the period by what they worked on; a meeting&apos;s summary takes several calls.</DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] space-y-2 overflow-y-auto text-sm">
            {failure && <p className="text-destructive">{failure}</p>}
            {!groups && !failure && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
            {groups?.length === 0 && (
              <p className="text-muted-foreground">
                None to show: indexing and searches keep no item, and calls made before this version didn&apos;t say what they worked on.
              </p>
            )}
            {groups?.map((group) => {
              const key = `${group.item}|${group.provider}|${group.model}|${group.server}`;
              const opened = open === key;

              return (
                <div key={key} className="rounded-md border">
                  <button type="button" className="flex w-full items-start gap-2 p-2 text-left hover:bg-accent/50" onClick={() => setOpen(opened ? null : key)}>
                    {opened ? <ChevronDown className="mt-0.5 size-4 shrink-0" /> : <ChevronRight className="mt-0.5 size-4 shrink-0" />}
                    <span className="min-w-0 flex-1 space-y-0.5">
                      <span className="block truncate">{group.title ?? 'Gone from the knowledge base'}</span>
                      <span className="block text-xs text-muted-foreground">
                        {formatWhen(group.lastAt)} · {TASKS[group.task] ?? group.task} · {group.model} on {group.server}
                        {' · '}
                        {group.calls} {group.calls === 1 ? 'call' : 'calls'} · {callTime(group.ms)}
                        {(group.inputTokens > 0 || group.outputTokens > 0) && ` · ${compact.format(group.inputTokens)} / ${compact.format(group.outputTokens)} tokens`}
                        {group.errors > 0 && <span className="text-destructive"> · {group.errors} failed</span>}
                      </span>
                    </span>
                  </button>
                  {opened && (
                    <div className="border-t p-2">
                      <CallResult item={group.item} links={{ onOpenChat: (chatId) => go(() => links.onOpenChat(chatId))(), onOpenDrafts: go(links.onOpenDrafts) }} onMeeting={setMeeting} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
      <MeetingDialog source={meeting} onClose={() => setMeeting(null)} />
    </>
  );
};

// Indexing and searches keep no item to show
const NO_ITEMS: AiTask[] = ['embedding', 'search'];

// The cells every table has: calls (with those of the background, and the chunks embedded), time, tokens, speed, errors
const Cells = ({ row, chunks, onErrors, onCalls }: { row: UsageRow, chunks?: boolean, onErrors: () => void, onCalls: (() => void) | null }) => (
  <>
    <td className="py-1.5 pr-3 text-right tabular-nums" title={`${row.background.toLocaleString()} by the background work`}>
      {onCalls ? (
        <button type="button" className="underline-offset-2 hover:underline" onClick={onCalls} title="Show what they worked on">
          {row.calls.toLocaleString()}
        </button>
      ) : row.calls.toLocaleString()}
      {chunks && row.items !== row.calls && <span className="text-muted-foreground"> · {compact.format(row.items)} chunks</span>}
    </td>
    <td className="py-1.5 pr-3 text-right tabular-nums">{formatDuration(row.ms)}</td>
    <td className="py-1.5 pr-3 text-right tabular-nums">{tokens(row)}</td>
    <td className="py-1.5 pr-3 text-right tabular-nums">{row.tokensPerSecond === null ? '—' : row.tokensPerSecond}</td>
    <td className="py-1.5 text-right tabular-nums">
      {row.errors ? (
        <button type="button" className="text-destructive underline-offset-2 hover:underline" onClick={onErrors} title="Show the errors">
          {row.errors.toLocaleString()}
        </button>
      ) : '—'}
    </td>
  </>
);

// A table sorted by a column, as clicked on its head: the numbers the most first, the names from A, a second click the
// other way; none, the core's order (the most calls first)
type SortKey = 'name' | 'calls' | 'ms' | 'tokens' | 'speed' | 'errors';
interface Sort { key: SortKey, descending: boolean }

const COLUMNS: { key: SortKey, label: string, title?: string }[] = [
  { key: 'calls', label: 'Calls' },
  { key: 'ms', label: 'Time' },
  { key: 'tokens', label: 'Tokens in / out', title: 'Input / output tokens; sorted by both together' },
  { key: 'speed', label: 'Tokens/s' },
  { key: 'errors', label: 'Errors' },
];

const valueOf = (row: UsageRow, key: Exclude<SortKey, 'name'>) => {
  switch (key) {
    case 'calls':
      return row.calls;
    case 'ms':
      return row.ms;
    case 'tokens':
      return row.inputTokens + row.outputTokens;
    case 'speed':
      return row.tokensPerSecond;
    default:
      return row.errors;
  }
};

// A speed not known goes last, whichever way
const sortRows = <T extends UsageRow>(rows: T[], sort: Sort | null, nameOf: (row: T) => string) => {
  if (!sort) {
    return rows;
  }

  const way = sort.descending ? -1 : 1;

  return [...rows].sort((a, b) => {
    if (sort.key === 'name') {
      return way * nameOf(a).localeCompare(nameOf(b));
    }

    const [x, y] = [valueOf(a, sort.key), valueOf(b, sort.key)];

    if (x === null || y === null) {
      return Number(x === null) - Number(y === null);
    }

    return way * (x - y);
  });
};

const SortHead = ({ label, title, sortKey, sort, onSort, className }: {
  label: string, title?: string, sortKey: SortKey, sort: Sort | null, onSort: (sort: Sort) => void, className: string,
}) => {
  const active = sort?.key === sortKey;
  const Arrow = sort?.descending ? ArrowDown : ArrowUp;
  let ariaSort: 'ascending' | 'descending' | 'none' = 'none';

  if (active) {
    ariaSort = sort.descending ? 'descending' : 'ascending';
  }

  return (
    <th className={className} aria-sort={ariaSort}>
      <button
        type="button"
        title={title}
        className={cn('inline-flex items-center gap-1 hover:text-foreground', active && 'text-foreground')}
        onClick={() => onSort({ key: sortKey, descending: active ? !sort.descending : sortKey !== 'name' })}
      >
        {label}
        {active && <Arrow className="size-3" />}
      </button>
    </th>
  );
};

const Head = ({ first, sort, onSort }: { first: string, sort: Sort | null, onSort: (sort: Sort) => void }) => (
  <thead>
    <tr className="border-b text-xs text-muted-foreground">
      <SortHead label={first} sortKey="name" sort={sort} onSort={onSort} className="py-1.5 pr-3 text-left font-normal" />
      {COLUMNS.map((column, index) => (
        <SortHead
          key={column.key}
          label={column.label}
          title={column.title}
          sortKey={column.key}
          sort={sort}
          onSort={onSort}
          className={cn('py-1.5 text-right font-normal', index < COLUMNS.length - 1 && 'pr-3')}
        />
      ))}
    </tr>
  </thead>
);

const AiUsageCard = ({ links }: { links: CallLinks }) => {
  const [period, setPeriod] = useState('7');
  const [usage, setUsage] = useState<AiUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorsOf, setErrorsOf] = useState<{ title: string, query: AiErrorsQuery } | null>(null);
  const [callsOf, setCallsOf] = useState<{ title: string, query: AiErrorsQuery } | null>(null);
  // Listed again at once after errors are deleted
  const [reloads, setReloads] = useState(0);
  const [taskSort, setTaskSort] = useState<Sort | null>(null);
  const [modelSort, setModelSort] = useState<Sort | null>(null);

  useEffect(() => {
    let alive = true;
    const list = () => window.kb.invoke('aiUsage', { since: sinceOf(period) })
      .then((found) => {
        if (alive) {
          setUsage(found);
          setError(null);
        }
      })
      .catch((reason: unknown) => alive && setError(errorMessage(reason)));

    list();
    const timer = setInterval(list, 30_000);

    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [period, reloads]);

  const { total } = usage ?? {};

  return (
    <section className="space-y-4 rounded-lg border bg-card p-4 text-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="font-medium">Statistics</h3>
          <p className="text-xs text-muted-foreground">
            Every model call: its time, tokens and errors, never what was asked or answered.
            {usage?.first && ` Kept since ${formatDay(usage.first)}.`}
          </p>
        </div>
        <Select value={period} onValueChange={setPeriod}>
          <SelectTrigger size="sm" className="w-44" aria-label="Period"><SelectValue /></SelectTrigger>
          <SelectContent position="popper" align="end">
            {PERIODS.map(({ value, label }) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      {error && <p className="text-destructive">{error}</p>}
      {usage && total && !total.calls && <p className="text-muted-foreground">No model calls in this period.</p>}
      {usage && total && total.calls > 0 && (
        <>
          <p className="text-muted-foreground">
            <span className="text-foreground">{total.calls.toLocaleString()}</span> calls
            {' · '}
            <span className="text-foreground">{formatDuration(total.ms)}</span> of model time
            {(total.inputTokens > 0 || total.outputTokens > 0) && (
              <>
                {' · '}
                <span className="text-foreground">{compact.format(total.inputTokens)}</span> tokens in,
                {' '}
                <span className="text-foreground">{compact.format(total.outputTokens)}</span> out
              </>
            )}
            {total.errors > 0 && (
              <>
                {' · '}
                <button
                  type="button"
                  className="text-destructive underline-offset-2 hover:underline"
                  onClick={() => setErrorsOf({ title: 'all', query: { since: sinceOf(period) } })}
                >
                  {total.errors.toLocaleString()} failed
                </button>
              </>
            )}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full">
              <Head first="Task" sort={taskSort} onSort={setTaskSort} />
              <tbody>
                {sortRows(usage.tasks, taskSort, (row) => TASKS[row.task] ?? row.task).map((row) => (
                  <tr key={row.task} className="border-b last:border-b-0">
                    <td className="py-1.5 pr-3">{TASKS[row.task] ?? row.task}</td>
                    <Cells
                      row={row}
                      chunks={row.task === 'embedding'}
                      onErrors={() => setErrorsOf({ title: TASKS[row.task] ?? row.task, query: { since: sinceOf(period), task: row.task } })}
                      onCalls={NO_ITEMS.includes(row.task) || row.task === 'rewrite' || row.task === 'style'
                        ? null
                        : () => setCallsOf({ title: TASKS[row.task] ?? row.task, query: { since: sinceOf(period), task: row.task } })}
                    />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <Head first="Model" sort={modelSort} onSort={setModelSort} />
              <tbody>
                {sortRows(usage.models, modelSort, (row) => `${row.model} ${row.server}`).map((row) => (
                  <tr key={`${row.provider}|${row.server}|${row.model}`} className="border-b last:border-b-0">
                    <td className="py-1.5 pr-3">
                      {row.model}
                      <span className="text-muted-foreground"> · {row.server}</span>
                    </td>
                    <Cells
                      row={row}
                      onErrors={() => setErrorsOf({
                        title: `${row.model} · ${row.server}`,
                        query: { since: sinceOf(period), model: { provider: row.provider, model: row.model, server: row.serverId } },
                      })}
                      onCalls={() => setCallsOf({
                        title: `${row.model} · ${row.server}`,
                        query: { since: sinceOf(period), model: { provider: row.provider, model: row.model, server: row.serverId } },
                      })}
                    />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">
            The time is the calls&apos; own: work on two servers at once counts twice. Tokens are as the provider counts them;
            embeddings count none. Each try of a call counts.
          </p>
        </>
      )}
      {errorsOf && <ErrorsDialog title={errorsOf.title} query={errorsOf.query} onClose={() => setErrorsOf(null)} onDeleted={() => setReloads((count) => count + 1)} />}
      {callsOf && <CallsDialog title={callsOf.title} query={callsOf.query} links={links} onClose={() => setCallsOf(null)} />}
    </section>
  );
};

export default AiUsageCard;
