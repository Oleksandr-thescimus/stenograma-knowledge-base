import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { AppEvent, AppStatus } from '../../../../core/protocol';

// The renderer's way to the knowledge base: window.kb from the preload, its status shared through a context

// An error from the main process or the core without the IPC's prefix ("Error invoking remote method 'kb:call': Error:")
export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))
  .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');

export const useKbEvents = (listener: (event: AppEvent) => void) => {
  useEffect(() => window.kb.onEvent(listener), [listener]);
};

const StatusContext = createContext<AppStatus | null>(null);

export const StatusProvider = ({ children }: { children: ReactNode }) => {
  const [status, setStatus] = useState<AppStatus | null>(null);

  useEffect(() => {
    let alive = true;
    window.kb.invoke('status', {}).then((initial) => {
      if (alive) {
        setStatus((current) => current ?? initial);
      }
    });
    const stop = window.kb.onEvent((event) => {
      if (event.type === 'status') {
        setStatus(event.status);
      }
    });

    return () => {
      alive = false;
      stop();
    };
  }, []);

  return <StatusContext.Provider value={status}>{children}</StatusContext.Provider>;
};

export const useAppStatus = () => useContext(StatusContext);
