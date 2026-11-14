import { useEffect, useState } from 'react';
import { ImageOff, Loader2 } from 'lucide-react';
import { cn } from 'cn';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { errorMessage } from '@/lib/kb';

// A chat image from the knowledge base's copy (fetched from the messenger the first time), as a data: URL: the CSP
// allows no image from elsewhere. Clicking it shows it whole

interface ChatImageProps {
  sourceId: number;
  fileId: string;
  name: string;
  className?: string;
  // Instead of showing it whole
  onClick?: () => void;
}

const ChatImage = ({ sourceId, fileId, name, className, onClick }: ChatImageProps) => {
  // undefined while it loads, null when it can't be had
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [whole, setWhole] = useState(false);

  useEffect(() => {
    let alive = true;
    setUrl(undefined);
    window.kb.invoke('attachmentImage', { sourceId, fileId })
      .then((loaded) => alive && setUrl(loaded))
      .catch((reason: unknown) => {
        if (alive) {
          setUrl(null);
          setError(errorMessage(reason));
        }
      });

    return () => {
      alive = false;
    };
  }, [sourceId, fileId]);

  if (url === undefined) {
    return (
      <div className={cn('flex items-center justify-center rounded-md bg-muted text-muted-foreground', className)}>
        <Loader2 className="size-4 animate-spin" />
      </div>
    );
  }

  if (url === null) {
    return (
      <div className={cn('flex items-center justify-center gap-1 rounded-md bg-muted p-2 text-xs text-muted-foreground', className)} title={error ?? undefined}>
        <ImageOff className="size-4 shrink-0" />
        <span className="truncate">{name}</span>
      </div>
    );
  }

  return (
    <>
      <button type="button" onClick={onClick ?? (() => setWhole(true))} className={cn('overflow-hidden rounded-md bg-muted', className)} title={name}>
        <img src={url} alt={name} className="size-full object-contain" />
      </button>
      {!onClick && (
        <Dialog open={whole} onOpenChange={setWhole}>
          <DialogContent className="max-w-[90vw] p-2 sm:max-w-[90vw]">
            <DialogTitle className="sr-only">{name}</DialogTitle>
            <img src={url} alt={name} className="max-h-[85vh] w-full object-contain" />
          </DialogContent>
        </Dialog>
      )}
    </>
  );
};

export default ChatImage;
