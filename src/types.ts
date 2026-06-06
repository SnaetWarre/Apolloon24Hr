export type RunnerStatus = 'registered' | 'warming_up' | 'waiting' | 'running' | 'ran';
export type RegistrationSource = 'import' | 'manual';

export interface Label {
  id: string;
  name: string;
  color: string;
  icon: string;
  kind: string;
  imageUrl: string | null;
  targetLaps: number | null;
  sortOrder: number | null;
  createdAt?: number;
  updatedAt?: number;
}

export interface LapRecord {
  id: string;
  runnerId: string;
  runnerNumber: string | null;
  runnerName: string;
  lapNumber: number;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  source: string;
  createdAt: number;
  labels: Label[];
}

export interface Runner {
  id: string;
  runnerNumber: string | null;
  name: string;
  targetLaps: number | null;
  historicalAvgMs: number | null;
  historicalBestMs: number | null;
  registrationSource: RegistrationSource;
  notes: string;
  createdAt: number;
  updatedAt: number;
  status: RunnerStatus;
  statusSince: number | null;
  queueIndex: number | null;
  hiddenFromQueue: boolean;
  queueHiddenAt: number | null;
  labels: Label[];
  lapCount: number;
  lastLapMs: number | null;
  bestLapMs: number | null;
  slowestLapMs: number | null;
  averageLapMs: number | null;
  totalTimeMs: number;
}

export interface RaceState {
  id: 1;
  activeRunnerId: string | null;
  activeStartedAt: number | null;
  raceStartedAt: number | null;
  raceFinishedAt: number | null;
}

export interface HostInfo {
  hostIpHint: string;
  port: number;
  url: string;
}

export interface AppSnapshot {
  runners: Runner[];
  labels: Label[];
  race: RaceState;
  laps: LapRecord[];
  serverNowMs: number;
  host: HostInfo;
}
