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
  type RaceStateExpectation,
  type TemporaryTeam,
} from '../shared/schemas.js';
import { createVerifiedBackup } from './backups.js';
import { assertWritable, joinPrimary, promoteToPrimary } from './cluster.js';
import {
  createBurgieGepaktEvent,
  createLabel,
  deleteLabel,
  deleteRunner,
  finishRace,
  getRaceState,
  getRunnerById,
  getRunnerRegistrations,
  getTemporaryTeam,
  hideRunnerInQueue,
  insertRunner,
  performHandoff,
  recordWrite,
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
import { CsvImportError, importRunnersFromCsv } from './runner-import.js';

const t = initTRPC.create();

function fail(code: 'NOT_FOUND' | 'BAD_REQUEST' | 'CONFLICT', message: string): never {
  throw new TRPCError({ code, message });
}

/**
 * Runs a mutation as one replicated write on the primary. A domain error
 * thrown by the database layer becomes a CONFLICT with its (Dutch) message.
 */
function commitWrite<T>(type: string, action: () => T): T {
  try {
    assertWritable();
  } catch (error) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: (error as Error).message,
    });
  }
  try {
    return recordWrite(type, action);
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    fail('CONFLICT', domainErrorMessage(error));
  }
}

function domainErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Opslaan mislukt';
  return /UNIQUE constraint failed: runners\.runner_number/.test(message)
    ? 'Dit lopersnummer is al in gebruik'
    : message;
}

/** Timing actions carry the race state the operator saw, so a stale second press cannot record a lap. */
function assertExpectedRaceState(expected: RaceStateExpectation): void {
  const actual = getRaceState();
  if (actual.activeRunnerId !== expected.activeRunnerId || actual.activeStartedAt !== expected.activeStartedAt) {
    fail('CONFLICT', 'Timingstatus is gewijzigd. Controleer de huidige loper en probeer opnieuw.');
  }
}

function requireTemporaryTeam(labelId: string): TemporaryTeam {
  return getTemporaryTeam(labelId) ?? fail('NOT_FOUND', 'Tijdelijke nachtploeg niet gevonden');
}

export const appRouter = t.router({
  cluster: t.router({
    join: t.procedure
      .input(z.object({ primaryUrl: z.string().trim().min(1).max(2_048) }))
      .mutation(({ input }) => joinPrimary(input.primaryUrl)),
    promote: t.procedure
      .input(z.object({ emergency: z.boolean() }))
      .mutation(({ input }) => promoteToPrimary(input.emergency)),
  }),

  backups: t.router({
    create: t.procedure.mutation(() => createVerifiedBackup('manual')),
  }),

  runners: t.router({
    registrations: t.procedure.query(() => getRunnerRegistrations()),
    create: t.procedure
      .input(runnerInputSchema)
      .mutation(({ input }) => commitWrite('runners.create', () => insertRunner(input))),
    update: t.procedure
      .input(runnerIdSchema.extend({ fields: runnerPatchSchema }))
      .mutation(({ input }) =>
        commitWrite(
          'runners.update',
          () => updateRunner(input.id, input.fields) ?? fail('NOT_FOUND', 'Loper niet gevonden')
        )
      ),
    delete: t.procedure.input(runnerIdSchema).mutation(({ input }) =>
      commitWrite('runners.delete', () => {
        const runner = getRunnerById(input.id) ?? fail('NOT_FOUND', 'Loper niet gevonden');
        if (runner.status === 'running') fail('CONFLICT', 'Actieve loper kan niet verwijderd worden');
        if (runner.lapCount > 0) fail('CONFLICT', 'Lopers met rondes blijven bewaard voor analyse');
        deleteRunner(input.id);
        return { ok: true };
      })
    ),
    setStatus: t.procedure.input(runnerStatusUpdateSchema).mutation(({ input }) =>
      commitWrite(
        'runners.setStatus',
        () =>
          updateRunnerStatus({
            id: input.id,
            status: input.status,
            statusSince: input.statusSince ?? Date.now(),
          }) ?? fail('NOT_FOUND', 'Loper niet gevonden')
      )
    ),
    reorder: t.procedure.input(queueReorderSchema).mutation(({ input }) =>
      commitWrite('runners.reorder', () => {
        updateWaitingOrder(input.ids);
        return { ok: true };
      })
    ),
    hide: t.procedure.input(runnerIdSchema).mutation(({ input }) =>
      commitWrite('runners.hide', () => {
        const current = getRunnerById(input.id) ?? fail('NOT_FOUND', 'Loper niet gevonden');
        if (current.status !== 'ran') fail('CONFLICT', 'Alleen gelopen lopers kunnen verborgen worden');
        return hideRunnerInQueue(input.id, Date.now()) ?? fail('NOT_FOUND', 'Loper niet gevonden');
      })
    ),
    unhide: t.procedure
      .input(runnerIdSchema)
      .mutation(({ input }) =>
        commitWrite('runners.unhide', () => unhideRunnerInQueue(input.id) ?? fail('NOT_FOUND', 'Loper niet gevonden'))
      ),
    importCsv: t.procedure.input(importCsvSchema).mutation(({ input }) =>
      commitWrite('runners.importCsv', () => {
        try {
          return importRunnersFromCsv(input.csvText);
        } catch (error) {
          if (error instanceof CsvImportError) fail('BAD_REQUEST', error.message);
          throw error;
        }
      })
    ),
  }),

  labels: t.router({
    create: t.procedure
      .input(labelInputSchema)
      .mutation(({ input }) => commitWrite('labels.create', () => createLabel(input))),
    update: t.procedure
      .input(runnerIdSchema.extend({ fields: labelPatchSchema }))
      .mutation(({ input }) =>
        commitWrite(
          'labels.update',
          () => updateLabel(input.id, input.fields) ?? fail('NOT_FOUND', 'Label niet gevonden')
        )
      ),
    delete: t.procedure.input(runnerIdSchema).mutation(({ input }) =>
      commitWrite('labels.delete', () => {
        if (!deleteLabel(input.id)) fail('NOT_FOUND', 'Label niet gevonden');
        return { ok: true };
      })
    ),
  }),

  temporaryTeams: t.router({
    create: t.procedure.input(temporaryTeamCreateSchema).mutation(({ input }) =>
      commitWrite('temporaryTeams.create', () => {
        const label = createLabel({
          name: input.name,
          color: input.color,
          kind: 'temporary_team',
        });
        setTemporaryTeamMembers(label.id, input.runnerIds);
        setTemporaryTeamSchedule(label.id, input.startsAt, input.endsAt);
        return requireTemporaryTeam(label.id);
      })
    ),
    setSchedule: t.procedure
      .input(temporaryTeamScheduleSchema.safeExtend({ labelId: z.string().min(1) }))
      .mutation(({ input }) =>
        commitWrite('temporaryTeams.setSchedule', () =>
          setTemporaryTeamSchedule(input.labelId, input.startsAt, input.endsAt)
        )
      ),
    setMembers: t.procedure
      .input(temporaryTeamMembersSchema)
      .mutation(({ input }) =>
        commitWrite('temporaryTeams.setMembers', () => setTemporaryTeamMembers(input.labelId, input.runnerIds))
      ),
    setActive: t.procedure
      .input(temporaryTeamActiveSchema)
      .mutation(({ input }) =>
        commitWrite('temporaryTeams.setActive', () => setTemporaryTeamActive(input.labelId, input.active, Date.now()))
      ),
  }),

  race: t.router({
    startNext: t.procedure.input(raceStateExpectationSchema).mutation(({ input }) =>
      commitWrite('race.startNext', () => {
        assertExpectedRaceState(input);
        if (input.activeRunnerId) fail('CONFLICT', 'Er loopt al een loper');
        const result = performHandoff(Date.now());
        return result.ok ? result : fail('CONFLICT', 'Niemand staat klaar in de wachtrij');
      })
    ),
    handoff: t.procedure.input(raceStateExpectationSchema).mutation(({ input }) =>
      commitWrite('race.handoff', () => {
        assertExpectedRaceState(input);
        const result = performHandoff(Date.now());
        return result.ok ? result : fail('CONFLICT', 'Niemand staat klaar in de wachtrij');
      })
    ),
    undoLastHandoff: t.procedure.input(raceStateExpectationSchema).mutation(({ input }) =>
      commitWrite('race.undoLastHandoff', () => {
        assertExpectedRaceState(input);
        const result = undoLastHandoff();
        return result.ok ? result : fail('CONFLICT', 'Er is geen wissel om ongedaan te maken');
      })
    ),
    finish: t.procedure.input(raceStateExpectationSchema).mutation(({ input }) =>
      commitWrite('race.finish', () => {
        assertExpectedRaceState(input);
        finishRace(Date.now());
        return { ok: true };
      })
    ),
  }),

  events: t.router({
    burgieGepakt: t.procedure.mutation(() =>
      commitWrite('events.burgieGepakt', () => createBurgieGepaktEvent(Date.now()))
    ),
  }),

  settings: t.router({
    updatePublicRecordMode: t.procedure
      .input(publicRecordModeUpdateSchema)
      .mutation(({ input }) =>
        commitWrite('settings.updatePublicRecordMode', () => setPublicRecordMode(input.publicRecordMode))
      ),
  }),
});

export type AppRouter = typeof appRouter;
