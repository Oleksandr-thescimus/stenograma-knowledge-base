import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { cn } from 'cn';
import type { CitedSource, MeetingView } from '../../../../core/protocol';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import MarkdownText from '@/components/MarkdownText';
import { formatDay, formatOffset } from '@/lib/format';
import { errorMessage } from '@/lib/kb';
import { citedRange } from '@/lib/meeting';

// A cited meeting from the knowledge base's own copy, scrolled to the cited moment (docs/PLAN.md, The app: meetings in
// answers). "Open in Stenograma" opens it in the extension of the browser it came from

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
      <DialogContent className="flex h-[85vh] max-w-3xl flex-col gap-0 p-0 sm:max-w-3xl">
        <DialogHeader className="border-b p-4 pr-12">
          <DialogTitle>{meeting?.title ?? source?.title}</DialogTitle>
          <DialogDescription>
            {[
              formatDay(meeting?.createdAt ?? source?.createdAt ?? 0),
              meeting && (meeting.origin === 'recording' ? 'Recording' : 'Meet call'),
              meeting?.participants.length && meeting.participants.join(', '),
            ].filter(Boolean).join(' · ')}
          </DialogDescription>
          {meeting?.canOpenInStenograma && (
            <div className="pt-2">
              <Button size="sm" variant="outline" onClick={openInStenograma}>
                <ExternalLink />
                Open in Stenograma
              </Button>
            </div>
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
                <Section title="Summary, made by AI" highlighted={source?.documentKind === 'meeting-summary'}>
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
