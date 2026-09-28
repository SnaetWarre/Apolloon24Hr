import Papa from 'papaparse';
import { type ImportSummary, type RunnerInput, type RunnerRegistration } from '../shared/schemas.js';
import { upsertRunnerFromImport } from './db.js';
import { cleanText } from './db/values.js';

/** Thrown for a CSV that cannot be read at all, as opposed to individual bad rows. */
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
  return cleanText(value) ?? '';
}

function parseDecimal(value: string): number {
  return Number(value.replace(',', '.'));
}

function parsePositiveInt(value: unknown): number | null {
  const raw = text(value);
  if (!raw) return null;
  const n = parseDecimal(raw);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
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
    targetLaps: parsePositiveInt(columnValue(row, ['target_laps', 'doelstelling', 'target'])),
    historicalAvgMs: parseDurationMs(columnValue(row, ['historical_avg', 'gemiddelde', 'avg', 'average'])),
    historicalBestMs: parseDurationMs(columnValue(row, ['historical_best', 'snelste', 'best', 'fastest'])),
  };
}

/**
 * Imports a plain runner CSV or a Google Form export (detected by its e-mail
 * column). Rows are upserted one by one; bad rows are reported, not fatal.
 */
export function importRunnersFromCsv(csvText: string): ImportSummary {
  if (!text(csvText)) throw new CsvImportError('csvText required');
  const parsed = Papa.parse(text(csvText), { header: true, skipEmptyLines: true }) as {
    data: Array<Record<string, unknown>>;
    errors: Array<{ message: string }>;
  };
  if (parsed.errors.length) throw new CsvImportError(parsed.errors[0].message);

  const summary: ImportSummary = { created: 0, updated: 0, skipped: 0, errors: [] };
  const formExport = parsed.data.some((row) =>
    Object.keys(row).some((key) => key.trim().toLowerCase().startsWith('e-mailadres'))
  );

  for (const [index, row] of parsed.data.entries()) {
    // Spreadsheet row number: the header is row 1.
    const rowNumber = index + 2;
    const registration = formExport ? registrationFromRow(row) : null;
    const runnerNumber =
      text(columnValue(row, ['runner_number', 'lopersnummer', 'nummer', 'number', 'bib'])) ||
      (formExport ? String(rowNumber) : '');
    const name = text(columnValue(row, ['name', 'naam', 'runner_name', 'loper', 'voornaam_+_naam']));

    if (!runnerNumber || !name || (registration && !registration.email)) {
      summary.skipped += 1;
      summary.errors.push(`Rij ${rowNumber}: lopersnummer, naam en bij formulierexport e-mailadres zijn verplicht`);
      continue;
    }

    try {
      const result = upsertRunnerFromImport(runnerInputFromRow(row, runnerNumber, name, registration));
      summary[result.action] += 1;
    } catch (error) {
      summary.skipped += 1;
      summary.errors.push(`Rij ${rowNumber}: ${error instanceof Error ? error.message : 'import mislukt'}`);
    }
  }
  return summary;
}
