import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { AlertTriangle, Filter, Loader2, MessageSquarePlus, SendHorizontal, Square, X } from 'lucide-react';
import { cn } from 'cn';
import type { AppEvent, AskPart, CitedSource, SavedTurn, SearchFilters } from '../../../../core/protocol';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import MarkdownText from '@/components/MarkdownText';
import MeetingDialog from '@/components/MeetingDialog';
import type { Chats } from '@/lib/chats';
import { citedNumbers } from '@/lib/citations';
import { formatDay, formatMoment } from '@/lib/format';
import { errorMessage, useAppStatus, useKbEvents } from '@/lib/kb';

// The chat (F6): streamed answers with [n] citations, filters set by hand, and the meeting view at the cited moment.
// The core keeps each chat (core/chats.ts); the sidebar lists them

type RequestPart = Extract<AskPart, { kind: 'request' }>;
type SourcesPart = Extract<AskPart, { kind: 'sources' }>;

interface Turn {
  askId: string;
  question: string;
  request?: RequestPart;
  sources?: SourcesPart;
  answer: string;
  state: 'searching' | 'answering' | 'done' | 'error';
  error?: string;
  startedAt: number;
}

interface FilterFields {
  from: string;
  to: string;
  person: string;
  sourceKind: string;
}

const NO_FILTERS: FilterFields = { from: '', to: '', person: '', sourceKind: 'all' };
const EXAMPLES = [
  'Що ми вирішили щодо релізу минулого тижня?',
  'What did Olena say about the budget?',
  'Які задачі в мене з останньої зустрічі?',
];

const isRunning = (turn: Turn) => turn.state === 'searching' || turn.state === 'answering';

// A turn of a saved chat. One still running was asked before the window was reloaded: its answer is saved when done
const fromSaved = (turn: SavedTurn): Turn => ({
  askId: `saved-${turn.id}`,
  question: turn.question,
  request: turn.request ?? undefined,
  sources: turn.sources ?? undefined,
  answer: turn.answer,
  state: turn.state === 'running' ? 'error' : turn.state,
  error: turn.state === 'running' ? 'Still being answered: open the chat again for the answer.' : turn.error ?? undefined,
  startedAt: turn.createdAt,
});

const dayStart = (day: string) => new Date(`${day}T00:00:00`).getTime();

// Days from the date fields: from the start of `from` to the end of `to`
const toFilters = (fields: FilterFields): SearchFilters => {
  const next = fields.to ? new Date(`${fields.to}T00:00:00`) : null;
  next?.setDate(next.getDate() + 1);

  return {
    ...(fields.from && { from: dayStart(fields.from) }),
    ...(next && { to: next.getTime() }),
    ...(fields.person.trim() && { person: fields.person.trim() }),
    ...(fields.sourceKind !== 'all' && { sourceKind: fields.sourceKind }),
  };
};

const applyPart = (turn: Turn, part: AskPart): Turn => {
  switch (part.kind) {
    case 'request':
      return { ...turn, request: part };
    case 'sources':
      return { ...turn, sources: part, state: 'answering' };
    case 'text':
      return { ...turn, answer: turn.answer + part.text };
    case 'done':
      return { ...turn, state: 'done' };
    default:
      return { ...turn, state: 'error', error: part.message };
  }
};

// Re-renders every second while something runs, for the time waited
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

const describeRequest = (request: RequestPart) => [
  request.from !== undefined && `from ${formatDay(request.from)}`,
  request.to !== undefined && `to ${formatDay(request.to - 1)}`,
  request.person && `person: ${request.person}`,
].filter(Boolean).join(' · ');

// A removed source is still listed, as its answer cites it, but no longer opens
const SourceRow = ({ source, onOpen, dimmed }: { source: CitedSource, onOpen: (source: CitedSource) => void, dimmed?: boolean }) => (
  <button
    type="button"
    onClick={() => onOpen(source)}
    disabled={source.removed}
    className={cn(
      'flex w-full items-baseline gap-2 rounded px-2 py-1 text-left text-sm enabled:hover:bg-accent',
      (dimmed || source.removed) && 'text-muted-foreground',
    )}
  >
    <span className="w-6 shrink-0 text-xs font-medium text-primary">[{source.n}]</span>
    <span className="min-w-0 truncate">{source.title}</span>
    <span className="shrink-0 text-xs text-muted-foreground">
      {formatDay(source.createdAt)}
      {formatMoment(source.startMs)}
    </span>
    {source.madeByAi && <Badge variant="outline" className="shrink-0">made by AI</Badge>}
    {source.removed && <Badge variant="outline" className="shrink-0">removed</Badge>}
  </button>
);

const TurnView = ({ turn, now, onOpen }: { turn: Turn, now: number, onOpen: (source: CitedSource) => void }) => {
  const sources = turn.sources?.sources ?? [];
  const cited = citedNumbers(turn.answer);
  // A removed source's [n] stays plain text
  const known = new Set(sources.filter((source) => !source.removed).map((source) => source.n));
  const waited = Math.round((now - turn.startedAt) / 1000);
  const openNumber = (n: number) => {
    const source = sources.find((candidate) => candidate.n === n);

    if (source) {
      onOpen(source);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="max-w-[80%] self-end rounded-2xl bg-primary/15 px-4 py-2 whitespace-pre-wrap">{turn.question}</div>
      <div className="rounded-2xl bg-bubble px-4 py-3">
        {turn.request && (
          <p className="mb-2 text-xs text-muted-foreground">
            Searched for: {turn.request.query}
            {describeRequest(turn.request) && ` · ${describeRequest(turn.request)}`}
          </p>
        )}
        {turn.state === 'searching' && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Searching…
          </p>
        )}
        {turn.sources?.warning && (
          <p className="mb-2 flex items-start gap-2 text-xs text-warning">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            {turn.sources.warning}
          </p>
        )}
        {turn.answer && <MarkdownText text={turn.answer} citations={known} onCitation={openNumber} />}
        {turn.state === 'answering' && !turn.answer && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Answering with {turn.sources?.llm}
            {waited > 10 && ` · ${waited} s`}
            {waited > 10 && turn.sources?.llm.startsWith('groq') && ': Groq\'s free tier may be waiting out its per-minute limit'}
          </p>
        )}
        {turn.state === 'done' && turn.sources && !sources.length && (
          <p className="text-sm text-muted-foreground">Nothing found that answers it.</p>
        )}
        {turn.sources && turn.sources.leftOut > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            {turn.sources.leftOut} found chunks were left out: their sources don&apos;t allow a cloud LLM.
          </p>
        )}
        {turn.error && <p className="text-sm text-destructive">{turn.error}</p>}
        {sources.length > 0 && turn.state !== 'searching' && (
          <div className="mt-3 border-t pt-2">
            {sources.filter((source) => cited.has(source.n)).map((source) => <SourceRow key={source.n} source={source} onOpen={onOpen} />)}
            {turn.state === 'done' && sources.some((source) => !cited.has(source.n)) && (
              <>
                <p className="mt-1 px-2 text-xs text-muted-foreground">Also given, not cited</p>
                {sources.filter((source) => !cited.has(source.n)).map((source) => <SourceRow key={source.n} source={source} onOpen={onOpen} dimmed />)}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

const ChatPage = ({ chats }: { chats: Chats }) => {
  const status = useAppStatus();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [fields, setFields] = useState<FilterFields>(NO_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [opened, setOpened] = useState<CitedSource | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const running = turns.some(isRunning);
  const now = useNow(running);
  const coreRunning = status?.process.state === 'running';
  const activeFilters = Object.keys(toFilters(fields)).length;

  const onEvent = useCallback((event: AppEvent) => {
    if (event.type === 'ask') {
      setTurns((current) => current.map((turn) => (turn.askId === event.askId ? applyPart(turn, event.part) : turn)));
    }
  }, []);

  useKbEvents(onEvent);

  const { chosen, choose, setAnswering, started, refresh } = chats;

  // A chat chosen in the sidebar, or a new one
  useEffect(() => {
    setLoadError(null);

    if (chosen.chatId === null) {
      setTurns([]);

      return undefined;
    }

    let current = true;
    window.kb.invoke('chat', { chatId: chosen.chatId }).then((chat) => {
      if (!current) {
        return;
      }

      if (chat) {
        setTurns(chat.turns.map(fromSaved));
      } else {
        choose(null);
        refresh();
      }
    }).catch((error: unknown) => {
      if (current) {
        setTurns([]);
        setLoadError(errorMessage(error));
      }
    });

    return () => {
      current = false;
    };
  }, [chosen, choose, refresh]);

  useEffect(() => {
    setAnswering(running);
  }, [running, setAnswering]);

  const lastAnswerLength = turns.at(-1)?.answer.length;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [turns.length, lastAnswerLength]);

  const send = async (text = question) => {
    const asked = text.trim();

    if (!asked || running || !coreRunning) {
      return;
    }

    const askId = crypto.randomUUID();
    setTurns((current) => [...current, { askId, question: asked, answer: '', state: 'searching', startedAt: Date.now() }]);
    setQuestion('');

    try {
      const { chatId } = await window.kb.invoke('ask', { askId, chatId: chats.chatId, question: asked, filters: toFilters(fields) });
      started(chatId);
      refresh();
    } catch (error) {
      setTurns((current) => current.map((turn) => (turn.askId === askId ? { ...turn, state: 'error', error: errorMessage(error) } : turn)));
    }
  };

  const stop = () => turns.filter(isRunning).forEach((turn) => window.kb.invoke('cancelAsk', { askId: turn.askId }));

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  const setField = (name: keyof FilterFields) => (value: string) => setFields((current) => ({ ...current, [name]: value }));

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
          {loadError && <p className="text-sm text-destructive">{loadError}</p>}
          {!turns.length && !loadError && (
            <div className="mt-16 text-center">
              <h2 className="mb-2 text-xl">Ask about your meetings</h2>
              <p className="mb-6 text-sm text-muted-foreground">
                Answers cite the meetings they come from; dates and people are taken from the question.
              </p>
              <div className="flex flex-col items-center gap-2">
                {EXAMPLES.map((example) => (
                  <Button key={example} variant="outline" size="sm" onClick={() => setQuestion(example)}>{example}</Button>
                ))}
              </div>
            </div>
          )}
          {turns.map((turn) => <TurnView key={turn.askId} turn={turn} now={now} onOpen={setOpened} />)}
          <div ref={bottomRef} />
        </div>
      </div>
      <div className="border-t bg-background">
        <div className="mx-auto max-w-3xl p-4">
          {showFilters && (
            <div className="mb-3 grid grid-cols-2 gap-3 rounded-lg border p-3 md:grid-cols-4">
              <div className="space-y-1">
                <Label htmlFor="filter-from">From</Label>
                <Input id="filter-from" type="date" value={fields.from} onChange={(event) => setField('from')(event.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="filter-to">To</Label>
                <Input id="filter-to" type="date" value={fields.to} onChange={(event) => setField('to')(event.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="filter-person">Person</Label>
                <Input id="filter-person" placeholder="Olena" value={fields.person} onChange={(event) => setField('person')(event.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Source</Label>
                <Select value={fields.sourceKind} onValueChange={setField('sourceKind')}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All sources</SelectItem>
                    <SelectItem value="stenograma">Meetings</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <p className="col-span-full text-xs text-muted-foreground">
                Set here, they win over the dates and the person taken from the question.
              </p>
            </div>
          )}
          <div className="flex items-end gap-2">
            <Textarea
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={coreRunning ? 'Ask a question (Enter sends, Shift+Enter starts a new line)' : 'The knowledge base isn\'t running'}
              disabled={!coreRunning}
              rows={2}
              className="max-h-48 min-h-[3.5rem] resize-none"
            />
            <div className="flex flex-col gap-1">
              {running ? (
                <Button size="icon" variant="secondary" onClick={stop} aria-label="Stop">
                  <Square />
                </Button>
              ) : (
                <Button size="icon" onClick={() => send()} disabled={!question.trim() || !coreRunning} aria-label="Send">
                  <SendHorizontal />
                </Button>
              )}
            </div>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <Button size="xs" variant={showFilters || activeFilters ? 'secondary' : 'ghost'} onClick={() => setShowFilters(!showFilters)}>
              <Filter />
              Filters
              {activeFilters > 0 && ` (${activeFilters})`}
            </Button>
            {activeFilters > 0 && (
              <Button size="xs" variant="ghost" onClick={() => setFields(NO_FILTERS)}>
                <X />
                Clear
              </Button>
            )}
            <div className="flex-1" />
            <Button size="xs" variant="ghost" onClick={() => choose(null)} disabled={running || !turns.length}>
              <MessageSquarePlus />
              New chat
            </Button>
          </div>
        </div>
      </div>
      <MeetingDialog source={opened} onClose={() => setOpened(null)} />
    </div>
  );
};

export default ChatPage;
