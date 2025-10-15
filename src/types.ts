export type RunnerStatus = 'warming_up' | 'waiting' | 'ran';

export interface Runner {
  id: string;
  name: string;
  status: RunnerStatus;
  statusSince: number | null;
  queueIndex: number | null;
}

export type ViewMode = 'table' | 'kanban';


