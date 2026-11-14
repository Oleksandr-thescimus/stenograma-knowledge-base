import type { Db } from '../db.ts';
import type { SyncProblem } from '../protocol.ts';
import { markSynced } from '../sources.ts';

// The sources a connector syncs (F4): each on its own timer, one run at a time, "Sync now", and after a failure again
// later, twice as late each time up to an hour. A run's error is its source's lastError. Logs ids only

export interface ConnectorRun {
  sourceId: number;
  signal: AbortSignal;
  // What it does now, for the source's status
  progress: (text: string) => void;
  // Documents changed, to embed them
  onChange: () => void;
}

export interface Connector {
  kind: string;
  // A source's syncs this often, as it's set
  intervalMs: (sourceId: number) => number;
  run: (run: ConnectorRun) => Promise<void>;
  // What the source reads, e.g. "olena on chat.example.com · 12 rooms"
  detail: (sourceId: number) => string;
  // What the knowledge base has of it
  summary?: (sourceId: number) => string | null;
  // What a run's error was, for what to do about it; 'other' without it
  problemOf?: (error: unknown) => SyncProblem;
}

export interface RunnerOptions {
  db: Db;
  connectors: Connector[];
  onStatus: () => void;
  onChange: () => void;
  log?: (line: string) => void;
}

const MAX_BACKOFF_MS = 3600_000;

interface SourceState {
  connector: Connector;
  timer: ReturnType<typeof setTimeout> | null;
  nextAt: number | null;
  controller: AbortController | null;
  running: Promise<void> | null;
  progress: string | null;
  failures: number;
  // The last run's, while it's the last
  problem: SyncProblem | null;
  // "Sync now" while it runs: once more right after
  again: boolean;
}

export const createSyncRunner = ({ db, connectors, onStatus, onChange, log = () => undefined }: RunnerOptions) => {
  const byKind = new Map(connectors.map((connector) => [connector.kind, connector]));
  const states = new Map<number, SourceState>();
  let stopped = false;

  const connectorOf = (sourceId: number) => {
    const row = db.prepare('select kind from sources where id = ? and enabled = 1').get(sourceId) as { kind: string } | undefined;

    return row ? byKind.get(row.kind) : undefined;
  };

  const schedule = (sourceId: number, state: SourceState, delayMs: number) => {
    if (state.timer) {
      clearTimeout(state.timer);
    }

    state.nextAt = Date.now() + delayMs;
    state.timer = setTimeout(() => run(sourceId), delayMs);
  };

  const run = (sourceId: number) => {
    const state = states.get(sourceId);

    if (!state || stopped) {
      return;
    }

    if (state.running) {
      state.again = true;

      return;
    }

    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }

    const controller = new AbortController();
    state.controller = controller;
    state.nextAt = null;
    onStatus();

    state.running = (async () => {
      try {
        await state.connector.run({
          sourceId,
          signal: controller.signal,
          progress: (text) => {
            state.progress = text;
            onStatus();
          },
          onChange,
        });
        markSynced(db, sourceId);
        state.failures = 0;
        state.problem = null;
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }

        state.failures += 1;
        state.problem = state.connector.problemOf?.(error) ?? 'other';
        markSynced(db, sourceId, error instanceof Error ? error.message : String(error));
        log(`sync of source ${sourceId} failed (${state.failures} in a row)`);
      } finally {
        state.running = null;
        state.controller = null;
        state.progress = null;

        if (!stopped && states.get(sourceId) === state) {
          const delay = Math.min(state.connector.intervalMs(sourceId) * (2 ** state.failures), MAX_BACKOFF_MS);
          schedule(sourceId, state, state.again ? 0 : delay);
          state.again = false;
        }

        onStatus();
      }
    })();
  };

  // Starts syncing a source of a connector, now
  const add = (sourceId: number) => {
    const connector = connectorOf(sourceId);

    if (!connector || states.has(sourceId) || stopped) {
      return;
    }

    const state: SourceState = {
      connector, timer: null, nextAt: null, controller: null, running: null, progress: null, failures: 0, problem: null, again: false,
    };
    states.set(sourceId, state);
    schedule(sourceId, state, 0);
  };

  // Stops a source's sync, waiting for a run to end
  const remove = async (sourceId: number) => {
    const state = states.get(sourceId);
    states.delete(sourceId);

    if (state) {
      if (state.timer) {
        clearTimeout(state.timer);
      }

      state.controller?.abort();
      await state.running;
    }
  };

  return {
    start: () => (db.prepare('select id from sources where enabled = 1').all() as { id: number }[]).forEach(({ id }) => add(id)),
    add,
    remove,
    syncNow: (sourceId: number) => {
      if (!states.has(sourceId)) {
        throw new Error(`Source ${sourceId} isn't synced by a connector`);
      }

      run(sourceId);
    },
    has: (sourceId: number) => states.has(sourceId),
    info: (sourceId: number) => {
      const state = states.get(sourceId);

      return state ? {
        detail: state.connector.detail(sourceId),
        summary: state.connector.summary?.(sourceId) ?? null,
        running: Boolean(state.running),
        progress: state.progress,
        nextAt: state.running ? null : state.nextAt,
        problem: state.problem,
      } : null;
    },
    stop: async () => {
      stopped = true;
      const running = [...states.values()];
      running.forEach((state) => {
        if (state.timer) {
          clearTimeout(state.timer);
        }

        state.controller?.abort();
      });
      await Promise.all(running.map((state) => state.running));
    },
  };
};

export type SyncRunner = ReturnType<typeof createSyncRunner>;
