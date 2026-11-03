import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { cn } from 'cn';
import type { ChatSummary } from '../../../../core/protocol';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { formatWhen } from '@/lib/format';
import type { Chats } from '@/lib/chats';

// The saved chats in the sidebar, the latest first. While an answer comes, its chat stays open

const ChatList = ({ chats, onChoose }: { chats: Chats, onChoose: (chatId: number | null) => void }) => {
  const [deleting, setDeleting] = useState<ChatSummary | null>(null);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mt-6 mb-1 flex items-center justify-between px-2">
        <h2 className="text-xs font-medium text-muted-foreground">Chats</h2>
        <Button size="icon-xs" variant="ghost" onClick={() => onChoose(null)} disabled={chats.answering} aria-label="New chat">
          <Plus />
        </Button>
      </div>
      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
        {chats.chats.map((chat) => (
          <div
            key={chat.id}
            className={cn('group flex items-center rounded-md hover:bg-accent', chat.id === chats.chatId && 'bg-accent')}
          >
            <button
              type="button"
              onClick={() => onChoose(chat.id)}
              disabled={chats.answering && chat.id !== chats.chatId}
              title={`${chat.title}\n${formatWhen(chat.updatedAt)}`}
              className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-sm disabled:opacity-50"
            >
              {chat.title}
            </button>
            <Button
              size="icon-xs"
              variant="ghost"
              className="mr-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              onClick={() => setDeleting(chat)}
              disabled={chats.answering && chat.id === chats.chatId}
              aria-label="Delete the chat"
            >
              <Trash2 />
            </Button>
          </div>
        ))}
      </div>
      <AlertDialog open={Boolean(deleting)} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete the chat?</AlertDialogTitle>
            <AlertDialogDescription>
              &quot;{deleting?.title}&quot; goes from the knowledge base with its questions and answers.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleting && chats.remove(deleting.id)}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default ChatList;
