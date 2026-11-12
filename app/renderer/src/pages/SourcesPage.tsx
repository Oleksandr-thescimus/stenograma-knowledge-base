import { useState } from 'react';
import { Archive, Globe, KeyRound, Plus, Trash2 } from 'lucide-react';
import type { SourceInfo } from '../../../../core/protocol';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import AddBrowserDialog from '@/components/AddBrowserDialog';
import NewTokenDialog from '@/components/NewTokenDialog';
import { formatWhen, sourceName } from '@/lib/format';
import { errorMessage, useAppStatus } from '@/lib/kb';

// The sources with their status (F4, F7), the cloud policy of each (F8), and the queue and API they share

const describeSync = (source: SourceInfo) => {
  if (!source.lastSyncAt) {
    return source.kind === 'stenograma-browser' ? 'Nothing sent yet' : 'Never synced';
  }

  return `${source.kind === 'stenograma-browser' ? 'Last push' : 'Imported'} ${formatWhen(source.lastSyncAt)}`;
};

interface SourceCardProps {
  source: SourceInfo;
  onRenewToken: (source: SourceInfo) => void;
  onRemove: (source: SourceInfo) => void;
}

const SourceCard = ({ source, onRenewToken, onRemove }: SourceCardProps) => {
  const [error, setError] = useState<string | null>(null);
  const Icon = source.kind === 'stenograma-browser' ? Globe : Archive;

  const setCloud = (allowed: boolean) => window.kb.invoke('setCloudAllowed', { sourceId: source.id, allowed })
    .catch((reason: unknown) => setError(errorMessage(reason)));

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 size-5 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h3 className="font-medium">{sourceName(source)}</h3>
            <span className="text-xs text-muted-foreground">
              {source.kind === 'stenograma-browser' ? 'Stenograma in a browser' : source.account}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            {source.documents} documents · {source.chunks} chunks · {describeSync(source)}
          </p>
          {source.indexedElsewhere > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              {source.indexedElsewhere} of its meetings came from another browser too, and are found through that copy.
            </p>
          )}
          {source.kind === 'stenograma-browser' && (
            <p className="mt-1 text-xs text-muted-foreground">
              The extension sends changes every 5 minutes; its popup has &quot;Sync now&quot;.
            </p>
          )}
          {source.lastError && <p className="mt-1 text-sm text-destructive">{source.lastError}</p>}
          {error && <p className="mt-1 text-sm text-destructive">{error}</p>}
          <label className="mt-3 flex items-center gap-2 text-sm">
            <Switch checked={source.cloudAllowed} onCheckedChange={setCloud} />
            May go to cloud AI
          </label>
          <p className="mt-1 text-xs text-muted-foreground">
            {source.cloudAllowed
              ? 'Its content may go to Groq or Gemini when they answer, and to Gemini\'s embeddings.'
              : 'Only Ollama on this computer sees it; with a cloud model it\'s left out of answers.'}
          </p>
        </div>
        {source.kind === 'stenograma-browser' && (
          <Button variant="ghost" size="sm" onClick={() => onRenewToken(source)}>
            <KeyRound />
            New token
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" onClick={() => onRemove(source)} aria-label={`Remove ${sourceName(source)}`}>
          <Trash2 />
        </Button>
      </div>
    </div>
  );
};

const SourcesPage = () => {
  const status = useAppStatus();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<SourceInfo | null>(null);
  const [renewing, setRenewing] = useState<SourceInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const core = status?.core;
  const sources = core?.sources ?? [];
  const running = status?.process.state === 'running';

  const remove = async () => {
    if (removing) {
      try {
        await window.kb.invoke('removeSource', { sourceId: removing.id });
      } catch (reason) {
        setError(errorMessage(reason));
      }

      setRemoving(null);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-xl">Sources</h2>
          <Button onClick={() => setAdding(true)} disabled={!running}>
            <Plus />
            Add a browser
          </Button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="space-y-3">
          {sources.map((source) => <SourceCard key={source.id} source={source} onRenewToken={setRenewing} onRemove={setRemoving} />)}
          {core && !sources.length && (
            <p className="text-sm text-muted-foreground">
              No sources yet. Add a browser and paste its token into Stenograma&apos;s popup, and its meetings arrive within
              5 minutes.
            </p>
          )}
        </div>
        {core && (
          <div className="space-y-2 rounded-lg border p-4 text-sm">
            <h3 className="font-medium">The index</h3>
            <p className="text-muted-foreground">
              Embeddings: {core.embedding.model}
              {core.embedding.pending > 0 ? ` · ${core.embedding.pending} chunks waiting` : ' · up to date'}
              {core.embedding.running && ' · working'}
            </p>
            {core.embedding.rebuild && (
              <p className="text-muted-foreground">
                Building {core.embedding.rebuild.model} in the background: {core.embedding.rebuild.total - core.embedding.rebuild.pending}
                {' of '}
                {core.embedding.rebuild.total} chunks. The search switches to it when it&apos;s done.
              </p>
            )}
            {core.embedding.error && (
              <p className="text-destructive">
                {core.embedding.error}. It&apos;s tried again in a minute; meanwhile new chunks are found by their words only.
              </p>
            )}
            <p className="text-muted-foreground">
              {core.server.listening
                ? `The extension sends to http://127.0.0.1:${core.server.port}`
                : `The extension can't send: ${core.server.error}`}
            </p>
            <p className="text-muted-foreground">Data: {core.dataDir}</p>
          </div>
        )}
      </div>
      <AddBrowserDialog open={adding} onClose={() => setAdding(false)} backup={sources.find((source) => source.kind === 'stenograma-backup')} />
      <NewTokenDialog source={renewing} onClose={() => setRenewing(null)} />
      <AlertDialog open={Boolean(removing)} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing && sourceName(removing)}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its {removing?.documents} documents go from the knowledge base. Chats keep their answers, with its
              citations shown as removed.
              {removing?.kind === 'stenograma-browser'
                && ' Meetings another browser sent too stay, found through its copy. Its token stops working: to send again, the browser needs to be added again.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={remove}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default SourcesPage;
