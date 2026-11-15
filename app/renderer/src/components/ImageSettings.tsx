import { useEffect, useState } from 'react';
import { Loader2, ScanText } from 'lucide-react';
import { cn } from 'cn';
import type { AiServer, AttachmentSettings, ImageChoice, ImageTry, LlmSettings } from '../../../../core/protocol';
import ChatImage from '@/components/ChatImage';
import Expandable from '@/components/Expandable';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { formatDay } from '@/lib/format';
import { errorMessage } from '@/lib/kb';

// Images and files in chats (F3): what is read, of when, and a try of the vision model (Settings → AI models) on an image
// of the chats, which keeps nothing. Their queue is on the Activity page

const PERIODS = [
  { value: '1', label: 'The last month' },
  { value: '3', label: 'The last 3 months' },
  { value: '6', label: 'The last 6 months' },
  { value: '12', label: 'The last 12 months' },
  { value: '0', label: 'All' },
];
// The servers' image models, in the settings' order
const imageModels = (servers: AiServer[]) => servers.filter((server) => server.images && server.kind !== 'groq').map((server) => ({
  key: `${server.kind}|${server.url}|${server.images}`,
  label: `${server.images} · ${server.name}`,
  llm: { provider: server.kind, model: server.images, ollamaUrl: server.kind === 'ollama' ? server.url : '' } as LlmSettings,
}));

// A model on an image of the chats, as a try
const ImageTryPanel = ({ servers }: { servers: AiServer[] }) => {
  const models = imageModels(servers);
  const [modelKey, setModelKey] = useState(models[0]?.key ?? '');
  const model = (models.find((candidate) => candidate.key === modelKey) ?? models[0])?.llm;
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
          model: model!,
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
              {models.length > 1 && (
                <Select value={modelKey || models[0].key} onValueChange={setModelKey}>
                  <SelectTrigger size="sm" className="w-64" aria-label="The model to try"><SelectValue /></SelectTrigger>
                  <SelectContent position="popper">
                    {models.map((candidate) => <SelectItem key={candidate.key} value={candidate.key}>{candidate.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}
              <Button size="sm" onClick={tryIt} disabled={busy || !model}>
                {busy ? <Loader2 className="animate-spin" /> : <ScanText />}
                {busy ? `Reading with ${model?.model}…` : `Read with ${model?.model ?? 'no image model'}`}
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

interface FileSettingsProps {
  settings: AttachmentSettings;
  // The servers as set, and as saved: the images are read again only with the image models saved
  servers: AiServer[];
  savedServers: AiServer[];
  onChange: (patch: Partial<AttachmentSettings>) => void;
}

// Settings → Chats: what is read of the chats' files and of when; reading the images again with the model saved, and a
// try of the model (as set in AI models, saved or not)
const FileSettings = ({ settings, servers, savedServers, onChange }: FileSettingsProps) => {
  const [again, setAgain] = useState<string | null>(null);
  const modelChanged = JSON.stringify(imageModels(servers).map((model) => model.key)) !== JSON.stringify(imageModels(savedServers).map((model) => model.key));

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
        Read images: their text word for word, and what they show (by the servers&apos; image models in AI models)
      </label>
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={settings.readDocuments} onCheckedChange={(readDocuments) => onChange({ readDocuments })} />
        Read PDFs and text files (without a model; a scanned PDF has no text)
      </label>
      <div className="space-y-1.5">
        <Label>Files of</Label>
        <Select value={String(settings.months)} onValueChange={(months) => onChange({ months: Number(months) })}>
          <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
          <SelectContent>
            {PERIODS.map(({ value, label }) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-3">
        <Button size="sm" variant="outline" onClick={readAgain} disabled={modelChanged}>Read all images again</Button>
        <span className="text-xs text-muted-foreground">
          {modelChanged ? 'Save the new image models first.' : again ?? 'With the image models saved: the ones read before keep theirs until then.'}
        </span>
      </div>
      <Expandable label="Try an image model on an image of the chats"><ImageTryPanel servers={servers} /></Expandable>
    </div>
  );
};

export default FileSettings;
