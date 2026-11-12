import { useState } from 'react';
import type { SourceInfo } from '../../../../core/protocol';
import TokenField from '@/components/TokenField';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { sourceName } from '@/lib/format';
import { errorMessage } from '@/lib/kb';

// "New token" of a paired browser whose token is lost (a reinstalled extension, a dialog closed too soon): the old one
// stops working, and the browser continues the same source with its meetings

interface NewTokenDialogProps {
  source: SourceInfo | null;
  onClose: () => void;
}

const NewTokenDialog = ({ source, onClose }: NewTokenDialogProps) => {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setToken(null);
    setError(null);
    onClose();
  };

  const renew = async () => {
    if (source) {
      setBusy(true);
      setError(null);

      try {
        setToken((await window.kb.invoke('renewBrowserToken', { sourceId: source.id })).token);
      } catch (reason) {
        setError(errorMessage(reason));
      } finally {
        setBusy(false);
      }
    }
  };

  return (
    <Dialog open={Boolean(source)} onOpenChange={(next) => !next && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New token for {source && sourceName(source)}</DialogTitle>
          <DialogDescription>
            The current token stops working, so a browser still using it can&apos;t send until it gets the new one. Its
            meetings stay: the browser continues the same source.
          </DialogDescription>
        </DialogHeader>
        {token && source && <TokenField label={sourceName(source)} token={token} />}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          {token ? (
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
