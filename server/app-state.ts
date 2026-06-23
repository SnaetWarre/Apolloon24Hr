import {
  getAllLaps,
  getAllRaceEvents,
  getAllRunners,
  getAppSettings,
  getLabels,
  getRaceState,
  getTemporaryTeams,
} from './db.js';
import { hostInfo } from './host.js';
import type { AppSnapshot } from '../shared/schemas.js';

export function appSnapshot(): AppSnapshot {
  return {
    runners: getAllRunners(),
    labels: getLabels(),
    race: getRaceState(),
    laps: getAllLaps(),
    events: getAllRaceEvents(),
    temporaryTeams: getTemporaryTeams(),
    settings: getAppSettings(),
    serverNowMs: Date.now(),
    host: hostInfo(),
  };
}
