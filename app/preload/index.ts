import { contextBridge } from 'electron';
import type { KbApi } from './api';

const api: KbApi = {
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
};

contextBridge.exposeInMainWorld('kb', api);
