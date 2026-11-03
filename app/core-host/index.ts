// The core's process: a utilityProcess the main process starts (app/main/core.ts). It runs core/service.ts and talks to
// the main process over its parentPort (a MessagePort). It exits when it can't start, and the main process starts it
// again later, so a lock taken by kb serve is retried until it's free
import type { CoreMessage, CoreRequest } from '../../core/protocol';
import { createKbService } from '../../core/service';

const port = process.parentPort;
const send = (message: CoreMessage) => port.postMessage(message);

const service = createKbService({
  onEvent: (event) => send({ event }),
  // Ids, counts and lengths only (CLAUDE.md, Privacy); the main process passes them to its own output
  log: (line) => console.log(`[core] ${line}`),
});

let stopping: Promise<void> | null = null;

const stop = () => {
  stopping ??= service.stop().finally(() => process.exit(0));

  return stopping;
};

port.on('message', ({ data }: { data: CoreRequest }) => {
  if ('stop' in data) {
    stop();

    return;
  }

  const { id, method, params } = data;
  // The main process checked the renderer's params; the service checks what it writes
  service.invoke(method, params as never)
    .then((result) => send({ id, result }))
    .catch((error: unknown) => send({ id, error: error instanceof Error ? error.message : String(error) }));
});

process.on('SIGTERM', stop);

service.start()
  .then(() => send({ ready: true }))
  .catch((error: unknown) => {
    send({ fatal: error instanceof Error ? error.message : String(error) });
    // A moment for the message to reach the main process before the port closes
    setTimeout(() => process.exit(1), 200);
  });
