import type { AppSettings, RaceState } from '../types';

/** Every server-derived query lives under this prefix, so one invalidation refreshes them all. */
export const appKey = ['app'] as const;

export const snapshotKey = [...appKey, 'snapshot'] as const;

export const historyKey = [...appKey, 'history'] as const;

export const registrationsKey = [...appKey, 'registrations'] as const;

export const clusterStatusKey = ['cluster', 'status'] as const;

export const emptyRace: RaceState = {
  id: 1,
  activeRunnerId: null,
  activeStartedAt: null,
  raceStartedAt: null,
  raceFinishedAt: null,
  activeLabels: [],
};

export const defaultSettings: AppSettings = {
  publicRecordMode: 'day',
};
