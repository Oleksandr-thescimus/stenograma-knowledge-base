import { sourceStats } from '../chat/store.ts';
import type { Connector } from '../connectors/runner.ts';
import type { Db } from '../db.ts';
import type { SyncProblem } from '../protocol.ts';
import { createRocketChatApi, RocketChatError } from './api.ts';
import { limitsOf, readConfig, ROCKETCHAT_KIND, syncRocketChat } from './sync.ts';

// Rocket.Chat as the sync runner runs it: every 5 minutes or as set, at most the calls a minute set, with the token from
// the keyring, read only when a run needs it (at login the keyring may still be locked: the run fails, and is tried
// again later)

export interface RocketChatConnectorOptions {
  db: Db;
  getToken: (sourceId: number) => string | undefined;
  embedModel: () => string | null;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

// Its token isn't in the keyring: given again, as a refused one
class MissingTokenError extends Error {}

const problemOf = (error: unknown): SyncProblem => {
  if (error instanceof MissingTokenError || (error instanceof RocketChatError && error.status === 401)) {
    return 'auth';
  }

  // Not answered, or timed out
  return error instanceof RocketChatError && error.status === 0 ? 'network' : 'other';
};

export const createRocketChatConnector = ({ db, getToken, embedModel, fetch, log = () => undefined }: RocketChatConnectorOptions): Connector => ({
  kind: ROCKETCHAT_KIND,
  intervalMs: (sourceId) => limitsOf(readConfig(db, sourceId)).intervalMinutes * 60_000,

  run: async ({ sourceId, signal, progress, onChange }) => {
    const config = readConfig(db, sourceId);
    const token = getToken(sourceId);

    if (!token) {
      throw new MissingTokenError('Its token isn\'t in the keyring (still locked?): it\'s tried again later, or give it again');
    }

    const api = createRocketChatApi({ ...config, token }, { fetch, signal, requestsPerMinute: limitsOf(config).requestsPerMinute });
    const result = await syncRocketChat({ db, sourceId, api, embedModel: embedModel(), signal, progress, onChange });
    log(`source ${sourceId}: ${result.rooms} rooms read, ${result.messages} messages`);
  },

  detail: (sourceId) => {
    const config = readConfig(db, sourceId);
    const rooms = (db.prepare('select count(*) as n from chat_rooms where source_id = ?').get(sourceId) as { n: number }).n;

    return `${config.username} on ${new URL(config.serverUrl).host} · ${rooms} ${rooms === 1 ? 'room' : 'rooms'}`;
  },

  problemOf,

  summary: (sourceId) => {
    const stats = sourceStats(db, sourceId);
    const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

    return stats.messages ? [
      count(stats.messages, 'message'),
      count(stats.threads, 'thread'),
      stats.reacted && `${stats.reacted.toLocaleString('en-US')} with reactions`,
      stats.images && `${count(stats.images, 'image')}, ${stats.imagesRead.toLocaleString('en-US')} read`,
      stats.files && `${count(stats.files, 'file')}, ${stats.filesRead.toLocaleString('en-US')} read`,
    ].filter(Boolean).join(' · ') : null;
  },
});
