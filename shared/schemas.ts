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

export const runnerRegistrationSchema = z.object({
  submittedAt: z.string(),
  email: z.string(),
  phone: z.string(),
  studyPhase: z.string(),
  estimatedLaps: z.string(),
  estimatedPace: z.string(),
  maxLapsPerBlock: z.string(),
  availableHours: z.array(z.string()),
  reuseConsent: z.string(),
  flexibility: z.string(),
  remarks: z.string(),
  categories: z.array(z.string()),
  /** Added for 2026; registrations imported before have none. */
  fastestLap: z.string().default(''),
});
export type RunnerRegistration = z.infer<typeof runnerRegistrationSchema>;

/** Registration answers an operator can fill in by hand; merged into the stored registration. */
export const runnerRegistrationDetailsSchema = z
  .object({
    email: z.string().trim().max(320),
    phone: z.string().trim().max(100),
    availableHours: z.array(z.string().trim().min(1).max(100)).max(200),
  })
  .partial();
export type RunnerRegistrationDetails = z.infer<typeof runnerRegistrationDetailsSchema>;

export const runnerSchema = z.object({
  id: z.string(),
  runnerNumber: z.string().nullable(),
  name: z.string(),
  targetLaps: z.number().int().nonnegative().nullable(),
  historicalAvgMs: z.number().int().nonnegative().nullable(),
  historicalBestMs: z.number().int().nonnegative().nullable(),
  registrationSource: registrationSourceSchema,
  notes: z.string(),
  /** From the registration form; the rest of the form (contact details) is served separately. */
  estimatedPace: z.string().nullable(),
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
  /** Evaluated on the server: inside the schedule, or switched on by hand when unscheduled. */
  active: z.boolean(),
  activatedAt: z.number().nullable(),
  startsAt: z.number().nullable(),
  endsAt: z.number().nullable(),
  memberRunnerIds: z.array(z.string()),
});
export type TemporaryTeam = z.infer<typeof temporaryTeamSchema>;

export const hostInfoSchema = z.object({
  hostIpHint: z.string(),
  port: z.number().int().positive(),
  url: z.string(),
});
export type HostInfo = z.infer<typeof hostInfoSchema>;

export type BackupRecord = {
  fileName: string;
  createdAt: number;
  sizeBytes: number;
  scheduled: boolean;
};

export type BackupStatus = {
  enabled: boolean;
  inProgress: boolean;
  intervalMs: number;
  nextScheduledAt: number | null;
  retainedCount: number;
  latest: BackupRecord | null;
  lastError: string | null;
  lastFailureAt: number | null;
  diskFreeBytes: number | null;
  minimumFreeBytes: number;
  diskLow: boolean;
  databaseBytes: number;
};

/** What a backup holds, so the operator knows what restoring it brings back. */
export type BackupPreview = {
  fileName: string;
  createdAt: number;
  runners: number;
  laps: number;
  lastLapAt: number | null;
  raceStartedAt: number | null;
  raceFinishedAt: number | null;
};

export const backupFileSchema = z.object({
  fileName: z
    .string()
    .min(1)
    .max(200)
    .regex(/^apolloon-[\w-]+\.sqlite$/),
});

/** One change in Beheer › Activiteit: when, what, and from which screen and address. */
export type ActivityEntry = {
  id: string;
  occurredAt: number;
  /** The operation, such as `runners.delete`. */
  action: string;
  summary: string;
  origin: string;
};

export const activityCursorSchema = z.object({
  occurredAt: z.number().int().nonnegative(),
  id: z.string().min(1).max(128),
});

export type ActivityCursor = z.infer<typeof activityCursorSchema>;

export const activityPageSchema = z.object({
  limit: z.number().int().positive().max(500).default(200),
  before: activityCursorSchema.nullable().default(null),
  /** Warm-up and queue moves (`runners.setStatus`, `runners.reorder`), which Activiteit hides unless asked. */
  queueMoves: z.boolean().default(true),
  /** Only entries whose summary or origin contains this, ignoring case and accents. */
  search: z.string().max(200).default(''),
});

export type ClusterRole = 'leader' | 'follower' | 'candidate';

/**
 * How the laptops are doing, for the screens: `solo` is a laptop on its own,
 * `healthy` has every laptop in the group up to date, `degraded` still has a
 * majority but misses a laptop, `electing` is choosing a new main laptop, and
 * `no-majority` cannot save changes until more laptops are back.
 */
export type GroupState = 'solo' | 'healthy' | 'degraded' | 'electing' | 'no-majority';

export type ClusterMemberStatus = {
  hostId: string;
  url: string;
  /** The computer name, or null when that laptop never told it. */
  name: string | null;
  self: boolean;
  leader: boolean;
  reachable: boolean;
  /** Holds every change the main laptop has. */
  caughtUp: boolean;
  /** Silent long enough that Beheer › Systeem offers "Uit de groep halen". */
  removable: boolean;
};

/** Laptops heard on the network that belong to another group, so a laptop on its own can join them in one click. */
export type NearbyGroup = {
  /** A laptop of that group to join through, and its computer name. */
  url: string;
  name: string | null;
  laptops: number;
  runners: number;
  /** Someone changed the event data there (labels, logos, settings); a fresh laptop says false. */
  changed: boolean;
  /** The race started or a lap was counted there. */
  raceStarted: boolean;
  /** The race started there and was not finished. */
  raceRunning: boolean;
  appVersion: string;
  compatible: boolean;
  /**
   * What Koppelen does with it, so the running race, then a started one, then the most runners stay:
   * `join` makes this laptop take that group's data, `invite` makes that empty
   * group take this laptop's data, and `there` means Koppelen must be pressed on
   * that laptop, because this one keeps its own data and that one holds runners.
   */
  link: 'join' | 'invite' | 'there';
};

export type ClusterStatus = {
  enabled: boolean;
  hostId: string;
  /** This laptop's computer name. */
  hostName: string | null;
  clusterId: string;
  appVersion: string;
  schemaVersion: number;
  role: ClusterRole;
  /** Raised on every election; the main laptop of the highest term wins. */
  term: number;
  state: GroupState;
  leader: { hostId: string; url: string } | null;
  members: ClusterMemberStatus[];
  /** Laptops that must hold a change before it counts as saved. */
  majority: number;
  writable: boolean;
  busy: 'joining' | 'resyncing' | null;
  selfUrl: string;
  logHead: number;
  runners: number;
  /** Someone changed the event data in this group; a laptop untouched since its first start says false. */
  changed: boolean;
  /** The race started or a lap was counted in this group. */
  raceStarted: boolean;
  /** The race started in this group and was not finished. */
  raceRunning: boolean;
  /** Other laptops in the group, so browsers can switch when this one goes away. */
  memberUrls: string[];
  nearby: NearbyGroup[];
  /** A group without runners links with the others on the network by itself. */
  autoLink: {
    enabled: boolean;
    /** Why this empty laptop does not link by itself now, in words for the screen. */
    waiting: string | null;
    /** Laptops of this group that linked by themselves, newest first. */
    linked: AutoLinkNote[];
  };
  /** Set on a laptop the group took out with "Uit de groep halen": a laptop of that group, to link with again. */
  removedFrom: { url: string; name: string | null } | null;
  lastError: string | null;
  backup: BackupStatus;
};

/** A laptop of the group that linked by itself, and the laptop (`with`) it linked with. */
export type AutoLinkNote = { hostId: string; name: string; self: boolean; with: string; at: number };

export type LiveAppSnapshot = {
  runners: Runner[];
  labels: Label[];
  race: RaceState;
  temporaryTeams: TemporaryTeam[];
  settings: AppSettings;
  revision: number;
  host: HostInfo;
};

export type AppSnapshot = LiveAppSnapshot & {
  laps: LapRecord[];
  events: RaceEvent[];
};

export const raceHistorySchema = z.object({
  scope: z.enum(['full', 'recent', 'runner']),
  runnerId: z.string().nullable(),
  limit: z.number().int().positive().nullable(),
  laps: z.array(lapRecordSchema),
  events: z.array(raceEventSchema),
  revision: z.number().int().nonnegative(),
});
export type RaceHistory = z.infer<typeof raceHistorySchema>;

/** Trimmed text where an empty answer means "not set". */
const optionalText = z
  .string()
  .trim()
  .max(1_000)
  .transform((value) => value || null);

export const publicRecordModeUpdateSchema = z.object({
  publicRecordMode: publicRecordModeSchema,
});

export const runnerInputSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1),
  runnerNumber: optionalText.nullable().optional(),
  targetLaps: z.number().int().nonnegative().nullable().optional(),
  historicalAvgMs: z.number().int().nonnegative().nullable().optional(),
  historicalBestMs: z.number().int().nonnegative().nullable().optional(),
  registrationSource: registrationSourceSchema.optional(),
  notes: z.string().trim().optional(),
  registration: runnerRegistrationSchema.nullable().optional(),
  registrationDetails: runnerRegistrationDetailsSchema.optional(),
  /** Label ids or names; unknown names become new labels. */
  labels: z.array(z.string().trim().min(1)).optional(),
  status: runnerStatusSchema.optional(),
  statusSince: z.number().int().nonnegative().optional(),
});
/** What the server works with after validation; clients send `z.input` of the schema. */
export type RunnerInput = z.infer<typeof runnerInputSchema>;

export const runnerPatchSchema = runnerInputSchema
  .partial()
  .omit({ id: true })
  .extend({
    name: z.string().trim().min(1).optional(),
  });
export type RunnerPatch = z.infer<typeof runnerPatchSchema>;

export const labelInputSchema = z.object({
  name: z.string().trim().min(1),
  color: z.string().trim().optional(),
  icon: z.string().trim().optional(),
  kind: z.string().trim().optional(),
  imageUrl: optionalText.nullable().optional(),
  targetLaps: z.number().int().nonnegative().nullable().optional(),
  sortOrder: z.number().int().nonnegative().nullable().optional(),
});
export type LabelInput = z.infer<typeof labelInputSchema>;

export const labelPatchSchema = labelInputSchema.partial();
export type LabelPatch = z.infer<typeof labelPatchSchema>;

/** A label logo the browser already scaled down; stored in the database so every laptop has it. */
export const labelImageUploadSchema = z.object({
  mime: z.enum(['image/webp', 'image/png']),
  dataBase64: z
    .string()
    .min(1)
    .max(1_000_000)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
});
export type LabelImageUpload = z.infer<typeof labelImageUploadSchema>;

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

export const temporaryTeamScheduleSchema = z
  .object({
    startsAt: z.number().int().nonnegative(),
    endsAt: z.number().int().nonnegative(),
  })
  .refine((value) => value.endsAt > value.startsAt, {
    message: 'Het einduur moet na het beginuur liggen',
  });

export const temporaryTeamCreateSchema = temporaryTeamScheduleSchema.safeExtend({
  name: z.string().trim().min(1),
  color: z.string(),
  runnerIds: z.array(z.string()).min(1),
});

export const runnerIdSchema = z.object({
  id: z.string().min(1),
});

export const lapIdSchema = z.object({ lapId: z.string().min(1) });

/** Moving a lap to another runner, or giving the second half of a split lap to `runnerId`. */
export const lapRunnerSchema = lapIdSchema.extend({ runnerId: z.string().min(1) });

export const runnerStatusUpdateSchema = runnerIdSchema.extend({
  status: runnerStatusSchema,
  statusSince: z.number().int().nonnegative().optional(),
});

export const raceStateExpectationSchema = z.object({
  activeRunnerId: z.string().nullable(),
  activeStartedAt: z.number().int().nonnegative().nullable(),
});
export type RaceStateExpectation = z.infer<typeof raceStateExpectationSchema>;

/** A timing action with the moment of the key press, and the lap as the timing screen measured it. */
export const timingPressSchema = raceStateExpectationSchema.extend({
  /** Cluster time of the press, from the key event rather than from when the request arrived. */
  pressedAt: z.number().int().nonnegative().optional(),
  /** Time since this screen's previous press, on one monotonic clock. */
  measuredDurationMs: z.number().int().nonnegative().optional(),
});
export type TimingPress = z.infer<typeof timingPressSchema>;

export const importCsvSchema = z.object({
  csvText: z.string().min(1),
});

export const importXlsxSchema = z.object({
  dataBase64: z
    .string()
    .min(1)
    .max(20_000_000)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
});

export type ImportSummary = {
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
};
