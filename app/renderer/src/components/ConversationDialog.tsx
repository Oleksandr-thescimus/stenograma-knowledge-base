import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, ExternalLink, FileText, Loader2, MessagesSquare } from 'lucide-react';
import { cn } from 'cn';
import type { ChatAttachmentView, CitedSource, ConversationView } from '../../../../core/protocol';
import ChatImage from '@/components/ChatImage';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { emojiOf, formatDay, formatTime } from '@/lib/format';
import { errorMessage } from '@/lib/kb';

// A cited conversation from the knowledge base's own copy (F3): a room's day or a thread, scrolled to the cited
// messages, with the messages each quotes. A thread started in it opens here too; any message opens in Rocket.Chat

const STATES = { pending: 'waiting to be read', failed: 'couldn\'t be read', skipped: 'not read', done: '' };

// What was read of a file: an image's description and text (by a vision model), a document's text, folded
const AttachmentRead = ({ file }: { file: ChatAttachmentView }) => {
  if (file.state !== 'done') {
    return <p className="text-xs text-muted-foreground">{STATES[file.state]}</p>;
  }

  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      {file.description && <p><span className="font-medium">Described by AI:</span> {file.description}</p>}
      {file.text && (
        <details>
          <summary className="cursor-pointer">{file.kind === 'image' ? 'Text in it, read by AI' : 'Its text'}</summary>
          <p className="mt-1 max-h-48 overflow-y-auto rounded bg-muted p-2 whitespace-pre-wrap">{file.text}</p>
        </details>
      )}
    </div>
  );
};

interface ConversationDialogProps {
  source: CitedSource | null;
  onClose: () => void;
}

const ConversationDialog = ({ source, onClose }: ConversationDialogProps) => {
  // The documents opened, the cited one first: a thread opened from its day goes on top, and "Back" returns
  const [stack, setStack] = useState<string[]>([]);
  // undefined while it loads, null when it's gone from the knowledge base
  const [view, setView] = useState<ConversationView | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const documentId = stack.at(-1);

  useEffect(() => setStack(source ? [source.documentId] : []), [source]);

  useEffect(() => {
    setView(undefined);
    setError(null);

    if (!documentId || !source) {
      return undefined;
    }

    let alive = true;
    const startMs = documentId === source.documentId ? source.startMs : null;
    window.kb.invoke('conversation', { documentId, startMs })
      .then((loaded) => alive && setView(loaded))
      .catch((reason: unknown) => alive && setError(errorMessage(reason)));

    return () => {
      alive = false;
    };
  }, [documentId, source]);

  const scrollToCited = useCallback((node: HTMLDivElement | null) => node?.scrollIntoView({ block: 'center' }), []);

  const openInChat = (messageId: string) => {
    if (view) {
      window.kb.invoke('openInChat', { documentId: view.documentId, messageId }).catch((reason: unknown) => setError(errorMessage(reason)));
    }
  };

  const citedMessage = view?.cited ? view.messages[view.cited.first] : view?.messages[0];

  return (
    <Dialog open={Boolean(source)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[85vh] max-w-3xl flex-col gap-0 p-0 sm:max-w-3xl">
        <DialogHeader className="border-b p-4 pr-12">
          <DialogTitle>{view?.title ?? source?.title}</DialogTitle>
          <DialogDescription>
            {[
              view?.kind === 'thread' ? `A thread in ${view.room}` : view?.room,
              formatDay(view?.createdAt ?? source?.createdAt ?? 0),
            ].filter(Boolean).join(' · ')}
          </DialogDescription>
          {view && view.members.length > 0 && (
            <p className="line-clamp-2 text-xs text-muted-foreground" title={view.members.join(', ')}>
              {view.members.length} {view.members.length === 1 ? 'member' : 'members'}: {view.members.join(', ')}
            </p>
          )}
          <div className="flex gap-2 pt-2">
            {stack.length > 1 && (
              <Button size="sm" variant="outline" onClick={() => setStack(stack.slice(0, -1))}>
                <ArrowLeft />
                Back
              </Button>
            )}
            {citedMessage && (
              <Button size="sm" variant="outline" onClick={() => openInChat(citedMessage.id)}>
                <ExternalLink />
                Open in Rocket.Chat
              </Button>
            )}
          </div>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto p-4">
          {error && <p className="text-sm text-destructive">{error}</p>}
          {view === undefined && !error && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading the conversation…
            </p>
          )}
          {view === null && <p className="text-sm text-muted-foreground">This conversation is no longer in the knowledge base.</p>}
          {view && (
            <div className="space-y-0.5">
              {view.messages.map((message, index) => {
                const cited = view.cited !== null && index >= view.cited.first && index <= view.cited.last;
                // A thread goes on over days: its later messages say which
                const otherDay = formatDay(message.ts) !== formatDay(view.createdAt);

                return (
                  <div
                    key={message.id}
                    ref={view.cited?.first === index ? scrollToCited : undefined}
                    className={cn('group flex gap-3 rounded px-2 py-1 text-sm', cited && 'bg-primary/10')}
                  >
                    <span className="w-14 shrink-0 pt-0.5 text-right text-xs text-muted-foreground tabular-nums">
                      {otherDay && <span className="block">{formatDay(message.ts).slice(5)}</span>}
                      {formatTime(message.ts)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <span className="font-medium">{message.author}</span>
                      {message.edited && <span className="ml-2 text-xs text-muted-foreground">edited</span>}
                      {message.quotes.map((quote, quoteIndex) => (
                        <blockquote key={quoteIndex} className="my-1 border-l-2 pl-2 text-muted-foreground">
                          <span className="font-medium">{quote.author}</span>
                          <p className="line-clamp-3 whitespace-pre-wrap break-words">{quote.text}</p>
                        </blockquote>
                      ))}
                      {message.text && <p className="whitespace-pre-wrap break-words">{message.text}</p>}
                      {message.attachments.map((file) => (
                        <div key={file.id} className="mt-1 space-y-1">
                          {file.kind === 'image' ? (
                            <ChatImage sourceId={view.sourceId} fileId={file.id} name={file.name} className="h-40 max-w-sm" />
                          ) : (
                            <Badge variant="secondary">
                              <FileText />
                              {file.name}
                            </Badge>
                          )}
                          <AttachmentRead file={file} />
                        </div>
                      ))}
                      {message.files.filter((name) => !message.attachments.some((file) => file.name === name)).map((file) => (
                        <Badge key={file} variant="secondary" className="mt-1 mr-1">
                          <FileText />
                          {file}
                        </Badge>
                      ))}
                      {message.reactions.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {message.reactions.map((reaction) => (
                            <span
                              key={reaction.emoji}
                              className="rounded-full border px-2 py-0.5 text-xs"
                              title={`${reaction.names.join(', ')} · :${reaction.emoji}:`}
                            >
                              {emojiOf(reaction.emoji)} {reaction.names.length}
                            </span>
                          ))}
                        </div>
                      )}
                      {message.threadDocumentId && (
                        <Button size="xs" variant="ghost" className="mt-1" onClick={() => setStack([...stack, message.threadDocumentId!])}>
                          <MessagesSquare />
                          Open the thread
                        </Button>
                      )}
                    </div>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="shrink-0 opacity-0 group-hover:opacity-100"
                      onClick={() => openInChat(message.id)}
                      aria-label="Open in Rocket.Chat"
                    >
                      <ExternalLink />
                    </Button>
                  </div>
                );
              })}
              {!view.messages.length && <p className="text-sm text-muted-foreground">No messages kept.</p>}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default ConversationDialog;
