import type { AppEvent, AppMethods } from '../../core/protocol';

// What the preload exposes to the renderer as window.kb: one call, checked by the main process (app/main/ipc.ts), and
// its events. The renderer has no other way to the main process
export interface KbApi {
  invoke: <M extends keyof AppMethods>(method: M, params: AppMethods[M]['params']) => Promise<AppMethods[M]['result']>;
  // Returns the function that stops listening
  onEvent: (listener: (event: AppEvent) => void) => () => void;
  versions: {
    electron: string;
    chrome: string;
    node: string;
  };
}
