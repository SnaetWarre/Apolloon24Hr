import Papa from 'papaparse';
import { readSheet } from 'read-excel-file/node';
import { type ImportSummary, type RunnerInput, type RunnerRegistration } from '../shared/schemas.js';
import { upsertRunnerFromImport } from './db.js';

/** Thrown for a file that cannot be read at all, as opposed to individual bad rows. */
export class CsvImportError extends Error {}

const IGNORED_LABEL_VALUES = new Set(['nee', 'neen', 'geen', 'n/a', 'na', 'none', '-', 'ja']);

const FORM_CATEGORY_LABELS = new Map([
  ['eerstejaars', '1ste jaar'],
  ['hilok gent', 'HILOK'],
  ['kinesia antwerpen', 'Kinesia'],
  ['mesacosa', 'Mesacosa'],
  ['vrouw', 'Dames'],
  ['ik ben alumni aan de faculteit faber', 'Anciens'],
]);

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}

function parseDecimal(value: string): number {
  return Number(value.replace(',', '.'));
}

/** Accepts `ss`, `mm:ss`, or `hh:mm:ss`, with a comma or dot as decimal separator. */
function parseDurationMs(value: unknown): number | null {
  const raw = text(value);
  if (!raw) return null;
  const parts = raw.split(':').map(parseDecimal);
  if (parts.length > 3 || parts.some((part) => !Number.isFinite(part))) return null;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return Math.round(seconds * 1000);
}

function splitLabels(values: unknown[]): string[] {
  return values
    .flatMap((value) => text(value).split(/[,;|]/))
    .map((label) => label.trim())
    .filter((label) => label && !IGNORED_LABEL_VALUES.has(label.toLowerCase()));
}

/** First non-empty value among the given column names (case- and space-insensitive). */
function columnValue(row: Record<string, unknown>, names: string[]): unknown {
  const byName = new Map(
    Object.entries(row).map(([key, value]) => [key.trim().toLowerCase().replace(/\s+/g, '_'), value])
  );
  for (const name of names) {
    const value = byName.get(name);
    if (value !== undefined && text(value)) return value;
  }
  return '';
}

/** Google Form columns are long questions; match them on how they start. */
function formValue(row: Record<string, unknown>, prefix: string): string {
  const normalizedPrefix = prefix.toLocaleLowerCase('nl-BE');
  const key = Object.keys(row).find((candidate) =>
    candidate.trim().toLocaleLowerCase('nl-BE').startsWith(normalizedPrefix)
  );
  return text(key ? row[key] : '');
}

function splitFormChoices(value: string): string[] {
  return value
    .split(/\s*,\s*|\s*;\s*|\n/)
    .map((choice) => choice.trim())
    .filter(Boolean);
}

function registrationFromRow(row: Record<string, unknown>): RunnerRegistration {
  return {
    submittedAt: formValue(row, 'Tijdstempel'),
    email: formValue(row, 'E-mailadres'),
    phone: formValue(row, 'GSM-nummer'),
    studyPhase: formValue(row, 'Studiefase'),
    estimatedLaps: formValue(row, 'Ik schat in totaal'),
    estimatedPace: formValue(row, 'Ik schat een gemiddelde'),
    maxLapsPerBlock: formValue(row, 'Maximum aantal rondjes'),
    availableHours: splitFormChoices(formValue(row, 'Ik ben volgende uren beschikbaar')),
    reuseConsent: formValue(row, 'Ik geef hierbij toestemming'),
    flexibility: formValue(row, 'Hoe flexibel ben jij'),
    remarks: formValue(row, 'Nog iets dat wij best kunnen weten'),
    categories: splitFormChoices(formValue(row, 'Behoor je tot')),
    fastestLap: formValue(row, 'Wat was de tijd van jouw snelste'),
  };
}

function labelsFromFormCategories(categories: string[]): string[] {
  return categories.flatMap((category) => FORM_CATEGORY_LABELS.get(category.trim().toLowerCase()) ?? []);
}

function runnerInputFromRow(
  row: Record<string, unknown>,
  runnerNumber: string,
  name: string,
  registration: RunnerRegistration | null
): RunnerInput {
  const base = { runnerNumber, name, status: 'registered', registrationSource: 'import' } as const;
  if (registration) {
    return { ...base, labels: labelsFromFormCategories(registration.categories), registration };
  }
  return {
    ...base,
    labels: splitLabels([
      columnValue(row, ['labels', 'label', 'categorie', 'categories', 'type']),
      columnValue(row, ['zustervereniging', 'vereniging', 'club']),
      columnValue(row, ['team', 'speedteam']),
      columnValue(row, ['jaar', 'groep']),
    ]),
    historicalAvgMs: parseDurationMs(columnValue(row, ['historical_avg', 'gemiddelde', 'avg', 'average'])),
    historicalBestMs: parseDurationMs(columnValue(row, ['historical_best', 'snelste', 'best', 'fastest'])),
  };
}

/** Excel keeps the clock time without a time zone; the library hands it over as that time in UTC. */
function excelDateText(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  // A cell holding only a time, such as a lap time typed as 1:20.
  if (date.getUTCFullYear() < 1900) return time;
  return `${pad(date.getUTCDate())}/${pad(date.getUTCMonth() + 1)}/${date.getUTCFullYear()} ${time}`;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return value instanceof Date ? excelDateText(value) : String(value);
}

/**
 * The first sheet of an .xlsx, such as the form's response sheet, as CSV text,
 * so an Excel file takes exactly the same import as a CSV export.
 */
export async function csvFromXlsx(file: Buffer): Promise<string> {
  let rows: unknown[][];
  try {
    rows = await readSheet(file);
  } catch {
    throw new CsvImportError('Het Excel-bestand kon niet gelezen worden.');
  }
  if (!rows.length) throw new CsvImportError('Het Excel-bestand is leeg.');
  return Papa.unparse(rows.map((row) => row.map(cellText)));
}

/**
 * Imports a plain runner CSV or a Google Form export (detected by its e-mail
 * column). Rows are upserted one by one; bad rows are reported, not fatal.
 */
export function importRunnersFromCsv(csvText: string): ImportSummary {
  if (!text(csvText)) throw new CsvImportError('Het CSV-bestand is leeg.');
  const parsed = Papa.parse(text(csvText), {
    header: true,
    skipEmptyLines: true,
  }) as {
    data: Array<Record<string, unknown>>;
    errors: Array<{ type: string; message: string }>;
  };
  // A hand-made list often leaves off empty trailing columns; those rows are fine, the missing fields are empty.
  const unreadable = parsed.errors.find((error) => error.type !== 'FieldMismatch');
  if (unreadable) throw new CsvImportError(`Het CSV-bestand kon niet gelezen worden: ${unreadable.message}`);

  const summary: ImportSummary = {
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [],
  };
  const formExport = parsed.data.some((row) =>
    Object.keys(row).some((key) => key.trim().toLowerCase().startsWith('e-mailadres'))
  );

  for (const [index, row] of parsed.data.entries()) {
    // Spreadsheet row number: the header is row 1.
    const rowNumber = index + 2;
    // Papa keeps values beyond the header's columns apart; no column can take them.
    const { __parsed_extra: extra, ...fields } = row;
    if (Array.isArray(extra) && extra.some((value) => text(value))) {
      summary.errors.push(`Rij ${rowNumber}: meer waarden dan kolommen, genegeerd: ${extra.join(', ')}`);
    }
    // A row left blank in the sheet, such as a formatted row under the answers.
    if (Object.values(fields).every((value) => !text(value))) continue;
    const registration = formExport ? registrationFromRow(fields) : null;
    const runnerNumber =
      text(columnValue(fields, ['runner_number', 'lopersnummer', 'nummer', 'number', 'bib'])) ||
      (formExport ? String(rowNumber) : '');
    const name = text(columnValue(fields, ['name', 'naam', 'runner_name', 'loper', 'voornaam_+_naam']));

    // Form answers are typed by hand: anything goes, as long as there is a name.
    if (!runnerNumber || !name) {
      summary.skipped += 1;
      summary.errors.push(`Rij ${rowNumber}: ${formExport ? 'naam' : 'lopersnummer en naam'} ontbreekt`);
      continue;
    }

    try {
      const result = upsertRunnerFromImport(runnerInputFromRow(fields, runnerNumber, name, registration));
      summary[result.action] += 1;
      if (result.numberTaken) {
        summary.errors.push(`Rij ${rowNumber}: nummer ${runnerNumber} is al in gebruik, ${name} kreeg geen nummer`);
      }
    } catch (error) {
      summary.skipped += 1;
      summary.errors.push(`Rij ${rowNumber}: ${error instanceof Error ? error.message : 'import mislukt'}`);
    }
  }
  return summary;
}
