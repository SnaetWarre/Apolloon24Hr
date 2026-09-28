import { TRPCError, initTRPC } from '@trpc/server';
import { z } from 'zod';
import {
  importCsvSchema,
  labelInputSchema,
  labelPatchSchema,
  publicRecordModeUpdateSchema,
  queueReorderSchema,
  raceStateExpectationSchema,
  runnerIdSchema,
  runnerInputSchema,
  runnerPatchSchema,
  runnerStatusUpdateSchema,
  temporaryTeamActiveSchema,
  temporaryTeamCreateSchema,
  temporaryTeamMembersSchema,
  temporaryTeamScheduleSchema,
  type ImportSummary,
  type RaceStateExpectation,
  type TemporaryTeam,
} from '../shared/schemas.js';
import { appSnapshot, liveAppSnapshot } from './app-state.js';
import { createVerifiedBackup } from './backups.js';
import { assertEmergencyTimingTakeoverAllowed, assertTimingTransferAllowed } from './cluster.js';
import { isClusterEnabled } from './cluster-policy.js';
import {
  assertOrClaimTimingController,
  assignTimingController,
  commitReplicatedWrite,
  createBurgieGepaktEvent,
  createLabel,
  deleteLabel,
  deleteRunner,
  ensureReplicationIdentity,
  finalizeReplicationConflict,
  finishRace,
  getAllLaps,
  getAllRaceEvents,
  getAllRunners,
  getAppDataRevision,
  getAppSettings,
  getLabels,
  getLapById,
  getRaceState,
  getRunnerById,
  getRunnersByIds,
  getTemporaryTeam,
  getTemporaryTeams,
  getTimingControllerHostId,
  hideRunnerInQueue,
  insertRunner,
  performHandoff,
  prepareReplicationConflictChoice,
  runnerStatusChangeError,
  setPublicRecordMode,
  setTemporaryTeamActive,
  setTemporaryTeamMembers,
  setTemporaryTeamSchedule,
  undoLastHandoff,
  unhideRunnerInQueue,
  updateLabel,
  updateRunner,
  updateRunnerStatus,
  updateWaitingOrder,
} from './db.js';
import { hostInfo } from './host.js';
import { emitRealtime } from './realtime.js';
import { CsvImportError, importRunnersFromCsv } from './runner-import.js';

const t = initTRPC.create();

const commandMetaShape = {
  _commandId: z.string().uuid().optional(),
  _clientId: z.string().min(1).max(128).optional(),
};

type CommandMeta = { _commandId?: string; _clientId?: string };

/** Every mutation carries an optional command id (for exactly-once retries) and client id. */
function withCommandMeta<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  return schema.extend(commandMetaShape);
}

function fail(code: 'NOT_FOUND' | 'BAD_REQUEST' | 'CONFLICT', message: string): never {
  throw new TRPCError({ code, message });
}

function rethrowAs<T>(code: 'BAD_REQUEST' | 'CONFLICT', fallback: string, action: () => T): T {
  try {
    return action();
  } catch (error) {
    fail(code, error instanceof Error ? error.message : fallback);
  }
}

function emitRunnerCollections(): void {
  emitRealtime({ type: 'runners:patched', payload: getAllRunners() });
}

function emitRunnerDelta(runnerIds: Array<string | null | undefined>): void {
  const runners = getRunnersByIds(runnerIds.filter((id): id is string => Boolean(id)));
  if (runners.length) emitRealtime({ type: 'runners:upserted', payload: runners });
}

function emitRaceDelta(runnerIds: Array<string | null | undefined>): void {
  emitRealtime({ type: 'race:changed', payload: getRaceState() });
  emitRunnerDelta(runnerIds);
}

function emitTemporaryTeams(): void {
  emitRealtime({ type: 'temporary-teams:patched', payload: getTemporaryTeams() });
}

function assertExpectedRaceState(expected: RaceStateExpectation): void {
  const actual = getRaceState();
  if (actual.activeRunnerId !== expected.activeRunnerId || actual.activeStartedAt !== expected.activeStartedAt) {
    fail('CONFLICT', 'Timingstatus is gewijzigd. Controleer de huidige loper en probeer opnieuw.');
  }
}

/**
 * Runs a mutation as one replicated command. Timing (`race.*`) commands also
 * claim timing control and record the race state they started from, so
 * concurrent timing on two laptops is detected as a conflict.
 */
function commitWrite<T>(type: string, input: CommandMeta | null, action: () => T): T {
  const isTiming = type.startsWith('race.');
  const race = isTiming ? getRaceState() : null;
  const { _commandId, _clientId, ...payload }: CommandMeta = input ?? {};
  return commitReplicatedWrite({
    id: _commandId,
    type,
    payload: { clientId: _clientId ?? null, input: input ? payload : null },
    raceBaseKey: race
      ? JSON.stringify({
          activeRunnerId: race.activeRunnerId,
          activeStartedAt: race.activeStartedAt,
          raceFinishedAt: race.raceFinishedAt,
        })
      : null,
    action: () => {
      if (isTiming) assertOrClaimTimingController();
      return action();
    },
  });
}

function requireTemporaryTeam(labelId: string): TemporaryTeam {
  return getTemporaryTeam(labelId) ?? fail('NOT_FOUND', 'Tijdelijke nachtploeg niet gevonden');
}

function isScheduledActive(team: TemporaryTeam, nowMs: number): boolean {
  return (
    team.startsAt !== null &&
    team.endsAt !== null &&
    team.memberRunnerIds.length > 0 &&
    nowMs >= team.startsAt &&
    nowMs < team.endsAt
  );
}

function applyTemporaryTeamSchedule(labelId: string, nowMs: number): void {
  const team = getTemporaryTeam(labelId);
  if (!team || team.startsAt === null || team.endsAt === null) return;
  const active = isScheduledActive(team, nowMs);
  if (team.active === active) return;
  setTemporaryTeamActive(labelId, active, nowMs);
  emitRunnerDelta(team.memberRunnerIds);
}

/**
 * Switches scheduled temporary teams on or off. In a cluster only one laptop
 * does this (the timing laptop, else the one that set the schedule), so the
 * transition is recorded once.
 */
export function runTemporaryTeamSchedules(nowMs = Date.now()): void {
  const hostId = isClusterEnabled(process.env) ? ensureReplicationIdentity().hostId : null;
  const timingHostId = hostId ? getTimingControllerHostId() : null;
  for (const team of getTemporaryTeams()) {
    if (team.startsAt === null || team.endsAt === null || team.active === isScheduledActive(team, nowMs)) continue;
    if (hostId && (timingHostId || team.scheduleOwnerHostId) !== hostId) continue;
    try {
      commitWrite('temporaryTeams.scheduleTransition', null, () => {
        applyTemporaryTeamSchedule(team.labelId, Date.now());
        emitTemporaryTeams();
      });
    } catch (error) {
      console.error(`Scheduled switch of temporary team ${team.labelId} failed:`, error);
    }
  }
}

export const appRouter = t.router({
  state: t.router({
    snapshot: t.procedure.query(() => liveAppSnapshot()),
    time: t.procedure.query(() => ({ serverNowMs: Date.now() })),
    hostInfo: t.procedure.query(() => hostInfo()),
  }),

  cluster: t.router({
    claimTimingControl: t.procedure
      .input(
        withCommandMeta(
          z.object({
            expectedControllerHostId: z.string().min(1).max(128).nullable(),
            force: z.boolean().default(false),
          })
        )
      )
      .mutation(({ input }) =>
        commitWrite('cluster.claimTimingControl', input, () => {
          assertEmergencyTimingTakeoverAllowed(input.expectedControllerHostId, input.force);
          return assignTimingController(ensureReplicationIdentity().hostId);
        })
      ),
    transferTimingControl: t.procedure
      .input(withCommandMeta(z.object({ targetHostId: z.string().min(1).max(128) })))
      .mutation(({ input }) =>
        commitWrite('cluster.transferTimingControl', input, () => {
          assertTimingTransferAllowed(input.targetHostId);
          return assignTimingController(input.targetHostId);
        })
      ),
    resolveConflict: t.procedure
      .input(withCommandMeta(z.object({ conflictId: z.string().min(1), selectedOperationId: z.string().min(1) })))
      .mutation(async ({ input }) => {
        await createVerifiedBackup('pre-conflict-resolution');
        return commitWrite('cluster.resolveConflict', input, () => {
          prepareReplicationConflictChoice(input.conflictId, input.selectedOperationId);
          const result = finalizeReplicationConflict(input.conflictId, appSnapshot());
          emitRealtime({ type: 'state:revision', payload: getAppDataRevision() });
          return result;
        });
      }),
  }),

  runners: t.router({
    list: t.procedure.query(() => getAllRunners()),
    create: t.procedure.input(withCommandMeta(runnerInputSchema)).mutation(({ input }) =>
      commitWrite('runners.create', input, () => {
        const runner = insertRunner(input);
        emitRealtime({ type: 'runner:upserted', payload: runner });
        return runner;
      })
    ),
    update: t.procedure
      .input(withCommandMeta(runnerIdSchema.extend({ fields: runnerPatchSchema })))
      .mutation(({ input }) =>
        commitWrite('runners.update', input, () => {
          const runner = updateRunner(input.id, input.fields) ?? fail('NOT_FOUND', 'runner not found');
          emitRealtime({ type: 'runner:upserted', payload: runner });
          return runner;
        })
      ),
    delete: t.procedure.input(withCommandMeta(runnerIdSchema)).mutation(({ input }) =>
      commitWrite('runners.delete', input, () => {
        const runner = getRunnerById(input.id) ?? fail('NOT_FOUND', 'runner not found');
        if (runner.status === 'running') fail('CONFLICT', 'Actieve loper kan niet verwijderd worden');
        if (runner.lapCount > 0) fail('CONFLICT', 'Lopers met rondes blijven bewaard voor analyse');
        deleteRunner(input.id);
        emitRealtime({ type: 'runner:deleted', payload: input.id });
        return { ok: true };
      })
    ),
    setStatus: t.procedure.input(withCommandMeta(runnerStatusUpdateSchema)).mutation(({ input }) =>
      commitWrite('runners.setStatus', input, () => {
        const race = getRaceState();
        const gateError = runnerStatusChangeError({
          runnerId: input.id,
          status: input.status,
          activeRunnerId: race.activeRunnerId,
          raceFinishedAt: race.raceFinishedAt,
          controllerHostId: getTimingControllerHostId(),
          localHostId: ensureReplicationIdentity().hostId,
        });
        if (gateError) fail('CONFLICT', gateError);
        const runner =
          rethrowAs('CONFLICT', 'Loperstatus aanpassen mislukt', () =>
            updateRunnerStatus({ id: input.id, status: input.status, statusSince: input.statusSince ?? Date.now() })
          ) ?? fail('NOT_FOUND', 'runner not found');
        emitRealtime({ type: 'runner:upserted', payload: runner });
        emitRealtime({ type: 'race:changed', payload: getRaceState() });
        return runner;
      })
    ),
    reorder: t.procedure.input(withCommandMeta(queueReorderSchema)).mutation(({ input }) =>
      commitWrite('runners.reorder', input, () => {
        rethrowAs('BAD_REQUEST', 'Wachtrij herschikken mislukt', () => updateWaitingOrder(input.ids));
        emitRunnerDelta(input.ids);
        return { ok: true };
      })
    ),
    hide: t.procedure.input(withCommandMeta(runnerIdSchema)).mutation(({ input }) =>
      commitWrite('runners.hide', input, () => {
        const current = getRunnerById(input.id) ?? fail('NOT_FOUND', 'runner not found');
        if (current.status !== 'ran') fail('CONFLICT', 'Alleen gelopen lopers kunnen verborgen worden');
        const runner = hideRunnerInQueue(input.id, Date.now()) ?? fail('NOT_FOUND', 'runner not found');
        emitRealtime({ type: 'runner:upserted', payload: runner });
        return runner;
      })
    ),
    unhide: t.procedure.input(withCommandMeta(runnerIdSchema)).mutation(({ input }) =>
      commitWrite('runners.unhide', input, () => {
        if (!getRunnerById(input.id)) fail('NOT_FOUND', 'runner not found');
        const runner = unhideRunnerInQueue(input.id) ?? fail('NOT_FOUND', 'runner not found');
        emitRealtime({ type: 'runner:upserted', payload: runner });
        return runner;
      })
    ),
    importCsv: t.procedure.input(withCommandMeta(importCsvSchema)).mutation(({ input }) =>
      commitWrite('runners.importCsv', input, () => {
        let summary: ImportSummary;
        try {
          summary = importRunnersFromCsv(input.csvText);
        } catch (error) {
          if (error instanceof CsvImportError) fail('BAD_REQUEST', error.message);
          throw error;
        }
        emitRunnerCollections();
        emitRealtime({ type: 'labels:patched', payload: getLabels() });
        return summary;
      })
    ),
  }),

  labels: t.router({
    list: t.procedure.query(() => getLabels()),
    create: t.procedure.input(withCommandMeta(labelInputSchema)).mutation(({ input }) =>
      commitWrite('labels.create', input, () => {
        const label = createLabel(input);
        emitRealtime({ type: 'label:upserted', payload: label });
        emitTemporaryTeams();
        return label;
      })
    ),
    update: t.procedure
      .input(withCommandMeta(runnerIdSchema.extend({ fields: labelPatchSchema })))
      .mutation(({ input }) =>
        commitWrite('labels.update', input, () => {
          const label = updateLabel(input.id, input.fields) ?? fail('NOT_FOUND', 'label not found');
          emitRealtime({ type: 'label:upserted', payload: label });
          emitTemporaryTeams();
          emitRunnerCollections();
          return label;
        })
      ),
    delete: t.procedure.input(withCommandMeta(runnerIdSchema)).mutation(({ input }) =>
      commitWrite('labels.delete', input, () => {
        if (!deleteLabel(input.id)) fail('NOT_FOUND', 'label not found');
        emitRealtime({ type: 'label:deleted', payload: input.id });
        emitTemporaryTeams();
        emitRunnerCollections();
        return { ok: true };
      })
    ),
  }),

  temporaryTeams: t.router({
    list: t.procedure.query(() => getTemporaryTeams()),
    create: t.procedure.input(withCommandMeta(temporaryTeamCreateSchema)).mutation(({ input }) =>
      commitWrite('temporaryTeams.create', input, () => {
        const label = createLabel({ name: input.name, color: input.color, kind: 'temporary_team' });
        setTemporaryTeamMembers(label.id, input.runnerIds);
        setTemporaryTeamSchedule(label.id, input.startsAt, input.endsAt, ensureReplicationIdentity().hostId);
        applyTemporaryTeamSchedule(label.id, Date.now());
        emitRealtime({ type: 'label:upserted', payload: label });
        emitRunnerDelta(input.runnerIds);
        emitTemporaryTeams();
        return requireTemporaryTeam(label.id);
      })
    ),
    setSchedule: t.procedure
      .input(withCommandMeta(temporaryTeamScheduleSchema.safeExtend({ labelId: z.string().min(1) })))
      .mutation(({ input }) =>
        commitWrite('temporaryTeams.setSchedule', input, () => {
          const previous = getTemporaryTeam(input.labelId);
          if (previous && !previous.memberRunnerIds.length) throw new Error('Voeg eerst minstens een loper toe');
          setTemporaryTeamSchedule(input.labelId, input.startsAt, input.endsAt, ensureReplicationIdentity().hostId);
          applyTemporaryTeamSchedule(input.labelId, Date.now());
          emitRunnerDelta(previous?.memberRunnerIds ?? []);
          emitTemporaryTeams();
          return requireTemporaryTeam(input.labelId);
        })
      ),
    setMembers: t.procedure.input(withCommandMeta(temporaryTeamMembersSchema)).mutation(({ input }) =>
      commitWrite('temporaryTeams.setMembers', input, () => {
        setTemporaryTeamMembers(input.labelId, input.runnerIds);
        applyTemporaryTeamSchedule(input.labelId, Date.now());
        const team = requireTemporaryTeam(input.labelId);
        emitRunnerDelta(team.memberRunnerIds);
        emitTemporaryTeams();
        return team;
      })
    ),
    setActive: t.procedure.input(withCommandMeta(temporaryTeamActiveSchema)).mutation(({ input }) =>
      commitWrite('temporaryTeams.setActive', input, () => {
        if (getTemporaryTeam(input.labelId)?.startsAt != null) {
          throw new Error('Deze ploeg volgt haar planning. Pas het begin- of einduur aan.');
        }
        const team = setTemporaryTeamActive(input.labelId, input.active, Date.now());
        emitRunnerDelta(team.memberRunnerIds);
        emitTemporaryTeams();
        return team;
      })
    ),
  }),

  race: t.router({
    state: t.procedure.query(() => getRaceState()),
    laps: t.procedure.query(() => getAllLaps()),
    startNext: t.procedure.input(withCommandMeta(raceStateExpectationSchema)).mutation(({ input }) =>
      commitWrite('race.startNext', input, () => {
        assertExpectedRaceState(input);
        if (input.activeRunnerId) fail('CONFLICT', 'Er loopt al een loper');
        const result = performHandoff(Date.now());
        if (!result.ok) fail('CONFLICT', result.error);
        emitRaceDelta([result.startedRunnerId]);
        return result;
      })
    ),
    handoff: t.procedure.input(withCommandMeta(raceStateExpectationSchema)).mutation(({ input }) =>
      commitWrite('race.handoff', input, () => {
        assertExpectedRaceState(input);
        const result = performHandoff(Date.now());
        if (!result.ok) fail('CONFLICT', result.error);
        emitRaceDelta([input.activeRunnerId, result.startedRunnerId]);
        const lap = result.lapId ? getLapById(result.lapId) : null;
        if (lap) emitRealtime({ type: 'lap:created', payload: lap });
        return result;
      })
    ),
    undoLastHandoff: t.procedure.input(withCommandMeta(raceStateExpectationSchema)).mutation(({ input }) =>
      commitWrite('race.undoLastHandoff', input, () => {
        assertExpectedRaceState(input);
        const result = undoLastHandoff();
        if (!result.ok) fail('CONFLICT', result.error);
        emitRaceDelta([input.activeRunnerId, getRaceState().activeRunnerId]);
        for (const lapId of result.deletedLapIds) {
          emitRealtime({ type: 'lap:deleted', payload: lapId });
        }
        return result;
      })
    ),
    finish: t.procedure.input(withCommandMeta(raceStateExpectationSchema)).mutation(({ input }) =>
      commitWrite('race.finish', input, () => {
        assertExpectedRaceState(input);
        finishRace(Date.now());
        emitRaceDelta([input.activeRunnerId]);
        return { ok: true };
      })
    ),
  }),

  events: t.router({
    list: t.procedure.query(() => getAllRaceEvents()),
    burgieGepakt: t.procedure.input(withCommandMeta(z.object({}))).mutation(({ input }) =>
      commitWrite('events.burgieGepakt', input, () => {
        const event = createBurgieGepaktEvent(Date.now());
        emitRealtime({ type: 'race-event:created', payload: event });
        return event;
      })
    ),
  }),

  settings: t.router({
    current: t.procedure.query(() => getAppSettings()),
    updatePublicRecordMode: t.procedure
      .input(withCommandMeta(publicRecordModeUpdateSchema))
      .mutation(({ input }) =>
        commitWrite('settings.updatePublicRecordMode', input, () => {
          const settings = setPublicRecordMode(input.publicRecordMode);
          emitRealtime({ type: 'settings:changed', payload: settings });
          return settings;
        })
      ),
  }),
});

export type AppRouter = typeof appRouter;
