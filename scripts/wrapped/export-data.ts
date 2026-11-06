// Turns an exported race workbook (Analyse › Exporteren › Excel) back into the runners and
// laps Apolloon Wrapped needs, for a card that has to be remade when the original database
// is gone. The workbook has no lap `source`, so every lap is read as a measured handoff;
// split laps can therefore not be left out of the fastest lap and average again.
import { readSheet } from 'read-excel-file/node';
import type { LapRecord, RunnerRegistration } from '../../shared/schemas.ts';
import { brusselsOffsetMs } from '../../shared/time.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The fields buildWrapped reads from a runner. */
export type ExportRunner = {
  id: string;
  runnerNumber: string | null;
  name: string;
  registration: RunnerRegistration | null;
};

export type ExportRace = {
  runners: ExportRunner[];
  laps: LapRecord[];
  registrations: Record<string, RunnerRegistration>;
  /** The earliest lap start and the latest lap finish; the export has no race start of its own. */
  raceStartedAt: number;
  raceFinishedAt: number;
};

/** An .xlsx cell as read-excel-file gives it: text, a number, a date, or null. */
type Cell = unknown;

const LAP_HEADERS = ['Binnen', 'Nummer', 'Naam', 'Ronde', 'Rondetijd'] as const;
const RUNNER_SHEET = 'Lopers';

/**
 * Reads "Rondes" for the laps and "Lopers" for the registration answers. The workbook is
 * refused when it has no "Rondes" sheet or no laps, because then it is not a race export.
 */
export async function readRaceExport(file: string): Promise<ExportRace> {
  const lapRows = await sheetRows(file, 'Rondes');
  const [finished, number, name, lap, duration] = columns(lapRows, 'Rondes', LAP_HEADERS);

  const byKey = new Map<string, ExportRunner>();
  const laps: LapRecord[] = [];
  for (const [index, row] of lapRows.slice(1).entries()) {
    const runnerNumber = runnerNumberOf(row[number]);
    const runnerName = text(row[name]);
    const finishedAt = momentMs(row[finished]);
    const durationMs = durationOf(row[duration]);
    // A formatted row under the data, or a lap the export left half empty.
    if (!runnerName || finishedAt == null || durationMs == null) continue;
    const runner = runnerFor(byKey, runnerNumber, runnerName);
    const startedAt = finishedAt - durationMs;
    const lapNumber = whole(row[lap]) ?? index + 1;
    laps.push({
      id: `${runner.id}-${index}`,
      runnerId: runner.id,
      runnerNumber: runner.runnerNumber,
      runnerName: runner.name,
      lapNumber,
      startedAt,
      finishedAt,
      durationMs,
      // The export does not say how a lap was recorded, so it counts as a normal handoff.
      source: 'handoff',
      createdAt: finishedAt,
      labels: [],
    });
  }
  if (!laps.length) throw new Error('Het blad "Rondes" heeft geen rondes met een tijd.');

  await addRegistrations(file, byKey);
  const runners = [...byKey.values()].sort(compareRunners);
  const registrations: Record<string, RunnerRegistration> = {};
  for (const runner of runners) if (runner.registration) registrations[runner.id] = runner.registration;

  return {
    runners,
    laps: laps.sort((a, b) => a.finishedAt - b.finishedAt),
    registrations,
    raceStartedAt: Math.min(...laps.map((lap) => lap.startedAt)),
    raceFinishedAt: Math.max(...laps.map((lap) => lap.finishedAt)),
  };
}

/** The runner the operator named, by number or name; a name that matches several asks again. */
export function findExportRunner(runners: ExportRunner[], query: string): ExportRunner {
  const wanted = query.trim().toLowerCase();
  const exact = runners.filter(
    (runner) => (runner.runnerNumber ?? '').toLowerCase() === wanted || runner.name.toLowerCase() === wanted
  );
  if (exact.length === 1) return exact[0];
  const partial = exact.length ? exact : runners.filter((runner) => runner.name.toLowerCase().includes(wanted));
  if (partial.length === 1) return partial[0];
  const list = (items: ExportRunner[]) =>
    items.map((runner) => `${runner.runnerNumber ? `${runner.runnerNumber} ` : ''}${runner.name}`).join(', ');
  if (!partial.length) {
    throw new Error(`Geen loper "${query}" in het bestand. Er zaten ${runners.length} lopers in:\n  ${list(runners)}`);
  }
  throw new Error(`"${query}" past bij meer lopers: ${list(partial)}. Geef het nummer mee.`);
}

async function sheetRows(file: string, sheet: string): Promise<Cell[][]> {
  try {
    return await readSheet(file, sheet);
  } catch (error) {
    const missing = error instanceof Error && error.name === 'SheetNotFoundError';
    throw new Error(
      missing
        ? `Het bestand heeft geen blad "${sheet}". Is dit de export van Analyse › Exporteren › Excel?`
        : `Het Excel-bestand kon niet gelezen worden: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** For every title, where it sits in the first row; a column renamed by hand is a clear error. */
function columns(rows: Cell[][], sheet: string, titles: readonly string[]): number[] {
  const header = (rows[0] ?? []).map((cell) => text(cell).toLowerCase());
  return titles.map((title) => {
    const index = header.indexOf(title.toLowerCase());
    if (index < 0) throw new Error(`Het blad "${sheet}" heeft geen kolom "${title}".`);
    return index;
  });
}

async function addRegistrations(file: string, byKey: Map<string, ExportRunner>): Promise<void> {
  let rows: Cell[][];
  try {
    rows = await readSheet(file, RUNNER_SHEET);
  } catch (error) {
    // The laps are enough for the card; only the e-mail address and reuse consent are lost.
    if (error instanceof Error && error.name === 'SheetNotFoundError') return;
    throw error;
  }
  const header = (rows[0] ?? []).map((cell) => text(cell).toLowerCase());
  const column = (...titles: string[]) => {
    const index = titles.map((title) => header.indexOf(title.toLowerCase())).find((found) => found >= 0);
    return index == null ? -1 : index;
  };
  const at = {
    number: column('Nummer'),
    name: column('Naam'),
    submittedAt: column('Ingeschreven op'),
    email: column('E-mail'),
    phone: column('Telefoon'),
    studyPhase: column('Studiefase'),
    estimatedLaps: column('Geschatte rondes'),
    estimatedPace: column('Geschat tempo'),
    fastestLap: column('Snelste ronde (opgegeven)'),
    maxLapsPerBlock: column('Max rondes per blok'),
    availableHours: column('Beschikbare uren'),
    flexibility: column('Flexibiliteit'),
    categories: column('Categorieën'),
    reuseConsent: column('Toestemming gegevens'),
    remarks: column('Opmerkingen'),
  };
  const cell = (row: Cell[], index: number) => (index < 0 ? '' : text(row[index]));
  for (const row of rows.slice(1)) {
    const runnerNumber = runnerNumberOf(row[at.number]);
    const runnerName = cell(row, at.name);
    if (!runnerName) continue;
    const runner = byKey.get(runnerKey(runnerNumber, runnerName));
    if (!runner) continue;
    runner.registration = {
      submittedAt: cell(row, at.submittedAt),
      email: cell(row, at.email),
      phone: cell(row, at.phone),
      studyPhase: cell(row, at.studyPhase),
      estimatedLaps: cell(row, at.estimatedLaps),
      estimatedPace: cell(row, at.estimatedPace),
      maxLapsPerBlock: cell(row, at.maxLapsPerBlock),
      availableHours: list(cell(row, at.availableHours)),
      reuseConsent: cell(row, at.reuseConsent),
      flexibility: cell(row, at.flexibility),
      remarks: cell(row, at.remarks),
      categories: list(cell(row, at.categories)),
      fastestLap: cell(row, at.fastestLap),
    };
  }
}

function runnerFor(byKey: Map<string, ExportRunner>, runnerNumber: string | null, name: string): ExportRunner {
  const key = runnerKey(runnerNumber, name);
  const known = byKey.get(key);
  if (known) return known;
  const runner: ExportRunner = {
    id: `export-${key
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase()}`,
    runnerNumber,
    name: name.trim(),
    registration: null,
  };
  byKey.set(key, runner);
  return runner;
}

/** A runner without a number is the same person by name; two people can share a name, not a number. */
function runnerKey(runnerNumber: string | null, name: string): string {
  return runnerNumber ? `#${runnerNumber}` : `name:${name.trim().toLowerCase()}`;
}

function compareRunners(a: ExportRunner, b: ExportRunner): number {
  if (!a.runnerNumber || !b.runnerNumber) {
    return Number(!a.runnerNumber) - Number(!b.runnerNumber) || a.name.localeCompare(b.name, 'nl-BE');
  }
  return a.runnerNumber.localeCompare(b.runnerNumber, 'nl-BE', { numeric: true });
}

function text(value: Cell): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function whole(value: Cell): number | null {
  const number = typeof value === 'number' ? value : Number(text(value));
  return Number.isInteger(number) ? number : null;
}

function runnerNumberOf(value: Cell): string | null {
  // The export writes digits as numbers so Excel sorts them; the app keeps numbers as text.
  const number = whole(value);
  const runnerNumber = number == null ? text(value) : String(number);
  return runnerNumber || null;
}

/** "1ste jaar, HILOK" or an Excel cell holding a list, back to the array the registration uses. */
function list(value: string): string[] {
  return value
    ? value
        .split(/[,;]/)
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

/**
 * A moment is written as Brussels clock time to the second, so put that wall clock back into a
 * real moment. The reader can be a millisecond off (Excel stores days as fractions), so the
 * result is rounded to the second the export shows. BrusselsOffsetMs is the offset at the
 * moment itself, so one extra pass is enough; the loop keeps it right when the first guess
 * lands on the other side of a clock change.
 */
function wallClockMs(wall: number): number {
  let guess = wall - brusselsOffsetMs(wall);
  guess = wall - brusselsOffsetMs(guess);
  return Math.round((wall - brusselsOffsetMs(guess)) / 1000) * 1000;
}

/** A date cell from the workbook, or a plain Excel serial number, as epoch milliseconds. */
function momentMs(value: Cell): number | null {
  if (value instanceof Date) {
    return wallClockMs(
      Date.UTC(
        value.getUTCFullYear(),
        value.getUTCMonth(),
        value.getUTCDate(),
        value.getUTCHours(),
        value.getUTCMinutes(),
        value.getUTCSeconds(),
        value.getUTCMilliseconds()
      )
    );
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Excel counts days from 30 December 1899; the wall clock is the fraction of the day.
    return wallClockMs(Math.round((value - 25569) * DAY_MS));
  }
  return null;
}

/** A lap time cell: a date holding a time of day, or a fraction of a day. */
function durationOf(value: Cell): number | null {
  if (value instanceof Date) {
    return (
      value.getUTCHours() * 3_600_000 +
      value.getUTCMinutes() * 60_000 +
      value.getUTCSeconds() * 1_000 +
      value.getUTCMilliseconds()
    );
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.round(value * DAY_MS);
  return null;
}
