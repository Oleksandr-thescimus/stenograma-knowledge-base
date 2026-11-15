import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, ExternalLink, Loader2, Sparkles, Square } from 'lucide-react';
import { cn } from 'cn';
import type { CitedSource, MeetingView, ShortSummary } from '../../../../core/protocol';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import MarkdownText from '@/components/MarkdownText';
import { formatDay, formatOffset, formatWhen } from '@/lib/format';
import { errorMessage } from '@/lib/kb';
import { citedRange } from '@/lib/meeting';
import { useMeetingSummary, type SummaryRun } from '@/lib/summary';

// A cited meeting from the knowledge base's own copy, scrolled to the cited moment (docs/PLAN.md, The app: meetings in
// answers). "Open in Stenograma" opens it in the extension of the browser it came from; "Summarize" makes a short
// summary of it, kept with it and shown in the header, as the text below is scrolled to the cited moment

// Whether the short summary is folded, remembered for every meeting; this window's preference only
const FOLDED_KEY = 'meeting-summary-folded';

const readFolded = () => {
  try {
    return localStorage.getItem(FOLDED_KEY) === 'true';
  } catch {
    return false;
  }
};

const ShortSummaryPanel = ({ text, saved, writing }: { text: string, saved: ShortSummary | null, writing: boolean }) => {
  const [folded, setFolded] = useState(readFolded);
  // A summary being written is shown, folded or not
  const open = writing || !folded;
  const meta = saved && !writing && `${saved.model} · ${formatWhen(saved.createdAt)}${saved.stale ? ' · the meeting changed since' : ''}`;

  const toggle = () => {
    setFolded(open);

    try {
      localStorage.setItem(FOLDED_KEY, String(open));
    } catch {
      // Not kept: it's folded or not in this window only
    }
  };

  return (
    <div className="mt-1 rounded-lg bg-bubble">
      <div className="flex items-center gap-2 py-1 pr-1 pl-3">
        <h3 className="shrink-0 text-sm font-medium text-muted-foreground">Short summary, made by AI</h3>
        <span className={cn('min-w-0 flex-1 truncate text-xs', saved?.stale && !writing ? 'text-warning' : 'text-muted-foreground')}>
          {!open && meta}
        </span>
        {!writing && (
          <Button size="xs" variant="ghost" onClick={toggle}>
            {open ? <ChevronUp /> : <ChevronDown />}
            {open ? 'Hide' : 'Show'}
          </Button>
        )}
      </div>
      {open && (
        <div className="max-h-64 overflow-y-auto px-3 pb-3">
          <MarkdownText text={text} />
          {meta && (
            <p className={cn('mt-2 text-xs', saved?.stale ? 'text-warning' : 'text-muted-foreground')}>
              {meta}
              {saved?.stale && ': summarize it again for the new text'}
            </p>
          )}
        </div>
      )}
    </div>
  );
};

const describeRun = (run: SummaryRun) => {
  const llm = run.llm ? ` with ${run.llm}` : '';

  if (run.text) {
    return `Writing the summary${llm}…`;
  }

  return run.all > 1 ? `Summarizing in parts${llm}: step ${run.done + 1} of ${run.all}` : `Summarizing${llm}…`;
};

const Section = ({ title, highlighted, children }: { title: string, highlighted: boolean, children: ReactNode }) => (
  <section
    ref={highlighted ? (node) => node?.scrollIntoView({ block: 'start' }) : undefined}
    className={cn('mb-4 rounded-lg p-3', highlighted ? 'bg-primary/10 ring-1 ring-primary/40' : 'bg-bubble')}
  >
    <h3 className="mb-2 text-sm font-medium text-muted-foreground">{title}</h3>
    {children}
  </section>
);

interface MeetingDialogProps {
  source: CitedSource | null;
  onClose: () => void;
}

const MeetingDialog = ({ source, onClose }: MeetingDialogProps) => {
  // undefined while it loads, null when it's gone from the knowledge base
  const [meeting, setMeeting] = useState<MeetingView | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMeeting(undefined);
    setError(null);

    if (!source?.threadId) {
      return undefined;
    }

    let alive = true;
    window.kb.invoke('meeting', { sourceId: source.sourceId, sessionId: source.threadId })
      .then((view) => alive && setMeeting(view))
      .catch((reason: unknown) => alive && setError(errorMessage(reason)));

    return () => {
      alive = false;
    };
  }, [source]);

  const summary = useMeetingSummary(meeting);
  const writing = Boolean(summary.run?.text);
  const range = useMemo(() => (meeting && source ? citedRange(meeting, source) : null), [meeting, source]);
  const scrollToCited = useCallback((node: HTMLDivElement | null) => node?.scrollIntoView({ block: 'center' }), []);

  const openInStenograma = () => {
    if (meeting && source) {
      window.kb.invoke('openInStenograma', { sourceId: meeting.sourceId, sessionId: meeting.sessionId, startMs: source.startMs })
        .catch((reason: unknown) => setError(errorMessage(reason)));
    }
  };

  return (
    <Dialog open={Boolean(source)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[85vh] max-w-3xl flex-col gap-0 p-0 sm:max-w-3xl xl:max-w-5xl">
        <DialogHeader className="border-b p-4 pr-12">
          <DialogTitle>{meeting?.title ?? source?.title}</DialogTitle>
          <DialogDescription>
            {[
              formatDay(meeting?.createdAt ?? source?.createdAt ?? 0),
              meeting && (meeting.origin === 'recording' ? 'Recording' : 'Meet call'),
              meeting?.participants.length && meeting.participants.join(', '),
            ].filter(Boolean).join(' · ')}
          </DialogDescription>
          {meeting && (
            <div className="flex gap-2 pt-2">
              <Button size="sm" variant="outline" onClick={() => summary.start()} disabled={Boolean(summary.run) || !meeting.messages.length}>
                <Sparkles />
                {summary.saved ? 'Summarize again' : 'Summarize'}
              </Button>
              {meeting.canOpenInStenograma && (
                <Button size="sm" variant="outline" onClick={openInStenograma}>
                  <ExternalLink />
                  Open in Stenograma
                </Button>
              )}
            </div>
          )}
          {/* The progress stays in sight here: the view below is scrolled to the cited moment */}
          {summary.run && (
            <div className="flex items-center gap-2 pt-1 text-sm text-muted-foreground">
              <Loader2 className="size-4 shrink-0 animate-spin" />
              <span className="min-w-0 flex-1">{describeRun(summary.run)}</span>
              <Button size="xs" variant="ghost" onClick={() => summary.stop()}>
                <Square />
                Stop
              </Button>
            </div>
          )}
          {summary.slow && !writing && (
            <p className="text-xs text-muted-foreground">
              A long meeting goes in parts, a call each within the model&apos;s limits. Gemini takes a whole meeting at
              once: it can be chosen in Settings.
            </p>
          )}
          {summary.error && <p className="pt-1 text-sm text-destructive">{summary.error}</p>}
          {(writing || (!summary.run && summary.saved)) && (
            <ShortSummaryPanel text={summary.run?.text || summary.saved?.text || ''} saved={summary.saved} writing={writing} />
          )}
        </DialogHeader>
        <div className="flex-1 overflow-y-auto p-4">
          {error && <p className="text-sm text-destructive">{error}</p>}
          {meeting === undefined && !error && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading the meeting…
            </p>
          )}
          {meeting === null && <p className="text-sm text-muted-foreground">This meeting is no longer in the knowledge base.</p>}
          {meeting && (
            <>
              {meeting.summary && (
                <Section title="Stenograma's summary, made by AI" highlighted={source?.documentKind === 'meeting-summary'}>
                  <MarkdownText text={meeting.summary} />
                </Section>
              )}
              {meeting.actionItems.length > 0 && (
                <Section title="Action items, made by AI" highlighted={source?.documentKind === 'meeting-actions'}>
                  <ul className="space-y-1 text-sm">
                    {meeting.actionItems.map((item, index) => (
                      <li key={index} className={cn(item.done && 'text-muted-foreground line-through')}>
                        {item.what}
                        {item.who && ` (${item.who})`}
                        {item.due && `, due ${item.due}`}
                      </li>
                    ))}
                  </ul>
                </Section>
              )}
              <div className="space-y-0.5">
                {meeting.messages.map((message, index) => {
                  const cited = range !== null && index >= range.first && index <= range.last;

                  return (
                    <div
                      key={index}
                      ref={range?.first === index ? scrollToCited : undefined}
                      className={cn('flex gap-3 rounded px-2 py-1 text-sm', cited && 'bg-primary/10')}
                    >
                      <span className="w-14 shrink-0 pt-0.5 text-right text-xs text-muted-foreground tabular-nums">
                        {message.startMs !== null && formatOffset(message.startMs)}
                      </span>
                      <div className="min-w-0">
                        <span className="font-medium">{message.user}</span>
                        {message.source === 'chat' && <Badge variant="secondary" className="ml-2">chat</Badge>}
                        <p className="whitespace-pre-wrap break-words">{message.text}</p>
                      </div>
                    </div>
                  );
                })}
                {!meeting.messages.length && <p className="text-sm text-muted-foreground">No text in this meeting.</p>}
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default MeetingDialog;
