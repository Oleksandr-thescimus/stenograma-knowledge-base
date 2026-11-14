import type { ReactNode } from 'react';
import { Cloud, Monitor } from 'lucide-react';
import { cn } from 'cn';
import type { LlmProvider, LlmSettings, ModelChoice } from '../../../../core/protocol';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';

// The models a chat's questions can go to (F6): Ollama's on this computer, and Groq's and Gemini's when their key is
// set. A cloud model sees only the sources that may go to cloud AI (F8), so it's marked

const PROVIDERS: { provider: LlmProvider, label: string }[] = [
  { provider: 'ollama', label: 'Ollama, on this computer' },
  { provider: 'groq', label: 'Groq, cloud' },
  { provider: 'gemini', label: 'Gemini, cloud' },
];

export const modelKey = (model: Pick<LlmSettings, 'provider' | 'model'>) => `${model.provider}|${model.model}`;

export const modelLabel = (model: Pick<LlmSettings, 'provider' | 'model'>) => (model.provider === 'ollama'
  ? model.model
  : `${model.model} · ${model.provider === 'groq' ? 'Groq' : 'Gemini'}`);

interface ModelPickerProps {
  models: ModelChoice[];
  value: LlmSettings | null;
  // Ollama's address of the settings, which a choice carries
  ollamaUrl: string;
  onChange: (llm: LlmSettings) => void;
  // The trigger when the value isn't shown, e.g. "Ask again with…"
  placeholder?: ReactNode;
  // Left out of the list, e.g. the model that answered
  except?: string;
  className?: string;
  disabled?: boolean;
  // Without a frame, in a bar
  ghost?: boolean;
  // When the list closes, to list the models again for the next time: listed while it's open, the list would change
  // under the pointer
  onClosed?: () => void;
}

const ModelPicker = ({ models, value, ollamaUrl, onChange, placeholder, except, className, disabled, ghost, onClosed }: ModelPickerProps) => {
  const shown = models.filter((model) => modelKey(model) !== except);
  const choose = (key: string) => {
    const model = shown.find((candidate) => modelKey(candidate) === key);

    if (model) {
      onChange({ provider: model.provider, model: model.model, ollamaUrl });
    }
  };

  return (
    <Select value={value ? modelKey(value) : ''} onValueChange={choose} disabled={disabled || !shown.length} onOpenChange={(open) => !open && onClosed?.()}>
      <SelectTrigger
        size="sm"
        className={cn(ghost && 'h-7 border-none bg-transparent px-2 text-xs shadow-none hover:bg-accent dark:bg-transparent dark:hover:bg-accent', className)}
      >
        {value ? <SelectValue /> : placeholder}
      </SelectTrigger>
      {/* A menu next to the button, scrolled within: aligned to the chosen item (Radix's default), a long list took the
          whole window and moved under the pointer */}
      <SelectContent position="popper" className="max-h-80">
        {PROVIDERS.map(({ provider, label }) => {
          const ofProvider = shown.filter((model) => model.provider === provider);

          return ofProvider.length ? (
            <SelectGroup key={provider}>
              <SelectLabel>{label}</SelectLabel>
              {ofProvider.map((model) => (
                <SelectItem key={modelKey(model)} value={modelKey(model)}>
                  {/* On this computer, or in the cloud, which sees only the sources that may go there */}
                  {model.local ? <Monitor /> : <Cloud />}
                  {modelLabel(model)}
                </SelectItem>
              ))}
            </SelectGroup>
          ) : null;
        })}
      </SelectContent>
    </Select>
  );
};

export default ModelPicker;
