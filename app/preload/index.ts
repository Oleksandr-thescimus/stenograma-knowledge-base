import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { AppEvent } from '../../core/protocol';
import type { KbApi } from './api';

const api: KbApi = {
  invoke: (method, params) => ipcRenderer.invoke('kb:call', method, params),
  onEvent: (listener) => {
    const handler = (_event: IpcRendererEvent, event: AppEvent) => listener(event);
    ipcRenderer.on('kb:event', handler);

    return () => {
      ipcRenderer.removeListener('kb:event', handler);
    };
  },
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
};

contextBridge.exposeInMainWorld('kb', api);
