import { useState } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { cn } from 'cn';
import type { BrowserKind, SourceInfo } from '../../../../core/protocol';
import PairingSteps from '@/components/PairingSteps';
import { BrowserIcon, BROWSERS, SourceIcon } from '@/components/SourceIcon';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { sourceName } from '@/lib/format';
import { errorMessage } from '@/lib/kb';

// "Add a browser" (F7, step 6 of the plan's Sending): which browser, for its icon, and its name; then a source of its own
// with a token, shown once, the steps to give it to the extension, and the browser's first push as it arrives. As kb
// add-browser, it offers to remove the imported backup, whose meetings the browser will send again. "Rename" changes the
// name and the browser later

const labelOf = (browser: BrowserKind) => BROWSERS.find((entry) => entry.browser === browser)!.label;

// "Firefox 2" when a Firefox is there already
const freeName = (name: string, taken: string[]) => {
  let n = 2;

  if (!taken.includes(name)) {
    return name;
  }

  while (taken.includes(`${name} ${n}`)) {
    n += 1;
  }

  return `${name} ${n}`;
};

interface BrowserFieldsProps {
  browser: BrowserKind;
  name: string;
  onChange: (browser: BrowserKind, name: string) => void;
  // Names taken by the other browsers
  taken: string[];
}

const BrowserFields = ({ browser, name, onChange, taken }: BrowserFieldsProps) => {
  // The name follows the browser chosen until it's typed
  const [typed, setTyped] = useState(false);

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label>Browser</Label>
        <div className="grid grid-cols-3 gap-2">
          {BROWSERS.map((entry) => (
            <button
              key={entry.browser}
              type="button"
              aria-pressed={entry.browser === browser}
              onClick={() => onChange(entry.browser, typed ? name : freeName(entry.label === 'Another' ? 'Browser' : entry.label, taken))}
              className={cn(
                'flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
                entry.browser === browser ? 'border-ring bg-accent' : 'hover:bg-accent/40',
              )}
            >
              <BrowserIcon browser={entry.browser} />
              {entry.label}
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="browser-label">Name</Label>
        <Input
          id="browser-label"
          value={name}
          maxLength={100}
          onChange={(event) => {
            setTyped(true);
            onChange(browser, event.target.value);
          }}
        />
        {taken.includes(name.trim()) && <p className="text-xs text-warning">Another browser is called so: a name of its own tells them apart.</p>}
      </div>
    </div>
  );
};

interface AddBrowserDialogProps {
  open: boolean;
  onClose: () => void;
  // Back to "Add a source"
  onBack?: () => void;
  backup?: SourceInfo;
  // The browsers there already
  browsers: SourceInfo[];
}

const AddBrowserDialog = ({ open, onClose, onBack, backup, browsers }: AddBrowserDialogProps) => {
  const taken = browsers.map(sourceName);
  const [browser, setBrowser] = useState<BrowserKind>('chrome');
  const [name, setName] = useState(() => freeName('Chrome', taken));
  const [added, setAdded] = useState<{ sourceId: number, token: string, since: number } | null>(null);
  const [backupRemoved, setBackupRemoved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  const shownName = name.trim() || 'Browser';

  // Chrome again each time it opens, named after the browsers there now
  if (open !== wasOpen) {
    setWasOpen(open);

    if (open) {
      setBrowser('chrome');
      setName(freeName('Chrome', taken));
    }
  }

  const close = () => {
    setAdded(null);
    setBackupRemoved(false);
    setError(null);
    onClose();
  };

  const add = async () => {
    setBusy(true);
    setError(null);

    try {
      const since = Date.now();
      setAdded({ ...await window.kb.invoke('addBrowser', { label: shownName, browser }), since });
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
      <DialogContent className="sm:max-w-xl">
        <DialogHeader className="flex-row items-center gap-3 space-y-0">
          <SourceIcon source={{ kind: 'stenograma-browser', browser }} />
          <div className="space-y-1">
            <DialogTitle>{added ? `Connect ${shownName}` : 'Add a browser'}</DialogTitle>
            <DialogDescription>
              {added
                ? 'Give its token to Stenograma in that browser.'
                : 'Each browser with Stenograma gets its own token, and its meetings are kept apart: deleting one in Chrome never removes Firefox\'s.'}
            </DialogDescription>
          </div>
        </DialogHeader>
        {added ? (
          <div className="space-y-4">
            <PairingSteps sourceId={added.sourceId} name={shownName} token={added.token} since={added.since} />
            {backup && !backupRemoved && (
              <div className="space-y-2 rounded-lg border p-3">
                <p className="text-sm">
                  Remove the imported backup ({backup.meetings} meetings)? Once this browser sends its meetings, each
                  would be found twice.
                </p>
                <Button size="sm" variant="secondary" onClick={removeBackup} disabled={busy}>Remove the backup</Button>
              </div>
            )}
            {backupRemoved && <p className="text-sm text-muted-foreground">The imported backup is removed.</p>}
          </div>
        ) : (
          <BrowserFields
            browser={browser}
            name={name}
            taken={taken}
            onChange={(nextBrowser, nextName) => {
              setBrowser(nextBrowser);
              setName(nextName);
            }}
          />
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          {added ? (
            <Button onClick={close}>Done</Button>
          ) : (
            <>
              {onBack && (
                <Button variant="ghost" className="sm:mr-auto" onClick={onBack}>
                  <ArrowLeft />
                  Back
                </Button>
              )}
              <Button variant="ghost" onClick={close}>Cancel</Button>
              <Button onClick={add} disabled={busy}>
                {busy && <Loader2 className="animate-spin" />}
                Add
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// A browser's name and browser, as it was added
export const EditBrowserDialog = ({ source, browsers, onClose }: { source: SourceInfo | null, browsers: SourceInfo[], onClose: () => void }) => {
  const [browser, setBrowser] = useState<BrowserKind>('chrome');
  const [name, setName] = useState('');
  const [shown, setShown] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The source's own values, each time another one opens
  if (source && shown !== source.id) {
    setShown(source.id);
    setBrowser(source.browser ?? 'other');
    setName(sourceName(source));
    setError(null);
  }

  const save = async () => {
    if (source) {
      setBusy(true);
      setError(null);

      try {
        await window.kb.invoke('updateBrowser', { sourceId: source.id, label: name.trim() || labelOf(browser), browser });
        setShown(null);
        onClose();
      } catch (reason) {
        setError(errorMessage(reason));
      } finally {
        setBusy(false);
      }
    }
  };

  return (
    <Dialog
      open={Boolean(source)}
      onOpenChange={(next) => {
        if (!next) {
          setShown(null);
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader className="flex-row items-center gap-3 space-y-0">
          <SourceIcon source={{ kind: 'stenograma-browser', browser }} />
          <div className="space-y-1">
            <DialogTitle>Rename {source && sourceName(source)}</DialogTitle>
            <DialogDescription>Its token and meetings stay as they are.</DialogDescription>
          </div>
        </DialogHeader>
        {source && (
          <BrowserFields
            key={source.id}
            browser={browser}
            name={name}
            taken={browsers.filter((other) => other.id !== source.id).map(sourceName)}
            onChange={(nextBrowser, nextName) => {
              setBrowser(nextBrowser);
              setName(nextName);
            }}
          />
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              setShown(null);
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default AddBrowserDialog;
