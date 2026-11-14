import { useState } from 'react';
import type { SourceInfo } from '../../../../core/protocol';
import PairingSteps from '@/components/PairingSteps';
import { SourceIcon } from '@/components/SourceIcon';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { sourceName } from '@/lib/format';
import { errorMessage } from '@/lib/kb';

// "New token" of a paired browser whose token is lost (a reinstalled extension, a dialog closed too soon): the old one
// stops working, and the browser continues the same source with its meetings, as its next push shows

interface NewTokenDialogProps {
  source: SourceInfo | null;
  onClose: () => void;
}

const NewTokenDialog = ({ source, onClose }: NewTokenDialogProps) => {
  const [renewed, setRenewed] = useState<{ token: string, since: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setRenewed(null);
    setError(null);
    onClose();
  };

  const renew = async () => {
    if (source) {
      setBusy(true);
      setError(null);

      try {
        const since = Date.now();
        setRenewed({ token: (await window.kb.invoke('renewBrowserToken', { sourceId: source.id })).token, since });
      } catch (reason) {
        setError(errorMessage(reason));
      } finally {
        setBusy(false);
      }
    }
  };

  return (
    <Dialog open={Boolean(source)} onOpenChange={(next) => !next && close()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader className="flex-row items-center gap-3 space-y-0">
          {source && <SourceIcon source={source} />}
          <div className="space-y-1">
            <DialogTitle>New token for {source && sourceName(source)}</DialogTitle>
            <DialogDescription>
              {renewed
                ? 'The old token works no more: give this one to Stenograma in that browser.'
                : 'The current token stops working, so a browser still using it can\'t send until it gets the new one. Its meetings stay: the browser continues the same source.'}
            </DialogDescription>
          </div>
        </DialogHeader>
        {renewed && source && <PairingSteps sourceId={source.id} name={sourceName(source)} token={renewed.token} since={renewed.since} again />}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          {renewed ? (
            <Button onClick={close}>Done</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={close}>Cancel</Button>
              <Button onClick={renew} disabled={busy}>Make a new token</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default NewTokenDialog;
