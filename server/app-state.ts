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
import { createDeltaStore } from './deltas.js';
import { hostInfo } from './host.js';
import type { Delta } from '../shared/delta.js';

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

// The host address can change without a new revision, so it is always sent.
const liveVersions = createDeltaStore<LiveAppSnapshot>({ alwaysSend: ['host'] });
const fullHistoryVersions = createDeltaStore<RaceHistory>();

/** The live snapshot, or only its changes for a screen that holds revision `since`. */
export function liveAppState(since: number | null): LiveAppSnapshot | Delta<LiveAppSnapshot> {
  const snapshot = liveAppSnapshot();
  if (since !== null) return liveVersions.diff(since, snapshot) ?? snapshot;
  liveVersions.remember(snapshot);
  return snapshot;
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

/** Lap history; a screen that holds revision `since` of the full history gets only its changes. */
export function raceHistoryState(request: HistoryRequest, since: number | null): RaceHistory | Delta<RaceHistory> {
  const history = raceHistory(request);
  if (request.scope !== 'full') return history;
  if (since !== null) return fullHistoryVersions.diff(since, history) ?? history;
  fullHistoryVersions.remember(history);
  return history;
}

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

export function historyCacheKey(request: HistoryRequest, since: number | null): string {
  const revision = getAppDataRevision();
  if (request.scope === 'runner') return `history:${revision}:runner:${request.runnerId}`;
  if (request.scope === 'recent') return `history:${revision}:recent:${boundedHistoryLimit(request.limit)}`;
  return `history:${revision}:full:${since ?? ''}`;
}
