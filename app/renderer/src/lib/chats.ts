import { useCallback, useEffect, useState } from 'react';
import type { ChatSummary } from '../../../../core/protocol';

// The saved chats (core/chats.ts), shared by the sidebar's list and the chat page. Choosing one makes the page load it;
// the page's own first question makes a chat it already shows, so that doesn't

export const useChats = (coreRunning: boolean) => {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chatId, setChatId] = useState<number | null>(null);
  // Changes on each choice, even of the same chat, so the page loads it again
  const [chosen, setChosen] = useState<{ chatId: number | null, at: number }>({ chatId: null, at: 0 });
  // While an answer comes, its chat stays open
  const [answering, setAnswering] = useState(false);

  const refresh = useCallback(() => {
    window.kb.invoke('chats', {}).then(setChats).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (coreRunning) {
      refresh();
    }
  }, [coreRunning, refresh]);

  // A chat, or a new one with null
  const choose = useCallback((id: number | null) => {
    setChatId(id);
    setChosen({ chatId: id, at: Date.now() });
  }, []);

  const remove = async (id: number) => {
    await window.kb.invoke('deleteChat', { chatId: id });

    if (id === chatId) {
      choose(null);
    }

    refresh();
  };

  return { chats, chatId, chosen, answering, setAnswering, choose, started: setChatId, refresh, remove };
};

export type Chats = ReturnType<typeof useChats>;
