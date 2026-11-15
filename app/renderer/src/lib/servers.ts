import type { AiServer, LlmSettings, Settings } from '../../../../core/protocol';

// The chat's model as the core takes it (core/servers.ts, answersLlm): the first server's text model, in the settings'
// order; this computer's Ollama when none has one
export const answersLlm = (servers: AiServer[]): LlmSettings => {
  const server = servers.find((candidate) => candidate.text);

  return server
    ? { provider: server.kind, model: server.text, ollamaUrl: server.kind === 'ollama' ? server.url : '' }
    : { provider: 'ollama', model: 'qwen3.5:9b', ollamaUrl: 'http://127.0.0.1:11434' };
};

const serverKey = (server: Settings['servers'][number]) => (server.kind === 'ollama' ? server.url.trim().replace(/\/+$/, '').toLowerCase() : server.kind);

// Settings saved elsewhere (a queue turned on or off on Activity or in the tray) taken into the form: what wasn't
// edited here follows them, what was edited stays, for Save to write
export const mergeOutside = (form: Settings, before: Settings, fresh: Settings): Settings => {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const merged = { ...form };

  for (const key of Object.keys(fresh) as (keyof Settings)[]) {
    if (key === 'servers') {
      // Server by server, while the list is as it was; one with servers added, removed or moved here stays as it is
      const order = (servers: Settings['servers']) => servers.map(serverKey).join('|');

      if (order(form.servers) === order(before.servers) && order(before.servers) === order(fresh.servers)) {
        merged.servers = form.servers.map((server, index) => (same(server, before.servers[index]) ? fresh.servers[index] : server));
      }
    } else if (same(form[key], before[key])) {
      (merged as Record<string, unknown>)[key] = fresh[key];
    }
  }

  return merged;
};
