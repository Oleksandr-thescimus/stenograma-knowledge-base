import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Check, Plus, Trash2 } from 'lucide-react';
import { cn } from 'cn';
import type { AiServer, KeyProvider } from '../../../../core/protocol';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { errorMessage } from '@/lib/kb';

// The AI servers (Settings → AI models), in the chat's order: this computer's Ollama, others with Ollama's API (an
// Orange Pi's RKLLama through an SSH tunnel), Groq's, Gemini's, Claude's and Ollama Cloud's APIs with their keys, and
// OpenAI-compatible APIs (Cerebras, OpenRouter, Mistral…) with their address and key. Each has its model for text
// (answers, summaries, drafts) and for images, checked as it's typed, and its background queue on or off: every server
// with the queue on takes the next meeting, draft or image it has a model for

const NONE = '\u0000none';

const normalized = (url: string) => url.trim().replace(/\/+$/, '').toLowerCase();
const sameUrl = (a: string, b: string) => normalized(a) === normalized(b);
// Known by their address: there may be several
const hasAddress = (kind: AiServer['kind']) => kind === 'ollama' || kind === 'openai';
// Its key's id in keys (the core's keyIdOf)
const keyIdOf = (server: AiServer) => (server.kind === 'openai' ? `openai:${normalized(server.url)}` : server.kind);

// OpenAI-compatible APIs with a free tier, their address ready; their limits and terms change, see each one's site
const OPENAI_PRESETS = [
  { name: 'Cerebras', url: 'https://api.cerebras.ai/v1' },
  { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1' },
  { name: 'Mistral', url: 'https://api.mistral.ai/v1' },
  { name: 'NVIDIA', url: 'https://integrate.api.nvidia.com/v1' },
  { name: 'SambaNova', url: 'https://api.sambanova.ai/v1' },
  { name: 'GitHub Models', url: 'https://models.github.ai/inference' },
];

// A cloud provider's key, saved in the keyring at once, without Save
const KeyField = ({ provider, url, label, saved, onChange }: {
  provider: KeyProvider, url?: string, label: string, saved: boolean | undefined, onChange: () => void,
}) => {
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = label;
  // An OpenAI-compatible API's key is its address's
  const where = provider === 'openai' ? { url } : {};
  const noAddress = provider === 'openai' && !(url && URL.canParse(url));

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
          <Button size="sm" variant="ghost" onClick={() => run(() => window.kb.invoke('deleteKey', { provider, ...where }))}>Remove</Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Input
            aria-label={`${name} API key`}
            type="password"
            autoComplete="off"
            placeholder={saved === undefined && !noAddress ? 'Reading the keyring…' : `Paste the ${name} API key`}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <Button onClick={() => run(() => window.kb.invoke('setKey', { provider, key: value, ...where }))} disabled={!value.trim() || noAddress}>Save</Button>
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
  // Groq, Gemini, Claude, Ollama Cloud: one each, named by the app
  const fixed = !hasAddress(server.kind);
  // Checked again a moment after its address is typed, or when its key changes
  const at = cloud ? `${server.kind}:${server.url}:${String(keySaved)}` : server.url;

  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      window.kb.invoke('serverModels', { kind: server.kind, url: server.url })
        .then((result) => alive && setFound({ at, ...result }))
        .catch(() => alive && setFound({ at, reachable: false, text: [], images: [] }));
    }, fixed ? 0 : 600);

    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [at, fixed, server.kind, server.url]);

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
          {fixed ? (
            <span className="flex h-9 w-36 shrink-0 items-center text-sm font-medium">{server.name}</span>
          ) : (
            <Input className="w-36 shrink-0" aria-label="Name" value={server.name} onChange={(event) => onChange({ ...server, name: event.target.value })} />
          )}
          <div className="min-w-0 flex-1 space-y-0.5">
            {hasAddress(server.kind) && (
              <Input
                aria-label={server.kind === 'openai' ? 'Address (an OpenAI-compatible API)' : 'Address (Ollama\'s API)'}
                placeholder={server.kind === 'openai' ? 'https://api.example.com/v1' : undefined}
                value={server.url}
                onChange={(event) => onChange({ ...server, url: event.target.value })}
              />
            )}
            {cloud && (
              <KeyField
                provider={server.kind as KeyProvider}
                url={server.url}
                label={server.kind === 'anthropic' ? 'Claude (Anthropic)' : server.name}
                saved={keySaved}
                onChange={onKeys}
              />
            )}
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
  keys: Record<string, boolean> | null,
  onChange: (change: ServersChange) => void,
  onKeys: () => void,
}) => {
  const ollama = servers.filter((server) => server.kind === 'ollama').length;
  const answering = servers.findIndex((server) => server.text);
  // Its queue off at first: a free tier's limits are small, and it takes only the sources that may go to cloud AI
  const add = ({ name, url }: { name: string, url: string }) => onChange({
    servers: [...servers, { name, kind: 'openai', url, text: '', images: '', queue: false }],
  });
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
            key={hasAddress(server.kind) ? `${server.kind}-${index}` : server.kind}
            server={server}
            index={index}
            count={servers.length}
            answers={index === answering}
            keySaved={server.kind === 'ollama' ? undefined : keys?.[keyIdOf(server)]}
            onChange={(next) => onChange({
              servers: servers.map((other, at) => (at === index ? next : other)),
              ...(next.url !== server.url && { moved: { from: server.url, to: next.url } }),
            })}
            onMove={(by) => move(index, by)}
            // An Ollama server goes, but the last one; an OpenAI-compatible API always
            onRemove={(server.kind === 'ollama' && ollama > 1) || server.kind === 'openai' ? () => onChange({ servers: servers.filter((_, at) => at !== index) }) : null}
            onKeys={onKeys}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline">
              <Plus />
              Add an OpenAI-compatible API
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {OPENAI_PRESETS.filter((preset) => !servers.some((server) => sameUrl(server.url, preset.url))).map((preset) => (
              <DropdownMenuItem key={preset.url} onSelect={() => add(preset)}>{preset.name}</DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => add({ name: 'API', url: '' })}>Another, by its address</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
};
