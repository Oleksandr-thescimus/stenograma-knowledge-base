import { useState, type KeyboardEvent } from 'react';
import { ArrowUp, Filter, Square, X } from 'lucide-react';
import { cn } from 'cn';
import type { LlmSettings, ModelChoice } from '../../../../core/protocol';
import ModelPicker from '@/components/ModelPicker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { fieldChips, NO_FILTERS, SOURCE_KINDS, type FilterFields } from '@/lib/filters';

// Where a question is written (F6): one frame, the text above and its bar below. On the left the filters set by hand,
// in a popover, and each active one as a chip with ✕; on the right the chat's model, next to sending, as it's what
// answers

export const Chip = ({ label, onRemove, disabled, title }: { label: string, onRemove: () => void, disabled?: boolean, title?: string }) => (
  <span className="inline-flex h-6 items-center gap-1 rounded-full bg-secondary pr-1 pl-2.5 text-xs text-secondary-foreground" title={title}>
    {label}
    <button
      type="button"
      onClick={onRemove}
      disabled={disabled}
      aria-label={`Remove ${label}`}
      className="rounded-full p-0.5 hover:bg-background/40 disabled:opacity-50"
    >
      <X className="size-3" />
    </button>
  </span>
);

const FilterForm = ({ fields, onChange, seriesNames }: { fields: FilterFields, onChange: (fields: FilterFields) => void, seriesNames: string[] }) => {
  const set = (name: keyof FilterFields) => (value: string) => onChange({ ...fields, [name]: value });

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label htmlFor="filter-from">From</Label>
          <Input id="filter-from" type="date" value={fields.from} onChange={(event) => set('from')(event.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="filter-to">To</Label>
          <Input id="filter-to" type="date" value={fields.to} onChange={(event) => set('to')(event.target.value)} />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="filter-person">Person</Label>
        <Input id="filter-person" placeholder="Olena" value={fields.person} onChange={(event) => set('person')(event.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="filter-room">Chat room</Label>
        <Input id="filter-room" placeholder="qa_dev_talks" value={fields.room} onChange={(event) => set('room')(event.target.value)} />
      </div>
      {seriesNames.length > 0 && (
        <div className="space-y-1">
          <Label>Meeting series</Label>
          <Select value={fields.series || 'none'} onValueChange={(value) => set('series')(value === 'none' ? '' : value)}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value="none">Any meeting</SelectItem>
              {seriesNames.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      )}
      <div className="space-y-1">
        <Label>Source</Label>
        <Select value={fields.sourceKind} onValueChange={set('sourceKind')}>
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            {SOURCE_KINDS.map(({ value, label }) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <p className="text-xs text-muted-foreground">Set here, they win over the dates, person, room and series taken from the question.</p>
    </div>
  );
};

interface ComposerProps {
  question: string;
  onQuestion: (question: string) => void;
  onSend: () => void;
  onStop: () => void;
  running: boolean;
  coreRunning: boolean;
  fields: FilterFields;
  onFields: (fields: FilterFields) => void;
  models: ModelChoice[];
  // The chat's model, and the settings' one it falls back to
  model: LlmSettings | null;
  onModel: (llm: LlmSettings) => void;
  // To list the models again once the list closes
  onModelsClosed: () => void;
  // The meeting series to filter by
  seriesNames: string[];
}

const Composer = ({
  question, onQuestion, onSend, onStop, running, coreRunning, fields, onFields, models, model, onModel, onModelsClosed, seriesNames,
}: ComposerProps) => {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const chips = fieldChips(fields);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      onSend();
    }
  };

  return (
    <div className="rounded-xl border bg-card shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/30">
      <Textarea
        value={question}
        onChange={(event) => onQuestion(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={coreRunning ? 'Ask a question (Enter sends, Shift+Enter starts a new line)' : 'The knowledge base isn\'t running'}
        disabled={!coreRunning}
        rows={2}
        className="max-h-48 min-h-[3.5rem] resize-none border-none bg-transparent px-3 pt-3 shadow-none focus-visible:ring-0 dark:bg-transparent"
      />
      <div className="flex items-center gap-2 px-2 pb-2">
        <Popover open={filtersOpen} onOpenChange={setFiltersOpen}>
          <PopoverTrigger asChild>
            <Button size="xs" variant={chips.length ? 'secondary' : 'ghost'} className="shrink-0">
              <Filter />
              Filters
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" side="top" className="w-80">
            <FilterForm fields={fields} onChange={onFields} seriesNames={seriesNames} />
            <div className="mt-3 flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => onFields(NO_FILTERS)} disabled={!chips.length}>Clear</Button>
              <Button size="sm" onClick={() => setFiltersOpen(false)}>Done</Button>
            </div>
          </PopoverContent>
        </Popover>
        <div className="flex min-w-0 flex-1 flex-wrap gap-1">
          {chips.map((chip) => <Chip key={chip.key} label={chip.label} onRemove={() => onFields({ ...fields, ...chip.clear })} />)}
        </div>
        {model && models.length > 0 && (
          <ModelPicker
            models={models}
            value={model}
            ollamaUrl={model.ollamaUrl}
            onChange={onModel}
            onClosed={onModelsClosed}
            disabled={running}
            className="shrink-0"
            ghost
          />
        )}
        {running ? (
          <Button size="icon-sm" variant="secondary" className="shrink-0 rounded-full" onClick={onStop} aria-label="Stop">
            <Square />
          </Button>
        ) : (
          <Button
            size="icon-sm"
            className={cn('shrink-0 rounded-full')}
            onClick={onSend}
            disabled={!question.trim() || !coreRunning}
            aria-label="Send"
          >
            <ArrowUp />
          </Button>
        )}
      </div>
    </div>
  );
};

export default Composer;
