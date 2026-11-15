import { useState } from 'react';
import { CircleAlert, Info, KeyRound, List, ListChecks, Loader2, MoreHorizontal, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import { cn } from 'cn';
import type { SourceInfo } from '../../../../core/protocol';
import { SourceIcon } from '@/components/SourceIcon';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatTime, formatWhen, sourceName } from '@/lib/format';
import { errorMessage } from '@/lib/kb';

// A source on the Sources page (F4, F7, F8): its icon, its state as a dot, what the knowledge base has of it in the units
// people count (meetings, rooms, messages), its cloud policy, and an error with what fixes it. Actions done rarely are in
// its "⋯" menu

export type SourceAction = 'rename' | 'browser-token' | 'rooms' | 'chat-token' | 'meetings' | 'remove';

type Tone = 'ok' | 'busy' | 'waiting' | 'idle' | 'error';

const DOTS: Record<Exclude<Tone, 'busy'>, string> = {
  ok: 'bg-success',
  waiting: 'bg-warning',
  idle: 'bg-muted-foreground/50',
  error: 'bg-destructive',
};

// A browser that sent within this long is sending
const SENDING_MS = 3600_000;
// A push calls /status first: a call this long after the push is a later check
const CHECK_AFTER_PUSH_MS = 60_000;

const stateOf = (source: SourceInfo): { tone: Tone, text: string, hint?: string } => {
  const { connector } = source;

  if (connector?.running) {
    return { tone: 'busy', text: `Syncing${connector.progress ? `: ${connector.progress}` : '…'}` };
  }

  if (connector && source.lastError) {
    return { tone: 'error', text: 'Sync failed' };
  }

  if (connector) {
    const next = connector.nextAt ? `${connector.live ? 'next full sync' : 'Next sync'} at ${formatTime(connector.nextAt)}` : '';

    // Live: new messages arrive as they're sent, and the whole sync is rarer
    if (connector.live && source.lastSyncAt) {
      return { tone: 'ok', text: `Live · synced ${formatWhen(source.lastSyncAt)}`, hint: `New messages arrive as they're sent${next && `; ${next}`}` };
    }

    return source.lastSyncAt
      ? { tone: 'ok', text: `Synced ${formatWhen(source.lastSyncAt)}`, hint: next || undefined }
      : { tone: 'idle', text: 'Not synced yet' };
  }

  if (source.kind === 'stenograma-browser') {
    const hint = 'The extension sends every 5 minutes while the browser is open; its popup has "Sync now".';

    // A check after the last push found nothing new: the extension reaches the app
    const checked = source.lastSeenAt && source.lastSeenAt - (source.lastSyncAt ?? 0) > CHECK_AFTER_PUSH_MS ? source.lastSeenAt : null;

    if (!source.lastSyncAt) {
      return checked
        ? { tone: 'waiting', text: `Checked ${formatWhen(checked)}, no meetings sent yet`, hint }
        : { tone: 'waiting', text: 'Waiting for its first meetings', hint };
    }

    const seen = Math.max(source.lastSyncAt, source.lastSeenAt ?? 0);

    return {
      tone: Date.now() - seen < SENDING_MS ? 'ok' : 'idle',
      text: `Sent ${formatWhen(source.lastSyncAt)}${checked ? ` · checked ${formatWhen(checked)}, nothing new` : ''}`,
      hint,
    };
  }

  return { tone: 'idle', text: source.lastSyncAt ? `Imported ${formatWhen(source.lastSyncAt)}` : 'Imported' };
};

const count = (n: number, one: string) => `${n.toLocaleString()} ${n === 1 ? one : `${one}s`}`;

const month = (ms: number) => new Date(ms).toLocaleDateString([], { month: 'short', year: 'numeric' });

// What it has, in the units of its kind
const factsOf = (source: SourceInfo, nameOf: (sourceId: number) => string) => {
  if (source.connector) {
    return [source.connector.detail, source.connector.summary].filter(Boolean).join(' · ');
  }

  return [
    source.kind === 'stenograma-backup' ? source.account : 'Stenograma',
    `${count(source.meetings, 'meeting')}${source.firstMeetingAt ? `, ${month(source.firstMeetingAt)} – ${month(source.latestMeeting?.createdAt ?? Date.now())}` : ''}`,
    ...source.copiesIn.map((copy) => `${copy.meetings.toLocaleString()} more indexed from ${nameOf(copy.sourceId)}'s copy`),
  ].filter(Boolean).join(' · ');
};

// A meetings source's newest meeting, its summaries and series, and its chunks still to embed
const meetingFactsOf = (source: SourceInfo) => [
  source.latestMeeting && `Latest: ${source.latestMeeting.title}, ${formatWhen(source.latestMeeting.createdAt)}`,
  [
    source.meetings > 0 && `${source.summarized.toLocaleString()} with a short summary`,
    source.inSeries > 0 && `${source.inSeries.toLocaleString()} in series`,
    source.embeddingsPending > 0 && `${count(source.embeddingsPending, 'chunk')} waiting for embeddings`,
  ].filter(Boolean).join(' · '),
].filter(Boolean) as string[];

const Hint = ({ text, label }: { text: string, label: string }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <button type="button" className="rounded-full text-muted-foreground hover:text-foreground" aria-label={label}>
        <Info className="size-3.5" />
      </button>
    </TooltipTrigger>
    <TooltipContent className="max-w-72">{text}</TooltipContent>
  </Tooltip>
);

interface SourceCardProps {
  source: SourceInfo;
  // Another source's name, for the meetings indexed from its copy
  nameOf: (sourceId: number) => string;
  onAction: (action: SourceAction, source: SourceInfo) => void;
}

const SourceCard = ({ source, nameOf, onAction }: SourceCardProps) => {
  const [error, setError] = useState<string | null>(null);
  const state = stateOf(source);
  const { connector } = source;
  const failed = Boolean(connector && source.lastError && !connector.running);

  const syncNow = () => {
    setError(null);
    window.kb.invoke('syncSource', { sourceId: source.id }).catch((reason: unknown) => setError(errorMessage(reason)));
  };

  const setCloud = (allowed: boolean) => window.kb.invoke('setCloudAllowed', { sourceId: source.id, allowed })
    .catch((reason: unknown) => setError(errorMessage(reason)));

  const setReplies = (enabled: boolean) => window.kb.invoke('setRepliesEnabled', { sourceId: source.id, enabled })
    .catch((reason: unknown) => setError(errorMessage(reason)));

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-start gap-3">
        <SourceIcon source={source} />
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="truncate font-medium">{sourceName(source)}</h3>
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            {state.tone === 'busy'
              ? <Loader2 className="size-3.5 shrink-0 animate-spin" />
              : <span className={cn('size-2 shrink-0 rounded-full', DOTS[state.tone])} aria-hidden />}
            {/* A sync's progress is long: it wraps rather than being cut */}
            <span className={state.tone === 'busy' ? 'min-w-0' : 'truncate'}>{state.text}</span>
            {state.hint && <Hint text={state.hint} label="When it syncs" />}
          </p>
          <p className="text-sm text-muted-foreground">{factsOf(source, nameOf)}</p>
          {!connector && meetingFactsOf(source).map((line) => <p key={line} className="truncate text-sm text-muted-foreground">{line}</p>)}
        </div>
        {connector && !failed && (
          <Button variant="ghost" size="sm" onClick={syncNow} disabled={connector.running}>
            <RefreshCw />
            Sync now
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`More for ${sourceName(source)}`}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {source.kind.startsWith('stenograma') && (
              <DropdownMenuItem onSelect={() => onAction('meetings', source)}>
                <List />
                Meetings…
              </DropdownMenuItem>
            )}
            {source.kind === 'stenograma-backup' && <DropdownMenuSeparator />}
            {source.kind === 'stenograma-browser' && (
              <>
                <DropdownMenuItem onSelect={() => onAction('rename', source)}>
                  <Pencil />
                  Rename…
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onAction('browser-token', source)}>
                  <KeyRound />
                  New token…
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            {source.kind === 'rocketchat' && (
              <>
                <DropdownMenuItem onSelect={() => onAction('rooms', source)}>
                  <ListChecks />
                  Rooms and period…
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onAction('chat-token', source)}>
                  <KeyRound />
                  New token…
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem variant="destructive" onSelect={() => onAction('remove', source)}>
              <Trash2 />
              Remove…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {failed && (
        <div className="mt-3 flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1 space-y-0.5 text-sm">
            <p>{source.lastError}</p>
            {connector?.nextAt && <p className="text-xs text-muted-foreground">Next try at {formatTime(connector.nextAt)}</p>}
          </div>
          {connector?.problem === 'auth' ? (
            <Button size="sm" variant="outline" onClick={() => onAction('chat-token', source)}>
              <KeyRound />
              Enter a new token
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={syncNow}>
              <RefreshCw />
              Try again
            </Button>
          )}
        </div>
      )}
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      <div className="mt-3 flex items-center gap-2 pl-[3.25rem] text-sm">
        <Switch checked={source.cloudAllowed} onCheckedChange={setCloud} aria-label="May go to cloud AI" />
        <span className={source.cloudAllowed ? '' : 'text-muted-foreground'}>{source.cloudAllowed ? 'May go to cloud AI' : 'Only on this computer'}</span>
        <Hint
          label="What cloud AI sees"
          text={source.cloudAllowed
            ? 'Its content may go to Groq, Gemini or Claude when they answer, and to Gemini\'s embeddings.'
            : 'Only Ollama on this computer sees it; with a cloud model it\'s left out of answers.'}
        />
      </div>
      {source.kind === 'rocketchat' && (
        <div className="mt-2 flex items-center gap-2 pl-[3.25rem] text-sm">
          <Switch checked={source.repliesEnabled} onCheckedChange={setReplies} aria-label="Draft replies" />
          <span className={source.repliesEnabled ? '' : 'text-muted-foreground'}>Draft replies</span>
          <Hint
            label="What gets a draft"
            text={`Direct messages, mentions of you and replies in your threads get a reply draft after each sync, in Reply drafts, from the rooms it reads. Turned on, the unread ones of the last day get one too. ${
              source.cloudAllowed ? '' : 'Only Ollama on this computer writes them, as the chats may not go to cloud AI. '}Nothing is sent: you copy a draft into Rocket.Chat.`}
          />
        </div>
      )}
    </div>
  );
};

export default SourceCard;
