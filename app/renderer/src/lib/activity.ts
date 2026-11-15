import { useEffect, useState } from 'react';
import type { BackgroundTask, TaskServer, TaskWait, WorkNow } from '../../../../core/protocol';
import { formatDuration, formatTime } from './format';

// The background AI work as the Activity page tells it: what's done now and where, how long the rest takes, and why a
// task waits

// The time now, a second at a time while something runs
export const useNow = (active: boolean) => {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!active) {
      return undefined;
    }

    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);

    return () => clearInterval(timer);
  }, [active]);

  return now;
};

const VERBS: Record<BackgroundTask, string> = { summaries: 'summarizing', images: 'reading an image', drafts: 'writing a reply draft' };

export const taskVerb = (task: BackgroundTask) => VERBS[task];

// "12 s so far · qwen3.5:9b on This computer"
export const workTiming = (work: WorkNow, now: number) => `${formatDuration(now - work.startedAt)} so far · ${work.model} on ${work.server}`;

// What's left, with the servers at work together: those waiting at their models' average times, and what's left of the
// ones done now. Null before a server's model was timed, or with none to do
export const leftMs = (pending: number, servers: TaskServer[], now: number) => {
  const timed = servers.filter((server): server is TaskServer & { averageMs: number } => server.averageMs !== null && server.averageMs > 0);
  // Done a millisecond, all of them
  const rate = timed.reduce((sum, server) => sum + (1 / server.averageMs), 0);
  const working = servers.filter((server) => server.work).length;
  const waiting = Math.max(0, pending - working);

  if (!rate || (waiting === 0 && !working)) {
    return null;
  }

  // The ones done now, as parts of one still to do
  const started = timed.reduce((sum, server) => sum + (server.work ? Math.max(0, 1 - ((now - server.work.startedAt) / server.averageMs)) : 0), 0);

  return Math.round((waiting + started) / rate);
};

const REASONS: Record<TaskWait['reason'], string> = {
  answer: 'is busy with what you asked for',
  drafts: 'writes a reply draft first',
  images: 'reads an image first',
  summaries: 'finishes a meeting\'s summary first',
  paused: 'is paused',
  unreachable: 'isn\'t reached',
  noVision: 'has an image model that doesn\'t read images: choose another in Settings → AI models',
  noServer: '',
  limited: 'is at its rate limit',
  refused: 'refused its work',
};

const whenText = ({ reason, retryAt }: TaskWait) => {
  if (!retryAt) {
    return '';
  }

  return reason === 'paused' ? ` until ${formatTime(retryAt)}` : `, tried again at ${formatTime(retryAt)}`;
};

export const waitText = (wait: TaskWait) => {
  let text = `${wait.server} ${REASONS[wait.reason]}`;

  if (wait.reason === 'paused') {
    text = 'the background AI work is paused';
  } else if (wait.reason === 'noServer') {
    text = 'no server takes it: turn a queue on, with a model for it, in Settings → AI models';
  } else if (wait.reason === 'noVision') {
    text = `the image model on ${wait.server} doesn't read images: choose another in Settings → AI models`;
  } else if (wait.reason === 'refused') {
    text = `${wait.server} ${refusedText(wait)}`;
  }

  return `Waiting: ${text}${whenText(wait)}`;
};

// "refused its work (402: Add usage credits…): check its key, credits and models in Settings → AI models"
const refusedText = (wait: TaskWait) => `${REASONS.refused}${wait.error ? ` (${wait.error})` : ''}: check its key, credits and models in Settings → AI models`;

// A server's own reason, after its name: "reads an image first", "isn't reached, tried again at 14:05"
export const serverWaitText = (wait: TaskWait) => `${wait.reason === 'refused' ? refusedText(wait) : REASONS[wait.reason]}${whenText(wait)}`;
