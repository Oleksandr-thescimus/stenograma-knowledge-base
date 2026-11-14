import { useEffect, useState, type ReactNode } from 'react';
import { Check, Loader2 } from 'lucide-react';
import type { KeyProvider, Settings } from '../../../../core/protocol';
import ImageSettings from '@/components/ImageSettings';
import SummaryProgress from '@/components/SummaryProgress';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { errorMessage, useAppStatus } from '@/lib/kb';

// The LLM and its keys (F6), the embedding model (F7), and the extension's port (N2); starting at login is in the tray's
// menu. The settings file and the keyring are the core's: this page reads and writes them through it

const LLM_PROVIDERS = [
  { value: 'ollama', label: 'Ollama, on this computer' },
  { value: 'groq', label: 'Groq' },
  { value: 'gemini', label: 'Gemini' },
];
const EMBEDDING_PROVIDERS = [
  { value: 'ollama', label: 'Ollama, on this computer' },
  { value: 'gemini', label: 'Gemini' },
];
// A model to start from when the provider changes
const DEFAULT_MODELS: Record<string, string> = {
  ollama: 'qwen3.5:9b',
  groq: 'openai/gpt-oss-120b',
  gemini: 'gemini-2.5-flash',
  'embedding:ollama': 'bge-m3',
  'embedding:gemini': 'gemini-embedding-001',
};

const Card = ({ title, description, children }: { title: string, description?: string, children: ReactNode }) => (
  <section className="space-y-4 rounded-lg border bg-card p-4">
    <div>
      <h3 className="font-medium">{title}</h3>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
    </div>
    {children}
  </section>
);

const Field = ({ id, label, children, hint }: { id?: string, label: string, children: ReactNode, hint?: string }) => (
  <div className="space-y-1.5">
    <Label htmlFor={id}>{label}</Label>
    {children}
    {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
  </div>
);

const KeyRow = ({ provider, saved, onChange }: { provider: KeyProvider, saved: boolean | undefined, onChange: () => void }) => {
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = provider === 'groq' ? 'Groq' : 'Gemini';

  const save = async () => {
    try {
      await window.kb.invoke('setKey', { provider, key: value });
      setValue('');
      setEditing(false);
      setError(null);
      onChange();
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  const remove = async () => {
    try {
      await window.kb.invoke('deleteKey', { provider });
      onChange();
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  return (
    <div className="space-y-1.5">
      <Label htmlFor={`key-${provider}`}>{name} key</Label>
      {saved && !editing ? (
        <div className="flex items-center gap-2 text-sm">
          <Check className="size-4 text-success" />
          <span className="flex-1 text-muted-foreground">In the keyring</span>
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>Replace</Button>
          <Button size="sm" variant="ghost" onClick={remove}>Remove</Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Input
            id={`key-${provider}`}
            type="password"
            autoComplete="off"
            placeholder={saved === undefined ? 'Reading the keyring…' : `Paste the ${name} API key`}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <Button onClick={save} disabled={!value.trim()}>Save</Button>
          {editing && <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>}
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
};

const SettingsPage = () => {
  const status = useAppStatus();
  const [saved, setSaved] = useState<Settings | null>(null);
  const [form, setForm] = useState<Settings | null>(null);
  const [keys, setKeys] = useState<Record<KeyProvider, boolean> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const running = status?.process.state === 'running';

  useEffect(() => {
    if (!running) {
      return;
    }

    window.kb.invoke('getSettings', {}).then((settings) => {
      setSaved(settings);
      setForm((current) => current ?? settings);
    }).catch((reason: unknown) => setError(errorMessage(reason)));
  }, [running]);

  const readKeys = () => window.kb.invoke('keys', {}).then(setKeys).catch((reason: unknown) => setError(errorMessage(reason)));

  useEffect(() => {
    if (running) {
      readKeys();
    }
  }, [running]);

  if (!form || !saved) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {error ?? (running ? 'Loading the settings…' : 'The settings are shown while the knowledge base runs.')}
      </div>
    );
  }

  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const embeddingChanged = JSON.stringify(form.embedding) !== JSON.stringify(saved.embedding);
  const update = <K extends keyof Settings>(section: K, patch: Partial<Settings[K]>) => {
    setJustSaved(false);
    setForm({ ...form, [section]: { ...form[section], ...patch } });
  };
  const rebuild = status?.core?.embedding.rebuild;

  const save = async () => {
    setSaving(true);
    setError(null);

    try {
      const next = await window.kb.invoke('saveSettings', form);
      setSaved(next);
      setForm(next);
      setJustSaved(true);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 p-6 pb-24">
        <h2 className="text-xl">Settings</h2>
        <Card title="Answers" description="The model that rewrites questions and answers them. Ollama keeps everything on this computer.">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Provider">
              <Select
                value={form.llm.provider}
                onValueChange={(provider) => update('llm', { provider: provider as Settings['llm']['provider'], model: DEFAULT_MODELS[provider] })}
              >
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {LLM_PROVIDERS.map((provider) => <SelectItem key={provider.value} value={provider.value}>{provider.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field id="llm-model" label="Model">
              <Input id="llm-model" value={form.llm.model} onChange={(event) => update('llm', { model: event.target.value })} />
            </Field>
            {form.llm.provider === 'ollama' && (
              <Field id="llm-ollama" label="Ollama's address">
                <Input id="llm-ollama" value={form.llm.ollamaUrl} onChange={(event) => update('llm', { ollamaUrl: event.target.value })} />
              </Field>
            )}
          </div>
          {form.llm.provider !== 'ollama' && (
            <p className="text-xs text-muted-foreground">
              Only sources that may go to cloud AI are sent to it (Sources); the others are left out of its answers.
            </p>
          )}
        </Card>
        <Card title="Keys" description="Kept in the system's keyring, never in the settings file. Gemini's key serves its embeddings too.">
          <KeyRow provider="groq" saved={keys?.groq} onChange={readKeys} />
          <KeyRow provider="gemini" saved={keys?.gemini} onChange={readKeys} />
        </Card>
        <Card
          title="Embeddings"
          description="The model that finds chunks by meaning. A new one is built in the background; the search keeps the current one until it's done."
        >
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Provider">
              <Select
                value={form.embedding.provider}
                onValueChange={(provider) => update('embedding', {
                  provider: provider as Settings['embedding']['provider'], model: DEFAULT_MODELS[`embedding:${provider}`],
                })}
              >
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {EMBEDDING_PROVIDERS.map((provider) => <SelectItem key={provider.value} value={provider.value}>{provider.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field id="embedding-model" label="Model">
              <Input id="embedding-model" value={form.embedding.model} onChange={(event) => update('embedding', { model: event.target.value })} />
            </Field>
            {form.embedding.provider === 'ollama' && (
              <Field id="embedding-ollama" label="Ollama's address">
                <Input
                  id="embedding-ollama"
                  value={form.embedding.ollamaUrl}
                  onChange={(event) => update('embedding', { ollamaUrl: event.target.value })}
                />
              </Field>
            )}
          </div>
          {embeddingChanged && (
            <p className="text-xs text-warning">
              Saving builds the whole index again with this model: with Ollama on this computer, ~7 minutes per 3500 chunks.
              {form.embedding.provider === 'gemini' && ' Gemini embeds only the sources that may go to cloud AI.'}
            </p>
          )}
          {rebuild && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Building {rebuild.model}: {rebuild.total - rebuild.pending} of {rebuild.total} chunks
            </p>
          )}
        </Card>
        <Card
          title="Images and files in chats"
          description="Read in the background, newest first, and found with their message. A vision model reads an image's text and says what it shows; it's marked as described by AI."
        >
          <ImageSettings
            settings={form.attachments}
            saved={saved.attachments}
            status={status?.core?.attachments}
            onChange={(patch) => update('attachments', patch)}
          />
        </Card>
        <Card
          title="Meeting summaries"
          description="A short summary of each meeting of a named series (Sources → Meeting series), made in the background by the answers' model, so a question about many meetings is answered from one each."
        >
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={form.summaries.auto} onCheckedChange={(auto) => update('summaries', { auto })} />
            Summarize the series&apos; meetings in the background
          </label>
          <Field label="Meetings of">
            <Select value={String(form.summaries.months)} onValueChange={(months) => update('summaries', { months: Number(months) })}>
              <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
              <SelectContent>
                {[['1', 'The last month'], ['3', 'The last 3 months'], ['6', 'The last 6 months'], ['12', 'The last 12 months'], ['0', 'All']]
                  .map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          {status?.core?.summaries && <SummaryProgress status={status.core.summaries} />}
        </Card>
        <Card title="The extension" description="Stenograma in the browser sends its meetings to this port on 127.0.0.1.">
          <Field id="port" label="Port" hint="Change it in the extension's popup too.">
            <Input
              id="port"
              type="number"
              min={1024}
              max={65535}
              className="w-32"
              value={form.server.port}
              onChange={(event) => update('server', { port: Number(event.target.value) })}
            />
          </Field>
        </Card>
      </div>
      <div className="sticky bottom-0 border-t bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-end gap-3 p-4">
          {error && <p className="flex-1 text-sm text-destructive">{error}</p>}
          {justSaved && !dirty && <p className="text-sm text-muted-foreground">Saved</p>}
          {dirty && <Button variant="ghost" onClick={() => setForm(saved)}>Undo changes</Button>}
          <Button onClick={save} disabled={!dirty || saving}>Save</Button>
        </div>
      </div>
    </div>
  );
};

export default SettingsPage;
