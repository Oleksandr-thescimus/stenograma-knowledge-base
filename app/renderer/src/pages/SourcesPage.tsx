import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { SourceInfo } from '../../../../core/protocol';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import AddBrowserDialog, { EditBrowserDialog } from '@/components/AddBrowserDialog';
import AddSourceDialog, { SourceKinds, type NewSourceKind } from '@/components/AddSourceDialog';
import NewTokenDialog from '@/components/NewTokenDialog';
import RocketChatDialog, { RocketChatTokenDialog } from '@/components/RocketChatDialog';
import SourceCard, { type SourceAction } from '@/components/SourceCard';
import SourceMeetingsDialog from '@/components/SourceMeetingsDialog';
import { sourceName } from '@/lib/format';
import { errorMessage, useAppStatus } from '@/lib/kb';

// The sources (F4, F7, F8), added through "Add a source". The background work they make is on the Activity page, and
// the meeting series in Settings → Meetings

const SourcesPage = () => {
  const status = useAppStatus();
  const [adding, setAdding] = useState<'choose' | NewSourceKind | null>(null);
  const [acting, setActing] = useState<{ action: SourceAction, source: SourceInfo } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const core = status?.core;
  const sources = core?.sources ?? [];
  const running = status?.process.state === 'running';
  const browsers = sources.filter((source) => source.kind === 'stenograma-browser');
  // The source acted on as it is now, its status changing meanwhile
  const target = (action: SourceAction) => (acting?.action === action ? sources.find((source) => source.id === acting.source.id) ?? null : null);
  const removing = target('remove');

  const remove = async () => {
    if (removing) {
      try {
        await window.kb.invoke('removeSource', { sourceId: removing.id });
      } catch (reason) {
        setError(errorMessage(reason));
      }

      setActing(null);
    }
  };

  const closeAction = () => setActing(null);
  const nameOf = (sourceId: number) => {
    const other = sources.find((source) => source.id === sourceId);

    return other ? sourceName(other) : 'another browser';
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl p-6 xl:max-w-6xl">
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <h2 className="text-xl">Sources</h2>
            <Button className="ml-auto" onClick={() => setAdding('choose')} disabled={!running}>
              <Plus />
              Add a source
            </Button>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="space-y-3">
            {sources.map((source) => <SourceCard key={source.id} source={source} nameOf={nameOf} onAction={(action) => setActing({ action, source })} />)}
            {core && !sources.length && (
              <div className="space-y-4 rounded-lg border border-dashed p-6">
                <div className="space-y-1">
                  <h3 className="font-medium">Add your first source</h3>
                  <p className="text-sm text-muted-foreground">Its meetings or messages are searched together, and answers cite them.</p>
                </div>
                <SourceKinds onPick={(kind) => running && setAdding(kind)} />
              </div>
            )}
          </div>
        </div>
      </div>
      <AddSourceDialog open={adding === 'choose'} onPick={setAdding} onClose={() => setAdding(null)} />
      <AddBrowserDialog
        open={adding === 'browser'}
        onClose={() => setAdding(null)}
        onBack={() => setAdding('choose')}
        backup={sources.find((source) => source.kind === 'stenograma-backup')}
        browsers={browsers}
      />
      <RocketChatDialog open={adding === 'rocketchat'} onClose={() => setAdding(null)} onBack={() => setAdding('choose')} />
      <RocketChatDialog open={Boolean(target('rooms'))} sourceId={target('rooms')?.id} onClose={closeAction} />
      <RocketChatTokenDialog sourceId={target('chat-token')?.id ?? null} onClose={closeAction} />
      <NewTokenDialog source={target('browser-token')} onClose={closeAction} />
      <EditBrowserDialog source={target('rename')} browsers={browsers} onClose={closeAction} />
      <SourceMeetingsDialog source={target('meetings')} nameOf={nameOf} onClose={closeAction} />
      <AlertDialog open={Boolean(removing)} onOpenChange={(open) => !open && closeAction()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing && sourceName(removing)}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its {removing?.documents} documents go from the knowledge base. Chats keep their answers, with its
              citations shown as removed.
              {removing?.kind === 'stenograma-browser'
                && ' Meetings another browser sent too stay, found through its copy. Its token stops working: to send again, the browser needs to be added again.'}
              {removing?.kind === 'rocketchat' && ' Its messages and its token in the keyring go too.'}
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
