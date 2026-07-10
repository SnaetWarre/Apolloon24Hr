import { TRPCError, initTRPC } from '@trpc/server';
import Papa from 'papaparse';
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
  temporaryTeamMembersSchema,
  type ImportSummary,
  type RunnerInput,
} from '../shared/schemas.js';
import { appSnapshot } from './app-state.js';
import { assertWritable, recordLocalWrite } from './cluster.js';
import {
  createBurgieGepaktEvent,
  createLabel,
  deleteLabel,
  deleteRunner,
  finishRace,
  getAllLaps,
  getAllRaceEvents,
  getAllRunners,
  getAppSettings,
  getLabels,
  getLapById,
  getRaceState,
  getRunnerById,
  getTemporaryTeams,
  hideRunnerInQueue,
  insertRunner,
  performHandoff,
  setPublicRecordMode,
  setTemporaryTeamActive,
  setTemporaryTeamMembers,
  undoLastHandoff,
  unhideRunnerInQueue,
  updateLabel,
  updateRunner,
  updateRunnerStatus,
  updateWaitingOrder,
  upsertRunnerFromImport,
} from './db.js';
import { hostInfo } from './host.js';
import { emitRealtime } from './realtime.js';

const t = initTRPC.create();

function cleanText(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function parsePositiveInt(value: unknown): number | null {
  const text = cleanText(value);
  if (!text) return null;
  const n = Number(text.replace(',', '.'));
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
}

function parseDurationMs(value: unknown): number | null {
  const text = cleanText(value);
  if (!text) return null;
  if (text.includes(':')) {
    const parts = text.split(':').map((part) => Number(part.replace(',', '.')));
    if (parts.some((part) => !Number.isFinite(part))) return null;
    if (parts.length === 2) {
      return Math.round((parts[0] * 60 + parts[1]) * 1000);
    }
    if (parts.length === 3) {
      return Math.round((parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000);
    }
    return null;
  }
  const seconds = Number(text.replace(',', '.'));
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
}

function splitLabels(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((item) => cleanText(item).split(/[,;|]/))
    .map((label) => label.trim())
    .filter((label) => {
      if (!label) return false;
      const normalized = label.toLowerCase();
      return !['nee', 'neen', 'geen', 'n/a', 'na', 'none', '-', 'ja'].includes(normalized);
    });
}

function getRowValue(row: Record<string, unknown>, names: string[]): unknown {
  const entries: Array<[string, unknown]> = Object.entries(row || {}).map(([key, value]) => [
    String(key).trim().toLowerCase().replace(/\s+/g, '_'),
    value,
  ]);
  const map = new Map(entries);
  for (const name of names) {
    const value = map.get(name);
    if (value !== undefined && cleanText(value)) return value;
  }
  return '';
}

function emitRunnerCollections(): void {
  emitRealtime({ type: 'runners:patched', payload: getAllRunners() });
}

function emitLabelCollections(): void {
  emitRealtime({ type: 'labels:patched', payload: getLabels() });
}

function emitRaceCollections(): void {
  emitRealtime({ type: 'race:changed', payload: getRaceState() });
  emitRunnerCollections();
}

function notFound(message: string): never {
  throw new TRPCError({ code: 'NOT_FOUND', message });
}

function badRequest(message: string): never {
  throw new TRPCError({ code: 'BAD_REQUEST', message });
}

function conflict(message: string): never {
  throw new TRPCError({ code: 'CONFLICT', message });
}

function assertExpectedRaceState(expected: { activeRunnerId: string | null; activeStartedAt: number | null }): void {
  const actual = getRaceState();
  if (actual.activeRunnerId !== expected.activeRunnerId || actual.activeStartedAt !== expected.activeStartedAt) {
    conflict('Timingstatus is gewijzigd. Controleer de huidige loper en probeer opnieuw.');
  }
}

function commitWrite<T>(type: string, action: () => T): T {
  try {
    assertWritable();
  } catch (err) {
    conflict(err instanceof Error ? err.message : 'This host cannot accept writes');
  }
  const result = action();
  recordLocalWrite(type);
  return result;
}

export const appRouter = t.router({
  state: t.router({
    snapshot: t.procedure.query(() => appSnapshot()),
    time: t.procedure.query(() => ({ serverNowMs: Date.now() })),
    hostInfo: t.procedure.query(() => hostInfo()),
  }),

  runners: t.router({
    list: t.procedure.query(() => getAllRunners()),
    create: t.procedure.input(runnerInputSchema).mutation(({ input }) => {
      return commitWrite('runners.create', () => {
        const runner = insertRunner(input);
        emitRealtime({ type: 'runner:upserted', payload: runner });
        return runner;
      });
    }),
    update: t.procedure
      .input(runnerIdSchema.extend({ fields: runnerPatchSchema }))
      .mutation(({ input }) => {
        return commitWrite('runners.update', () => {
          const runner = updateRunner(input.id, input.fields);
          if (!runner) notFound('runner not found');
          emitRealtime({ type: 'runner:upserted', payload: runner });
          return runner;
        });
      }),
    delete: t.procedure.input(runnerIdSchema).mutation(({ input }) => {
      return commitWrite('runners.delete', () => {
        const runner = getRunnerById(input.id);
        if (!runner) notFound('runner not found');
        if (runner.status === 'running') conflict('Actieve loper kan niet verwijderd worden');
        if (runner.lapCount > 0) conflict('Lopers met rondes blijven bewaard voor analyse');
        deleteRunner(input.id);
        emitRealtime({ type: 'runner:deleted', payload: input.id });
        return { ok: true };
      });
    }),
    setStatus: t.procedure.input(runnerStatusUpdateSchema).mutation(({ input }) => {
      return commitWrite('runners.setStatus', () => {
        let runner: ReturnType<typeof updateRunnerStatus>;
        try {
          runner = updateRunnerStatus({
            id: input.id,
            status: input.status,
            statusSince: input.statusSince ?? Date.now(),
          });
        } catch (err) {
          conflict(err instanceof Error ? err.message : 'Loperstatus aanpassen mislukt');
        }
        if (!runner) notFound('runner not found');
        emitRealtime({ type: 'runner:upserted', payload: runner });
        emitRealtime({ type: 'queue:patched', payload: getAllRunners() });
        emitRealtime({ type: 'race:changed', payload: getRaceState() });
        return runner;
      });
    }),
    reorder: t.procedure.input(queueReorderSchema).mutation(({ input }) => {
      return commitWrite('runners.reorder', () => {
        try {
          updateWaitingOrder(input.ids);
        } catch (err) {
          badRequest(err instanceof Error ? err.message : 'Wachtrij herschikken mislukt');
        }
        emitRealtime({ type: 'queue:patched', payload: getAllRunners() });
        return { ok: true };
      });
    }),
    hide: t.procedure.input(runnerIdSchema).mutation(({ input }) => {
      return commitWrite('runners.hide', () => {
        const current = getRunnerById(input.id);
        if (!current) notFound('runner not found');
        if (current.status !== 'ran') conflict('Alleen gelopen lopers kunnen verborgen worden');
        const runner = hideRunnerInQueue(input.id, Date.now());
        if (!runner) notFound('runner not found');
        emitRealtime({ type: 'runner:upserted', payload: runner });
        emitRealtime({ type: 'queue:patched', payload: getAllRunners() });
        return runner;
      });
    }),
    unhide: t.procedure.input(runnerIdSchema).mutation(({ input }) => {
      return commitWrite('runners.unhide', () => {
        const current = getRunnerById(input.id);
        if (!current) notFound('runner not found');
        const runner = unhideRunnerInQueue(input.id);
        if (!runner) notFound('runner not found');
        emitRealtime({ type: 'runner:upserted', payload: runner });
        emitRealtime({ type: 'queue:patched', payload: getAllRunners() });
        return runner;
      });
    }),
    importCsv: t.procedure.input(importCsvSchema).mutation(({ input }) => {
      return commitWrite('runners.importCsv', () => {
        const csvText = cleanText(input.csvText);
        if (!csvText) badRequest('csvText required');

        const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true }) as {
          data: Record<string, unknown>[];
          errors?: Array<{ message: string }>;
        };
        if (parsed.errors?.length) {
          badRequest(parsed.errors[0].message);
        }

        const summary: ImportSummary = {
          created: 0,
          updated: 0,
          skipped: 0,
          errors: [],
        };

        for (const [index, row] of parsed.data.entries()) {
          const runnerNumber = cleanText(
            getRowValue(row, ['runner_number', 'lopersnummer', 'nummer', 'number', 'bib'])
          );
          const name = cleanText(getRowValue(row, ['name', 'naam', 'runner_name', 'loper']));

          if (!runnerNumber || !name) {
            summary.skipped += 1;
            summary.errors.push(`Rij ${index + 2}: runner_number en name zijn verplicht`);
            continue;
          }

          try {
            const labelValues = [
              getRowValue(row, ['labels', 'label', 'categorie', 'categories', 'type']),
              getRowValue(row, ['zustervereniging', 'vereniging', 'club']),
              getRowValue(row, ['team', 'speedteam']),
              getRowValue(row, ['jaar', 'groep']),
            ];
            const runnerInput: RunnerInput = {
              runnerNumber,
              name,
              labels: splitLabels(labelValues),
              targetLaps: parsePositiveInt(getRowValue(row, ['target_laps', 'doelstelling', 'target'])),
              historicalAvgMs: parseDurationMs(
                getRowValue(row, ['historical_avg', 'gemiddelde', 'avg', 'average'])
              ),
              historicalBestMs: parseDurationMs(
                getRowValue(row, ['historical_best', 'snelste', 'best', 'fastest'])
              ),
              status: 'registered',
              registrationSource: 'import',
            };
            const result = upsertRunnerFromImport(runnerInput);
            if (result.action === 'updated') summary.updated += 1;
            else summary.created += 1;
          } catch (err) {
            summary.skipped += 1;
            summary.errors.push(
              `Rij ${index + 2}: ${err instanceof Error ? err.message : 'import mislukt'}`
            );
          }
        }

        emitRunnerCollections();
        emitLabelCollections();
        return summary;
      });
    }),
  }),

  labels: t.router({
    list: t.procedure.query(() => getLabels()),
    create: t.procedure.input(labelInputSchema).mutation(({ input }) => {
      return commitWrite('labels.create', () => {
        const label = createLabel(input);
        emitRealtime({ type: 'label:upserted', payload: label });
        emitRealtime({ type: 'temporary-teams:patched', payload: getTemporaryTeams() });
        return label;
      });
    }),
    update: t.procedure
      .input(runnerIdSchema.extend({ fields: labelPatchSchema }))
      .mutation(({ input }) => {
        return commitWrite('labels.update', () => {
          const label = updateLabel(input.id, input.fields);
          if (!label) notFound('label not found');
          emitRealtime({ type: 'label:upserted', payload: label });
          emitRealtime({ type: 'temporary-teams:patched', payload: getTemporaryTeams() });
          emitRunnerCollections();
          return label;
        });
      }),
    delete: t.procedure.input(runnerIdSchema).mutation(({ input }) => {
      return commitWrite('labels.delete', () => {
        if (!deleteLabel(input.id)) notFound('label not found');
        emitRealtime({ type: 'label:deleted', payload: input.id });
        emitRealtime({ type: 'temporary-teams:patched', payload: getTemporaryTeams() });
        emitRunnerCollections();
        return { ok: true };
      });
    }),
  }),

  temporaryTeams: t.router({
    list: t.procedure.query(() => getTemporaryTeams()),
    setMembers: t.procedure.input(temporaryTeamMembersSchema).mutation(({ input }) => {
      return commitWrite('temporaryTeams.setMembers', () => {
        const team = setTemporaryTeamMembers(input.labelId, input.runnerIds);
        emitRealtime({ type: 'temporary-teams:patched', payload: getTemporaryTeams() });
        return team;
      });
    }),
    setActive: t.procedure.input(temporaryTeamActiveSchema).mutation(({ input }) => {
      return commitWrite('temporaryTeams.setActive', () => {
        const team = setTemporaryTeamActive(input.labelId, input.active, Date.now());
        emitRunnerCollections();
        emitRealtime({ type: 'temporary-teams:patched', payload: getTemporaryTeams() });
        return team;
      });
    }),
  }),

  race: t.router({
    state: t.procedure.query(() => getRaceState()),
    laps: t.procedure.query(() => getAllLaps()),
    startNext: t.procedure.input(raceStateExpectationSchema).mutation(({ input }) => {
      return commitWrite('race.startNext', () => {
        assertExpectedRaceState(input);
        if (input.activeRunnerId) conflict('Er loopt al een loper');
        const result = performHandoff(Date.now());
        if (!result.ok) conflict(result.error);
        emitRaceCollections();
        return result;
      });
    }),
    handoff: t.procedure.input(raceStateExpectationSchema).mutation(({ input }) => {
      return commitWrite('race.handoff', () => {
        assertExpectedRaceState(input);
        const result = performHandoff(Date.now());
        if (!result.ok) conflict(result.error);
        emitRaceCollections();
        if (result.lapId) {
          const lap = getLapById(result.lapId);
          if (lap) emitRealtime({ type: 'lap:created', payload: lap });
        }
        return result;
      });
    }),
    undoLastHandoff: t.procedure.input(raceStateExpectationSchema).mutation(({ input }) => {
      return commitWrite('race.undoLastHandoff', () => {
        assertExpectedRaceState(input);
        const result = undoLastHandoff();
        if (!result.ok) conflict(result.error);
        emitRaceCollections();
        for (const lapId of result.deletedLapIds) {
          emitRealtime({ type: 'lap:deleted', payload: lapId });
        }
        return result;
      });
    }),
    finish: t.procedure.input(raceStateExpectationSchema).mutation(({ input }) => {
      return commitWrite('race.finish', () => {
        assertExpectedRaceState(input);
        finishRace(Date.now());
        emitRaceCollections();
        return { ok: true };
      });
    }),
  }),

  events: t.router({
    list: t.procedure.query(() => getAllRaceEvents()),
    burgieGepakt: t.procedure.mutation(() => {
      return commitWrite('events.burgieGepakt', () => {
        const event = createBurgieGepaktEvent(Date.now());
        emitRealtime({ type: 'race-event:created', payload: event });
        return event;
      });
    }),
  }),

  settings: t.router({
    current: t.procedure.query(() => getAppSettings()),
    updatePublicRecordMode: t.procedure.input(publicRecordModeUpdateSchema).mutation(({ input }) => {
      return commitWrite('settings.updatePublicRecordMode', () => {
        const settings = setPublicRecordMode(input.publicRecordMode);
        emitRealtime({ type: 'settings:changed', payload: settings });
        return settings;
      });
    }),
  }),
});

export type AppRouter = typeof appRouter;
