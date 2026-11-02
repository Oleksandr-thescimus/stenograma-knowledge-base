// What the preload exposes to the renderer as window.kb. Keep it a short list of calls: the renderer has no other way
// to the main process
export interface KbApi {
  versions: {
    electron: string;
    chrome: string;
    node: string;
  };
}
