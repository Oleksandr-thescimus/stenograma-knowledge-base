import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Cloud, Loader2, Monitor } from 'lucide-react';
import { cn } from 'cn';
import type { AppEvent, AskPart, CitedSource, LlmSettings, ModelChoice, SavedTurn } from '../../../../core/protocol';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Composer, { Chip } from '@/components/Composer';
import MarkdownText from '@/components/MarkdownText';
import ConversationDialog from '@/components/ConversationDialog';
import MeetingDialog from '@/components/MeetingDialog';
import ModelPicker from '@/components/ModelPicker';
import type { Chats } from '@/lib/chats';
import { citedNumbers } from '@/lib/citations';
import { NO_FILTERS, requestChips, toFilters, type FilterFields, type Without } from '@/lib/filters';
import { formatChunkStart, formatDay, isChatDocument } from '@/lib/format';
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
      {formatChunkStart(source)}
    </span>
    {source.madeByAi && <Badge variant="outline" className="shrink-0">made by AI</Badge>}
    {source.removed && <Badge variant="outline" className="shrink-0">removed</Badge>}
  </button>
);

// The models to ask again with, under a finished answer
interface AskAgain {
  models: ModelChoice[];
  ollamaUrl: string;
  disabled: boolean;
  onAsk: (question: string, llm: LlmSettings) => void;
  // Without a filter the rewrite took from the question
  onAskWithout: (question: string, without: Without) => void;
}

interface TurnViewProps {
  turn: Turn;
  now: number;
  onOpen: (source: CitedSource) => void;
  askAgain: AskAgain | null;
}

const TurnView = ({ turn, now, onOpen, askAgain }: TurnViewProps) => {
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
          <div className="mb-2 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            <span className="mr-1">Searched for: {turn.request.query}</span>
            {/* Taken from the question: a made-up one goes with ✕, which asks again without it */}
            {requestChips(turn.request).map((chip) => (
              <Chip
                key={chip.key}
                label={chip.label}
                title="Taken from the question: remove it to ask again without it"
                disabled={!askAgain || askAgain.disabled}
                onRemove={() => askAgain?.onAskWithout(turn.question, chip.key)}
              />
            ))}
          </div>
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
        {turn.state === 'done' && turn.sources && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {/* On this computer, or in the cloud */}
            <span className="flex items-center gap-1">
              Answered by
              {turn.sources.local ? <Monitor className="size-3.5" /> : <Cloud className="size-3.5" />}
              {turn.sources.llm.slice(turn.sources.llm.indexOf(' ') + 1)}
            </span>
            {askAgain && (
              <ModelPicker
                models={askAgain.models}
                value={null}
                ollamaUrl={askAgain.ollamaUrl}
                onChange={(llm) => askAgain.onAsk(turn.question, llm)}
                placeholder="Ask again with…"
                except={turn.sources.llm.replace(' ', '|')}
                disabled={askAgain.disabled}
                ghost
              />
            )}
          </div>
        )}
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
  const [opened, setOpened] = useState<CitedSource | null>(null);
  // The chat's model; null for the settings' one
  const [chatLlm, setChatLlm] = useState<LlmSettings | null>(null);
  const [defaultLlm, setDefaultLlm] = useState<LlmSettings | null>(null);
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [seriesNames, setSeriesNames] = useState<string[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const running = turns.some(isRunning);
  const now = useNow(running);
  const coreRunning = status?.process.state === 'running';

  const onEvent = useCallback((event: AppEvent) => {
    if (event.type === 'ask') {
      setTurns((current) => current.map((turn) => (turn.askId === event.askId ? applyPart(turn, event.part) : turn)));
    }
  }, []);

  useKbEvents(onEvent);

  // The settings' model, and the models to choose from: listed again after the list closes and when the window comes
  // back, as models are installed elsewhere. Kept as they were when the same, not to draw the list again
  const listModels = useCallback(() => {
    const same = <T, >(next: T) => (current: T) => (JSON.stringify(current) === JSON.stringify(next) ? current : next);
    window.kb.invoke('getSettings', {}).then((settings) => setDefaultLlm(same<LlmSettings | null>(settings.llm))).catch(() => undefined);
    window.kb.invoke('chatModels', {}).then((found) => setModels(same(found))).catch(() => undefined);
    window.kb.invoke('meetingSeries', {}).then(({ series }) => setSeriesNames(same(series.map(({ name }) => name)))).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!coreRunning) {
      return undefined;
    }

    listModels();
    window.addEventListener('focus', listModels);

    return () => window.removeEventListener('focus', listModels);
  }, [coreRunning, listModels]);

  const { chosen, choose, setAnswering, started, refresh } = chats;

  // A chat chosen in the sidebar, or a new one
  useEffect(() => {
    setLoadError(null);

    if (chosen.chatId === null) {
      setTurns([]);
      setChatLlm(null);

      return undefined;
    }

    let current = true;
    window.kb.invoke('chat', { chatId: chosen.chatId }).then((chat) => {
      if (!current) {
        return;
      }

      if (chat) {
        setTurns(chat.turns.map(fromSaved));
        setChatLlm(chat.llm);
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

  // Ctrl+N starts a new chat, as the sidebar's +
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n' && !running) {
        event.preventDefault();
        choose(null);
      }
    };
    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [choose, running]);

  const lastAnswerLength = turns.at(-1)?.answer.length;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [turns.length, lastAnswerLength]);

  // A question goes to the chat's model; asked again with another one, that one is the chat's from then on
  const send = async (text = question, llm = chatLlm, without: Without[] = []) => {
    const asked = text.trim();

    if (!asked || running || !coreRunning) {
      return;
    }

    const askId = crypto.randomUUID();
    setTurns((current) => [...current, { askId, question: asked, answer: '', state: 'searching', startedAt: Date.now() }]);
    setChatLlm(llm);

    if (text === question) {
      setQuestion('');
    }

    try {
      const { chatId } = await window.kb.invoke('ask', { askId, chatId: chats.chatId, question: asked, filters: toFilters(fields), llm, without });
      started(chatId);
      refresh();
    } catch (error) {
      setTurns((current) => current.map((turn) => (turn.askId === askId ? { ...turn, state: 'error', error: errorMessage(error) } : turn)));
    }
  };

  const stop = () => turns.filter(isRunning).forEach((turn) => window.kb.invoke('cancelAsk', { askId: turn.askId }));

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
          {turns.map((turn) => (
            <TurnView
              key={turn.askId}
              turn={turn}
              now={now}
              onOpen={setOpened}
              askAgain={defaultLlm ? {
                models,
                ollamaUrl: defaultLlm.ollamaUrl,
                disabled: running || !coreRunning,
                onAsk: (asked, llm) => send(asked, llm),
                onAskWithout: (asked, without) => send(asked, chatLlm, [without]),
              } : null}
            />
          ))}
          <div ref={bottomRef} />
        </div>
      </div>
      <div className="bg-background">
        <div className="mx-auto max-w-3xl px-4 pb-4">
          <Composer
            question={question}
            onQuestion={setQuestion}
            onSend={() => send()}
            onStop={stop}
            running={running}
            coreRunning={coreRunning}
            fields={fields}
            onFields={setFields}
            models={models}
            model={chatLlm ?? defaultLlm}
            onModel={setChatLlm}
            onModelsClosed={listModels}
            seriesNames={seriesNames}
          />
        </div>
      </div>
      <MeetingDialog source={opened && !isChatDocument(opened.documentKind) ? opened : null} onClose={() => setOpened(null)} />
      <ConversationDialog source={opened && isChatDocument(opened.documentKind) ? opened : null} onClose={() => setOpened(null)} />
    </div>
  );
};

export default ChatPage;
