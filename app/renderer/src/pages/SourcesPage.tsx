import { useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import type { CoreStatus, SourceInfo } from '../../../../core/protocol';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import AddBrowserDialog, { EditBrowserDialog } from '@/components/AddBrowserDialog';
import AddSourceDialog, { SourceKinds, type NewSourceKind } from '@/components/AddSourceDialog';
import ImagePause from '@/components/ImagePause';
import MeetingSeriesCard from '@/components/MeetingSeriesCard';
import NewTokenDialog from '@/components/NewTokenDialog';
import RocketChatDialog, { RocketChatTokenDialog } from '@/components/RocketChatDialog';
import SourceCard, { type SourceAction } from '@/components/SourceCard';
import SourceMeetingsDialog from '@/components/SourceMeetingsDialog';
import SummaryProgress from '@/components/SummaryProgress';
import type { SourcesTab } from '@/lib/status';
import { sourceName } from '@/lib/format';
import { errorMessage, useAppStatus } from '@/lib/kb';

// The sources (F4, F7, F8), added through "Add a source"; the meeting series; and the index with the background work the
// sources make. Each a tab, which the app keeps (the sidebar's status line opens one)

const IndexTab = ({ core }: { core: CoreStatus }) => (
  <div className="space-y-2 rounded-lg border bg-card p-4 text-sm">
    <p className="text-muted-foreground">
      Embeddings: {core.embedding.model}
      {core.embedding.pending > 0 ? ` · ${core.embedding.pending.toLocaleString()} chunks waiting` : ' · up to date'}
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
      Images and files in chats: {core.attachments.done.toLocaleString()} read, {core.attachments.pending.toLocaleString()} waiting
      {core.attachments.failed ? `, ${core.attachments.failed.toLocaleString()} not read` : ''}
      {core.attachments.running && ' · reading'}
    </p>
    {core.attachments.error && <p className="text-destructive">Images and files: {core.attachments.error}</p>}
    <SummaryProgress status={core.summaries} />
    <ImagePause status={core.attachments} />
    <p className="text-muted-foreground">
      {core.server.listening
        ? `The extension sends to http://127.0.0.1:${core.server.port}`
        : `The extension can't send: ${core.server.error}`}
    </p>
    <p className="text-muted-foreground">Data: {core.dataDir}</p>
  </div>
);

// The index tab's mark: an error, or work going on
const indexMark = (core: CoreStatus) => {
  if (core.embedding.error || core.attachments.error || !core.server.listening) {
    return <span className="size-2 rounded-full bg-destructive" aria-label="An error" />;
  }

  return core.embedding.running || core.attachments.running || core.summaries.running || core.embedding.rebuild
    ? <Loader2 className="size-3.5 animate-spin" aria-label="Working" />
    : null;
};

const SourcesPage = ({ tab, onTab }: { tab: SourcesTab, onTab: (tab: SourcesTab) => void }) => {
  const status = useAppStatus();
  const [adding, setAdding] = useState<'choose' | NewSourceKind | null>(null);
  const [acting, setActing] = useState<{ action: SourceAction, source: SourceInfo } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const core = status?.core;
  const sources = core?.sources ?? [];
  const running = status?.process.state === 'running';
  const hasMeetings = sources.some((source) => source.kind.startsWith('stenograma'));
  const browsers = sources.filter((source) => source.kind === 'stenograma-browser');
  // The source acted on as it is now, its status changing meanwhile
  const target = (action: SourceAction) => (acting?.action === action ? sources.find((source) => source.id === acting.source.id) ?? null : null);
  const removing = target('remove');
  const shown = tab === 'series' && !hasMeetings ? 'sources' : tab;

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
      <div className="mx-auto max-w-3xl p-6">
        <Tabs value={shown} onValueChange={(next) => onTab(next as SourcesTab)} className="gap-4">
          <div className="flex items-center gap-3">
            <TabsList>
              <TabsTrigger value="sources">
                Sources
                {sources.length > 0 && <span className="text-xs text-muted-foreground">{sources.length}</span>}
              </TabsTrigger>
              {hasMeetings && <TabsTrigger value="series">Meeting series</TabsTrigger>}
              <TabsTrigger value="index">
                Index
                {core && indexMark(core)}
              </TabsTrigger>
            </TabsList>
            <Button className="ml-auto" onClick={() => setAdding('choose')} disabled={!running}>
              <Plus />
              Add a source
            </Button>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <TabsContent value="sources" className="space-y-3">
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
          </TabsContent>
          {hasMeetings && (
            <TabsContent value="series">
              {core && <MeetingSeriesCard summaries={core.summaries} />}
            </TabsContent>
          )}
          <TabsContent value="index">
            {core && <IndexTab core={core} />}
          </TabsContent>
        </Tabs>
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
