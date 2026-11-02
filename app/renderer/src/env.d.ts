import type { KbApi } from '../../preload/api';

declare global {
  interface Window {
    kb: KbApi;
  }
}
