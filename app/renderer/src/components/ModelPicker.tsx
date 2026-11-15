import type { ReactNode } from 'react';
import { Cloud, Monitor } from 'lucide-react';
import { cn } from 'cn';
import type { LlmSettings, ModelChoice } from '../../../../core/protocol';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';

// The models a question, a summary or a draft can go to (F6): each AI server's (this computer's Ollama, an Orange Pi),
// and Groq's, Gemini's and Claude's when their key is set. A cloud model sees only the sources that may go to cloud AI (F8), so
// it's marked

const NONE = '\u0000none';

const CLOUD: Record<string, string> = { groq: 'Groq', gemini: 'Gemini', anthropic: 'Claude' };

const normalized = (url: string | undefined) => (url ?? '').trim().replace(/\/+$/, '').toLowerCase();

// An Ollama model is known by its server too: the same name may be on two
export const modelKey = (model: Pick<LlmSettings, 'provider' | 'model'> & { ollamaUrl?: string }) => (model.provider === 'ollama'
  ? `ollama|${normalized(model.ollamaUrl)}|${model.model}`
  : `${model.provider}|${model.model}`);

export const modelLabel = (model: Pick<LlmSettings, 'provider' | 'model'>) => (model.provider === 'ollama'
  ? model.model
  : `${model.model} · ${CLOUD[model.provider]}`);

// The groups of the list: a server each, then the cloud providers
const groupsOf = (models: ModelChoice[]) => {
  const groups: { key: string, label: string, models: ModelChoice[] }[] = [];

  for (const model of models) {
    const key = model.provider === 'ollama' ? `ollama|${normalized(model.ollamaUrl)}` : model.provider;
    let group = groups.find((candidate) => candidate.key === key);

    if (!group) {
      const cloud = `${CLOUD[model.provider]}, cloud`;
      group = { key, label: model.provider === 'ollama' ? model.server ?? 'Ollama' : cloud, models: [] };
      groups.push(group);
    }

    group.models.push(model);
  }

  return groups.sort((a, b) => Number(!a.key.startsWith('ollama')) - Number(!b.key.startsWith('ollama')));
};

interface ModelPickerProps {
  models: ModelChoice[];
  value: LlmSettings | null;
  // The address a model chosen carries when its choice has none
  ollamaUrl?: string;
  onChange: (llm: LlmSettings) => void;
  // A first item meaning none chosen ("Same as answers"), which gives null
  noneLabel?: string;
  onNone?: () => void;
  // The trigger when the value isn't shown, e.g. "Ask again with…"
  placeholder?: ReactNode;
  // Left out of the list, e.g. the model that answered: "provider|model"
  except?: string;
  className?: string;
  disabled?: boolean;
  // Without a frame, in a bar
  ghost?: boolean;
  // When the list closes, to list the models again for the next time: listed while it's open, the list would change
  // under the pointer
  onClosed?: () => void;
}

const ModelPicker = ({
  models, value, ollamaUrl = '', onChange, noneLabel, onNone, placeholder, except, className, disabled, ghost, onClosed,
}: ModelPickerProps) => {
  const shown = models.filter((model) => `${model.provider}|${model.model}` !== except);
  const choose = (key: string) => {
    if (key === NONE) {
      onNone?.();

      return;
    }

    const model = shown.find((candidate) => modelKey(candidate) === key);

    if (model) {
      onChange({ provider: model.provider, model: model.model, ollamaUrl: model.ollamaUrl ?? ollamaUrl });
    }
  };
  let selected = '';
  const chosen = value && shown.find((model) => modelKey(model) === modelKey(value));
  // The trigger names the server when there are several
  const servers = new Set(shown.filter((model) => model.provider === 'ollama').map((model) => normalized(model.ollamaUrl)));
  const valueText = chosen && chosen.provider === 'ollama' && servers.size > 1 && chosen.server ? `${chosen.model} · ${chosen.server}` : null;

  if (value) {
    selected = modelKey(value);
  } else if (noneLabel) {
    selected = NONE;
  }

  return (
    <Select value={selected} onValueChange={choose} disabled={disabled || (!shown.length && !noneLabel)} onOpenChange={(open) => !open && onClosed?.()}>
      <SelectTrigger
        size="sm"
        className={cn(ghost && 'h-7 border-none bg-transparent px-2 text-xs shadow-none hover:bg-accent dark:bg-transparent dark:hover:bg-accent', className)}
      >
        {selected ? <SelectValue>{valueText ?? undefined}</SelectValue> : placeholder}
      </SelectTrigger>
      {/* A menu next to the button, scrolled within: aligned to the chosen item (Radix's default), a long list took the
          whole window and moved under the pointer */}
      <SelectContent position="popper" className="max-h-80">
        {noneLabel && (
          <>
            <SelectItem value={NONE}>{noneLabel}</SelectItem>
            <SelectSeparator />
          </>
        )}
        {groupsOf(shown).map((group) => (
          <SelectGroup key={group.key}>
            <SelectLabel>{group.label}</SelectLabel>
            {group.models.map((model) => (
              <SelectItem key={modelKey(model)} value={modelKey(model)}>
                {/* On this computer or another of the user's (a loopback address), or in the cloud, which sees only
                    the sources that may go there */}
                {model.local ? <Monitor /> : <Cloud />}
                {modelLabel(model)}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
};

export default ModelPicker;
