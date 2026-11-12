import { useState } from 'react';
import type { SourceInfo } from '../../../../core/protocol';
import TokenField from '@/components/TokenField';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { errorMessage } from '@/lib/kb';

// "Add a browser" (F7, step 6 of the plan's Sending): a source of its own with a token, shown once, to paste into the
// extension's popup. As kb add-browser, it offers to remove the imported backup, whose meetings the browser will send
// again

interface AddBrowserDialogProps {
  open: boolean;
  onClose: () => void;
  backup?: SourceInfo;
}

const AddBrowserDialog = ({ open, onClose, backup }: AddBrowserDialogProps) => {
  const [label, setLabel] = useState('Chrome');
  const [token, setToken] = useState<string | null>(null);
  const [backupRemoved, setBackupRemoved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setToken(null);
    setBackupRemoved(false);
    setError(null);
    onClose();
  };

  const add = async () => {
    setBusy(true);
    setError(null);

    try {
      setToken((await window.kb.invoke('addBrowser', { label: label.trim() || 'Browser' })).token);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const removeBackup = async () => {
    if (backup) {
      setBusy(true);

      try {
        await window.kb.invoke('removeSource', { sourceId: backup.id });
        setBackupRemoved(true);
      } catch (reason) {
        setError(errorMessage(reason));
      } finally {
        setBusy(false);
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a browser</DialogTitle>
          <DialogDescription>
            Each browser with Stenograma gets its own token. Its meetings are kept apart: deleting one in Chrome never
            removes Firefox&apos;s.
          </DialogDescription>
        </DialogHeader>
        {token ? (
          <div className="space-y-4">
            <TokenField label={label.trim() || 'Browser'} token={token} />
            {backup && !backupRemoved && (
              <div className="space-y-2 rounded-lg border p-3">
                <p className="text-sm">
                  Remove the imported backup ({backup.documents} documents)? Once this browser sends its meetings, each
                  would be found twice.
                </p>
                <Button size="sm" variant="secondary" onClick={removeBackup} disabled={busy}>Remove the backup</Button>
              </div>
            )}
            {backupRemoved && <p className="text-sm text-muted-foreground">The imported backup is removed.</p>}
          </div>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="browser-label">Name</Label>
            <Input id="browser-label" value={label} onChange={(event) => setLabel(event.target.value)} maxLength={100} />
            <div className="flex gap-2">
              {['Chrome', 'Firefox'].map((name) => (
                <Button key={name} size="xs" variant="ghost" onClick={() => setLabel(name)}>{name}</Button>
              ))}
            </div>
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          {token ? (
            <Button onClick={close}>Done</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={close}>Cancel</Button>
              <Button onClick={add} disabled={busy}>Add</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default AddBrowserDialog;
