import type { AiServer, AiServerKind, BackgroundTask, EmbeddingSettings, LlmSettings, Settings } from './protocol.ts';

// The AI servers (Ollama's API: this computer's Ollama, an Orange Pi's RKLLama through a tunnel; Groq's and Gemini's
// and Claude's APIs), in the chat's order, each with its models for text and images and whether it takes the background work. The
// background work runs a queue per server, each taking the next meeting, draft or image it has a model for, so the
// Orange Pi summarizes while this computer reads images and answers; work gives way only to what the user asked for on
// the same server

export type ModelRef = Pick<LlmSettings, 'provider' | 'model' | 'ollamaUrl'>;

export const sameUrl = (a: string, b: string) => normalizeUrl(a) === normalizeUrl(b);
export const normalizeUrl = (url: string) => url.trim().replace(/\/+$/, '').toLowerCase();

export const OLLAMA_URL = 'http://127.0.0.1:11434';
export const CLOUD_NAMES: Record<Exclude<AiServerKind, 'ollama'>, string> = { groq: 'Groq', gemini: 'Gemini', anthropic: 'Claude' };

// A server's own id: an Ollama server's address, else its provider; the lane of its queue too
export const serverId = (server: Pick<AiServer, 'kind' | 'url'>) => (server.kind === 'ollama' ? normalizeUrl(server.url) : server.kind);

// An Ollama model's server, else its cloud provider
export const laneOf = (model: Pick<ModelRef, 'provider' | 'ollamaUrl'>) => (model.provider === 'ollama' ? normalizeUrl(model.ollamaUrl) : model.provider);

// What reads documents needs no model: a lane of its own
export const DOCUMENTS_LANE = 'documents';

const modelOn = (server: AiServer, model: string): LlmSettings => ({
  provider: server.kind, model, ollamaUrl: server.kind === 'ollama' ? server.url : '',
});

export const textModel = (server: AiServer) => (server.text ? modelOn(server, server.text) : null);
// Groq reads no images
export const imageModel = (server: AiServer) => (server.images && server.kind !== 'groq' ? modelOn(server, server.images) : null);

// What of the background work a server can take
export const serverTakes = (server: AiServer): BackgroundTask[] => [
  ...(server.text ? ['drafts' as const] : []), ...(imageModel(server) ? ['images' as const] : []), ...(server.text ? ['summaries' as const] : []),
];

// Ollama's on this computer when none is set: a summary or a draft of a source that may not go to cloud AI needs one
export const DEFAULT_TEXT = 'qwen3.5:9b';
const DEFAULT_LOCAL: LlmSettings = { provider: 'ollama', model: DEFAULT_TEXT, ollamaUrl: OLLAMA_URL };

const isLoopbackUrl = (url: string) => URL.canParse(url) && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname);

// The text models in the chat's order; the first answers, the next ones when it isn't reached
export const textModels = (settings: Pick<Settings, 'servers'>) => settings.servers.map(textModel).filter((model): model is LlmSettings => model !== null);
export const answersLlm = (settings: Pick<Settings, 'servers'>) => textModels(settings)[0] ?? DEFAULT_LOCAL;

// F8: the first Ollama on this computer or another of the user's (a loopback address), for what may not go to cloud AI
export const localTextLlm = (settings: Pick<Settings, 'servers'>) => textModels(settings)
  .find((model) => model.provider === 'ollama' && isLoopbackUrl(model.ollamaUrl)) ?? DEFAULT_LOCAL;

export const serverOf = (servers: AiServer[], model: Pick<ModelRef, 'provider' | 'ollamaUrl'>) => servers.find((server) => (model.provider === 'ollama'
  ? server.kind === 'ollama' && sameUrl(server.url, model.ollamaUrl)
  : server.kind === model.provider));

// "Orange Pi", "Groq"; an address no server has, as it is
export const whereLabel = (servers: AiServer[], model: Pick<ModelRef, 'provider' | 'ollamaUrl'>) => serverOf(servers, model)?.name
  ?? (model.provider === 'ollama' ? normalizeUrl(model.ollamaUrl) : CLOUD_NAMES[model.provider]);

const CLOUD: AiServer[] = [
  { name: 'Groq', kind: 'groq', url: '', text: '', images: '', queue: false },
  { name: 'Gemini', kind: 'gemini', url: '', text: '', images: '', queue: false },
  { name: 'Claude', kind: 'anthropic', url: '', text: '', images: '', queue: false },
];

export const DEFAULT_SERVERS: AiServer[] = [
  { name: 'This computer', kind: 'ollama', url: OLLAMA_URL, text: DEFAULT_TEXT, images: DEFAULT_TEXT, queue: true },
  ...CLOUD,
];

// Settings saved before the servers had their models: a model for answers, summaries, drafts and images each, and the
// servers' addresses with "their model for the background work"
interface OldSettings {
  servers?: { name: string, url: string, model?: string, kind?: AiServerKind }[];
  llm?: LlmSettings;
  fallback?: LlmSettings | null;
  summaries?: { llm?: LlmSettings | null };
  drafts?: { llm?: LlmSettings | null };
  attachments?: { provider?: 'ollama' | 'gemini', model?: string, ollamaUrl?: string };
  embedding?: EmbeddingSettings;
}

const migrated = (saved: OldSettings): AiServer[] => {
  const { llm } = saved;
  const background = [saved.summaries?.llm ?? llm, saved.drafts?.llm ?? llm].filter((model): model is LlmSettings => Boolean(model));
  const attachments = saved.attachments?.model
    ? { provider: saved.attachments.provider ?? 'ollama', model: saved.attachments.model, ollamaUrl: saved.attachments.ollamaUrl ?? OLLAMA_URL }
    : null;
  const known = saved.servers?.length ? saved.servers : [{ name: 'This computer', url: OLLAMA_URL, model: DEFAULT_TEXT }];
  const addresses = [...known.map((server) => ({ name: server.name, url: server.url, model: server.model ?? '' }))];

  // Addresses only the models named
  for (const model of [llm, ...background, attachments, saved.fallback, saved.embedding]) {
    if (model?.provider === 'ollama' && !addresses.some((server) => sameUrl(server.url, model.ollamaUrl))) {
      addresses.push({ name: `Server ${addresses.length + 1}`, url: model.ollamaUrl, model: model.model });
    }
  }

  const on = (model: ModelRef | null | undefined, server: { kind: AiServerKind, url: string }) => Boolean(model)
    && model!.provider === server.kind && (server.kind !== 'ollama' || sameUrl(model!.ollamaUrl, server.url));
  const ollama = addresses.map((server): AiServer => {
    const place = { kind: 'ollama' as const, url: server.url };
    const text = background.find((model) => on(model, place))?.model ?? (on(llm, place) ? llm!.model : server.model);

    return { name: server.name, kind: 'ollama', url: server.url, text, images: on(attachments, place) ? attachments!.model : '', queue: true };
  });
  const cloud = CLOUD.map((server) => ({
    ...server,
    text: on(llm, server) ? llm!.model : '',
    images: on(attachments, server) ? attachments!.model : '',
  }));
  // The answers' server first
  const all = [...ollama, ...cloud];
  const first = all.findIndex((server) => on(llm, server));

  return first > 0 ? [all[first], ...all.filter((_, index) => index !== first)] : all;
};

// The servers as saved, with Groq and Gemini always there; those of older settings made from their models
export const serversOf = (saved: OldSettings): AiServer[] => {
  if (!saved.servers?.length || saved.servers.some((server) => !server.kind)) {
    return migrated(saved);
  }

  const servers = saved.servers as AiServer[];

  return [...servers, ...CLOUD.filter((cloud) => !servers.some((server) => server.kind === cloud.kind))];
};

// Whether an Ollama server answers, asked at most every 15 seconds; its last answer meanwhile
export const createReachability = (fetchImpl: typeof fetch, ttlMs = 15_000) => {
  const known = new Map<string, { at: number, reachable: boolean }>();

  const check = async (url: string, force = false) => {
    const key = normalizeUrl(url);
    const cached = known.get(key);

    if (!force && cached && Date.now() - cached.at < ttlMs) {
      return cached.reachable;
    }

    const reachable = await fetchImpl(`${key}/api/version`, { signal: AbortSignal.timeout(2500) })
      .then((response) => response.ok, () => false);
    known.set(key, { at: Date.now(), reachable });

    return reachable;
  };

  return {
    check,
    // Without asking: null when never asked
    last: (url: string) => known.get(normalizeUrl(url))?.reachable ?? null,
    // A model's call failed to reach it
    unreachable: (url: string) => known.set(normalizeUrl(url), { at: Date.now(), reachable: false }),
  };
};
