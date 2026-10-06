import type { Express, Response } from 'express';
import Papa from 'papaparse';
import { formatDurationMs } from '../shared/time.js';
import { appSnapshot } from './app-state.js';
import type { LapRecord, Runner } from '../shared/schemas.js';
import { getAllLaps, getAllRaceEvents, getAllRunners } from './db.js';
import { raceWorkbook } from './excel-export.js';

type CsvRow = Record<string, string | number>;

/** Names come from the public form, so cells Excel would run as a formula get a leading quote. */
export function csvText(columns: string[], rows: CsvRow[]): string {
  return rows.length ? Papa.unparse(rows, { header: true, columns, escapeFormulae: true }) : `${columns.join(',')}\n`;
}

function sendCsv(res: Response, fileName: string, columns: string[], rows: CsvRow[]): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.send(csvText(columns, rows));
}

export const LAP_COLUMNS = [
  'timestamp',
  'runner_number',
  'name',
  'lap_number',
  'lap_time_ms',
  'lap_time_readable',
  'labels',
  'historical_avg_ms',
  'historical_best_ms',
  'source',
];

const EVENT_COLUMNS = ['timestamp', 'type', 'message', 'runner_id', 'runner_number', 'runner_name', 'created_at'];

/** Laps oldest first, with the runner's historical times for spreadsheet analysis. */
export function lapRows(laps: LapRecord[], runners: Runner[]): CsvRow[] {
  const runnersById = new Map(runners.map((runner) => [runner.id, runner]));
  return [...laps].reverse().map((lap) => {
    const runner = runnersById.get(lap.runnerId);
    return {
      timestamp: new Date(lap.finishedAt).toISOString(),
      runner_number: lap.runnerNumber || '',
      name: lap.runnerName,
      lap_number: lap.lapNumber,
      lap_time_ms: lap.durationMs,
      lap_time_readable: formatDurationMs(lap.durationMs),
      labels: lap.labels.map((label) => label.name).join(', '),
      historical_avg_ms: runner?.historicalAvgMs ?? '',
      historical_best_ms: runner?.historicalBestMs ?? '',
      source: lap.source,
    };
  });
}

function eventRows(): CsvRow[] {
  return getAllRaceEvents()
    .reverse()
    .map((event) => ({
      timestamp: new Date(event.occurredAt).toISOString(),
      type: event.type,
      message: event.message,
      runner_id: event.runnerId || '',
      runner_number: event.runnerNumber || '',
      runner_name: event.runnerName || '',
      created_at: new Date(event.createdAt).toISOString(),
    }));
}

export function registerExportRoutes(app: Express): void {
  app.get('/api/export/race.xlsx', async (_req, res, next) => {
    try {
      const workbook = await raceWorkbook(getAllLaps(), getAllRunners(), getAllRaceEvents());
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="apolloon-race.xlsx"');
      res.send(workbook);
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/export/laps.csv', (_req, res) => {
    sendCsv(res, 'apolloon-laps.csv', LAP_COLUMNS, lapRows(getAllLaps(), getAllRunners()));
  });
  app.get('/api/export/laps.json', (_req, res) => {
    res.json({ laps: getAllLaps() });
  });
  app.get('/api/export/events.csv', (_req, res) => {
    sendCsv(res, 'apolloon-events.csv', EVENT_COLUMNS, eventRows());
  });
  app.get('/api/export/events.json', (_req, res) => {
    res.json({ events: getAllRaceEvents() });
  });
  app.get('/api/export/current-state.json', (_req, res) => {
    res.json(appSnapshot());
  });
}
