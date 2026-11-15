import type { Db } from './db.ts';
import type { AiCallGroup, AiError, AiErrorsQuery, AiTask, AiUsage, UsageRow } from './protocol.ts';

// The AI's work, kept for its statistics: a row per model call with its task, model, server, time, tokens and how it
// ended, never its text or what it was about. The calls of the last year are kept as they are; older ones are folded
// into a day's totals, so the statistics of any period stay

export interface AiCall {
  startedAt: number;
  ms: number;
  task: AiTask;
  provider: string;
  model: string;
  server: string;
  inputTokens: number | null;
  outputTokens: number | null;
  items?: number;
  error: 'unreachable' | 'timeout' | 'aborted' | 'failed' | null;
  // What it said, cut to 300 characters
  errorMessage?: string | null;
  // What it worked on, by its ids: meeting:sourceId:sessionId, draft:id, file:sourceId:fileId
  item?: string | null;
  background: boolean;
}

export const KEEP_CALLS_MS = 365 * 24 * 60 * 60_000;

export const recordCall = (db: Db, call: AiCall) => db.prepare(`
  insert into ai_calls (started_at, ms, task, provider, model, server, input_tokens, output_tokens, items, error, error_message, background, item)
  values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  call.startedAt, Math.round(call.ms), call.task, call.provider, call.model, call.server, call.inputTokens, call.outputTokens, call.items ?? 1,
  call.error, call.error ? (call.errorMessage ?? '').slice(0, 300) || null : null, call.background ? 1 : 0, call.item ?? null,
);

// The failed calls since then, the newest first: of a task, or of a model on a server, or all; those folded into a
// day's totals are counted there only
export const aiErrors = (
  db: Db, { since, task, model }: AiErrorsQuery, serverName: (provider: string, server: string) => string, itemName: (item: string) => string | null, limit = 100,
) => {
  const rows = db.prepare(`
    select started_at as startedAt, ms, task, provider, model, server, error, error_message as message, background, item
    from ai_calls
    where error is not null and started_at >= ? and (? is null or task = ?)
      and (? is null or (provider = ? and model = ? and server = ?))
    order by started_at desc limit ?
  `).all(
    since ?? 0, task ?? null, task ?? null, model ? 1 : null, model?.provider ?? null, model?.model ?? null, model?.server ?? null, limit,
  ) as (Omit<AiError, 'background' | 'server' | 'item'> & { server: string, background: number, item: string | null })[];

  return rows.map((row): AiError => ({
    ...row, server: serverName(row.provider, row.server), background: Boolean(row.background), item: row.item ? itemName(row.item) : null,
  }));
};

// The calls before then into their day's totals (the local day)
export const foldCalls = (db: Db, before: number) => db.transaction(() => {
  db.prepare(`
    insert into ai_call_days (day, task, provider, model, server, background, calls, ms, input_tokens, output_tokens, counted_ms, items, errors)
    select date(started_at / 1000, 'unixepoch', 'localtime'), task, provider, model, server, background, count(*), sum(ms),
      coalesce(sum(input_tokens), 0), coalesce(sum(output_tokens), 0), coalesce(sum(case when output_tokens is not null then ms end), 0),
      sum(items), sum(error is not null)
    from ai_calls where started_at < ? group by 1, 2, 3, 4, 5, 6
    on conflict (day, task, provider, model, server, background) do update set
      calls = calls + excluded.calls, ms = ms + excluded.ms, input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens, counted_ms = counted_ms + excluded.counted_ms,
      items = items + excluded.items, errors = errors + excluded.errors
  `).run(before);

  return db.prepare('delete from ai_calls where started_at < ?').run(before).changes;
})();

interface Totals {
  calls: number;
  background: number;
  ms: number;
  input: number;
  output: number;
  countedMs: number;
  items: number;
  errors: number;
}

const toRow = (totals: Totals): UsageRow => ({
  calls: totals.calls,
  background: totals.background,
  ms: totals.ms,
  inputTokens: totals.input,
  outputTokens: totals.output,
  tokensPerSecond: totals.output && totals.countedMs ? Math.round((totals.output / totals.countedMs) * 10_000) / 10 : null,
  items: totals.items,
  errors: totals.errors,
});

// The calls since then (all of them for null), the kept ones and the days' totals together, by the columns given
const totalsBy = (db: Db, since: number | null, columns: string[]) => {
  const group = columns.length ? `group by ${columns.join(', ')}` : '';
  const select = columns.length ? `${columns.join(', ')},` : '';

  return db.prepare(`
    select ${select} sum(calls) as calls, sum(background) as background, sum(ms) as ms, sum(input) as input, sum(output) as output,
      sum(counted_ms) as countedMs, sum(items) as items, sum(errors) as errors
    from (
      select task, provider, model, server, count(*) as calls, sum(background) as background, sum(ms) as ms,
        coalesce(sum(input_tokens), 0) as input, coalesce(sum(output_tokens), 0) as output,
        coalesce(sum(case when output_tokens is not null then ms end), 0) as counted_ms, sum(items) as items, sum(error is not null) as errors
      from ai_calls where started_at >= ? group by task, provider, model, server
      union all
      select task, provider, model, server, sum(calls), sum(case when background then calls else 0 end), sum(ms), sum(input_tokens),
        sum(output_tokens), sum(counted_ms), sum(items), sum(errors)
      from ai_call_days where day >= date(? / 1000, 'unixepoch', 'localtime') group by task, provider, model, server
    ) where calls > 0 ${group} order by ms desc
  `).all(since ?? 0, since ?? 0) as (Totals & Record<string, string>)[];
};

// The statistics since then, by task and by model; servers named by serverName
export const aiUsage = (db: Db, since: number | null, serverName: (provider: string, server: string) => string): AiUsage => {
  const [total] = totalsBy(db, since, []);
  const first = db.prepare(`
    select min(at) as at from (
      select min(started_at) as at from ai_calls
      union all select cast(strftime('%s', min(day)) as integer) * 1000 from ai_call_days
    )
  `).get() as { at: number | null };

  return {
    since,
    first: first.at,
    total: toRow(total?.calls ? total : { calls: 0, background: 0, ms: 0, input: 0, output: 0, countedMs: 0, items: 0, errors: 0 }),
    tasks: totalsBy(db, since, ['task']).map((row) => ({ task: row.task as AiTask, ...toRow(row) })),
    models: totalsBy(db, since, ['provider', 'model', 'server']).map((row) => ({
      provider: row.provider, model: row.model, server: serverName(row.provider, row.server), serverId: row.server, ...toRow(row),
    })),
  };
};

// The calls since then that kept what they worked on, by it and the model, the newest first: a meeting's summary is
// several calls (its parts' notes, then the summary). A question's rewrite and answer are one item
export const aiCalls = (
  db: Db, { since, task, model }: AiErrorsQuery, serverName: (provider: string, server: string) => string, itemName: (item: string) => string | null, limit = 100,
) => (db.prepare(`
  select item, min(task) as task, provider, model, server, count(*) as calls, sum(ms) as ms, coalesce(sum(input_tokens), 0) as inputTokens,
    coalesce(sum(output_tokens), 0) as outputTokens, sum(error is not null) as errors, max(started_at) as lastAt
  from ai_calls
  where item is not null and started_at >= ? and (? is null or task = ? or (? = 'answer' and task = 'rewrite'))
    and (? is null or (provider = ? and model = ? and server = ?))
  group by item, provider, model, server order by lastAt desc limit ?
`).all(
  since ?? 0, task ?? null, task ?? null, task ?? null, model ? 1 : null, model?.provider ?? null, model?.model ?? null, model?.server ?? null, limit,
) as (Omit<AiCallGroup, 'title'> & { task: string })[]).map((row): AiCallGroup => ({
  ...row,
  // A question's rewrite and its answer are told as the answer
  task: (row.task === 'rewrite' ? 'answer' : row.task) as AiTask,
  server: serverName(row.provider, row.server),
  title: itemName(row.item),
}));

// The failed calls the errors list shows, gone: since then, of a task or of a model on a server, or all. Those in a
// day's totals (over a year old) stay counted there
export const deleteErrors = (db: Db, { since, task, model }: AiErrorsQuery) => db.prepare(`
  delete from ai_calls
  where error is not null and started_at >= ? and (? is null or task = ?)
    and (? is null or (provider = ? and model = ? and server = ?))
`).run(since ?? 0, task ?? null, task ?? null, model ? 1 : null, model?.provider ?? null, model?.model ?? null, model?.server ?? null).changes;
