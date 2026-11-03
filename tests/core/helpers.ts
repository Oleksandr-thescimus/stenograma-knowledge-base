import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../../core/db.ts';
import type { EmbeddingProvider } from '../../core/embed/provider.ts';
import type { SessionBundle, StenogramaMessage } from '../../core/stenograma/types.ts';

// A knowledge base in a temporary SQLite file, as the integration tests of the plan's Verification want
export const createTestDb = () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-test-'));
  const db = openDb(join(dir, 'kb.sqlite'));

  const cleanup = () => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  };

  return { db, cleanup };
};

// Vectors from words: one dimension per topic word, plus one so no vector is zero, padded to 8 dimensions (bit vectors
// need a multiple of 8). Counts every text it embeds
export const createFakeProvider = (topics = ['бюджет', 'реліз', 'мікрофон']) => {
  const embedded: string[] = [];
  const provider: EmbeddingProvider = {
    id: 'fake:topics',
    local: true,
    embed: async (values) => {
      embedded.push(...values);

      return values.map((value) => {
        const lower = value.toLowerCase();
        const counts = [...topics.map((topic) => lower.split(topic).length - 1), 0.1];
        const vector = Float32Array.from({ length: Math.ceil(counts.length / 8) * 8 }, (_, i) => counts[i] ?? 0);
        const length = Math.hypot(...vector);

        return vector.map((x) => x / length);
      });
    },
  };

  return { provider, embedded };
};

export const message = (user: string, text: string, timestamp?: number): StenogramaMessage => ({ user, text, timestamp, source: 'caption' });

export const bundle = (sessionId: string, messages: StenogramaMessage[], extra: Partial<SessionBundle> = {}): SessionBundle => ({
  session: { sessionId, stenogramaArray: messages, ...extra.session },
  transcripts: extra.transcripts ?? [],
  assistantAnswers: extra.assistantAnswers ?? [],
  actionItems: extra.actionItems ?? [],
});

export type { Db };
