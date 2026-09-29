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
  timingPressSchema,
  type RaceStateExpectation,
  type TemporaryTeam,
  type TimingPress,
} from '../shared/schemas.js';
import { createVerifiedBackup } from './backups.js';
import { clusterNow } from './clock.js';
import { assertWritable, forwardWrite, isFollowing, joinPrimary, promoteToPrimary } from './cluster.js';
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

/** `forwarded` marks a write another laptop passed on to this one. */
export type RequestContext = { forwarded?: boolean };

const t = initTRPC.context<RequestContext>().create();

type ErrorCode = ConstructorParameters<typeof TRPCError>[0]['code'];

/** Error codes a primary can answer a forwarded write with; anything else is reported as a server error. */
const FORWARDED_ERROR_CODES = new Set<string>(['BAD_REQUEST', 'NOT_FOUND', 'CONFLICT', 'SERVICE_UNAVAILABLE']);

function fail(code: 'NOT_FOUND' | 'BAD_REQUEST' | 'CONFLICT', message: string): never {
  throw new TRPCError({ code, message });
}

/**
 * A mutation that changes event data. The main laptop commits it as one
 * replicated write; any other laptop passes the call on to the main laptop
 * and answers once its own copy has the change.
 */
function write<I, T>(action: (input: I) => T) {
  return async ({ input, path, ctx }: { input: I; path: string; ctx: RequestContext }): Promise<T> => {
    if (isFollowing()) {
      if (ctx.forwarded) {
        throw new TRPCError({
          code: 'SERVICE_UNAVAILABLE',
          message: 'De laptops wisselen net van rol. Probeer opnieuw.',
        });
      }
      const outcome = await forwardWrite<T>(path, input);
      if (outcome.ok) return outcome.data;
      const code = (FORWARDED_ERROR_CODES.has(outcome.code) ? outcome.code : 'INTERNAL_SERVER_ERROR') as ErrorCode;
      throw new TRPCError({ code, message: outcome.message });
    }
    return commitWrite(path, () => action(input));
  };
}

function commitWrite<T>(type: string, action: () => T): T {
  try {
    assertWritable();
  } catch (error) {
    throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: (error as Error).message });
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

/**
 * The moment of the key press as the timing screen recorded it. A press more
 * than a few seconds from this laptop's clock means that screen's clock is
 * off, so the arrival time is used instead.
 */
function pressMoment(press: TimingPress): number {
  const now = clusterNow();
  const pressedAt = press.pressedAt;
  const plausible = pressedAt !== undefined && pressedAt >= now - 10_000 && pressedAt <= now + 1_000;
  return Math.max(plausible ? pressedAt : now, press.activeStartedAt ?? 0);
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
    create: t.procedure.input(runnerInputSchema).mutation(write((input) => insertRunner(input))),
    update: t.procedure
      .input(runnerIdSchema.extend({ fields: runnerPatchSchema }))
      .mutation(write((input) => updateRunner(input.id, input.fields) ?? fail('NOT_FOUND', 'Loper niet gevonden'))),
    delete: t.procedure.input(runnerIdSchema).mutation(
      write((input) => {
        const runner = getRunnerById(input.id) ?? fail('NOT_FOUND', 'Loper niet gevonden');
        if (runner.status === 'running') fail('CONFLICT', 'Actieve loper kan niet verwijderd worden');
        if (runner.lapCount > 0) fail('CONFLICT', 'Lopers met rondes blijven bewaard voor analyse');
        deleteRunner(input.id);
        return { ok: true };
      })
    ),
    setStatus: t.procedure.input(runnerStatusUpdateSchema).mutation(
      write(
        (input) =>
          updateRunnerStatus({
            id: input.id,
            status: input.status,
            statusSince: input.statusSince ?? clusterNow(),
          }) ?? fail('NOT_FOUND', 'Loper niet gevonden')
      )
    ),
    reorder: t.procedure.input(queueReorderSchema).mutation(
      write((input) => {
        updateWaitingOrder(input.ids);
        return { ok: true };
      })
    ),
    hide: t.procedure.input(runnerIdSchema).mutation(
      write((input) => {
        const current = getRunnerById(input.id) ?? fail('NOT_FOUND', 'Loper niet gevonden');
        if (current.status !== 'ran') fail('CONFLICT', 'Alleen gelopen lopers kunnen verborgen worden');
        return hideRunnerInQueue(input.id, clusterNow()) ?? fail('NOT_FOUND', 'Loper niet gevonden');
      })
    ),
    unhide: t.procedure
      .input(runnerIdSchema)
      .mutation(write((input) => unhideRunnerInQueue(input.id) ?? fail('NOT_FOUND', 'Loper niet gevonden'))),
    importCsv: t.procedure.input(importCsvSchema).mutation(
      write((input) => {
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
    create: t.procedure.input(labelInputSchema).mutation(write((input) => createLabel(input))),
    update: t.procedure
      .input(runnerIdSchema.extend({ fields: labelPatchSchema }))
      .mutation(write((input) => updateLabel(input.id, input.fields) ?? fail('NOT_FOUND', 'Label niet gevonden'))),
    delete: t.procedure.input(runnerIdSchema).mutation(
      write((input) => {
        if (!deleteLabel(input.id)) fail('NOT_FOUND', 'Label niet gevonden');
        return { ok: true };
      })
    ),
  }),

  temporaryTeams: t.router({
    create: t.procedure.input(temporaryTeamCreateSchema).mutation(
      write((input) => {
        const label = createLabel({ name: input.name, color: input.color, kind: 'temporary_team' });
        setTemporaryTeamMembers(label.id, input.runnerIds);
        setTemporaryTeamSchedule(label.id, input.startsAt, input.endsAt);
        return requireTemporaryTeam(label.id);
      })
    ),
    setSchedule: t.procedure
      .input(temporaryTeamScheduleSchema.safeExtend({ labelId: z.string().min(1) }))
      .mutation(write((input) => setTemporaryTeamSchedule(input.labelId, input.startsAt, input.endsAt))),
    setMembers: t.procedure
      .input(temporaryTeamMembersSchema)
      .mutation(write((input) => setTemporaryTeamMembers(input.labelId, input.runnerIds))),
    setActive: t.procedure
      .input(temporaryTeamActiveSchema)
      .mutation(write((input) => setTemporaryTeamActive(input.labelId, input.active, clusterNow()))),
  }),

  race: t.router({
    startNext: t.procedure.input(timingPressSchema).mutation(
      write((input) => {
        assertExpectedRaceState(input);
        if (input.activeRunnerId) fail('CONFLICT', 'Er loopt al een loper');
        const result = performHandoff(pressMoment(input));
        return result.ok ? result : fail('CONFLICT', 'Niemand staat klaar in de wachtrij');
      })
    ),
    handoff: t.procedure.input(timingPressSchema).mutation(
      write((input) => {
        assertExpectedRaceState(input);
        const result = performHandoff(pressMoment(input), input.measuredDurationMs);
        return result.ok ? result : fail('CONFLICT', 'Niemand staat klaar in de wachtrij');
      })
    ),
    undoLastHandoff: t.procedure.input(raceStateExpectationSchema).mutation(
      write((input) => {
        assertExpectedRaceState(input);
        const result = undoLastHandoff();
        return result.ok ? result : fail('CONFLICT', 'Er is geen wissel om ongedaan te maken');
      })
    ),
    finish: t.procedure.input(timingPressSchema).mutation(
      write((input) => {
        assertExpectedRaceState(input);
        finishRace(pressMoment(input));
        return { ok: true };
      })
    ),
  }),

  events: t.router({
    burgieGepakt: t.procedure.mutation(write(() => createBurgieGepaktEvent(clusterNow()))),
  }),

  settings: t.router({
    updatePublicRecordMode: t.procedure
      .input(publicRecordModeUpdateSchema)
      .mutation(write((input) => setPublicRecordMode(input.publicRecordMode))),
  }),
});

export type AppRouter = typeof appRouter;
