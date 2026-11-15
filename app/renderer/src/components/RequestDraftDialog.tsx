import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { DraftableConversation } from '../../../../core/protocol';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatWhen } from '@/lib/format';
import { errorMessage } from '@/lib/kb';

// A reply draft asked for by hand: a conversation of the last days, whose last message from someone else it answers,
// whatever the rules of which messages get one say (to check the drafts, or for a message they missed)

const RequestDraftDialog = ({ open, onClose }: { open: boolean, onClose: () => void }) => {
  const [conversations, setConversations] = useState<DraftableConversation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    if (!open) {
      setConversations(null);
      setError(null);

      return undefined;
    }

    let alive = true;
    window.kb.invoke('draftableConversations', {})
      .then((list) => alive && setConversations(list))
      .catch((reason: unknown) => alive && setError(errorMessage(reason)));

    return () => {
      alive = false;
    };
  }, [open]);

  const ask = async (conversation: DraftableConversation) => {
    setAsking(true);
    setError(null);

    try {
      await window.kb.invoke('requestDraft', { sourceId: conversation.sourceId, roomId: conversation.roomId, threadId: conversation.threadId });
      onClose();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setAsking(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex max-h-[80vh] max-w-2xl flex-col gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="border-b p-4 pr-12">
          <DialogTitle>Draft a reply</DialogTitle>
          <DialogDescription>
            To a conversation&apos;s last message from someone else, of the days set in Settings → Reply drafts.
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto p-2">
          {error && <p className="p-2 text-sm text-destructive">{error}</p>}
          {!conversations && !error && <Loader2 className="m-4 size-4 animate-spin text-muted-foreground" />}
          {conversations && !conversations.length && (
            <p className="p-2 text-sm text-muted-foreground">No conversation has a message from someone else in those days.</p>
          )}
          <ul>
            {conversations?.map((conversation) => (
              <li key={`${conversation.sourceId}:${conversation.roomId}:${conversation.threadId ?? ''}`}>
                <button
                  type="button"
                  disabled={asking}
                  onClick={() => ask(conversation)}
                  className="w-full space-y-0.5 rounded-md px-2 py-1.5 text-left text-sm enabled:hover:bg-accent"
                >
                  <span className="flex items-center gap-2">
                    <span className="truncate font-medium">{conversation.conversation}</span>
                    {conversation.drafted && <Badge variant="outline" className="shrink-0">has a draft</Badge>}
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">{formatWhen(conversation.last.ts)}</span>
                  </span>
                  <span className="line-clamp-1 text-muted-foreground">{conversation.last.author}: {conversation.last.text}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default RequestDraftDialog;
