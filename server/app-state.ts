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
import type { AppSnapshot } from '../shared/schemas.js';

let cachedRevision = -1;
let cachedSnapshot: AppSnapshot | null = null;

export function appSnapshot(): AppSnapshot {
  const revision = getAppDataRevision();
  if (!cachedSnapshot || cachedRevision !== revision) {
    cachedRevision = revision;
    cachedSnapshot = {
      runners: getAllRunners(),
      labels: getLabels(),
      race: getRaceState(),
      laps: getAllLaps(),
      events: getAllRaceEvents(),
      temporaryTeams: getTemporaryTeams(),
      settings: getAppSettings(),
      revision,
      serverNowMs: 0,
      host: hostInfo(),
    };
  }

  return {
    ...cachedSnapshot,
    revision,
    serverNowMs: Date.now(),
    host: hostInfo(),
  };
}
