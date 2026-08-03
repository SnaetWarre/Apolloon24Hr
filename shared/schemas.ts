import { z } from 'zod';

export const runnerStatusSchema = z.enum(['registered', 'warming_up', 'waiting', 'running', 'ran']);
export type RunnerStatus = z.infer<typeof runnerStatusSchema>;

export const registrationSourceSchema = z.enum(['import', 'manual']);
export type RegistrationSource = z.infer<typeof registrationSourceSchema>;

export const labelSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  icon: z.string(),
  kind: z.string(),
  imageUrl: z.string().nullable(),
  targetLaps: z.number().int().nonnegative().nullable(),
  sortOrder: z.number().int().nonnegative().nullable(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
});
export type Label = z.infer<typeof labelSchema>;

export const lapRecordSchema = z.object({
  id: z.string(),
  runnerId: z.string(),
  runnerNumber: z.string().nullable(),
  runnerName: z.string(),
  lapNumber: z.number().int().nonnegative(),
  startedAt: z.number(),
  finishedAt: z.number(),
  durationMs: z.number().int().nonnegative(),
  source: z.string(),
  createdAt: z.number(),
  labels: z.array(labelSchema),
});
export type LapRecord = z.infer<typeof lapRecordSchema>;

export const raceEventTypeSchema = z.enum(['burgie_gepakt']);
export type RaceEventType = z.infer<typeof raceEventTypeSchema>;

export const raceEventSchema = z.object({
  id: z.string(),
  type: raceEventTypeSchema,
  message: z.string(),
  occurredAt: z.number(),
  createdAt: z.number(),
  runnerId: z.string().nullable(),
  runnerNumber: z.string().nullable(),
  runnerName: z.string().nullable(),
});
export type RaceEvent = z.infer<typeof raceEventSchema>;

export const publicRecordModeSchema = z.enum(['off', 'day', 'two_hour', 'hour']);
export type PublicRecordMode = z.infer<typeof publicRecordModeSchema>;

export const appSettingsSchema = z.object({
  publicRecordMode: publicRecordModeSchema,
});
export type AppSettings = z.infer<typeof appSettingsSchema>;

export const runnerSchema = z.object({
  id: z.string(),
  runnerNumber: z.string().nullable(),
  name: z.string(),
  targetLaps: z.number().int().nonnegative().nullable(),
  historicalAvgMs: z.number().int().nonnegative().nullable(),
  historicalBestMs: z.number().int().nonnegative().nullable(),
  registrationSource: registrationSourceSchema,
  notes: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  status: runnerStatusSchema,
  statusSince: z.number().nullable(),
  queueIndex: z.number().int().nonnegative().nullable(),
  hiddenFromQueue: z.boolean(),
  queueHiddenAt: z.number().nullable(),
  labels: z.array(labelSchema),
  lapCount: z.number().int().nonnegative(),
  lastLapMs: z.number().int().nonnegative().nullable(),
  bestLapMs: z.number().int().nonnegative().nullable(),
  slowestLapMs: z.number().int().nonnegative().nullable(),
  averageLapMs: z.number().int().nonnegative().nullable(),
  totalTimeMs: z.number().int().nonnegative(),
});
export type Runner = z.infer<typeof runnerSchema>;

export const raceStateSchema = z.object({
  id: z.literal(1),
  activeRunnerId: z.string().nullable(),
  activeStartedAt: z.number().nullable(),
  raceStartedAt: z.number().nullable(),
  raceFinishedAt: z.number().nullable(),
  activeLabels: z.array(labelSchema),
});
export type RaceState = z.infer<typeof raceStateSchema>;

export const temporaryTeamSchema = z.object({
  labelId: z.string(),
  active: z.boolean(),
  activatedAt: z.number().nullable(),
  memberRunnerIds: z.array(z.string()),
  restoreLabelIdsByRunner: z.record(z.string(), z.array(z.string())),
});
export type TemporaryTeam = z.infer<typeof temporaryTeamSchema>;

export const hostInfoSchema = z.object({
  hostIpHint: z.string(),
  port: z.number().int().positive(),
  url: z.string(),
});
export type HostInfo = z.infer<typeof hostInfoSchema>;

export const clusterRoleSchema = z.enum(['standalone', 'local-first']);
export type ClusterRole = z.infer<typeof clusterRoleSchema>;

export const clusterPeerSchema = z.object({
  id: z.string().nullable(),
  url: z.string(),
  reachable: z.boolean(),
  lastSeenAt: z.number().nullable(),
  lastSeq: z.number().int().nonnegative().nullable(),
  synchronized: z.boolean(),
  operationVector: z.record(z.string(), z.number().int().nonnegative()).optional(),
});
export type ClusterPeer = z.infer<typeof clusterPeerSchema>;

export const backupRecordSchema = z.object({
  fileName: z.string(),
  createdAt: z.number().int().nonnegative(),
  reason: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  verified: z.literal(true),
});
export type BackupRecord = z.infer<typeof backupRecordSchema>;

export const backupStatusSchema = z.object({
  enabled: z.boolean(),
  inProgress: z.boolean(),
  intervalMs: z.number().int().positive(),
  nextScheduledAt: z.number().int().nonnegative().nullable(),
  retainedCount: z.number().int().nonnegative(),
  latest: backupRecordSchema.nullable(),
  lastFailureAt: z.number().int().nonnegative().nullable(),
  lastError: z.string().nullable(),
});
export type BackupStatus = z.infer<typeof backupStatusSchema>;

export const timingControlStateSchema = z.enum([
  'unassigned',
  'local',
  'remote-reachable',
  'remote-unreachable',
]);
export type TimingControlState = z.infer<typeof timingControlStateSchema>;

export const timingControlStatusSchema = z.object({
  state: timingControlStateSchema,
  controllerHostId: z.string().nullable(),
  generation: z.number().int().nonnegative(),
  controllerUrl: z.string().nullable(),
  controllerLastSeenAt: z.number().int().nonnegative().nullable(),
  localReplicaCaughtUp: z.boolean(),
  takeoverAllowed: z.boolean(),
  takeoverAvailableAt: z.number().int().nonnegative().nullable(),
  forcedTakeoverAllowed: z.boolean(),
  forcedTakeoverAvailableAt: z.number().int().nonnegative().nullable(),
});
export type TimingControlStatus = z.infer<typeof timingControlStatusSchema>;

export const clusterStatusSchema = z.object({
  enabled: z.boolean(),
  hostId: z.string(),
  clusterId: z.string(),
  pairingCode: z.string(),
  role: clusterRoleSchema,
  writable: z.boolean(),
  connectedHosts: z.number().int().positive(),
  knownHosts: z.number().int().positive(),
  pendingOperations: z.number().int().nonnegative(),
  conflictCount: z.number().int().nonnegative(),
  timingControllerHostId: z.string().nullable(),
  timingControl: timingControlStatusSchema,
  clockSkewMs: z.number().nullable(),
  lastAppliedSeq: z.number().int().nonnegative(),
  peers: z.array(clusterPeerSchema),
  backup: backupStatusSchema,
});
export type ClusterStatus = z.infer<typeof clusterStatusSchema>;

export const appSnapshotSchema = z.object({
  runners: z.array(runnerSchema),
  labels: z.array(labelSchema),
  race: raceStateSchema,
  laps: z.array(lapRecordSchema),
  events: z.array(raceEventSchema),
  temporaryTeams: z.array(temporaryTeamSchema),
  settings: appSettingsSchema,
  revision: z.number().int().nonnegative().optional(),
  serverNowMs: z.number(),
  host: hostInfoSchema,
  cluster: clusterStatusSchema.optional(),
});
export type AppSnapshot = z.infer<typeof appSnapshotSchema>;

export const publicRecordModeUpdateSchema = z.object({
  publicRecordMode: publicRecordModeSchema,
});

export const runnerInputSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1),
  runnerNumber: z.string().nullable().optional(),
  targetLaps: z.number().int().nonnegative().nullable().optional(),
  historicalAvgMs: z.number().int().nonnegative().nullable().optional(),
  historicalBestMs: z.number().int().nonnegative().nullable().optional(),
  registrationSource: registrationSourceSchema.optional(),
  notes: z.string().optional(),
  labels: z.array(z.string()).optional(),
  status: runnerStatusSchema.optional(),
  statusSince: z.number().int().nonnegative().optional(),
});
export type RunnerInput = z.infer<typeof runnerInputSchema>;

export const runnerPatchSchema = runnerInputSchema.partial().omit({ id: true }).extend({
  name: z.string().trim().min(1).optional(),
});
export type RunnerPatch = z.infer<typeof runnerPatchSchema>;

export const labelInputSchema = z.object({
  name: z.string().trim().min(1),
  color: z.string().optional(),
  icon: z.string().optional(),
  kind: z.string().optional(),
  imageUrl: z.string().nullable().optional(),
  targetLaps: z.number().int().nonnegative().nullable().optional(),
  sortOrder: z.number().int().nonnegative().nullable().optional(),
});
export type LabelInput = z.infer<typeof labelInputSchema>;

export const labelPatchSchema = labelInputSchema.partial();
export type LabelPatch = z.infer<typeof labelPatchSchema>;

export const queueReorderSchema = z.object({
  ids: z.array(z.string()).min(1),
});

export const temporaryTeamMembersSchema = z.object({
  labelId: z.string().min(1),
  runnerIds: z.array(z.string()),
});

export const temporaryTeamActiveSchema = z.object({
  labelId: z.string().min(1),
  active: z.boolean(),
});

export const runnerIdSchema = z.object({
  id: z.string().min(1),
});

export const runnerStatusUpdateSchema = runnerIdSchema.extend({
  status: runnerStatusSchema,
  statusSince: z.number().int().nonnegative().optional(),
});

export const raceStateExpectationSchema = z.object({
  activeRunnerId: z.string().nullable(),
  activeStartedAt: z.number().int().nonnegative().nullable(),
});
export type RaceStateExpectation = z.infer<typeof raceStateExpectationSchema>;

export const importCsvSchema = z.object({
  csvText: z.string().min(1),
});

export type ImportSummary = {
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
};
