import { useState } from 'react';
import { Database, MessageSquare, RotateCw, Settings as SettingsIcon } from 'lucide-react';
import { cn } from 'cn';
import type { AppStatus } from '../../../core/protocol';
import { Button } from '@/components/ui/button';
import ChatList from '@/components/ChatList';
import StatusLine from '@/components/StatusLine';
import type { SourcesTab } from '@/lib/status';
import { useChats } from '@/lib/chats';
import { useAppStatus } from '@/lib/kb';
import { formatTime } from '@/lib/format';
import ChatPage from '@/pages/ChatPage';
import SettingsPage from '@/pages/SettingsPage';
import SourcesPage from '@/pages/SourcesPage';

// The app's window (docs/PLAN.md, M3): the chat with the saved chats in the sidebar, the sources and the settings. Pages
// stay mounted, so an answer goes on coming while another page is open

type Page = 'chat' | 'sources' | 'settings';

const TOP_PAGES: { id: Page, label: string, icon: typeof MessageSquare }[] = [
  { id: 'chat', label: 'Chat', icon: MessageSquare },
];

const BOTTOM_PAGES: { id: Page, label: string, icon: typeof MessageSquare }[] = [
  { id: 'sources', label: 'Sources', icon: Database },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
];

const PageButton = ({
  id,
  label,
  icon: Icon,
  active,
  onClick,
}: {
  id: Page,
  label: string,
  icon: typeof MessageSquare,
  active: boolean,
  onClick: (id: Page) => void,
}) => (
  <button
    type="button"
    onClick={() => onClick(id)}
    className={cn(
      'flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-accent',
      active && 'bg-accent font-medium',
    )}
  >
    <Icon className="size-4" />
    {label}
  </button>
);

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
  const [sourcesTab, setSourcesTab] = useState<SourcesTab>('sources');
  const chats = useChats(status?.process.state === 'running');

  // While an answer comes, its chat stays open (the list allows only it)
  const chooseChat = (chatId: number | null) => {
    if (!chats.answering) {
      chats.choose(chatId);
    }

    setPage('chat');
  };

  const openSources = (tab: SourcesTab) => {
    setSourcesTab(tab);
    setPage('sources');
  };

  return (
    <div className="flex h-screen bg-canvas text-foreground">
      <nav className="flex w-52 shrink-0 flex-col border-r bg-card p-3">
        <h1 className="mb-4 px-2 pt-1 text-lg font-medium">Stenograma KB</h1>
        <div className="space-y-1">
          {TOP_PAGES.map((item) => (
            <PageButton key={item.id} {...item} active={page === item.id} onClick={setPage} />
          ))}
        </div>
        <ChatList chats={chats} onChoose={chooseChat} />
        <div className="mt-2 space-y-1 border-t pt-2">
          {BOTTOM_PAGES.map((item) => (
            <PageButton key={item.id} {...item} active={page === item.id} onClick={setPage} />
          ))}
        </div>
        <StatusLine status={status} onOpen={openSources} />
      </nav>
      <main className="flex min-w-0 flex-1 flex-col bg-background">
        {status && <ProcessBanner status={status} />}
        <div className="min-h-0 flex-1">
          <div className={cn('h-full', page !== 'chat' && 'hidden')}><ChatPage chats={chats} /></div>
          <div className={cn('h-full', page !== 'sources' && 'hidden')}><SourcesPage tab={sourcesTab} onTab={setSourcesTab} /></div>
          <div className={cn('h-full', page !== 'settings' && 'hidden')}><SettingsPage /></div>
        </div>
      </main>
    </div>
  );
};

export default App;
