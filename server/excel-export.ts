import writeXlsxFile, { type Cell, type Sheet } from 'write-excel-file/node';
import type { LapRecord, RaceEvent, Runner } from '../shared/schemas.js';
import { brusselsOffsetMs } from '../shared/time.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const EXCEL_DATE_FORMAT = 'dd/mm/yyyy hh:mm:ss';
const EXCEL_DURATION_FORMAT = '[m]:ss.000';

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

/** Laps and race events oldest first, one sheet each, with Dutch headers for the teachers. */
export function excelSheets(laps: LapRecord[], runners: Runner[], events: RaceEvent[]): Sheet<never>[] {
  const runnersById = new Map(runners.map((runner) => [runner.id, runner]));
  const lapRows = [...laps]
    .sort((a, b) => a.finishedAt - b.finishedAt)
    .map((lap): Cell[] => {
      const runner = runnersById.get(lap.runnerId);
      return [
        excelLocalTime(lap.finishedAt),
        excelRunnerNumber(lap.runnerNumber),
        lap.runnerName,
        lap.lapNumber,
        excelDuration(lap.durationMs),
        lap.labels.map((label) => label.name).join(', '),
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
  ];
}

/** The .xlsx file behind Analyse › Exporteren › Excel. */
export function raceWorkbook(laps: LapRecord[], runners: Runner[], events: RaceEvent[]): Promise<Buffer> {
  return writeXlsxFile(excelSheets(laps, runners, events)).toBuffer();
}
