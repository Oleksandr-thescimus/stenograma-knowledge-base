import { useEffect, useMemo, useState } from 'react';
import { Loader2, Search, Sparkles } from 'lucide-react';
import type { CitedSource, SourceInfo, SourceMeeting } from '../../../../core/protocol';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import MeetingDialog from '@/components/MeetingDialog';
import { formatDay, formatTime, sourceName } from '@/lib/format';
import { errorMessage } from '@/lib/kb';

// A browser's or a backup's meetings (Sources → ⋯ → Meetings…), the newest first, to see what the knowledge base has
// and open one in the meeting view, as a citation opens it

const PAGE = 100;

// The meeting view takes a cited source: this one cites no chunk, so it opens at the top. It's opened from the copy
// that's indexed, whose document a short summary is kept with
const asSource = (meeting: SourceMeeting): CitedSource => ({
  n: 0,
  chunkId: 0,
  documentId: '',
  sourceId: meeting.indexedIn,
  sourceKind: 'stenograma',
  documentKind: 'meeting-list',
  threadId: meeting.sessionId,
  title: meeting.title,
  createdAt: meeting.createdAt,
  startMs: null,
  madeByAi: false,
  text: '',
});

interface SourceMeetingsDialogProps {
  source: SourceInfo | null;
  nameOf: (sourceId: number) => string;
  onClose: () => void;
}

const SourceMeetingsDialog = ({ source, nameOf, onClose }: SourceMeetingsDialogProps) => {
  const [meetings, setMeetings] = useState<SourceMeeting[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [opened, setOpened] = useState<CitedSource | null>(null);
  const sourceId = source?.id ?? null;

  // Again after a push, which may bring new meetings
  useEffect(() => {
    if (sourceId === null) {
      setMeetings(null);
      setQuery('');
      setLimit(PAGE);

      return undefined;
    }

    let alive = true;
    setError(null);
    window.kb.invoke('sourceMeetings', { sourceId })
      .then((list) => alive && setMeetings(list))
      .catch((reason: unknown) => alive && setError(errorMessage(reason)));

    return () => {
      alive = false;
    };
  }, [sourceId, source?.lastSyncAt]);

  const found = useMemo(() => {
    const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);

    return (meetings ?? []).filter((meeting) => {
      const text = `${meeting.title} ${meeting.series ?? ''} ${formatDay(meeting.createdAt)}`.toLocaleLowerCase();

      return words.every((word) => text.includes(word));
    });
  }, [meetings, query]);

  return (
    <>
      <Dialog open={Boolean(source)} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="flex h-[85vh] max-w-3xl flex-col gap-0 p-0 sm:max-w-3xl xl:max-w-5xl">
          <DialogHeader className="border-b p-4 pr-12">
            <DialogTitle>Meetings of {source && sourceName(source)}</DialogTitle>
            <DialogDescription>
              {meetings ? `${meetings.length.toLocaleString()} meetings, the newest first` : 'Loading…'}
            </DialogDescription>
            <div className="relative mt-2">
              <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-8"
                placeholder="Title, series or date (2026-11)"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setLimit(PAGE);
                }}
              />
            </div>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto p-2">
            {error && <p className="p-2 text-sm text-destructive">{error}</p>}
            {!meetings && !error && <Loader2 className="m-4 size-4 animate-spin text-muted-foreground" />}
            {meetings && !found.length && <p className="p-2 text-sm text-muted-foreground">No meeting matches.</p>}
            <ul>
              {found.slice(0, limit).map((meeting) => (
                <li key={meeting.sessionId}>
                  <button
                    type="button"
                    onClick={() => setOpened(asSource(meeting))}
                    className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                  >
                    <span className="w-32 shrink-0 text-muted-foreground tabular-nums">
                      {formatDay(meeting.createdAt)} {formatTime(meeting.createdAt)}
                    </span>
                    {/* A series's name is in its meetings' titles */}
                    <span className="min-w-0 flex-1 truncate">{meeting.title}</span>
                    {meeting.indexedIn !== sourceId && (
                      <span className="shrink-0 text-xs text-muted-foreground">from {nameOf(meeting.indexedIn)}&apos;s copy</span>
                    )}
                    {meeting.summarized ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Sparkles className="size-3.5 shrink-0 text-muted-foreground" aria-label="Has a short summary" />
                        </TooltipTrigger>
                        <TooltipContent>Has a short summary</TooltipContent>
                      </Tooltip>
                    ) : <span className="size-3.5 shrink-0" />}
                  </button>
                </li>
              ))}
            </ul>
            {found.length > limit && (
              <Button variant="ghost" size="sm" className="m-2" onClick={() => setLimit(limit + PAGE)}>
                Show {Math.min(PAGE, found.length - limit)} more of {(found.length - limit).toLocaleString()}
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
      <MeetingDialog source={opened} onClose={() => setOpened(null)} />
    </>
  );
};

export default SourceMeetingsDialog;
