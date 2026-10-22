import writeXlsxFile, { type Cell, type Sheet } from 'write-excel-file/node';
import { isMeasuredLap, lapDaypart, lapPoints, POINTS_RULES } from '../shared/points.js';
import type { LapRecord, RaceEvent, Runner, RunnerRegistration } from '../shared/schemas.js';
import { brusselsOffsetMs } from '../shared/time.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const EXCEL_DATE_FORMAT = 'dd/mm/yyyy hh:mm:ss';
const EXCEL_DURATION_FORMAT = '[m]:ss.000';
const EXCEL_SECONDS_FORMAT = '0.000';
const EXCEL_POINTS_FORMAT = '0.00';

/**
 * Excel stores a moment without a time zone and this library reads a Date as UTC, so shift it
 * to show Brussels clock time, like the screens, whatever zone the server runs in.
 */
function excelLocalTime(ms: number): Date {
  return new Date(ms + brusselsOffsetMs(ms));
}

/** A duration as an Excel time value, so sums, averages and sorting work on it. */
function excelDuration(ms: number | null | undefined): Cell {
  return ms == null ? null : { value: ms / DAY_MS, format: EXCEL_DURATION_FORMAT };
}

/** Runner numbers are text in the app; digits become numbers so Excel sorts them and does not warn. */
function excelRunnerNumber(runnerNumber: string | null): Cell {
  if (!runnerNumber) return null;
  return /^\d+$/.test(runnerNumber) ? Number(runnerNumber) : runnerNumber;
}

function headerRow(titles: string[]): Cell[] {
  return titles.map((title) => ({ value: title, fontWeight: 'bold' }));
}

function labelNames(labels: { name: string }[]): string {
  return labels.map((label) => label.name).join(', ');
}

function formula(value: string, format?: string): Cell {
  return { type: 'Formula', value, format };
}

/** Numbered runners first in number order (digits as numbers), then runners without a number, by name. */
function compareRunnerNumbers(a: Runner, b: Runner): number {
  if (!a.runnerNumber || !b.runnerNumber) {
    return Number(!a.runnerNumber) - Number(!b.runnerNumber) || a.name.localeCompare(b.name, 'nl-BE');
  }
  return a.runnerNumber.localeCompare(b.runnerNumber, 'nl-BE', { numeric: true });
}

/**
 * The settings of shared/points.ts on their own sheet, laid out like "Prijzensysteem 2026.xlsx". The
 * point sheets refer to these cells, so a teacher who changes a number here sees every total change.
 */
function pointsRulesSheet() {
  const data: Cell[][] = [
    [{ value: 'Puntenregels', fontWeight: 'bold' }],
    ['Punten per ronde = basispunten × tijdcoëfficiënt × dagdeelfactor'],
    [],
    ['Basispunten per ronde', POINTS_RULES.basePointsPerLap],
    ['Referentietijd (s)', POINTS_RULES.referenceLapSeconds],
    ['Factor tijdcoëfficiënt (per seconde sneller)', POINTS_RULES.coefficientPerSecond],
    [],
    headerRow(['Dagdeel', 'Van (uur)', 'Tot (uur)', 'Factor']),
  ];
  const firstDaypartRow = data.length + 1;
  for (const daypart of POINTS_RULES.dayparts) {
    data.push([daypart.name, daypart.fromHour, daypart.toHour, daypart.factor]);
  }
  const lastDaypartRow = data.length;
  data.push(
    [],
    ['Tijdcoëfficiënt = 1 + factor × (referentietijd − rondetijd). Een ronde trager dan de referentietijd krijgt 1.'],
    ['Het dagdeel hangt af van het uur waarop de ronde startte, in Belgische tijd.'],
    ['Een dubbele druk (korter dan 20 s) en de tweede helft van een gesplitste ronde krijgen coëfficiënt 1.'],
    ['Verander een getal in kolom B of een factor in kolom D: Punten per ronde en Puntenlijst rekenen opnieuw.']
  );
  const sheet: Sheet<never> = {
    sheet: 'Puntenregels',
    data,
    columns: [{ width: 44 }, { width: 11 }, { width: 10 }, { width: 8 }],
  };
  const rules = "'Puntenregels'!";
  return {
    sheet,
    basePoints: `${rules}$B$4`,
    referenceSeconds: `${rules}$B$5`,
    coefficientPerSecond: `${rules}$B$6`,
    daypartNames: `${rules}$A$${firstDaypartRow}:$A$${lastDaypartRow}`,
    daypartFactors: `${rules}$D$${firstDaypartRow}:$D$${lastDaypartRow}`,
  };
}

/** One row per runner, laps or not, with every registration answer exactly as it was typed. */
function runnersSheet(runners: Runner[], registrations: Record<string, RunnerRegistration>): Sheet<never> {
  const rows = [...runners].sort(compareRunnerNumbers).map((runner): Cell[] => {
    const registration = registrations[runner.id];
    const ran = runner.lapCount > 0;
    return [
      excelRunnerNumber(runner.runnerNumber),
      runner.name,
      labelNames(runner.labels),
      runner.lapCount,
      excelDuration(runner.bestLapMs),
      excelDuration(runner.averageLapMs),
      excelDuration(ran ? runner.totalTimeMs : null),
      registration?.submittedAt,
      registration?.email,
      registration?.phone,
      registration?.studyPhase,
      registration?.estimatedLaps,
      registration?.estimatedPace,
      registration?.fastestLap,
      registration?.maxLapsPerBlock,
      registration?.availableHours.join(', '),
      registration?.flexibility,
      registration?.categories.join(', '),
      registration?.reuseConsent,
      registration?.remarks,
      runner.notes,
    ].map((cell) => cell ?? null);
  });
  return {
    sheet: 'Lopers',
    data: [
      headerRow([
        'Nummer',
        'Naam',
        'Labels',
        'Rondes gelopen',
        'Snelste ronde',
        'Gemiddelde ronde',
        'Totale looptijd',
        'Ingeschreven op',
        'E-mail',
        'Telefoon',
        'Studiefase',
        'Geschatte rondes',
        'Geschat tempo',
        'Snelste ronde (opgegeven)',
        'Max rondes per blok',
        'Beschikbare uren',
        'Flexibiliteit',
        'Categorieën',
        'Toestemming gegevens',
        'Opmerkingen',
        'Notities',
      ]),
      ...rows,
    ],
    stickyRowsCount: 1,
    columns: [
      { width: 9 },
      { width: 26 },
      { width: 24 },
      { width: 15 },
      { width: 14 },
      { width: 17 },
      { width: 15 },
      { width: 20 },
      { width: 30 },
      { width: 16 },
      { width: 16 },
      { width: 16 },
      { width: 15 },
      { width: 24 },
      { width: 19 },
      { width: 40 },
      { width: 20 },
      { width: 30 },
      { width: 21 },
      { width: 40 },
      { width: 40 },
    ],
  };
}

/** Laps and race events oldest first, one sheet each, with Dutch headers for the teachers. */
export function excelSheets(
  laps: LapRecord[],
  runners: Runner[],
  events: RaceEvent[],
  registrations: Record<string, RunnerRegistration>
): Sheet<never>[] {
  const runnersById = new Map(runners.map((runner) => [runner.id, runner]));
  const lapsOldestFirst = [...laps].sort((a, b) => a.finishedAt - b.finishedAt);
  const lapRows = lapsOldestFirst.map((lap): Cell[] => {
    const runner = runnersById.get(lap.runnerId);
    return [
      excelLocalTime(lap.finishedAt),
      excelRunnerNumber(lap.runnerNumber),
      lap.runnerName,
      lap.lapNumber,
      excelDuration(lap.durationMs),
      labelNames(lap.labels),
      excelDuration(runner?.historicalAvgMs),
      excelDuration(runner?.historicalBestMs),
    ];
  });
  const eventRows = [...events]
    .sort((a, b) => a.occurredAt - b.occurredAt)
    .map((event): Cell[] => [
      excelLocalTime(event.occurredAt),
      event.message,
      excelRunnerNumber(event.runnerNumber),
      event.runnerName,
    ]);

  // Each points cell is a formula on the Puntenregels sheet; the totals computed here only order Puntenlijst.
  const rules = pointsRulesSheet();
  const pointsByRunner = new Map<string, number>();
  const lapPointRows = lapsOldestFirst.map((lap, index): Cell[] => {
    const row = index + 2;
    const runner = runnersById.get(lap.runnerId);
    const daypart = lapDaypart(lap.startedAt);
    pointsByRunner.set(lap.runnerId, (pointsByRunner.get(lap.runnerId) ?? 0) + lapPoints(lap));
    return [
      excelRunnerNumber(runner ? runner.runnerNumber : lap.runnerNumber),
      runner?.name ?? lap.runnerName,
      lap.lapNumber,
      excelLocalTime(lap.startedAt),
      { value: lap.durationMs / 1_000, format: EXCEL_SECONDS_FORMAT },
      daypart?.name ?? null,
      isMeasuredLap(lap)
        ? formula(
            `IF(E${row}>=${rules.referenceSeconds},1,1+${rules.coefficientPerSecond}*(${rules.referenceSeconds}-E${row}))`,
            EXCEL_SECONDS_FORMAT
          )
        : 1,
      daypart ? formula(`INDEX(${rules.daypartFactors},MATCH(F${row},${rules.daypartNames},0))`) : 0,
      formula(`${rules.basePoints}*G${row}*H${row}`, EXCEL_POINTS_FORMAT),
    ];
  });

  const ranked = runners
    .filter((runner) => runner.lapCount > 0)
    .map((runner) => ({ runner, points: pointsByRunner.get(runner.id) ?? 0 }))
    .sort(
      (a, b) => b.points - a.points || b.runner.lapCount - a.runner.lapCount || compareRunnerNumbers(a.runner, b.runner)
    );
  const lastRankedRow = ranked.length + 1;
  const rankingRows = ranked.map(({ runner, points }, index): Cell[] => {
    const row = index + 2;
    return [
      formula(`RANK(F${row},$F$2:$F$${lastRankedRow})`),
      excelRunnerNumber(runner.runnerNumber),
      runner.name,
      labelNames(runner.labels),
      runner.lapCount,
      // SUMIF needs the number to find the runner's laps; a runner without one keeps the total of the app.
      runner.runnerNumber
        ? formula(`SUMIF('Punten per ronde'!$A:$A,B${row},'Punten per ronde'!$I:$I)`, EXCEL_POINTS_FORMAT)
        : { value: points, format: EXCEL_POINTS_FORMAT },
    ];
  });

  return [
    {
      sheet: 'Rondes',
      data: [
        headerRow([
          'Binnen',
          'Nummer',
          'Naam',
          'Ronde',
          'Rondetijd',
          'Labels',
          'Historisch gemiddelde',
          'Historisch snelste',
        ]),
        ...lapRows,
      ],
      dateFormat: EXCEL_DATE_FORMAT,
      stickyRowsCount: 1,
      columns: [
        { width: 20 },
        { width: 9 },
        { width: 26 },
        { width: 8 },
        { width: 11 },
        { width: 32 },
        { width: 21 },
        { width: 18 },
      ],
    },
    {
      sheet: 'Gebeurtenissen',
      data: [headerRow(['Tijdstip', 'Bericht', 'Nummer', 'Naam']), ...eventRows],
      dateFormat: EXCEL_DATE_FORMAT,
      stickyRowsCount: 1,
      columns: [{ width: 20 }, { width: 40 }, { width: 9 }, { width: 26 }],
    },
    runnersSheet(runners, registrations),
    {
      sheet: 'Puntenlijst',
      data: [headerRow(['Plaats', 'Nummer', 'Naam', 'Labels', 'Rondes', 'Punten']), ...rankingRows],
      stickyRowsCount: 1,
      columns: [{ width: 8 }, { width: 9 }, { width: 26 }, { width: 24 }, { width: 8 }, { width: 10 }],
    },
    {
      sheet: 'Punten per ronde',
      data: [
        headerRow([
          'Nummer',
          'Naam',
          'Ronde',
          'Gestart',
          'Rondetijd (s)',
          'Dagdeel',
          'Tijdcoëfficiënt',
          'Dagdeelfactor',
          'Punten',
        ]),
        ...lapPointRows,
      ],
      dateFormat: EXCEL_DATE_FORMAT,
      stickyRowsCount: 1,
      columns: [
        { width: 9 },
        { width: 26 },
        { width: 8 },
        { width: 20 },
        { width: 14 },
        { width: 10 },
        { width: 15 },
        { width: 14 },
        { width: 10 },
      ],
    },
    rules.sheet,
  ];
}

/** The .xlsx file behind Analyse › Exporteren › Excel. It holds e-mail addresses and phone numbers. */
export function raceWorkbook(
  laps: LapRecord[],
  runners: Runner[],
  events: RaceEvent[],
  registrations: Record<string, RunnerRegistration>
): Promise<Buffer> {
  return writeXlsxFile(excelSheets(laps, runners, events, registrations)).toBuffer();
}
