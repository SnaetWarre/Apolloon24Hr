import type { AppSnapshot, LiveAppSnapshot, RaceHistory } from '../shared/schemas.js';
import {
  getAllLaps,
  getAllRaceEvents,
  getAllRunners,
  getAppDataRevision,
  getAppSettings,
  getLabels,
  getLapsForRunner,
  getRaceState,
  getRecentLaps,
  getRecentRaceEvents,
  getTemporaryTeams,
} from './db.js';
import { boundedHistoryLimit } from './db/values.js';
import { hostInfo } from './host.js';

/** Everything the operator screens and displays show live, without lap history. */
export function liveAppSnapshot(): LiveAppSnapshot {
  return {
    runners: getAllRunners(),
    labels: getLabels(),
    race: getRaceState(),
    temporaryTeams: getTemporaryTeams(),
    settings: getAppSettings(),
    revision: getAppDataRevision(),
    host: hostInfo(),
  };
}

export function appSnapshot(): AppSnapshot {
  return {
    ...liveAppSnapshot(),
    laps: getAllLaps(),
    events: getAllRaceEvents(),
  };
}

export type HistoryRequest =
  | { scope: 'full' }
  | { scope: 'recent'; limit: number }
  | { scope: 'runner'; runnerId: string };

export function raceHistory(request: HistoryRequest): RaceHistory {
  const revision = getAppDataRevision();
  if (request.scope === 'runner') {
    return {
      scope: 'runner',
      runnerId: request.runnerId,
      limit: null,
      laps: getLapsForRunner(request.runnerId),
      events: [],
      revision,
    };
  }
  if (request.scope === 'recent') {
    const limit = boundedHistoryLimit(request.limit);
    return {
      scope: 'recent',
      runnerId: null,
      limit,
      laps: getRecentLaps(limit),
      events: getRecentRaceEvents(Math.min(limit, 100)),
      revision,
    };
  }

  return {
    scope: 'full',
    runnerId: null,
    limit: null,
    laps: getAllLaps(),
    events: getAllRaceEvents(),
    revision,
  };
}

export function historyCacheKey(request: HistoryRequest): string {
  const revision = getAppDataRevision();
  if (request.scope === 'runner') return `history:${revision}:runner:${request.runnerId}`;
  if (request.scope === 'recent') return `history:${revision}:recent:${boundedHistoryLimit(request.limit)}`;
  return `history:${revision}:full`;
}
