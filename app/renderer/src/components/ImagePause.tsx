import { useState } from 'react';
import { Pause, Play } from 'lucide-react';
import type { AttachmentStatus } from '../../../../core/protocol';
import { Button } from '@/components/ui/button';
import { formatWhen } from '@/lib/format';
import { errorMessage } from '@/lib/kb';

// Pausing the background AI work (reading images, summarizing meetings), which takes the GPU, while working on
// something else: for an hour, four, or until resumed. Documents are still read: they need no model

const ImagePause = ({ status }: { status: AttachmentStatus }) => {
  const [error, setError] = useState<string | null>(null);
  const call = (run: () => Promise<unknown>) => run().catch((reason: unknown) => setError(errorMessage(reason)));

  if (status.paused) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <Pause className="size-4" />
        The background AI work (images, summaries) is paused {status.paused.until ? `until ${formatWhen(status.paused.until)}` : 'until resumed'}
        <Button size="xs" variant="outline" onClick={() => call(() => window.kb.invoke('resumeBackground', {}))}>
          <Play />
          Resume
        </Button>
        {error && <span className="text-destructive">{error}</span>}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
      Pause the background AI work (images, summaries):
      {[{ label: '1 hour', minutes: 60 }, { label: '4 hours', minutes: 240 }, { label: 'Until resumed', minutes: null }].map(({ label, minutes }) => (
        <Button key={label} size="xs" variant="outline" onClick={() => call(() => window.kb.invoke('pauseBackground', { minutes }))}>
          {label}
        </Button>
      ))}
      {error && <span className="text-destructive">{error}</span>}
    </div>
  );
};

export default ImagePause;
