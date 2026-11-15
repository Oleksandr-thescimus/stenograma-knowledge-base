import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import type { ModelChoice, Settings } from '../../../../core/protocol';
import DraftStyleField from '@/components/DraftStyleField';
import Expandable from '@/components/Expandable';
import FileSettings from '@/components/ImageSettings';
import { AiServersList } from '@/components/AiServers';
import ModelPicker from '@/components/ModelPicker';
import MeetingSeriesCard from '@/components/MeetingSeriesCard';
import SummaryTryPanel from '@/components/SummaryTry';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { errorMessage, useAppStatus } from '@/lib/kb';
import { answersLlm, mergeOutside } from '@/lib/servers';

// The settings, a tab each: AI models (the servers, in the chat's order, each with its text and image models, its
// background queue and a cloud provider's key, F6; the index's embedding model, F7), Meetings (summaries and the meeting
// series), Chats (their files, reply drafts) and General (the extension's port, N2; the data's folder). Starting at login
// is in the tray's menu. One Save for all the tabs, but the keys, which are saved at once. What the background work does
// now is on the Activity page. The settings file and the keyring are the core's: this page reads and writes them
// through it

const sameUrl = (a: string, b: string) => a.trim().replace(/\/+$/, '').toLowerCase() === b.trim().replace(/\/+$/, '').toLowerCase();

// A server's new address: the embeddings' model on it follows
const withServerMoved = (form: Settings, from: string, to: string): Settings => (form.embedding.provider === 'ollama' && sameUrl(form.embedding.ollamaUrl, from)
  ? { ...form, embedding: { ...form.embedding, ollamaUrl: to } }
  : form);

const DAY_CHOICES = [['1', 'The last day'], ['3', 'The last 3 days'], ['7', 'The last week'], ['14', 'The last 2 weeks'], ['30', 'The last 30 days']];

type SettingsTab = 'models' | 'meetings' | 'chats' | 'general';

const TABS: { value: SettingsTab, label: string }[] = [
  { value: 'models', label: 'AI models' },
  { value: 'meetings', label: 'Meetings' },
  { value: 'chats', label: 'Chats' },
  { value: 'general', label: 'General' },
];

// Each tab's part of the settings, to mark a tab with changes not saved
const TAB_PARTS: Record<SettingsTab, (settings: Settings) => unknown> = {
  models: ({ servers, embedding }) => [servers, embedding],
  meetings: ({ summaries }) => [summaries.auto, summaries.months],
  chats: ({ attachments, drafts }) => [attachments.describeImages, attachments.readDocuments, attachments.months, drafts.unreadDays, drafts.maxAgeDays, drafts.style],
  general: ({ server }) => server,
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

const SettingsPage = ({ onOpenActivity }: { onOpenActivity: () => void }) => {
  const status = useAppStatus();
  const [saved, setSaved] = useState<Settings | null>(null);
  const [form, setForm] = useState<Settings | null>(null);
  const [keys, setKeys] = useState<Record<string, boolean> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [tab, setTab] = useState<SettingsTab>('models');
  const [embeddingModels, setEmbeddingModels] = useState<ModelChoice[]>([]);
  const running = status?.process.state === 'running';

  // Read again when a server's queue is turned on or off elsewhere (Activity, the tray), so Save never undoes it
  const queues = JSON.stringify(status?.core?.ai.lanes.map((lane) => [lane.id, lane.queue]));
  const savedRef = useRef<Settings | null>(null);

  useEffect(() => {
    if (!running) {
      return;
    }

    window.kb.invoke('getSettings', {}).then((settings) => {
      const before = savedRef.current;
      savedRef.current = settings;
      setSaved(settings);
      setForm((current) => (current && before ? mergeOutside(current, before, settings) : current ?? settings));
    }).catch((reason: unknown) => setError(errorMessage(reason)));
  }, [running, queues]);

  // An OpenAI-compatible API's key is its address's: asked for those typed
  const openaiUrls = JSON.stringify((form?.servers ?? []).filter((server) => server.kind === 'openai' && URL.canParse(server.url)).map((server) => server.url));
  const readKeys = () => window.kb.invoke('keys', { urls: JSON.parse(openaiUrls) as string[] }).then(setKeys).catch((reason: unknown) => setError(errorMessage(reason)));

  // Every saved server's models, and the cloud's with their keys: listed again when the keys or the servers change
  const savedServers = JSON.stringify(saved?.servers);

  useEffect(() => {
    if (running) {
      window.kb.invoke('taskModels', { task: 'embeddings' }).then(setEmbeddingModels).catch(() => setEmbeddingModels([]));
    }
  }, [running, keys, savedServers]);

  useEffect(() => {
    if (!running) {
      return undefined;
    }

    // A moment after an address is typed
    const timer = setTimeout(readKeys, 400);

    return () => clearTimeout(timer);
  }, [running, openaiUrls]);

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
  const set = (next: Settings) => {
    setJustSaved(false);
    setForm(next);
  };
  const serversUnsaved = JSON.stringify(form.servers) !== JSON.stringify(saved.servers);
  const rebuild = status?.core?.embedding.rebuild;
  const changed = (part: SettingsTab) => JSON.stringify(TAB_PARTS[part](form)) !== JSON.stringify(TAB_PARTS[part](saved));
  const activityLink = (
    <Button variant="link" size="sm" className="h-auto p-0" onClick={onOpenActivity}>Activity</Button>
  );

  const save = async () => {
    setSaving(true);
    setError(null);

    try {
      const next = await window.kb.invoke('saveSettings', form);
      savedRef.current = next;
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
      <div className="mx-auto max-w-3xl p-6 pb-24 xl:max-w-6xl">
        <Tabs value={tab} onValueChange={(next) => setTab(next as SettingsTab)} className="gap-6">
          <div className="flex items-center gap-4">
            <h2 className="text-xl">Settings</h2>
            <TabsList>
              {TABS.map(({ value, label }) => (
                <TabsTrigger key={value} value={value}>
                  {label}
                  {changed(value) && <span className="size-1.5 rounded-full bg-warning" aria-label="Not saved" />}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          <TabsContent value="models" forceMount className="space-y-6 data-[state=inactive]:hidden">
            <Card
              title="AI servers"
              description="Where the models run, in the chat's order: the first reached with a text model answers, the next one when it isn't. Every server with its queue on takes the next summary, reply draft or image it has a model for, so they work at the same time; on each, what you ask for goes first. An Ollama server at a loopback address (127.0.0.1) counts as this computer for the sources that may not go to cloud AI. Keys are saved at once, in the system's keyring."
            >
              <AiServersList
                servers={form.servers}
                keys={keys}
                onKeys={readKeys}
                onChange={({ servers, moved }) => set({ ...(moved ? withServerMoved(form, moved.from, moved.to) : form), servers })}
              />
              {!form.servers.some((server) => server.queue && (server.text || server.images)) && (
                <p className="text-xs text-warning">No server takes the background work: turn a queue on, with a model for it.</p>
              )}
            </Card>
            <Card
              title="Embeddings"
              description="The index's model, which finds chunks by meaning: one for the whole index. A new one is built in the background; the search keeps the current one until it's done. Gemini's needs its key above."
            >
              {serversUnsaved && <p className="text-xs text-warning">Save to list the models of the servers as changed.</p>}
              <ModelPicker
                models={embeddingModels}
                value={form.embedding}
                ollamaUrl={form.embedding.ollamaUrl}
                onChange={(llm) => {
                  if (llm.provider === 'ollama' || llm.provider === 'gemini') {
                    update('embedding', { provider: llm.provider, model: llm.model, ollamaUrl: llm.ollamaUrl || form.embedding.ollamaUrl });
                  }
                }}
                className="w-full"
              />
              {embeddingChanged && (
                <p className="text-xs text-warning">
                  Saving builds the whole index again with this model: with Ollama on this computer, ~7 minutes per 3500 chunks.
                  {form.embedding.provider === 'gemini' && ' Gemini embeds only the sources that may go to cloud AI.'}
                </p>
              )}
              {rebuild && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  Building {rebuild.model}: {rebuild.total - rebuild.pending} of {rebuild.total} chunks. Its progress is on
                  {' '}
                  {activityLink}.
                </p>
              )}
            </Card>
          </TabsContent>
          <TabsContent value="meetings" forceMount className="space-y-6 data-[state=inactive]:hidden">
            <Card
              title="Summaries"
              description="A short summary of each meeting of a named series (below), made in the background by the answers' model, so a question about many meetings is answered from one each."
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
              {status?.core?.summaries && (
                <p className="text-sm text-muted-foreground">
                  {status.core.summaries.done.toLocaleString()} made, {status.core.summaries.pending.toLocaleString()} waiting; their progress is on
                  {' '}
                  {activityLink}.
                </p>
              )}
              <Expandable label="Compare models on a meeting">
                <SummaryTryPanel defaultLlm={answersLlm(saved.servers)} />
              </Expandable>
            </Card>
            {running && <MeetingSeriesCard />}
          </TabsContent>
          <TabsContent value="chats" forceMount className="space-y-6 data-[state=inactive]:hidden">
            <Card
              title="Images and files"
              description="Read in the background, newest first, and found with their message. An image's description is marked as made by AI."
            >
              <FileSettings settings={form.attachments} servers={form.servers} savedServers={saved.servers} onChange={(patch) => update('attachments', patch)} />
            </Card>
            <Card
              title="Reply drafts"
              description="Which messages to you get a draft by their age, on a Rocket.Chat source with &quot;Draft replies&quot; on (Sources), written by the servers whose queue is on (AI models). Any conversation's draft can also be asked for by hand on the Reply drafts page."
            >
              <Field label="When turned on, the unread ones of" hint="Messages from before drafts were turned on count only while unread in Rocket.Chat.">
                <Select value={String(form.drafts.unreadDays)} onValueChange={(days) => update('drafts', { unreadDays: Number(days) })}>
                  <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {DAY_CHOICES.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="None older than" hint="As when the app was off: a message this old is answered or forgotten by then. It caps the unread ones too.">
                <Select value={String(form.drafts.maxAgeDays)} onValueChange={(days) => update('drafts', { maxAgeDays: Number(days) })}>
                  <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {DAY_CHOICES.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
              {running && <DraftStyleField value={form.drafts.style} onChange={(style) => update('drafts', { style })} />}
            </Card>
          </TabsContent>
          <TabsContent value="general" forceMount className="space-y-6 data-[state=inactive]:hidden">
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
            <Card title="Data" description="The knowledge base, its index and the chats' files, on this computer only. Starting at login is in the tray's menu.">
              <p className="font-mono text-sm">{status?.core?.dataDir}</p>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
      <div className="sticky bottom-0 border-t bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-end gap-3 p-4 xl:max-w-6xl">
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
