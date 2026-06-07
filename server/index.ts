import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import Papa from 'papaparse';
import { Server as SocketIOServer } from 'socket.io';
import { appSnapshot } from './app-state.js';
import { getAllLaps, getAllRunners, initDb } from './db.js';
import { hostInfo, SERVER_PORT } from './host.js';
import { setRealtimeEmitter } from './realtime.js';
import { appRouter } from './router.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compiledDistDir = path.resolve(__dirname, '..', '..', 'dist');
const sourceDistDir = path.resolve(__dirname, '..', 'dist');
const DIST_DIR = fs.existsSync(compiledDistDir) ? compiledDistDir : sourceDistDir;
const INDEX_HTML = path.join(DIST_DIR, 'index.html');

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: true, credentials: false },
});

function formatDurationMs(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || Number.isNaN(Number(ms))) return '';
  const totalMilliseconds = Math.max(0, Math.floor(Number(ms)));
  const milliseconds = totalMilliseconds % 1000;
  const totalWholeSeconds = Math.floor(totalMilliseconds / 1000);
  const hours = Math.floor(totalWholeSeconds / 3600);
  const minutes = Math.floor((totalWholeSeconds % 3600) / 60);
  const seconds = totalWholeSeconds % 60;
  const fraction = String(milliseconds).padStart(3, '0');

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${fraction}`;
  }

  return `${minutes}:${String(seconds).padStart(2, '0')}.${fraction}`;
}

function lapExportRows(): Array<Record<string, string | number>> {
  const runnersById = new Map(getAllRunners().map((runner) => [runner.id, runner]));
  return getAllLaps()
    .slice()
    .reverse()
    .map((lap) => {
      const runner = runnersById.get(lap.runnerId);
      return {
        timestamp: new Date(lap.finishedAt).toISOString(),
        runner_number: lap.runnerNumber || '',
        name: lap.runnerName,
        lap_number: lap.lapNumber,
        lap_time_ms: lap.durationMs,
        lap_time_readable: formatDurationMs(lap.durationMs),
        labels: (lap.labels || []).map((label) => label.name).join(', '),
        target_laps: runner?.targetLaps ?? '',
        historical_avg_ms: runner?.historicalAvgMs ?? '',
        historical_best_ms: runner?.historicalBestMs ?? '',
        source: lap.source,
      };
    });
}

const LAP_EXPORT_COLUMNS = [
  'timestamp',
  'runner_number',
  'name',
  'lap_number',
  'lap_time_ms',
  'lap_time_readable',
  'labels',
  'target_laps',
  'historical_avg_ms',
  'historical_best_ms',
  'source',
];

setRealtimeEmitter((event) => {
  io.emit(event.type, event.payload);
});

app.use(
  '/trpc',
  createExpressMiddleware({
    router: appRouter,
  })
);

app.get('/api/state', (_req, res) => {
  res.json(appSnapshot());
});

app.get('/api/time', (_req, res) => {
  res.json({ serverNowMs: Date.now() });
});

app.get('/api/host-info', (_req, res) => {
  res.json(hostInfo());
});

app.get('/api/export/laps.csv', (_req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="apolloon-laps.csv"');
  const rows = lapExportRows();
  res.send(
    rows.length
      ? Papa.unparse(rows, { header: true, columns: LAP_EXPORT_COLUMNS })
      : `${LAP_EXPORT_COLUMNS.join(',')}\n`
  );
});

app.get('/api/export/laps.json', (_req, res) => {
  res.json({ laps: getAllLaps() });
});

app.get('/api/export/current-state.json', (_req, res) => {
  res.json(appSnapshot());
});

app.use(express.static(DIST_DIR));
app.get('/{*splat}', (_req, res) => {
  if (fs.existsSync(INDEX_HTML)) {
    res.sendFile(INDEX_HTML);
    return;
  }
  res.status(404).send('Frontend build not found. Run vite in dev or npm run build first.');
});

io.on('connection', (socket) => {
  socket.emit('bootstrap', appSnapshot());
});

await initDb();

server.listen(SERVER_PORT, () => {
  console.log(`Server listening on http://0.0.0.0:${SERVER_PORT}`);
  console.log(`Event URL for laptops: ${hostInfo().url}`);
});
