import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    // EPERM: it runs, as another user
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const tryCreate = (path: string) => {
  try {
    const fd = openSync(path, 'wx', 0o600);
    writeSync(fd, String(process.pid));
    closeSync(fd);

    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }

    return false;
  }
};

// The core that writes holds this lock: kb import now, the app's core and kb serve later (M1, Settings and secrets).
// A lock left by a process that's gone is taken over. Returns the function that releases it
export const acquireLock = (path: string) => {
  if (!tryCreate(path)) {
    const pid = Number(readFileSync(path, 'utf8'));

    if (pid && isRunning(pid)) {
      throw new Error(`The knowledge base is in use by process ${pid}: the app, kb serve or another kb import`);
    }

    unlinkSync(path);

    if (!tryCreate(path)) {
      throw new Error('Another process took the knowledge base\'s lock');
    }
  }

  return () => {
    try {
      unlinkSync(path);
    } catch {
      // Already gone
    }
  };
};
