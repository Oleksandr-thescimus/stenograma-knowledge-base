import { useEffect, useState } from 'react';
import { Loader2, ScanText } from 'lucide-react';
import { cn } from 'cn';
import type { AttachmentSettings, AttachmentStatus, ImageChoice, ImageTry } from '../../../../core/protocol';
import ChatImage from '@/components/ChatImage';
import ImagePause from '@/components/ImagePause';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { formatDay } from '@/lib/format';
import { errorMessage } from '@/lib/kb';

// Images and files in chats (F3): the vision model that reads images, the period read, documents, the queue's status,
// and a try of the model (as set here, saved or not) on an image of the chats, which keeps nothing

const PERIODS = [
  { value: '1', label: 'The last month' },
  { value: '3', label: 'The last 3 months' },
  { value: '6', label: 'The last 6 months' },
  { value: '12', label: 'The last 12 months' },
  { value: '0', label: 'All' },
];
const DEFAULT_MODELS = { ollama: 'qwen3.5:9b', gemini: 'gemini-2.5-flash' };

const ModelField = ({ settings, onChange }: { settings: AttachmentSettings, onChange: (patch: Partial<AttachmentSettings>) => void }) => {
  const [models, setModels] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (settings.provider !== 'ollama') {
      return undefined;
    }

    let alive = true;
    setError(null);
    window.kb.invoke('visionModels', { ollamaUrl: settings.ollamaUrl })
      .then((found) => alive && setModels(found))
      .catch((reason: unknown) => {
        if (alive) {
          setModels(null);
          setError(errorMessage(reason));
        }
      });

    return () => {
      alive = false;
    };
  }, [settings.provider, settings.ollamaUrl]);

  if (settings.provider === 'ollama' && models?.length) {
    const choices = models.includes(settings.model) ? models : [settings.model, ...models];

    return (
      <Select value={settings.model} onValueChange={(model) => onChange({ model })}>
        <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>
          {choices.map((model) => <SelectItem key={model} value={model}>{model}</SelectItem>)}
        </SelectContent>
      </Select>
    );
  }

  return (
    <div className="space-y-1">
      <Input id="image-model" value={settings.model} onChange={(event) => onChange({ model: event.target.value })} />
      {settings.provider === 'ollama' && (
        <p className="text-xs text-muted-foreground">{error ?? (models ? 'None of Ollama\'s models reads images.' : 'Listing Ollama\'s models…')}</p>
      )}
    </div>
  );
};

// The model on an image of the chats, as a try
const ImageTryPanel = ({ settings }: { settings: AttachmentSettings }) => {
  const [images, setImages] = useState<ImageChoice[] | null>(null);
  const [chosen, setChosen] = useState<ImageChoice | null>(null);
  const [result, setResult] = useState<ImageTry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.kb.invoke('recentImages', {}).then(setImages).catch((reason: unknown) => setError(errorMessage(reason)));
  }, []);

  const tryIt = async () => {
    if (chosen) {
      setBusy(true);
      setError(null);
      setResult(null);

      try {
        setResult(await window.kb.invoke('tryImageModel', {
          sourceId: chosen.sourceId,
          fileId: chosen.fileId,
          model: { provider: settings.provider, model: settings.model, ollamaUrl: settings.ollamaUrl },
        }));
      } catch (reason) {
        setError(errorMessage(reason));
      } finally {
        setBusy(false);
      }
    }
  };

  if (images && !images.length) {
    return <p className="text-sm text-muted-foreground">No images in the chats yet to try the model on.</p>;
  }

  return (
    <div className="space-y-3">
      <Label>Try it on an image of the chats</Label>
      <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
        {images?.slice(0, 12).map((image) => (
          <ChatImage
            key={`${image.sourceId}:${image.fileId}`}
            sourceId={image.sourceId}
            fileId={image.fileId}
            name={`${image.name} · ${image.room} · ${formatDay(image.ts)}`}
            className={cn('aspect-square w-full ring-offset-2 ring-offset-card', chosen?.fileId === image.fileId && 'ring-2 ring-primary')}
            onClick={() => {
              setChosen(image);
              setResult(null);
            }}
          />
        ))}
      </div>
      {chosen && (
        <div className="space-y-3 rounded-md border p-3">
          <div className="flex items-start gap-3">
            <ChatImage sourceId={chosen.sourceId} fileId={chosen.fileId} name={chosen.name} className="h-32 w-48 shrink-0" />
            <div className="min-w-0 space-y-2 text-sm">
              <p className="truncate text-muted-foreground">{chosen.name} · {chosen.room} · {formatDay(chosen.ts)}</p>
              <Button size="sm" onClick={tryIt} disabled={busy || !settings.model.trim()}>
                {busy ? <Loader2 className="animate-spin" /> : <ScanText />}
                {busy ? `Reading with ${settings.model}…` : `Read with ${settings.model}`}
              </Button>
            </div>
          </div>
          {result && (
            <div className="space-y-2 text-sm">
              <p className="text-xs text-muted-foreground">{result.model} · {(result.ms / 1000).toFixed(1)} s · nothing is kept</p>
              <p><span className="font-medium">Description:</span> {result.description ?? '—'}</p>
              <div>
                <span className="font-medium">Text in it:</span>
                <p className="mt-1 max-h-48 overflow-y-auto rounded bg-muted p-2 whitespace-pre-wrap">{result.text ?? 'None'}</p>
              </div>
            </div>
          )}
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
};

interface ImageSettingsProps {
  settings: AttachmentSettings;
  saved: AttachmentSettings;
  status: AttachmentStatus | undefined;
  onChange: (patch: Partial<AttachmentSettings>) => void;
}

const ImageSettings = ({ settings, saved, status, onChange }: ImageSettingsProps) => {
  const [again, setAgain] = useState<string | null>(null);
  const modelChanged = settings.provider !== saved.provider || settings.model !== saved.model;

  const readAgain = async () => {
    try {
      const { images } = await window.kb.invoke('readImagesAgain', {});
      setAgain(`${images} images will be read again`);
    } catch (reason) {
      setAgain(errorMessage(reason));
    }
  };

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={settings.describeImages} onCheckedChange={(describeImages) => onChange({ describeImages })} />
        Read images: their text word for word, and what they show
      </label>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Provider</Label>
          <Select
            value={settings.provider}
            onValueChange={(provider) => onChange({ provider: provider as AttachmentSettings['provider'], model: DEFAULT_MODELS[provider as 'ollama' | 'gemini'] })}
          >
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ollama">Ollama, on this computer</SelectItem>
              <SelectItem value="gemini">Gemini</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="image-model">Model</Label>
          <ModelField settings={settings} onChange={onChange} />
        </div>
        {settings.provider === 'ollama' && (
          <div className="space-y-1.5">
            <Label htmlFor="image-ollama">Ollama&apos;s address</Label>
            <Input id="image-ollama" value={settings.ollamaUrl} onChange={(event) => onChange({ ollamaUrl: event.target.value })} />
          </div>
        )}
        <div className="space-y-1.5">
          <Label>Files of</Label>
          <Select value={String(settings.months)} onValueChange={(months) => onChange({ months: Number(months) })}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PERIODS.map(({ value, label }) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>
      {settings.provider === 'gemini' && (
        <p className="text-xs text-muted-foreground">
          Only chats that may go to cloud AI are sent to Gemini; the others&apos; images are read by Ollama&apos;s
          {' '}
          {DEFAULT_MODELS.ollama}.
        </p>
      )}
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={settings.readDocuments} onCheckedChange={(readDocuments) => onChange({ readDocuments })} />
        Read PDFs and text files (without a model; a scanned PDF has no text)
      </label>
      {status && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          {status.running && <Loader2 className="size-4 animate-spin" />}
          {status.done} read · {status.pending} waiting{status.failed ? ` · ${status.failed} not read` : ''}
          {status.running && ' · reading'}
        </p>
      )}
      {status?.error && <p className="text-sm text-destructive">{status.error}. It&apos;s tried again in a minute.</p>}
      {status && settings.describeImages && <ImagePause status={status} />}
      <div className="flex items-center gap-3">
        <Button size="sm" variant="outline" onClick={readAgain} disabled={modelChanged}>Read all images again</Button>
        <span className="text-xs text-muted-foreground">
          {modelChanged ? 'Save the new model first.' : again ?? 'With the model saved: the ones read before keep theirs until then.'}
        </span>
      </div>
      <ImageTryPanel settings={settings} />
    </div>
  );
};

export default ImageSettings;
