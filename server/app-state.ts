import { getAllLaps, getAllRunners, getLabels, getRaceState } from './db.js';
import { hostInfo } from './host.js';
import type { AppSnapshot } from '../shared/schemas.js';

export function appSnapshot(): AppSnapshot {
  return {
    runners: getAllRunners(),
    labels: getLabels(),
    race: getRaceState(),
    laps: getAllLaps(),
    serverNowMs: Date.now(),
    host: hostInfo(),
  };
}
