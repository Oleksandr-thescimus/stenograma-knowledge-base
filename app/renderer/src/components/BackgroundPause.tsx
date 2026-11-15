import { useState, type ReactNode } from 'react';
import { ChevronDown, Pause, Play } from 'lucide-react';
import type { AttachmentStatus } from '../../../../core/protocol';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { formatWhen } from '@/lib/format';
import { errorMessage } from '@/lib/kb';

// Pausing the background AI work (reading images, summarizing meetings, writing reply drafts), which takes the GPU,
// while working on something else: one button, then for how long. A pause goes on until then or until resumed, and its
// time can be changed meanwhile. Documents are still read, as they need no model, and drafts asked for by hand are still
// written

// Minutes; null until resumed
const PERIODS: { label: string, minutes: number | null }[] = [
  { label: 'For 1 hour', minutes: 60 },
  { label: 'For 4 hours', minutes: 240 },
  { label: 'Until resumed', minutes: null },
];

const BackgroundPause = ({ status }: { status: AttachmentStatus }) => {
  const [error, setError] = useState<string | null>(null);
  const call = (run: () => Promise<unknown>) => run().then(() => setError(null), (reason: unknown) => setError(errorMessage(reason)));
  const pause = (minutes: number | null) => call(() => window.kb.invoke('pauseBackground', { minutes }));

  const menu = (trigger: ReactNode) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Pause</DropdownMenuLabel>
        {PERIODS.map(({ label, minutes }) => <DropdownMenuItem key={label} onSelect={() => pause(minutes)}>{label}</DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
      {status.paused ? (
        <>
          <Pause className="size-4" />
          <span className="flex-1">
            The background AI work (images, summaries, reply drafts) is paused {status.paused.until ? `until ${formatWhen(status.paused.until)}` : 'until resumed'}
          </span>
          <Button size="sm" onClick={() => call(() => window.kb.invoke('resumeBackground', {}))}>
            <Play />
            Resume
          </Button>
          {menu(
            <Button size="sm" variant="outline">
              Change
              <ChevronDown />
            </Button>,
          )}
        </>
      ) : (
        <>
          <span className="flex-1">The background AI work (images, summaries, reply drafts) runs.</span>
          {menu(
            <Button size="sm" variant="outline">
              <Pause />
              Pause
              <ChevronDown />
            </Button>,
          )}
        </>
      )}
      {error && <span className="w-full text-destructive">{error}</span>}
    </div>
  );
};

export default BackgroundPause;
