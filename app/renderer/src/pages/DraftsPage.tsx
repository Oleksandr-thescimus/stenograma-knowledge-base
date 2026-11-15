import { useCallback, useEffect, useState } from 'react';
import { Check, Cloud, Copy, ExternalLink, Loader2, Monitor, Plus, RotateCw, X } from 'lucide-react';
import { cn } from 'cn';
import type { AttachmentStatus, CitedSource, DraftView } from '../../../../core/protocol';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import ConversationDialog from '@/components/ConversationDialog';
import BackgroundPause from '@/components/BackgroundPause';
import MeetingDialog from '@/components/MeetingDialog';
import RequestDraftDialog from '@/components/RequestDraftDialog';
import SourceRow from '@/components/SourceRow';
import { citedNumbers } from '@/lib/citations';
import { withoutCitations } from '@/lib/drafts';
import { formatDuration, formatTime, formatWhen, isChatDocument } from '@/lib/format';
import { errorMessage, useAppStatus } from '@/lib/kb';

// Reply drafts (F9, M7) to review: the message to the user with the ones before it, and a draft from what the knowledge
// base has, citing it as [n]. Nothing is sent from here: "Copy" takes the text without the marks, to paste into the
// messenger

const REASONS: Record<DraftView['reason'], string> = {
  direct: 'direct message',
  mention: 'mentions you',
  thread: 'in your thread',
  manual: 'asked for by hand',
};

const useNow = (active: boolean) => {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!active) {
      return undefined;
    }

    const timer = setInterval(() => setNow(Date.now()), 1000);

    return () => clearInterval(timer);
  }, [active]);

  return now;
};

// paused: the background AI work's pause, which drafts asked for by hand don't wait for
const DraftState = ({ draft, paused }: { draft: DraftView, paused: AttachmentStatus['paused'] }) => {
  const now = useNow(draft.state === 'writing');

  if (draft.state === 'waiting' && paused && !draft.asked) {
    return (
      <p className="text-sm text-muted-foreground">
        Waits: the background AI work is paused {paused.until ? `until ${formatTime(paused.until)}` : 'until resumed'}. &quot;Write
        again&quot; writes it now.
      </p>
    );
  }

  if (draft.state === 'waiting') {
    return <p className="text-sm text-muted-foreground">In the queue{draft.ahead ? `, ${draft.ahead} before it` : ', next'}</p>;
  }

  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin" />
      Writing{draft.llm && ` with ${draft.llm}`} · {formatDuration(now - draft.updatedAt)}
    </p>
  );
};

interface DraftCardProps {
  draft: DraftView;
  paused: AttachmentStatus['paused'];
  onOpen: (source: CitedSource) => void;
}

const DraftCard = ({ draft, paused, onOpen }: DraftCardProps) => {
  const [text, setText] = useState(draft.text);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cited = citedNumbers(text);

  // A draft written again replaces what was edited
  useEffect(() => setText(draft.text), [draft.text]);

  const call = (run: () => Promise<unknown>) => {
    setError(null);
    run().catch((reason: unknown) => setError(errorMessage(reason)));
  };

  const copy = () => call(async () => {
    await navigator.clipboard.writeText(withoutCitations(text));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  });

  const answered = draft.messages.at(-1);

  return (
    <article className="space-y-3 rounded-lg border bg-card p-4">
      <header className="flex items-center gap-2">
        <h3 className="min-w-0 truncate font-medium">{draft.conversation}</h3>
        <Badge variant="outline" className="shrink-0">{REASONS[draft.reason]}</Badge>
        {answered && <span className="shrink-0 text-xs text-muted-foreground">{formatWhen(answered.ts)}</span>}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => call(() => window.kb.invoke('openDraftInChat', { draftId: draft.id }))}
        >
          <ExternalLink />
          Open in Rocket.Chat
        </Button>
      </header>
      <div className="space-y-1 rounded-md bg-bubble p-3 text-sm">
        {draft.messages.map((message) => (
          <p key={message.id} className={cn('whitespace-pre-wrap', message.mine && 'text-muted-foreground', message.id === answered?.id && 'font-medium')}>
            <span className="text-muted-foreground">{message.mine ? 'You' : message.author}: </span>
            {message.text}
          </p>
        ))}
      </div>
      {(draft.state === 'waiting' || draft.state === 'writing') && <DraftState draft={draft} paused={paused} />}
      {draft.state === 'failed' && <p className="text-sm text-destructive">The draft wasn&apos;t written: {draft.error}</p>}
      {draft.state === 'ready' && (
        <>
          <Textarea value={text} onChange={(event) => setText(event.target.value)} className="min-h-24" aria-label="The reply draft" />
          {draft.sources.length > 0 && (
            <div>
              {draft.sources.filter((source) => cited.has(source.n)).map((source) => <SourceRow key={source.n} source={source} onOpen={onOpen} />)}
              {draft.sources.filter((source) => !cited.has(source.n)).map((source) => <SourceRow key={source.n} source={source} onOpen={onOpen} dimmed />)}
            </div>
          )}
        </>
      )}
      <footer className="flex flex-wrap items-center gap-2">
        {draft.state === 'ready' && (
          <Button size="sm" onClick={copy}>
            {copied ? <Check /> : <Copy />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        )}
        {(draft.state === 'ready' || draft.state === 'failed' || (draft.state === 'waiting' && paused && !draft.asked)) && (
          <Button size="sm" variant="outline" onClick={() => call(() => window.kb.invoke('draftAction', { draftId: draft.id, action: 'rewrite' }))}>
            <RotateCw />
            Write again
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => call(() => window.kb.invoke('draftAction', { draftId: draft.id, action: 'dismiss' }))}>
          <X />
          Dismiss
        </Button>
        {draft.state === 'ready' && draft.llm && (
          <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
            {draft.local ? <Monitor className="size-3.5" /> : <Cloud className="size-3.5" />}
            {draft.llm.slice(draft.llm.indexOf(' ') + 1)}
          </span>
        )}
        {error && <span className="text-sm text-destructive">{error}</span>}
      </footer>
    </article>
  );
};

const DraftsPage = ({ onOpenSources }: { onOpenSources: () => void }) => {
  const status = useAppStatus();
  const [drafts, setDrafts] = useState<DraftView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<CitedSource | null>(null);
  const [asking, setAsking] = useState(false);
  const core = status?.core;
  const hasChat = core?.sources.some((source) => source.kind === 'rocketchat') ?? false;
  const running = status?.process.state === 'running';
  const enabled = core?.sources.some((source) => source.repliesEnabled) ?? false;
  // Read again when the queue moves
  const key = core ? `${core.drafts.ready}:${core.drafts.waiting}:${core.drafts.writing}` : '';

  const load = useCallback(() => {
    window.kb.invoke('drafts', {})
      .then((list) => {
        setDrafts(list);
        setError(null);
      })
      .catch((reason: unknown) => setError(errorMessage(reason)));
  }, []);

  useEffect(() => {
    if (running) {
      load();
    }
  }, [running, key, load]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-4 p-6 xl:max-w-5xl">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-medium">Reply drafts</h2>
            {hasChat && (
              <Button size="sm" variant="outline" className="ml-auto" onClick={() => setAsking(true)} disabled={!running}>
                <Plus />
                Draft a reply…
              </Button>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            For Rocket.Chat messages to you: direct messages, mentions and replies in your threads, from what the knowledge base
            has. Check a draft, copy it and send it in Rocket.Chat yourself; it goes from here once you&apos;ve written there.
          </p>
        </div>
        {core?.attachments.paused && core.drafts.waiting > 0 && <BackgroundPause status={core.attachments} />}
        {core?.drafts.error && core.drafts.waiting > 0 && <p className="text-sm text-destructive">{core.drafts.error}</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {core && !enabled && (
          <div className="space-y-2 rounded-lg border border-dashed p-6 text-sm">
            <p>
              New messages to you get no draft: turn on &quot;Draft replies&quot; on a Rocket.Chat source. A draft for any conversation can be
              asked for with &quot;Draft a reply…&quot;.
            </p>
            <Button size="sm" variant="outline" onClick={onOpenSources}>Open Sources</Button>
          </div>
        )}
        {enabled && drafts && !drafts.length && (
          <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">No drafts: nothing to you is waiting for a reply.</p>
        )}
        {drafts?.map((draft) => <DraftCard key={draft.id} draft={draft} paused={core?.attachments.paused ?? null} onOpen={setOpened} />)}
      </div>
      <MeetingDialog source={opened && !isChatDocument(opened.documentKind) ? opened : null} onClose={() => setOpened(null)} />
      <ConversationDialog source={opened && isChatDocument(opened.documentKind) ? opened : null} onClose={() => setOpened(null)} />
      <RequestDraftDialog open={asking} onClose={() => setAsking(false)} />
    </div>
  );
};

export default DraftsPage;
