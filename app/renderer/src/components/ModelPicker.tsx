import type { ReactNode } from 'react';
import { Check, ChevronDown, Cloud, Monitor } from 'lucide-react';
import { cn } from 'cn';
import type { LlmSettings, ModelChoice } from '../../../../core/protocol';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent,
  DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

// The models a question, a summary or a draft can go to (F6): each AI server's (this computer's Ollama, an Orange Pi),
// and Groq's, Gemini's, Claude's, Ollama Cloud's and OpenAI-compatible APIs' when their key is set. A cloud model sees only the sources that may go to cloud AI (F8), so
// it's marked


const CLOUD: Record<string, string> = { groq: 'Groq', gemini: 'Gemini', anthropic: 'Claude', 'ollama-cloud': 'Ollama Cloud' };

const normalized = (url: string | undefined) => (url ?? '').trim().replace(/\/+$/, '').toLowerCase();

const hasAddress = (provider: LlmSettings['provider']) => provider === 'ollama' || provider === 'openai';

// An Ollama model, or an OpenAI-compatible API's, is known by its server too: the same name may be on two
export const modelKey = (model: Pick<LlmSettings, 'provider' | 'model'> & { ollamaUrl?: string }) => (hasAddress(model.provider)
  ? `${model.provider}|${normalized(model.ollamaUrl)}|${model.model}`
  : `${model.provider}|${model.model}`);

export const modelLabel = (model: Pick<LlmSettings, 'provider' | 'model'> & { server?: string, ollamaUrl?: string }) => {
  if (model.provider === 'ollama') {
    return model.model;
  }

  return `${model.model} · ${model.provider === 'openai' ? model.server ?? normalized(model.ollamaUrl) : CLOUD[model.provider]}`;
};

// The groups of the list: a server each, then the cloud providers
const groupsOf = (models: ModelChoice[]) => {
  const groups: { key: string, label: string, models: ModelChoice[] }[] = [];

  for (const model of models) {
    const key = hasAddress(model.provider) ? `${model.provider}|${normalized(model.ollamaUrl)}` : model.provider;
    let group = groups.find((candidate) => candidate.key === key);

    if (!group) {
      const cloud = `${model.provider === 'openai' ? model.server ?? normalized(model.ollamaUrl) : CLOUD[model.provider]}, cloud`;
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
  const choose = (model: ModelChoice) => onChange({ provider: model.provider, model: model.model, ollamaUrl: model.ollamaUrl ?? ollamaUrl });
  const selected = value ? modelKey(value) : null;
  const chosen = value && shown.find((model) => modelKey(model) === selected);
  // The trigger names the server when there are several
  const servers = new Set(shown.filter((model) => model.provider === 'ollama').map((model) => normalized(model.ollamaUrl)));
  let triggerText: ReactNode = placeholder;

  if (chosen) {
    triggerText = chosen.provider === 'ollama' && servers.size > 1 && chosen.server ? `${chosen.model} · ${chosen.server}` : modelLabel(chosen);
  } else if (value) {
    triggerText = modelLabel(value);
  } else if (noneLabel) {
    triggerText = noneLabel;
  }

  const groups = groupsOf(shown);
  // On this computer or another of the user's (a loopback address), or in the cloud, which sees only the sources that
  // may go there
  const item = (model: ModelChoice, label: string) => (
    <DropdownMenuItem key={modelKey(model)} onSelect={() => choose(model)}>
      {model.local ? <Monitor /> : <Cloud />}
      <span className="flex-1 truncate">{label}</span>
      {modelKey(model) === selected && <Check className="text-foreground" />}
    </DropdownMenuItem>
  );

  return (
    <DropdownMenu onOpenChange={(open) => !open && onClosed?.()}>
      <DropdownMenuTrigger asChild disabled={disabled || (!shown.length && !noneLabel)}>
        <button
          type="button"
          className={cn(
            'flex h-8 w-fit min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 text-sm whitespace-nowrap shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 dark:hover:bg-input/50',
            !chosen && !value && !noneLabel && 'text-muted-foreground',
            ghost && 'h-7 border-none bg-transparent px-2 text-xs shadow-none hover:bg-accent dark:bg-transparent dark:hover:bg-accent',
            className,
          )}
        >
          <span className="truncate">{triggerText}</span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      {/* The servers first, each with its models in a menu of its own, scrolled within: one list of every model was too
          long. A single server's models are listed at once */}
      <DropdownMenuContent align="start" className="max-h-80 min-w-56">
        {noneLabel && (
          <>
            <DropdownMenuItem onSelect={() => onNone?.()}>
              <span className="flex-1">{noneLabel}</span>
              {!value && <Check className="text-foreground" />}
            </DropdownMenuItem>
            {groups.length > 0 && <DropdownMenuSeparator />}
          </>
        )}
        {groups.length === 1 && groups[0].models.map((model) => item(model, modelLabel(model)))}
        {groups.length > 1 && groups.map((group) => {
          const local = group.models.some((model) => model.local);
          const here = group.models.some((model) => modelKey(model) === selected);

          return (
            <DropdownMenuSub key={group.key}>
              <DropdownMenuSubTrigger>
                {local ? <Monitor /> : <Cloud />}
                <span className="flex-1 truncate">{group.label}</span>
                <span className={cn('text-xs text-muted-foreground', here && 'font-medium text-foreground')}>
                  {here ? '✓ ' : ''}
                  {group.models.length}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuPortal>
                <DropdownMenuSubContent className="max-h-80 min-w-56 overflow-y-auto">
                  {group.models.map((model) => item(model, model.model))}
                </DropdownMenuSubContent>
              </DropdownMenuPortal>
            </DropdownMenuSub>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default ModelPicker;
