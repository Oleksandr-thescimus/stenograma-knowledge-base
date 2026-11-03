import { utilityProcess, type UtilityProcess } from 'electron';
import type { CoreEvent, CoreMessage, CoreMethods, CoreRequest, ProcessStatus } from '../../core/protocol';
import { nextAttempt, restartDelay } from './backoff';

// Runs the core (app/core-host) in a utilityProcess and calls it over its MessagePort. When the core exits, it's started
// again with a growing delay, and the status says why it stopped (docs/PLAN.md, M3)

interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

interface SupervisorOptions {
  entry: string;
  onEvent: (event: CoreEvent) => void;
  onProcessStatus: (status: ProcessStatus) => void;
}

const STOP_TIMEOUT_MS = 5000;

export const createCoreSupervisor = ({ entry, onEvent, onProcessStatus }: SupervisorOptions) => {
  let child: UtilityProcess | null = null;
  let status: ProcessStatus = { state: 'stopped', error: null, restarts: 0, retryAt: null };
  let attempt = 0;
  let startedAt = 0;
  let lastFatal: string | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let stopping = false;
  let nextId = 1;
  const pending = new Map<number, Pending>();

  const setStatus = (next: Partial<ProcessStatus>) => {
    status = { ...status, ...next };
    onProcessStatus(status);
  };

  const rejectPending = (message: string) => {
    pending.forEach(({ reject }) => reject(new Error(message)));
    pending.clear();
  };

  const onMessage = (message: CoreMessage) => {
    if ('ready' in message) {
      lastFatal = null;
      setStatus({ state: 'running', error: null, retryAt: null });
    } else if ('fatal' in message) {
      lastFatal = message.fatal;
    } else if ('event' in message) {
      onEvent(message.event);
    } else {
      const call = pending.get(message.id);
      pending.delete(message.id);

      if ('error' in message) {
        call?.reject(new Error(message.error));
      } else {
        call?.resolve(message.result);
      }
    }
  };

  const start = () => {
    restartTimer = null;
    lastFatal = null;
    startedAt = Date.now();
    setStatus({ state: status.restarts ? 'restarting' : 'starting', retryAt: null });

    const process = utilityProcess.fork(entry, [], { serviceName: 'Stenograma KB core', stdio: 'inherit' });
    child = process;
    process.on('message', onMessage);
    process.once('exit', (code) => {
      child = null;
      rejectPending('The knowledge base stopped');

      if (stopping) {
        setStatus({ state: 'stopped', retryAt: null });

        return;
      }

      attempt = nextAttempt(attempt, Date.now() - startedAt);
      const delay = restartDelay(attempt);
      restartTimer = setTimeout(start, delay);
      setStatus({
        state: 'restarting',
        error: lastFatal ?? `The knowledge base stopped (exit code ${code})`,
        restarts: status.restarts + 1,
        retryAt: Date.now() + delay,
      });
    });
  };

  return {
    start,

    getStatus: () => status,

    // Starts it now instead of at its next restart
    restartNow: () => {
      if (restartTimer) {
        clearTimeout(restartTimer);
        start();
      }
    },

    invoke: <M extends keyof CoreMethods>(method: M, params: CoreMethods[M]['params']) => new Promise<CoreMethods[M]['result']>((resolve, reject) => {
      if (!child || status.state !== 'running') {
        reject(new Error(status.error ? `The knowledge base isn't running: ${status.error}` : 'The knowledge base is starting'));

        return;
      }

      const id = nextId++;
      pending.set(id, { resolve: resolve as (result: unknown) => void, reject });
      child.postMessage({ id, method, params } satisfies CoreRequest);
    }),

    // Lets the core close the API and the database and release the lock; kills it when it takes too long
    stop: async () => {
      stopping = true;

      if (restartTimer) {
        clearTimeout(restartTimer);
      }

      const running = child;

      if (!running) {
        return;
      }

      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => running.kill(), STOP_TIMEOUT_MS);
        running.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        running.postMessage({ stop: true } satisfies CoreRequest);
      });
    },
  };
};

export type CoreSupervisor = ReturnType<typeof createCoreSupervisor>;
