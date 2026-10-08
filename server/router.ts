import { EventEmitter, on } from 'node:events';
import { TRPCError, initTRPC } from '@trpc/server';
import { z } from 'zod';
import {
  importCsvSchema,
  importXlsxSchema,
  labelImageUploadSchema,
  labelInputSchema,
  labelPatchSchema,
  lapIdSchema,
  lapRunnerSchema,
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
import { activityPageSchema, backupFileSchema } from '../shared/schemas.js';
import { describeWrite } from './activity.js';
import { backupFile, createVerifiedBackup, listBackups } from './backups.js';
import { clusterNow } from './clock.js';
import {
  NOT_CONFIRMED_MESSAGE,
  NO_LEADER_MESSAGE,
  assertWritable,
  continueAlone,
  forwardWrite,
  groupSettled,
  linkWith,
  newRequestId,
  removeLaptop,
  writeDeadline,
  writeTarget,
} from './cluster.js';
import { clusterStatusUpdates } from './cluster-feed.js';
import { currentTerm, waitForCommit } from './consensus.js';
import { LAPTOP_NAME } from './host.js';
import { selfUrl } from './peers.js';
import {
  createBurgieGepaktEvent,
  createLabel,
  deleteLabel,
  deleteLap,
  deleteRunner,
  canUndoFinish,
  finishRace,
  findForwardedWrite,
  getActivity,
  getAppDataRevision,
  getLogHead,
  getRaceState,
  getRunnerById,
  getRunnerRegistrations,
  getTemporaryTeam,
  hideRunnerInQueue,
  insertRunner,
  logActivity,
  moveLap,
  onAppDataChanged,
  performHandoff,
  previewBackup,
  readRestoreData,
  replaceEventData,
  restoreDataSchema,
  recordWrite,
  saveForwardedWrite,
  saveLabelImage,
  setPublicRecordMode,
  setTemporaryTeamActive,
  setTemporaryTeamMembers,
  setTemporaryTeamSchedule,
  splitLap,
  touchForwardedWrite,
  undoLastHandoff,
  unhideRunnerInQueue,
  updateLabel,
  updateRunner,
  updateRunnerStatus,
  updateWaitingOrder,
} from './db.js';
import { CsvImportError, csvFromXlsx, importRunnersFromCsv } from './runner-import.js';

/**
 * A write another laptop passed on is `forwarded` and carries that laptop's
 * `requestId`; `reportLogSeq` tells it which log entry to wait for.
 */
export type RequestContext = {
  forwarded?: boolean;
  requestId?: string;
  reportLogSeq?: (seq: number) => void;
  /** The screen and address the operator made the change on, for the activity log. */
  origin?: string;
};

const t = initTRPC.context<RequestContext>().create();

// Clients refetch when the revision moves; several changes in one tick send one event.
const revisions = new EventEmitter<{ revision: [number] }>();
revisions.setMaxListeners(0);
let revisionEmitQueued = false;
onAppDataChanged(() => {
  if (revisionEmitQueued) return;
  revisionEmitQueued = true;
  setImmediate(() => {
    revisionEmitQueued = false;
    revisions.emit('revision', getAppDataRevision());
  });
});

type ErrorCode = ConstructorParameters<typeof TRPCError>[0]['code'];

/** Error codes a leader can answer a forwarded write with; anything else is reported as a server error. */
const FORWARDED_ERROR_CODES = new Set<string>(['BAD_REQUEST', 'NOT_FOUND', 'CONFLICT', 'SERVICE_UNAVAILABLE']);

function fail(code: 'NOT_FOUND' | 'BAD_REQUEST' | 'CONFLICT', message: string): never {
  throw new TRPCError({ code, message });
}

function unavailable(message: string): never {
  throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message });
}

type Preparation<P> = { value: P; isCurrent: () => boolean };

/**
 * A mutation that changes event data, callable on every laptop. The leader
 * commits it as one replicated write and answers once a majority of laptops
 * stored it. Any other laptop passes the call on to the leader, and repeats it
 * at the next leader when the first one fails meanwhile, so a key press
 * during a takeover still counts, once, with its original time.
 */
function write<I, T, P = undefined>(action: (input: I, prepared: P) => T, prepare?: () => Promise<Preparation<P>>) {
  return async ({ input, path, ctx }: { input: I; path: string; ctx: RequestContext }): Promise<T> => {
    const origin = ctx.origin || 'onbekend';
    const change = { type: path, input, origin, action: (prepared: P) => action(input, prepared), prepare };
    if (ctx.forwarded) return commitHere(change, ctx.requestId, ctx.reportLogSeq);
    const deadline = writeDeadline();
    let requestId: string | undefined;
    for (;;) {
      const target = await writeTarget(deadline);
      if (target === null) unavailable(NO_LEADER_MESSAGE);
      if (target === 'self') return commitHere(change, requestId);
      requestId ??= newRequestId();
      const outcome = await forwardWrite<T>(target, path, input, requestId, origin);
      if (outcome.ok) return outcome.data;
      if (outcome.retry && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      const code = (FORWARDED_ERROR_CODES.has(outcome.code) ? outcome.code : 'INTERNAL_SERVER_ERROR') as ErrorCode;
      throw new TRPCError({ code, message: outcome.message });
    }
  };
}

type Change<T, P> = {
  type: string;
  input: unknown;
  origin: string;
  action: (prepared: P) => T;
  prepare?: () => Promise<Preparation<P>>;
};

/**
 * Commits on this laptop, the leader, and waits until a majority holds the change.
 * The activity log entry is part of the same write.
 */
async function commitHere<T, P>(
  { type, input, origin, action, prepare }: Change<T, P>,
  requestId?: string,
  reportLogSeq?: (seq: number) => void
): Promise<T> {
  let prepared: P | undefined;
  try {
    assertWritable();
    // A repeated forwarded restore returns its original result and safety backup.
    if (prepare && !(requestId && findForwardedWrite(requestId))) {
      const deadline = writeDeadline();
      for (;;) {
        const candidate = await prepare();
        assertWritable();
        if (candidate.isCurrent()) {
          prepared = candidate.value;
          break;
        }
        if (performance.now() >= deadline) {
          unavailable('De gegevens veranderen nog. Probeer het terugzetten opnieuw.');
        }
      }
    }
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
      const describe = safeDescribe(type, input);
      // No await between checking the backup's revision and replacing the data.
      const outcome = action(prepared as P);
      if (describe) logActivity({ occurredAt: clusterNow(), action: type, summary: describe(outcome), origin });
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

/** A description that cannot be made never stops the change itself. */
function safeDescribe(type: string, input: unknown): ((result: unknown) => string) | null {
  try {
    const describe = describeWrite(type, input);
    if (!describe) return null;
    return (result) => {
      try {
        return describe(result);
      } catch {
        return type;
      }
    };
  } catch {
    return () => type;
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

const applyRestore = write(
  (input: z.infer<typeof restoreDataSchema>, safety) => ({ ...replaceEventData(input), ...safety }),
  async () => {
    const head = getLogHead();
    const term = currentTerm();
    const safety = await createVerifiedBackup('pre-restore');
    return {
      value: { safetyBackup: safety.fileName, safetyHostUrl: selfUrl(), safetyHostName: LAPTOP_NAME },
      isCurrent: () => currentTerm() === term && getLogHead().id === head.id,
    };
  }
);

/** One laptop out of the group at a time: it waits until everything written before it is on a majority. */
const removeMember = write(
  (input: { hostId: string }) => removeLaptop(input.hostId),
  async () => {
    await groupSettled();
    return { value: undefined, isCurrent: () => true };
  }
);

const importCsv = write((input: z.infer<typeof importCsvSchema>) => {
  try {
    return importRunnersFromCsv(input.csvText);
  } catch (error) {
    if (error instanceof CsvImportError) fail('BAD_REQUEST', error.message);
    throw error;
  }
});

export const appRouter = t.router({
  live: t.router({
    /** The data revision now and after every committed change, over the WebSocket. */
    revision: t.procedure.subscription(async function* ({ signal }) {
      // Listen before reading the current revision, so no change falls in between.
      const changes = on(revisions, 'revision', { signal });
      yield getAppDataRevision();
      for await (const [revision] of changes) yield revision as number;
    }),
    /** The group status now and whenever it changes, for the screens that show it. */
    cluster: t.procedure.subscription(({ signal }) => clusterStatusUpdates(signal)),
  }),

  cluster: t.router({
    join: t.procedure
      .input(z.object({ url: z.string().trim().min(1).max(2_048) }))
      .mutation(({ input }) => linkWith(input.url)),
    continueAlone: t.procedure.mutation(({ ctx }) => continueAlone(ctx.origin)),
    removeMember: t.procedure.input(z.object({ hostId: z.string().min(1).max(128) })).mutation(removeMember),
  }),

  backups: t.router({
    create: t.procedure.mutation(() => createVerifiedBackup('manual')),
    list: t.procedure.query(() => listBackups()),
    preview: t.procedure.input(backupFileSchema).query(({ input }) => {
      const found = backupFile(input.fileName) ?? fail('NOT_FOUND', 'Deze backup bestaat niet meer.');
      return previewBackup(found.path, found.record.fileName, found.record.createdAt);
    }),
    /**
     * Puts every laptop back to a backup of this laptop. The leader keeps a verified
     * backup of its current data first. The rows travel as one ordinary replicated write, so the
     * whole group changes together and nobody has to stop or relink a laptop.
     */
    restore: t.procedure.input(backupFileSchema).mutation(async ({ input, ctx }) => {
      const found = backupFile(input.fileName) ?? fail('NOT_FOUND', 'Deze backup bestaat niet meer.');
      let data;
      try {
        data = readRestoreData(found.path, found.record.fileName, found.record.createdAt);
      } catch (error) {
        fail('BAD_REQUEST', error instanceof Error ? error.message : String(error));
      }
      return applyRestore({ input: data, path: 'backups.applyRestore', ctx });
    }),
    /** The replicated half of `restore`; also what a laptop forwards to the leader. */
    applyRestore: t.procedure
      .input(restoreDataSchema)
      .mutation(({ input, path, ctx }) => applyRestore({ input, path, ctx })),
  }),

  activity: t.router({
    list: t.procedure.input(activityPageSchema).query(({ input }) => getActivity(input.limit, input.before)),
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
    importCsv: t.procedure.input(importCsvSchema).mutation(importCsv),
    // Read here, then imported as CSV: the write itself must not wait, and the leader gets plain text.
    importXlsx: t.procedure.input(importXlsxSchema).mutation(async ({ input, ctx }) => {
      let csvText: string;
      try {
        csvText = await csvFromXlsx(Buffer.from(input.dataBase64, 'base64'));
      } catch (error) {
        if (error instanceof CsvImportError) fail('BAD_REQUEST', error.message);
        throw error;
      }
      return importCsv({ input: { csvText }, path: 'runners.importCsv', ctx });
    }),
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
        // A finish without its own undo step would make undo take back the handoff before it.
        if (getRaceState().raceFinishedAt && !canUndoFinish()) {
          fail('CONFLICT', 'De race is afgesloten. Hervat de race eerst om een wissel ongedaan te maken.');
        }
        const result = undoLastHandoff();
        return result.ok ? result : fail('CONFLICT', 'Er is geen wissel om ongedaan te maken');
      })
    ),
    finish: t.procedure.input(timingPressSchema).mutation(
      write((input) => {
        const race = getRaceState();
        if (!race.raceStartedAt) fail('CONFLICT', 'De race is nog niet gestart.');
        if (race.raceFinishedAt) fail('CONFLICT', 'De race is al afgesloten.');
        assertExpectedRaceState(input);
        finishRace(pressMoment(input, FINISH_PRESS_MAX_AGE_MS));
        return { ok: true };
      })
    ),
  }),

  laps: t.router({
    move: t.procedure.input(lapRunnerSchema).mutation(write((input) => moveLap(input.lapId, input.runnerId))),
    split: t.procedure.input(lapRunnerSchema).mutation(write((input) => splitLap(input.lapId, input.runnerId))),
    delete: t.procedure.input(lapIdSchema).mutation(write((input) => deleteLap(input.lapId))),
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
