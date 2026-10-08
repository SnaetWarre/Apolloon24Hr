import type { PublicRecordMode, Runner, RunnerStatus } from '../shared/schemas.js';
import { formatDurationMs } from '../shared/time.js';
import { getLabels, getLapById, getRaceState, getRunnerById, getRunnerRegistrations, lapsToUndo } from './db.js';

/**
 * Says in words what a write does, for Beheer › Activiteit. Called before the write, so
 * it still sees what gets deleted; the returned function finishes the sentence with the
 * result. `null` means the write is not worth listing: handoffs already are the laps.
 */
export function describeWrite(path: string, input: unknown): ((result: unknown) => string) | null {
  const value = (input ?? {}) as Record<string, unknown>;
  const id = typeof value.id === 'string' ? value.id : typeof value.labelId === 'string' ? value.labelId : '';

  switch (path) {
    case 'race.handoff':
      return null;
    case 'race.startNext': {
      const started = getRaceState().raceStartedAt !== null;
      return () => (started ? 'Volgende loper gestart' : 'Wedstrijd gestart');
    }
    case 'race.undoLastHandoff': {
      // Undo after a finish takes back the finish itself.
      const finished = getRaceState().raceFinishedAt !== null;
      // Names the lap as it stands now: Beheer › Rondes may have moved it to another runner since.
      const laps = lapsToUndo()
        .filter((lapId) => getLapById(lapId))
        .map(lapText);
      return () =>
        finished
          ? 'Wedstrijd heropend (beëindigen ongedaan gemaakt)'
          : laps.length
            ? `Laatste wissel ongedaan gemaakt (${laps.join(' en ')} verwijderd)`
            : 'Laatste wissel ongedaan gemaakt';
    }
    case 'race.finish':
      return () => 'Wedstrijd beëindigd';
    case 'laps.move': {
      const lap = lapText(value.lapId);
      const runner = runnerName(String(value.runnerId ?? ''));
      return () => `${lap} naar ${runner} verplaatst`;
    }
    case 'laps.split': {
      const lap = lapText(value.lapId);
      const first = getLapById(String(value.lapId ?? ''))?.runnerId;
      const second = String(value.runnerId ?? '');
      const runner = runnerName(second);
      return () =>
        second === first
          ? `${lap} gesplitst in twee rondes van ${runner}`
          : `${lap} gesplitst: de tweede helft is voor ${runner}`;
    }
    case 'laps.delete': {
      const lap = lapText(value.lapId);
      return () => `${lap} verwijderd`;
    }
    case 'events.burgieGepakt':
      return () => 'Burgie gepakt';
    case 'runners.create':
      return (result) => `${runnerText(result as Runner | null) || String(value.name ?? 'Loper')} toegevoegd`;
    case 'runners.update': {
      // The profile sends every field on each save, so list only what the write really changed.
      const runner = runnerName(id);
      const before = profileValues(id);
      return () => {
        const after = profileValues(id);
        const changed = Object.keys(before).filter((field) => before[field] !== after[field]);
        return `${runner} aangepast (${changed.length ? changed.join(', ') : 'niets gewijzigd'})`;
      };
    }
    case 'runners.delete': {
      const runner = runnerName(id);
      return () => `${runner} verwijderd`;
    }
    case 'runners.setStatus': {
      const runner = runnerName(id);
      return () => `${runner}: ${STATUS_TEXT[value.status as RunnerStatus] ?? String(value.status)}`;
    }
    case 'runners.reorder':
      return () => 'Wachtrij herschikt';
    case 'runners.hide': {
      const runner = runnerName(id);
      return () => `${runner} verborgen in de wachtrij`;
    }
    case 'runners.unhide': {
      const runner = runnerName(id);
      return () => `${runner} terug zichtbaar in de wachtrij`;
    }
    case 'runners.importCsv':
      return (result) => {
        const summary = result as { created?: number; updated?: number } | null;
        return `Inschrijvingen geïmporteerd: ${summary?.created ?? 0} nieuw, ${summary?.updated ?? 0} bijgewerkt`;
      };
    case 'labels.create':
      return () => `Label ${String(value.name ?? '')} toegevoegd`;
    case 'labels.update': {
      const label = labelName(id);
      return () => `Label ${label} aangepast (${fieldNames(value.fields)})`;
    }
    case 'labels.delete': {
      const label = labelName(id);
      return () => `Label ${label} verwijderd`;
    }
    case 'labels.uploadImage':
      return () => 'Logo opgeladen';
    case 'temporaryTeams.create':
      return () => `Nachtploeg ${String(value.name ?? '')} aangemaakt`;
    case 'temporaryTeams.setSchedule': {
      const label = labelName(id);
      return () => `Uren van nachtploeg ${label} aangepast`;
    }
    case 'temporaryTeams.setMembers': {
      const label = labelName(id);
      return () => `Leden van nachtploeg ${label} aangepast`;
    }
    case 'temporaryTeams.setActive': {
      const label = labelName(id);
      return () => `Nachtploeg ${label} ${value.active ? 'gestart' : 'gestopt'}`;
    }
    case 'settings.updatePublicRecordMode':
      return () =>
        `Records op de publieke schermen: ${RECORD_MODE_TEXT[value.publicRecordMode as PublicRecordMode] ?? ''}`;
    case 'backups.applyRestore': {
      const at = typeof value.backupCreatedAt === 'number' ? value.backupCreatedAt : null;
      return (result) => {
        const restored = result as { runners?: number; laps?: number } | null;
        const when = at === null ? '' : ` van ${formatMoment(at)}`;
        return `Backup${when} teruggezet (${restored?.runners ?? 0} lopers, ${restored?.laps ?? 0} rondes)`;
      };
    }
    default:
      return () => path;
  }
}

const STATUS_TEXT: Record<RunnerStatus, string> = {
  registered: 'terug naar ingeschreven',
  warming_up: 'naar opwarming',
  waiting: 'naar de wachtrij',
  running: 'op de piste',
  ran: 'heeft gelopen',
};

const RECORD_MODE_TEXT: Record<PublicRecordMode, string> = {
  off: 'uit',
  day: 'per dag',
  two_hour: 'per 2 uur',
  hour: 'per uur',
};

const FIELD_TEXT: Record<string, string> = {
  name: 'naam',
  color: 'kleur',
  icon: 'icoon',
  kind: 'soort',
  imageUrl: 'logo',
  sortOrder: 'volgorde',
};

function fieldNames(fields: unknown): string {
  const names = Object.keys((fields ?? {}) as object).map((key) => FIELD_TEXT[key] ?? key);
  return names.length ? names.join(', ') : 'niets';
}

/** What an operator can edit on a runner, by its Dutch name, as text to compare. */
function profileValues(id: string): Record<string, string> {
  const runner = id ? getRunnerById(id) : null;
  if (!runner) return {};
  const registration = getRunnerRegistrations()[id];
  return {
    naam: runner.name,
    nummer: runner.runnerNumber ?? '',
    doel: String(runner.targetLaps),
    gemiddelde: String(runner.historicalAvgMs),
    'beste tijd': String(runner.historicalBestMs),
    notities: runner.notes,
    telefoon: registration?.phone ?? '',
    'e-mail': registration?.email ?? '',
    uren: (registration?.availableHours ?? []).join('\n'),
    labels: runner.labels
      .map((label) => label.id)
      .sort()
      .join(),
  };
}

function runnerName(id: string): string {
  return runnerText(id ? getRunnerById(id) : null) || 'Loper';
}

function runnerText(runner: Pick<Runner, 'name' | 'runnerNumber'> | null): string {
  if (!runner?.name) return '';
  return runner.runnerNumber ? `#${runner.runnerNumber} ${runner.name}` : runner.name;
}

/** "Ronde 3 van #12 Jan (1:14.320, do 21:05)", read before the write changes it. */
function lapText(lapId: unknown): string {
  const lap = typeof lapId === 'string' ? getLapById(lapId) : null;
  if (!lap) return 'Ronde';
  const runner = runnerText({ name: lap.runnerName, runnerNumber: lap.runnerNumber }) || 'Loper';
  return `Ronde ${lap.lapNumber} van ${runner} (${formatDurationMs(lap.durationMs)}, ${formatMoment(lap.finishedAt)})`;
}

function labelName(id: string): string {
  return getLabels().find((label) => label.id === id)?.name ?? '';
}

/** Belgian time, as the operators read it. */
function formatMoment(ms: number): string {
  return new Intl.DateTimeFormat('nl-BE', {
    timeZone: 'Europe/Brussels',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(ms);
}

const SCREEN_NAMES: Array<[RegExp, string]> = [
  [/^\/timing/, 'Timing'],
  [/^\/queue/, 'Wachtrij'],
  [/^\/admin/, 'Beheer'],
  [/^\/analysis/, 'Analyse'],
  [/^\/tactics/, 'Tactiek'],
  [/^\/display\/inside/, 'Binnenscherm'],
  [/^\/display\/outside/, 'Buitenscherm'],
  [/^\/$/, 'Start'],
];

/**
 * Where a change was made: the screen, and the laptop itself (its name and address) or
 * the address of the browser that sent it. Written from this laptop's point of view, because the entry
 * is read on every laptop.
 */
export function describeOrigin(
  screenPath: string | undefined,
  remoteAddress: string | undefined,
  selfAddress: string,
  selfName: string | null = null
): string {
  const screen = SCREEN_NAMES.find(([pattern]) => pattern.test(screenPath ?? ''))?.[1] ?? 'Ander scherm';
  const address = (remoteAddress ?? '').replace(/^::ffff:/, '');
  const local = !address || address === '::1' || address.startsWith('127.');
  const self = selfName ? `${selfName} (${selfAddress})` : selfAddress;
  return `${screen} · ${local ? `laptop ${self}` : `browser ${address}`}`;
}

/** Where a change the laptops made by themselves comes from: the laptop that noticed it. */
export function describeAutomaticOrigin(selfAddress: string, selfName: string | null = null): string {
  return `Vanzelf · laptop ${selfName ? `${selfName} (${selfAddress})` : selfAddress}`;
}
