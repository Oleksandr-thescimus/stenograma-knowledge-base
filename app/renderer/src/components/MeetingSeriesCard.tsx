import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, Loader2, Plus, Trash2 } from 'lucide-react';
import type { MeetingSeriesInfo, SeriesMatcher, SeriesSuggestion } from '../../../../core/protocol';
import { Chip } from '@/components/Composer';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatDay } from '@/lib/format';
import { errorMessage } from '@/lib/kb';

// Meeting series (core/stenograma/series.ts): the meetings grouped by their Meet code, to name once ("Lead meeting",
// "Daily"), and the series named, with the matchers that put a meeting in them: a code, or a weekday and time for a code
// used for different meetings. The name goes into the meetings' titles, and questions about a series ("what was
// discussed at the lead meetings last month") are answered from a short summary of each of its meetings

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// Monday first
const WEEK = [1, 2, 3, 4, 5, 6, 0];

const percent = (share: number) => `${Math.round(share * 100)}%`;

// "mostly Thu (91%) at 11:30 (91%)"; a daily is on different days, a team's room at different times
const describeWhen = (suggestion: SeriesSuggestion) => [
  suggestion.weekdayShare >= 0.5 ? `mostly ${WEEKDAYS[suggestion.weekday]} (${percent(suggestion.weekdayShare)})` : 'on different days',
  suggestion.timeShare >= 0.5 ? `at ${suggestion.time} (${percent(suggestion.timeShare)})` : 'at different times',
].join(' ');

export const describeMatcher = (matcher: SeriesMatcher) => [
  matcher.code,
  matcher.weekdays?.length && matcher.weekdays.map((day) => WEEKDAYS[day]).join(', '),
  matcher.time && `${matcher.time} ±${matcher.tolerance ?? 20} min`,
  matcher.from !== undefined && `from ${formatDay(matcher.from)}`,
  matcher.to !== undefined && `to ${formatDay(matcher.to - 1)}`,
].filter(Boolean).join(' · ');

const RuleForm = ({ codes, onAdd }: { codes: string[], onAdd: (matcher: SeriesMatcher) => void }) => {
  const [code, setCode] = useState('any');
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [time, setTime] = useState('');
  const [tolerance, setTolerance] = useState('20');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const toggle = (day: number) => setWeekdays(weekdays.includes(day) ? weekdays.filter((other) => other !== day) : [...weekdays, day]);
  const nextDay = (day: string) => {
    const date = new Date(`${day}T00:00:00`);
    date.setDate(date.getDate() + 1);

    return date.getTime();
  };

  const add = () => onAdd({
    ...(code !== 'any' && { code }),
    ...(weekdays.length && { weekdays: [...weekdays].sort() }),
    ...(time && { time, tolerance: Number(tolerance) || 0 }),
    ...(from && { from: new Date(`${from}T00:00:00`).getTime() }),
    ...(to && { to: nextDay(to) }),
  });

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label>Meet code</Label>
          <Select value={code} onValueChange={setCode}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent position="popper" className="max-h-72">
              <SelectItem value="any">Any</SelectItem>
              {codes.map((candidate) => <SelectItem key={candidate} value={candidate}>{candidate}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex gap-2">
          <div className="flex-1 space-y-1">
            <Label htmlFor="rule-time">Time</Label>
            <Input id="rule-time" type="time" value={time} onChange={(event) => setTime(event.target.value)} />
          </div>
          <div className="w-24 space-y-1">
            <Label htmlFor="rule-tolerance">± minutes</Label>
            <Input id="rule-tolerance" type="number" min={0} max={180} value={tolerance} onChange={(event) => setTolerance(event.target.value)} />
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-1">
        {WEEK.map((day) => (
          <Button key={day} size="xs" variant={weekdays.includes(day) ? 'secondary' : 'outline'} onClick={() => toggle(day)}>
            {WEEKDAYS[day]}
          </Button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="rule-from">From (when the schedule changed)</Label>
          <Input id="rule-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="rule-to">To</Label>
          <Input id="rule-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        </div>
      </div>
      <Button size="sm" onClick={add} disabled={code === 'any' && !time && !weekdays.length}>Add the rule</Button>
    </div>
  );
};

const SeriesRow = ({ series, codes, onSave, onDelete }: {
  series: MeetingSeriesInfo,
  codes: string[],
  onSave: (matchers: SeriesMatcher[]) => void,
  onDelete: () => void,
}) => {
  const [adding, setAdding] = useState(false);

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-medium">{series.name}</p>
          <p className="text-xs text-muted-foreground">
            {series.meetings} meetings · {series.summarized} summarized{series.lastAt ? ` · last ${formatDay(series.lastAt)}` : ''}
          </p>
        </div>
        <Button size="xs" variant="ghost" onClick={() => setAdding(!adding)}>
          <Plus />
          Rule
        </Button>
        <Button size="icon-xs" variant="ghost" onClick={onDelete} aria-label={`Delete ${series.name}`}>
          <Trash2 />
        </Button>
      </div>
      <div className="flex flex-wrap gap-1">
        {series.matchers.map((matcher, index) => (
          <Chip
            key={describeMatcher(matcher)}
            label={describeMatcher(matcher)}
            onRemove={() => onSave(series.matchers.filter((_, other) => other !== index))}
          />
        ))}
        {!series.matchers.length && <span className="text-xs text-muted-foreground">No meeting is in it: add a rule</span>}
      </div>
      {adding && (
        <RuleForm
          codes={codes}
          onAdd={(matcher) => {
            onSave([...series.matchers, matcher]);
            setAdding(false);
          }}
        />
      )}
    </div>
  );
};

const SuggestionRow = ({ suggestion, series, onName, onAddTo }: {
  suggestion: SeriesSuggestion,
  series: MeetingSeriesInfo[],
  onName: (name: string) => void,
  onAddTo: (seriesId: number) => void,
}) => {
  const [name, setName] = useState('');

  return (
    <div className="space-y-2 border-b py-3 last:border-b-0">
      <div className="text-sm">
        <span className="font-mono">{suggestion.code}</span>
        <span className="text-muted-foreground">
          {` · ${suggestion.meetings} meetings · ${describeWhen(suggestion)}`}
          {` · ${formatDay(suggestion.firstAt)} – ${formatDay(suggestion.lastAt)}`}
        </span>
      </div>
      {suggestion.participants.length > 0 && <p className="truncate text-xs text-muted-foreground">{suggestion.participants.join(', ')}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Input className="h-8 w-56" placeholder="Name it, e.g. Lead meeting" value={name} onChange={(event) => setName(event.target.value)} />
        <Button size="sm" variant="outline" onClick={() => onName(name)} disabled={!name.trim()}>Name the series</Button>
        {series.length > 0 && (
          <Select value="" onValueChange={(id) => onAddTo(Number(id))}>
            <SelectTrigger size="sm"><SelectValue placeholder="or add it to…" /></SelectTrigger>
            <SelectContent position="popper">
              {series.map((candidate) => <SelectItem key={candidate.id} value={String(candidate.id)}>{candidate.name}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
      </div>
    </div>
  );
};

const MeetingSeriesCard = () => {
  const [data, setData] = useState<{ series: MeetingSeriesInfo[], suggestions: SeriesSuggestion[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => window.kb.invoke('meetingSeries', {}).then(setData).catch((reason: unknown) => setError(errorMessage(reason))), []);

  useEffect(() => {
    load();
  }, [load]);

  const run = async (call: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);

    try {
      await call();
      await load();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const save = (series: { id?: number, name: string, matchers: SeriesMatcher[] }) => run(() => window.kb.invoke('saveMeetingSeries', series));
  const codes = data?.suggestions.map((suggestion) => suggestion.code) ?? [];
  // Codes of two meetings or more that no series has yet
  const unnamed = data?.suggestions.filter((suggestion) => suggestion.seriesId === null && suggestion.meetings >= 2) ?? [];

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4">
      <div className="flex items-start gap-3">
        <CalendarClock className="mt-0.5 size-5 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h3 className="font-medium">Meeting series</h3>
          <p className="text-sm text-muted-foreground">
            Recurring meetings keep their Meet code. Name them once: the name goes into their titles, and questions such
            as &quot;what was discussed at the lead meetings last month&quot; are answered from a summary of each.
          </p>
        </div>
        {busy && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {data?.series.map((series) => (
        <SeriesRow
          key={series.id}
          series={series}
          codes={codes}
          onSave={(matchers) => save({ id: series.id, name: series.name, matchers })}
          onDelete={() => run(() => window.kb.invoke('deleteMeetingSeries', { id: series.id }))}
        />
      ))}
      {unnamed.length > 0 && (
        <div>
          <h4 className="text-sm font-medium">Meetings by their code, not in a series</h4>
          {unnamed.map((suggestion) => (
            <SuggestionRow
              key={suggestion.code}
              suggestion={suggestion}
              series={data?.series ?? []}
              onName={(name) => save({ name, matchers: [{ code: suggestion.code }] })}
              onAddTo={(seriesId) => {
                const target = data?.series.find((series) => series.id === seriesId);

                if (target) {
                  save({ id: target.id, name: target.name, matchers: [...target.matchers, { code: suggestion.code }] });
                }
              }}
            />
          ))}
        </div>
      )}
      {data && !data.series.length && !unnamed.length && <p className="text-sm text-muted-foreground">No meetings with a Meet code yet.</p>}
    </div>
  );
};

export default MeetingSeriesCard;
