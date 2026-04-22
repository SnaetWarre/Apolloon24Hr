export type RunnerStatus = 'warming_up' | 'waiting' | 'ran';

export interface Lap {
  durationMs: number;
}

export interface Runner {
  id: string;
  name: string;
  status: RunnerStatus;
  statusSince: number | null;
  queueIndex: number | null;
  /** Optional: exported in CSV when present */
  laps?: Lap[];
  manualRunTimeSec?: number | null;
}

export type ViewMode = 'table' | 'kanban';


