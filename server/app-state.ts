import {
  getAllLaps,
  getAllRaceEvents,
  getAllRunners,
  getAppDataRevision,
  getAppSettings,
  getLabels,
  getRaceState,
  getTemporaryTeams,
} from './db.js';
import { hostInfo } from './host.js';
import type { AppSnapshot, LiveAppSnapshot } from '../shared/schemas.js';

let cachedLiveRevision = -1;
let cachedLiveSnapshot: LiveAppSnapshot | null = null;
let cachedFullRevision = -1;
let cachedFullSnapshot: AppSnapshot | null = null;

export function liveAppSnapshot(): LiveAppSnapshot {
  const revision = getAppDataRevision();
  if (!cachedLiveSnapshot || cachedLiveRevision !== revision) {
    cachedLiveRevision = revision;
    cachedLiveSnapshot = {
      runners: getAllRunners(),
      labels: getLabels(),
      race: getRaceState(),
      temporaryTeams: getTemporaryTeams(),
      settings: getAppSettings(),
      revision,
      serverNowMs: 0,
      host: hostInfo(),
    };
  }

  return {
    ...cachedLiveSnapshot,
    revision,
    serverNowMs: Date.now(),
    host: hostInfo(),
  };
}

export function appSnapshot(): AppSnapshot {
  const revision = getAppDataRevision();
  if (!cachedFullSnapshot || cachedFullRevision !== revision) {
    cachedFullRevision = revision;
    cachedFullSnapshot = {
      ...liveAppSnapshot(),
      laps: getAllLaps(),
      events: getAllRaceEvents(),
    };
  }

  return {
    ...cachedFullSnapshot,
    revision,
    serverNowMs: Date.now(),
    host: hostInfo(),
  };
}
