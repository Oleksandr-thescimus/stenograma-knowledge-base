import { useState, type ReactNode } from 'react';
import { Check, CircleCheck, Copy, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAppStatus } from '@/lib/kb';

// A browser's token, shown once, and how to give it to the extension, step by step: its popup's "Local knowledge base"
// (KnowledgeBaseSetup in the extension's repo). Then it waits for the browser's first push, which the core's status shows,
// so the user sees the browser connected without going to look

// The extension's default address (DEFAULT_KB_URL there)
const EXTENSION_PORT = 47321;

const Step = ({ n, title, children }: { n: number, title: string, children: ReactNode }) => (
  <li className="flex gap-3">
    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-medium text-secondary-foreground">{n}</span>
    <div className="min-w-0 flex-1 space-y-2">
      <p className="text-sm font-medium">{title}</p>
      {children}
    </div>
  </li>
);

const Copyable = ({ value, label, mono = true }: { value: string, label: string, mono?: boolean }) => {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
  };

  return (
    <div className="flex gap-2">
      <Input readOnly value={value} aria-label={label} className={mono ? 'font-mono text-xs' : ''} onFocus={(event) => event.target.select()} />
      <Button variant="outline" size="icon" onClick={copy} aria-label={`Copy the ${label}`}>
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
};

interface PairingStepsProps {
  sourceId: number;
  name: string;
  token: string;
  // Pushes from then on are the browser's with this token
  since: number;
  // A new token for a browser that sent before
  again?: boolean;
}

const PairingSteps = ({ sourceId, name, token, since, again }: PairingStepsProps) => {
  const core = useAppStatus()?.core;
  const source = core?.sources.find((candidate) => candidate.id === sourceId);
  const arrived = source?.lastSyncAt !== null && source?.lastSyncAt !== undefined && source.lastSyncAt >= since;
  const meetings = source ? source.meetings + source.indexedElsewhere : 0;
  const port = core?.server.port ?? EXTENSION_PORT;

  const waiting = () => (core?.server.listening === false ? (
    <p className="text-sm text-destructive">The extension can&apos;t send now: {core.server.error}</p>
  ) : (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      Waiting for {name} to send…
    </p>
  ));

  return (
    <div className="space-y-4">
      <ol className="space-y-4">
        <Step n={1} title="Copy the token">
          <Copyable value={token} label="token" />
          <p className="text-xs text-muted-foreground">
            It&apos;s shown only now: the knowledge base keeps only its hash. If it&apos;s lost, the card&apos;s &quot;New
            token&quot; makes another.
          </p>
        </Step>
        <Step n={2} title={`In ${name}, open Stenograma's popup`}>
          <p className="text-sm text-muted-foreground">
            Open &quot;Local knowledge base&quot;, turn on &quot;Send meetings to the knowledge base&quot;
            {port === EXTENSION_PORT ? ' and paste the token.' : ', set its URL to this one and paste the token:'}
          </p>
          {port !== EXTENSION_PORT && <Copyable value={`http://127.0.0.1:${port}`} label="address" />}
        </Step>
        <Step n={3} title={'Press "Sync now" there'}>
          <p className="text-sm text-muted-foreground">Or wait: it sends every 5 minutes while the browser is open.</p>
        </Step>
      </ol>
      <div className="rounded-lg border bg-muted/40 px-3 py-2.5" aria-live="polite">
        {arrived ? (
          <p className="flex items-center gap-2 text-sm">
            <CircleCheck className="size-4 text-success" />
            {again ? `${name} sends again` : `${name} is connected`}
            {`: ${meetings.toLocaleString()} ${meetings === 1 ? 'meeting' : 'meetings'}`}
            {core?.embedding.pending ? ', being indexed' : ''}
          </p>
        ) : waiting()}
      </div>
    </div>
  );
};

export default PairingSteps;
