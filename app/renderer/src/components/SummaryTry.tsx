import { useEffect, useRef, useState } from 'react';
import { Cloud, Loader2, Monitor, Sparkles, Square, X } from 'lucide-react';
import type { LlmSettings, ModelChoice, SummaryTry, SummaryTryMeeting } from '../../../../core/protocol';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import MarkdownText from '@/components/MarkdownText';
import ModelPicker from '@/components/ModelPicker';
import { formatDay, formatDuration } from '@/lib/format';
import { errorMessage } from '@/lib/kb';

// Trying summary models on a meeting (Settings → Meeting summaries): each try's summary with its time, calls and
// tokens, next to the saved one and the others tried, to compare. Nothing is kept

interface Tried extends SummaryTry {
  id: string;
  meeting: string;
}

const meetingKey = (meeting: Pick<SummaryTryMeeting, 'sourceId' | 'sessionId'>) => `${meeting.sourceId}|${meeting.sessionId}`;

const stats = (tried: Pick<SummaryTry, 'ms' | 'calls' | 'inputTokens' | 'outputTokens' | 'tokensPerSecond'>) => [
  formatDuration(tried.ms),
  `${tried.calls} ${tried.calls === 1 ? 'call' : 'calls'}`,
  tried.inputTokens !== null && tried.outputTokens !== null && `${tried.inputTokens.toLocaleString()} tokens in, ${tried.outputTokens.toLocaleString()} out`,
  tried.tokensPerSecond !== null && `${tried.tokensPerSecond} tokens/s`,
].filter(Boolean).join(' · ');

const Result = ({ title, local, meta, text, note, onRemove }: {
  title: string, local?: boolean, meta: string, text: string, note?: string, onRemove?: () => void,
}) => (
  <div className="space-y-1 rounded-md border p-3">
    <div className="flex items-center gap-2 text-sm">
      {local === undefined && <Sparkles className="size-3.5" />}
      {local === true && <Monitor className="size-3.5" />}
      {local === false && <Cloud className="size-3.5" />}
      <span className="font-medium">{title}</span>
      <span className="text-xs text-muted-foreground">{meta}</span>
      {onRemove && (
        <Button variant="ghost" size="icon-sm" className="ml-auto" onClick={onRemove} aria-label="Remove">
          <X />
        </Button>
      )}
    </div>
    {note && <p className="text-xs text-warning">{note}</p>}
    <div className="text-sm"><MarkdownText text={text} /></div>
  </div>
);

const SummaryTryPanel = ({ defaultLlm }: { defaultLlm: LlmSettings }) => {
  const [meetings, setMeetings] = useState<SummaryTryMeeting[] | null>(null);
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [chosen, setChosen] = useState<string>('');
  const [llm, setLlm] = useState<LlmSettings>(defaultLlm);
  const [running, setRunning] = useState<{ id: string, startedAt: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [tried, setTried] = useState<Tried[]>([]);
  const [error, setError] = useState<string | null>(null);
  const count = useRef(0);

  useEffect(() => {
    window.kb.invoke('summaryTryMeetings', {})
      .then((list) => {
        setMeetings(list);
        setChosen((current) => current || (list[0] ? meetingKey(list[0]) : ''));
      })
      .catch((reason: unknown) => setError(errorMessage(reason)));
    window.kb.invoke('chatModels', {}).then(setModels).catch(() => setModels([]));
  }, []);

  useEffect(() => {
    if (!running) {
      return undefined;
    }

    const timer = setInterval(() => setNow(Date.now()), 1000);

    return () => clearInterval(timer);
  }, [running]);

  const meeting = meetings?.find((candidate) => meetingKey(candidate) === chosen);
  const shown = tried.filter((result) => result.meeting === chosen);

  const run = async () => {
    if (!meeting) {
      return;
    }

    count.current += 1;
    const id = `try-${Date.now()}-${count.current}`;
    setRunning({ id, startedAt: Date.now() });
    setNow(Date.now());
    setError(null);

    try {
      const result = await window.kb.invoke('trySummary', { tryId: id, sourceId: meeting.sourceId, sessionId: meeting.sessionId, llm });
      setTried((current) => [{ ...result, id, meeting: meetingKey(meeting) }, ...current]);
    } catch (reason) {
      const message = errorMessage(reason);

      if (message !== 'Stopped') {
        setError(message);
      }
    } finally {
      setRunning(null);
    }
  };

  const stop = () => running && window.kb.invoke('cancelSummary', { summaryId: running.id });

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        A meeting&apos;s summary by another model, next to the saved one, to compare; nothing is kept. An Ollama model&apos;s first
        try includes loading it, so try it twice for its time. A meeting that may not go to cloud AI is tried only with Ollama.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={chosen} onValueChange={setChosen} disabled={!meetings?.length || Boolean(running)}>
          <SelectTrigger size="sm" className="w-80"><SelectValue placeholder={meetings ? 'No meetings with text' : 'Listing the meetings…'} /></SelectTrigger>
          <SelectContent position="popper" className="max-h-80">
            {meetings?.map((candidate) => (
              <SelectItem key={meetingKey(candidate)} value={meetingKey(candidate)}>
                {formatDay(candidate.createdAt)} · {candidate.title} · {candidate.lines} lines
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <ModelPicker models={models} value={llm} onChange={setLlm} disabled={Boolean(running)} className="w-64" />
        {running ? (
          <Button size="sm" variant="outline" onClick={stop}>
            <Square />
            Stop · {formatDuration(now - running.startedAt)}
          </Button>
        ) : (
          <Button size="sm" onClick={run} disabled={!meeting}>
            <Sparkles />
            Summarize
          </Button>
        )}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {running && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Summarizing with {llm.model}…
        </p>
      )}
      {shown.map((result) => (
        <Result
          key={result.id}
          title={result.llm.slice(result.llm.indexOf(' ') + 1)}
          local={result.local}
          meta={stats(result)}
          text={result.text}
          note={result.shared ? 'Background work ran meanwhile on the same computer: alone it takes less.' : undefined}
          onRemove={() => setTried((current) => current.filter((other) => other.id !== result.id))}
        />
      ))}
      {meeting?.saved && (
        <Result
          title={`Saved: ${meeting.saved.model.slice(meeting.saved.model.indexOf(' ') + 1)}`}
          meta={meeting.saved.durationMs !== null ? formatDuration(meeting.saved.durationMs) : 'made before it was timed'}
          text={meeting.saved.text}
        />
      )}
    </div>
  );
};

export default SummaryTryPanel;
