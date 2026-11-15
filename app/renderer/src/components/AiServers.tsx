import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Check, Plus, Trash2 } from 'lucide-react';
import { cn } from 'cn';
import type { AiServer, KeyProvider } from '../../../../core/protocol';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { errorMessage } from '@/lib/kb';

// The AI servers (Settings → AI models), in the chat's order: this computer's Ollama, others with Ollama's API (an
// Orange Pi's RKLLama through an SSH tunnel), and Groq's, Gemini's and Claude's APIs with their keys. Each has its model for text
// (answers, summaries, drafts) and for images, checked as it's typed, and its background queue on or off: every server
// with the queue on takes the next meeting, draft or image it has a model for

const NONE = '\u0000none';

const sameUrl = (a: string, b: string) => a.trim().replace(/\/+$/, '').toLowerCase() === b.trim().replace(/\/+$/, '').toLowerCase();

// A cloud provider's key, saved in the keyring at once, without Save
const KeyField = ({ provider, saved, onChange }: { provider: KeyProvider, saved: boolean | undefined, onChange: () => void }) => {
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = { groq: 'Groq', gemini: 'Gemini', anthropic: 'Claude (Anthropic)' }[provider];

  const run = async (call: () => Promise<unknown>) => {
    try {
      await call();
      setValue('');
      setEditing(false);
      setError(null);
      onChange();
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  return (
    <div className="space-y-1">
      {saved && !editing ? (
        <div className="flex h-9 items-center gap-2 text-sm">
          <Check className="size-4 text-success" />
          <span className="flex-1 text-muted-foreground">Key in the keyring</span>
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>Replace</Button>
          <Button size="sm" variant="ghost" onClick={() => run(() => window.kb.invoke('deleteKey', { provider }))}>Remove</Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Input
            aria-label={`${name} API key`}
            type="password"
            autoComplete="off"
            placeholder={saved === undefined ? 'Reading the keyring…' : `Paste the ${name} API key`}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <Button onClick={() => run(() => window.kb.invoke('setKey', { provider, key: value }))} disabled={!value.trim()}>Save</Button>
          {editing && <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>}
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
};

// Its text or image model, from those it has; none for not this
const ModelField = ({ label, value, models, disabled, onChange }: {
  label: string, value: string, models: string[], disabled?: boolean, onChange: (model: string) => void,
}) => {
  const choices = value && !models.includes(value) ? [value, ...models] : models;

  return (
    <div className="min-w-0 flex-1 space-y-1">
      {/* Above it on a narrow window; in it, on one line with the server, on a wide one */}
      <Label className="text-xs text-muted-foreground xl:sr-only">{label}</Label>
      <Select value={value || NONE} onValueChange={(model) => onChange(model === NONE ? '' : model)} disabled={disabled}>
        <SelectTrigger className="w-full" aria-label={label}>
          <span className="hidden shrink-0 text-muted-foreground xl:inline">{label}:</span>
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" className="max-h-72">
          <SelectItem value={NONE}>None</SelectItem>
          {choices.map((model) => <SelectItem key={model} value={model}>{model}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
};

interface ServerRowProps {
  server: AiServer;
  index: number;
  count: number;
  // The first with a text model answers the chat
  answers: boolean;
  keySaved: boolean | undefined;
  onChange: (server: AiServer) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: (() => void) | null;
  onKeys: () => void;
}

const ServerRow = ({ server, index, count, answers, keySaved, onChange, onMove, onRemove, onKeys }: ServerRowProps) => {
  const [found, setFound] = useState<{ at: string, reachable: boolean, text: string[], images: string[], error?: string } | null>(null);
  const cloud = server.kind !== 'ollama';
  // Checked again a moment after its address is typed, or when its key changes
  const at = cloud ? `${server.kind}:${String(keySaved)}` : server.url;

  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      window.kb.invoke('serverModels', { kind: server.kind, url: server.url })
        .then((result) => alive && setFound({ at, ...result }))
        .catch(() => alive && setFound({ at, reachable: false, text: [], images: [] }));
    }, cloud ? 0 : 600);

    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [at, cloud, server.kind, server.url]);

  const checked = found && (cloud ? found.at === at : sameUrl(found.at, server.url)) ? found : null;
  let state = 'Checking…';

  if (checked) {
    state = checked.reachable ? `${checked.text.length} models` : checked.error ?? 'Not reached';
  }

  if (cloud && keySaved === false) {
    state = 'No key';
  }

  return (
    // One line on a wide window: the server, its models, its queue; the models below it on a narrow one
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex flex-wrap items-start gap-x-2 gap-y-3">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <div className="flex flex-col pt-0.5">
            <Button variant="ghost" size="icon-sm" className="h-4" onClick={() => onMove(-1)} disabled={index === 0} aria-label={`Move ${server.name} up`}>
              <ArrowUp />
            </Button>
            <Button variant="ghost" size="icon-sm" className="h-4" onClick={() => onMove(1)} disabled={index === count - 1} aria-label={`Move ${server.name} down`}>
              <ArrowDown />
            </Button>
          </div>
          {cloud ? (
            <span className="flex h-9 w-36 shrink-0 items-center text-sm font-medium">{server.name}</span>
          ) : (
            <Input className="w-36 shrink-0" aria-label="Name" value={server.name} onChange={(event) => onChange({ ...server, name: event.target.value })} />
          )}
          <div className="min-w-0 flex-1 space-y-0.5">
            {cloud
              ? <KeyField provider={server.kind as KeyProvider} saved={keySaved} onChange={onKeys} />
              : <Input aria-label="Address (Ollama's API)" value={server.url} onChange={(event) => onChange({ ...server, url: event.target.value })} />}
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className={cn('size-2 rounded-full', { 'bg-success': checked?.reachable, 'bg-destructive': checked && !checked.reachable, 'bg-muted-foreground/50': !checked })} />
              {state}
              {answers && ' · answers the chat'}
            </p>
          </div>
        </div>
        <div className="order-3 flex basis-full gap-3 pl-9 xl:order-2 xl:basis-[28rem] xl:pl-0">
          <ModelField label="Text" value={server.text} models={checked?.text ?? []} onChange={(text) => onChange({ ...server, text })} />
          <ModelField
            label="Images"
            value={server.images}
            models={checked?.images ?? []}
            disabled={server.kind === 'groq'}
            onChange={(images) => onChange({ ...server, images })}
          />
        </div>
        <div className="order-2 flex items-start gap-2 xl:order-3">
          <label className="flex h-9 shrink-0 items-center gap-2 text-sm" title="Takes the background work: summaries, drafts, images">
            <Switch checked={server.queue} onCheckedChange={(queue) => onChange({ ...server, queue })} />
            Queue
          </label>
          {onRemove && (
            <Button variant="ghost" size="icon-sm" className="mt-1" onClick={onRemove} aria-label={`Remove ${server.name}`}>
              <Trash2 />
            </Button>
          )}
        </div>
      </div>
      {server.queue && cloud && (
        <p className="pl-9 text-xs text-muted-foreground">Its queue takes only the work of sources that may go to cloud AI (Sources).</p>
      )}
    </div>
  );
};

// A change of a server's address: the embeddings' model on it follows (SettingsPage)
export interface ServersChange {
  servers: AiServer[];
  moved?: { from: string, to: string };
}

export const AiServersList = ({ servers, keys, onChange, onKeys }: {
  servers: AiServer[],
  keys: Record<KeyProvider, boolean> | null,
  onChange: (change: ServersChange) => void,
  onKeys: () => void,
}) => {
  const ollama = servers.filter((server) => server.kind === 'ollama').length;
  const answering = servers.findIndex((server) => server.text);
  const move = (index: number, by: -1 | 1) => {
    const next = [...servers];
    [next[index], next[index + by]] = [next[index + by], next[index]];
    onChange({ servers: next });
  };

  return (
    <div className="space-y-3">
      <div className="space-y-3">
        {servers.map((server, index) => (
          <ServerRow
            key={server.kind === 'ollama' ? `ollama-${index}` : server.kind}
            server={server}
            index={index}
            count={servers.length}
            answers={index === answering}
            keySaved={server.kind === 'ollama' ? undefined : keys?.[server.kind]}
            onChange={(next) => onChange({
              servers: servers.map((other, at) => (at === index ? next : other)),
              ...(next.url !== server.url && { moved: { from: server.url, to: next.url } }),
            })}
            onMove={(by) => move(index, by)}
            // An Ollama server goes, but the last one
            onRemove={server.kind === 'ollama' && ollama > 1 ? () => onChange({ servers: servers.filter((_, at) => at !== index) }) : null}
            onKeys={onKeys}
          />
        ))}
      </div>
      <Button
        size="sm"
        variant="outline"
        onClick={() => onChange({
          servers: [...servers, { name: `Server ${ollama + 1}`, kind: 'ollama', url: 'http://127.0.0.1:11435', text: '', images: '', queue: true }],
        })}
      >
        <Plus />
        Add an Ollama server
      </Button>
    </div>
  );
};
