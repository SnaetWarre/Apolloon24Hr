export type Label = {
  id: string;
  name: string;
  color: string;
  icon: string;
  kind: string;
  imageUrl: string | null;
  targetLaps: number | null;
  sortOrder: number | null;
};

export type Runner = {
  id: string;
  name: string;
  runnerNumber: string | null;
  labels?: Label[];
};

export type LapRecord = {
  id: string;
  runnerId: string;
  runnerNumber: string | null;
  runnerName: string;
  lapNumber: number;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  source: 'spacebar' | 'split' | 'manual' | 'handoff' | 'import' | 'timing';
  createdAt: number;
  labels: Label[];
};

export type RunnerRegistration = {
  submittedAt: string;
  email: string;
  phone: string;
  studyPhase: string;
  estimatedLaps: string;
  estimatedPace: string;
  maxLapsPerBlock: string;
  availableHours: string[];
  reuseConsent: string;
  flexibility: string;
  remarks: string;
  categories: string[];
  fastestLap: string;
};

export type LiveAppSnapshot = {
  runners: Runner[];
  race: { raceStartedAt: number | null; raceFinishedAt: number | null };
};
