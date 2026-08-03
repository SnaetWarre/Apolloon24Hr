import type { RaceHistory } from '../shared/schemas.js';
import {
  getAllLaps,
  getAllRaceEvents,
  getAppDataRevision,
  getLapsForRunner,
  getRecentLaps,
  getRecentRaceEvents,
} from './db.js';

type HistoryRequest =
  | { scope: 'full' }
  | { scope: 'recent'; limit: number }
  | { scope: 'runner'; runnerId: string };

const cache = new Map<string, RaceHistory>();
let cachedRevision = -1;

export function raceHistory(request: HistoryRequest): RaceHistory {
  const revision = getAppDataRevision();
  if (revision !== cachedRevision) {
    cachedRevision = revision;
    cache.clear();
  }
  const key = historyCacheKey(request);
  const cached = cache.get(key);
  if (cached) return cached;

  const history: RaceHistory =
    request.scope === 'full'
      ? {
          scope: 'full',
          runnerId: null,
          limit: null,
          laps: getAllLaps(),
          events: getAllRaceEvents(),
          revision,
        }
      : request.scope === 'runner'
        ? {
            scope: 'runner',
            runnerId: request.runnerId,
            limit: null,
            laps: getLapsForRunner(request.runnerId),
            events: [],
            revision,
          }
        : {
            scope: 'recent',
            runnerId: null,
            limit: boundedLimit(request.limit),
            laps: getRecentLaps(request.limit),
            events: getRecentRaceEvents(Math.min(request.limit, 100)),
            revision,
          };
  cache.set(key, history);
  if (cache.size > 64) cache.delete(cache.keys().next().value as string);
  return history;
}

function historyCacheKey(request: HistoryRequest): string {
  if (request.scope === 'runner') return `runner:${request.runnerId}`;
  if (request.scope === 'recent') return `recent:${boundedLimit(request.limit)}`;
  return 'full';
}

function boundedLimit(value: number): number {
  return Math.max(1, Math.min(1_000, Math.floor(value) || 100));
}
