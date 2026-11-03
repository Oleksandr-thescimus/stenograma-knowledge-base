import { useState } from 'react';
import { Database, MessageSquare, RotateCw, Settings as SettingsIcon } from 'lucide-react';
import { cn } from 'cn';
import type { AppStatus } from '../../../core/protocol';
import { Button } from '@/components/ui/button';
import ChatList from '@/components/ChatList';
import { useChats } from '@/lib/chats';
import { useAppStatus } from '@/lib/kb';
import { formatTime } from '@/lib/format';
import ChatPage from '@/pages/ChatPage';
import SettingsPage from '@/pages/SettingsPage';
import SourcesPage from '@/pages/SourcesPage';

// The app's window (docs/PLAN.md, M3): the chat with the saved chats in the sidebar, the sources and the settings. Pages
// stay mounted, so an answer goes on coming while another page is open

type Page = 'chat' | 'sources' | 'settings';

const PAGES: { id: Page, label: string, icon: typeof MessageSquare }[] = [
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'sources', label: 'Sources', icon: Database },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
];

// One line in the sidebar: whether the knowledge base runs, and what the index is doing
const describeStatus = (status: AppStatus | null): { tone: 'ok' | 'busy' | 'error', text: string } => {
  if (!status || status.process.state === 'starting') {
    return { tone: 'busy', text: 'Starting…' };
  }

  if (status.process.state !== 'running') {
    return { tone: 'error', text: 'Not running' };
  }

  const {core} = status;

  if (core?.embedding.rebuild) {
    return { tone: 'busy', text: `Building ${core.embedding.rebuild.model}` };
  }

  if (core?.embedding.pending) {
    return { tone: core.embedding.error ? 'error' : 'busy', text: `${core.embedding.pending} chunks to embed` };
  }

  if (core && !core.server.listening) {
    return { tone: 'error', text: 'The extension can\'t send' };
  }

  return { tone: 'ok', text: `${core?.sources.reduce((sum, source) => sum + source.chunks, 0) ?? 0} chunks` };
};

// When the core isn't running: why, and when it starts again
const ProcessBanner = ({ status }: { status: AppStatus }) => {
  const { process } = status;

  if (process.state === 'running' || process.state === 'starting') {
    return null;
  }

  return (
    <div className="flex items-center gap-3 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-sm">
      <p className="flex-1">
        The knowledge base isn&apos;t running{process.error && `: ${process.error}`}.
        {process.retryAt && ` It starts again at ${formatTime(process.retryAt)}.`}
      </p>
      {process.state === 'restarting' && (
        <Button size="sm" variant="outline" onClick={() => window.kb.invoke('restartCore', {})}>
          <RotateCw />
          Start now
        </Button>
      )}
    </div>
  );
};

const App = () => {
  const status = useAppStatus();
  const [page, setPage] = useState<Page>('chat');
  const summary = describeStatus(status);
  const chats = useChats(status?.process.state === 'running');

  // While an answer comes, its chat stays open (the list allows only it)
  const chooseChat = (chatId: number | null) => {
    if (!chats.answering) {
      chats.choose(chatId);
    }

    setPage('chat');
  };

  return (
    <div className="flex h-screen bg-canvas text-foreground">
      <nav className="flex w-52 shrink-0 flex-col border-r bg-card p-3">
        <h1 className="mb-4 px-2 pt-1 text-lg font-medium">Stenograma KB</h1>
        <div className="space-y-1">
          {PAGES.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setPage(id)}
              className={cn(
                'flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-accent',
                page === id && 'bg-accent font-medium',
              )}
            >
              <Icon className="size-4" />
              {label}
            </button>
          ))}
        </div>
        <ChatList chats={chats} onChoose={chooseChat} />
        <div className="mt-2 flex items-center gap-2 px-2 text-xs text-muted-foreground">
          <span
            className={cn(
              'size-2 shrink-0 rounded-full',
              { ok: 'bg-success', busy: 'bg-warning', error: 'bg-destructive' }[summary.tone],
            )}
          />
          <span className="truncate">{summary.text}</span>
        </div>
      </nav>
      <main className="flex min-w-0 flex-1 flex-col bg-background">
        {status && <ProcessBanner status={status} />}
        <div className="min-h-0 flex-1">
          <div className={cn('h-full', page !== 'chat' && 'hidden')}><ChatPage chats={chats} /></div>
          <div className={cn('h-full', page !== 'sources' && 'hidden')}><SourcesPage /></div>
          <div className={cn('h-full', page !== 'settings' && 'hidden')}><SettingsPage /></div>
        </div>
      </main>
    </div>
  );
};

export default App;
