import type { ReactNode } from 'react';
import { BrowserIcon, RocketChatIcon } from '@/components/SourceIcon';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

// "Add a source": what can be added, as tiles, each going on to its own steps. The empty Sources page shows the same
// tiles. Another source (email, another messenger) is a tile more

export type NewSourceKind = 'browser' | 'rocketchat';

const KINDS: { kind: NewSourceKind, title: string, text: string, icon: ReactNode }[] = [
  {
    kind: 'browser',
    title: 'A browser with Stenograma',
    text: 'The meetings Stenograma records in Google Meet, sent by the extension every 5 minutes.',
    icon: (
      <span className="flex gap-1.5">
        <BrowserIcon browser="chrome" className="size-6" />
        <BrowserIcon browser="firefox" className="size-6" />
      </span>
    ),
  },
  {
    kind: 'rocketchat',
    title: 'Rocket.Chat',
    text: 'Channels, private groups and direct messages, with their threads, reactions and images.',
    icon: <RocketChatIcon className="size-6" />,
  },
];

export const SourceKinds = ({ onPick }: { onPick: (kind: NewSourceKind) => void }) => (
  <div className="grid gap-3 sm:grid-cols-2">
    {KINDS.map(({ kind, title, text, icon }) => (
      <button
        key={kind}
        type="button"
        onClick={() => onPick(kind)}
        className="flex flex-col items-start gap-3 rounded-lg border bg-card p-4 text-left transition-colors hover:border-ring hover:bg-accent/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        {icon}
        <span className="space-y-1">
          <span className="block font-medium">{title}</span>
          <span className="block text-sm text-muted-foreground">{text}</span>
        </span>
      </button>
    ))}
  </div>
);

interface AddSourceDialogProps {
  open: boolean;
  onPick: (kind: NewSourceKind) => void;
  onClose: () => void;
}

const AddSourceDialog = ({ open, onPick, onClose }: AddSourceDialogProps) => (
  <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
    <DialogContent className="sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>Add a source</DialogTitle>
        <DialogDescription>Its content is kept on this computer; whether it may go to cloud AI is set on its card.</DialogDescription>
      </DialogHeader>
      <SourceKinds onPick={onPick} />
    </DialogContent>
  </Dialog>
);

export default AddSourceDialog;
