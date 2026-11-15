import type { RoomChange } from '../chat/types.ts';
import type { Db } from '../db.ts';
import type { SyncProblem } from '../protocol.ts';
import { markSynced } from '../sources.ts';

// The sources a connector syncs (F4): each on its own timer, one run at a time, "Sync now", and after a failure again
// later, twice as late each time up to an hour. A run's error is its source's lastError. A connector that watches its
// source as it changes (Rocket.Chat's realtime API) gets the rooms that changed read at once, and is synced whole only
// every half an hour while it watches, for what a change doesn't tell; at once when it connects again. Logs ids only

export interface ConnectorRun {
  sourceId: number;
  signal: AbortSignal;
  // What it does now, for the source's status
  progress: (text: string) => void;
  // Documents changed, to embed them
  onChange: () => void;
  // Only these rooms, as the source told they changed; null for a whole sync
  changes: RoomChange[] | null;
}

// What a source's watch tells
export interface WatchEvents {
  onChanges: (changes: RoomChange[]) => void;
  // Connected again after it was cut: synced whole, for what was missed
  onReconnect: () => void;
  onLive: (live: boolean) => void;
}

export interface Watch {
  connected: () => boolean;
  stop: () => void;
}

export interface Connector {
  kind: string;
  // A source's syncs this often, as it's set
  intervalMs: (sourceId: number) => number;
  // 'whole' when the rooms that changed need a whole sync (one not kept yet)
  run: (run: ConnectorRun) => Promise<'whole' | void>;
  // Watches a source as it changes, while it's synced
  watch?: (sourceId: number, events: WatchEvents) => Watch;
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
// A whole sync this often, at least, while the source is watched
const WATCHED_INTERVAL_MS = 30 * 60_000;

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
  watch: Watch | null;
  // A whole sync ran since it was added
  synced: boolean;
  // The rooms told to have changed, not read yet
  changes: Map<string, RoomChange>;
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

  // The time to the next whole sync: longer while the source is watched
  const intervalOf = (sourceId: number, state: SourceState) => {
    const interval = state.connector.intervalMs(sourceId);

    return state.watch?.connected() ? Math.max(interval, WATCHED_INTERVAL_MS) : interval;
  };

  // A whole sync, or only the rooms told to have changed (the timer of the whole one goes on)
  const run = (sourceId: number, whole = true) => {
    const state = states.get(sourceId);

    if (!state || stopped) {
      return;
    }

    if (state.running) {
      state.again ||= whole;

      return;
    }

    if (whole && state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }

    const changes = whole ? null : [...state.changes.values()];
    state.changes.clear();

    if (changes?.length === 0) {
      return;
    }

    const controller = new AbortController();
    state.controller = controller;

    if (whole) {
      state.nextAt = null;
    }

    onStatus();

    state.running = (async () => {
      let needsWhole = false;

      try {
        needsWhole = await state.connector.run({
          sourceId,
          signal: controller.signal,
          progress: (text) => {
            state.progress = text;
            onStatus();
          },
          onChange,
          changes,
        }) === 'whole';
        markSynced(db, sourceId);
        state.synced ||= whole;
        state.failures = 0;
        state.problem = null;
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }

        if (whole) {
          state.failures += 1;
          state.problem = state.connector.problemOf?.(error) ?? 'other';
          markSynced(db, sourceId, error instanceof Error ? error.message : String(error));
          log(`sync of source ${sourceId} failed (${state.failures} in a row)`);
        } else {
          // The whole sync reads them in its turn
          log(`sync of ${changes!.length} changed rooms of source ${sourceId} failed`);
        }
      } finally {
        state.running = null;
        state.controller = null;
        state.progress = null;

        if (!stopped && states.get(sourceId) === state) {
          const wholeNow = state.again || needsWhole;

          if (whole || wholeNow) {
            const delay = Math.min(intervalOf(sourceId, state) * (2 ** state.failures), MAX_BACKOFF_MS);
            schedule(sourceId, state, wholeNow ? 0 : delay);
            state.again = false;
          }

          // Rooms told to have changed meanwhile, unless a whole sync comes now
          if (state.changes.size && !wholeNow) {
            setTimeout(() => run(sourceId, false), 0);
          }
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
      watch: null, synced: false, changes: new Map(),
    };
    states.set(sourceId, state);
    schedule(sourceId, state, 0);
    state.watch = connector.watch?.(sourceId, {
      onChanges: (changes) => {
        changes.forEach((change) => state.changes.set(change.roomId, { ...state.changes.get(change.roomId), ...change }));
        run(sourceId, false);
      },
      onReconnect: () => run(sourceId),
      onLive: (live) => {
        const left = state.nextAt ? state.nextAt - Date.now() : null;

        // Live after the first sync: the next whole one in half an hour. Cut off: back at its own interval
        if (!state.running && left !== null && state.failures === 0 && state.synced) {
          if (live ? left < intervalOf(sourceId, state) : left > connector.intervalMs(sourceId)) {
            schedule(sourceId, state, intervalOf(sourceId, state));
          }
        }

        onStatus();
      },
    }) ?? null;
  };

  // Stops a source's sync, waiting for a run to end
  const remove = async (sourceId: number) => {
    const state = states.get(sourceId);
    states.delete(sourceId);

    if (state) {
      if (state.timer) {
        clearTimeout(state.timer);
      }

      state.watch?.stop();
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
        live: state.watch ? state.watch.connected() : null,
      } : null;
    },
    stop: async () => {
      stopped = true;
      const running = [...states.values()];
      running.forEach((state) => {
        if (state.timer) {
          clearTimeout(state.timer);
        }

        state.watch?.stop();
        state.controller?.abort();
      });
      await Promise.all(running.map((state) => state.running));
    },
  };
};

export type SyncRunner = ReturnType<typeof createSyncRunner>;
