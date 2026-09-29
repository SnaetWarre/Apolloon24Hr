import { TRPCError, initTRPC } from '@trpc/server';
import { z } from 'zod';
import {
  importCsvSchema,
  labelImageUploadSchema,
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
import {
  NOT_CONFIRMED_MESSAGE,
  NO_LEADER_MESSAGE,
  assertWritable,
  continueAlone,
  forwardWrite,
  joinGroup,
  newRequestId,
  writeDeadline,
  writeTarget,
} from './cluster.js';
import { waitForCommit } from './consensus.js';
import {
  createBurgieGepaktEvent,
  createLabel,
  deleteLabel,
  deleteRunner,
  finishRace,
  findForwardedWrite,
  getLogHead,
  getRaceState,
  getRunnerById,
  getRunnerRegistrations,
  getTemporaryTeam,
  hideRunnerInQueue,
  insertRunner,
  performHandoff,
  recordWrite,
  saveForwardedWrite,
  saveLabelImage,
  setPublicRecordMode,
  setTemporaryTeamActive,
  setTemporaryTeamMembers,
  setTemporaryTeamSchedule,
  touchForwardedWrite,
  undoLastHandoff,
  unhideRunnerInQueue,
  updateLabel,
  updateRunner,
  updateRunnerStatus,
  updateWaitingOrder,
} from './db.js';
import { CsvImportError, importRunnersFromCsv } from './runner-import.js';

/**
 * A write another laptop passed on is `forwarded` and carries that laptop's
 * `requestId`; `reportLogSeq` tells it which log entry to wait for.
 */
export type RequestContext = {
  forwarded?: boolean;
  requestId?: string;
  reportLogSeq?: (seq: number) => void;
};

const t = initTRPC.context<RequestContext>().create();

type ErrorCode = ConstructorParameters<typeof TRPCError>[0]['code'];

/** Error codes a leader can answer a forwarded write with; anything else is reported as a server error. */
const FORWARDED_ERROR_CODES = new Set<string>(['BAD_REQUEST', 'NOT_FOUND', 'CONFLICT', 'SERVICE_UNAVAILABLE']);

function fail(code: 'NOT_FOUND' | 'BAD_REQUEST' | 'CONFLICT', message: string): never {
  throw new TRPCError({ code, message });
}

function unavailable(message: string): never {
  throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message });
}

/**
 * A mutation that changes event data, callable on every laptop. The leader
 * commits it as one replicated write and answers once a majority of laptops
 * stored it. Any other laptop passes the call on to the leader, and repeats it
 * at the next leader when the first one fails meanwhile, so a key press
 * during a takeover still counts, once, with its original time.
 */
function write<I, T>(action: (input: I) => T) {
  return async ({ input, path, ctx }: { input: I; path: string; ctx: RequestContext }): Promise<T> => {
    if (ctx.forwarded) return commitHere(path, () => action(input), ctx.requestId, ctx.reportLogSeq);
    const deadline = writeDeadline();
    let requestId: string | undefined;
    for (;;) {
      const target = await writeTarget(deadline);
      if (target === null) unavailable(NO_LEADER_MESSAGE);
      if (target === 'self') return commitHere(path, () => action(input), requestId);
      requestId ??= newRequestId();
      const outcome = await forwardWrite<T>(target, path, input, requestId);
      if (outcome.ok) return outcome.data;
      if (outcome.retry && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      const code = (FORWARDED_ERROR_CODES.has(outcome.code) ? outcome.code : 'INTERNAL_SERVER_ERROR') as ErrorCode;
      throw new TRPCError({ code, message: outcome.message });
    }
  };
}

/** Commits on this laptop, the leader, and waits until a majority holds the change. */
async function commitHere<T>(
  type: string,
  action: () => T,
  requestId?: string,
  reportLogSeq?: (seq: number) => void
): Promise<T> {
  try {
    assertWritable();
  } catch (error) {
    unavailable((error as Error).message);
  }
  let result: T;
  try {
    result = recordWrite(type, () => {
      const earlier = requestId ? findForwardedWrite(requestId) : null;
      if (requestId && earlier) {
        touchForwardedWrite(requestId, clusterNow());
        return earlier.result as T;
      }
      const outcome = action();
      if (requestId) saveForwardedWrite(requestId, outcome, clusterNow());
      return outcome;
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    fail('CONFLICT', domainErrorMessage(error));
  }
  const seq = getLogHead().seq;
  reportLogSeq?.(seq);
  if (!(await waitForCommit(seq))) unavailable(NOT_CONFIRMED_MESSAGE);
  return result;
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

/** A press may wait this long during a takeover (the write deadline) and still keep its own time. */
const PRESS_MAX_AGE_MS = 20_000;
/** Finishing stops the clock at the first click; the confirmations after it may take a while. */
const FINISH_PRESS_MAX_AGE_MS = 10 * 60_000;

/**
 * The moment of the key press as the timing screen recorded it. A press older
 * than any takeover wait, or in the future, means that screen's clock is off,
 * so the arrival time is used instead.
 */
function pressMoment(press: TimingPress, maxAgeMs = PRESS_MAX_AGE_MS): number {
  const now = clusterNow();
  const pressedAt = press.pressedAt;
  const plausible = pressedAt !== undefined && pressedAt >= now - maxAgeMs && pressedAt <= now + 1_000;
  return Math.max(plausible ? pressedAt : now, press.activeStartedAt ?? 0);
}

function requireTemporaryTeam(labelId: string): TemporaryTeam {
  return getTemporaryTeam(labelId) ?? fail('NOT_FOUND', 'Tijdelijke nachtploeg niet gevonden');
}

export const appRouter = t.router({
  cluster: t.router({
    join: t.procedure
      .input(z.object({ url: z.string().trim().min(1).max(2_048) }))
      .mutation(({ input }) => joinGroup(input.url)),
    continueAlone: t.procedure.mutation(() => continueAlone()),
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
    uploadImage: t.procedure
      .input(labelImageUploadSchema)
      .mutation(write((input) => ({ imageUrl: saveLabelImage(input) }))),
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
        finishRace(pressMoment(input, FINISH_PRESS_MAX_AGE_MS));
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
