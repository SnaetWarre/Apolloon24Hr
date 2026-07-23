import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import Papa from 'papaparse';
import { Server as SocketIOServer } from 'socket.io';
import { formatDurationMs } from '../shared/time.js';
import { appSnapshot } from './app-state.js';
import { proxyFollowerTrpcWrites, registerClusterRoutes, startClusterService } from './cluster.js';
import { getAllLaps, getAllRaceEvents, getAllRunners, getAppDataRevision, initDb } from './db.js';
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
app.disable('x-powered-by');
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: true, credentials: false },
  serveClient: false,
});

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

function eventExportRows(): Array<Record<string, string | number>> {
  return getAllRaceEvents()
    .slice()
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

const EVENT_EXPORT_COLUMNS = [
  'timestamp',
  'type',
  'message',
  'runner_id',
  'runner_number',
  'runner_name',
  'created_at',
];

setRealtimeEmitter((event) => {
  io.emit(event.type, event.payload);
});

app.use(express.json({ limit: '50mb' }));
registerClusterRoutes(app);
app.use('/trpc', proxyFollowerTrpcWrites);

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

app.get('/api/export/events.csv', (_req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="apolloon-events.csv"');
  const rows = eventExportRows();
  res.send(
    rows.length
      ? Papa.unparse(rows, { header: true, columns: EVENT_EXPORT_COLUMNS })
      : `${EVENT_EXPORT_COLUMNS.join(',')}\n`
  );
});

app.get('/api/export/events.json', (_req, res) => {
  res.json({ events: getAllRaceEvents() });
});

app.get('/api/export/current-state.json', (_req, res) => {
  res.json(appSnapshot());
});

app.use(
  express.static(DIST_DIR, {
    setHeaders(res, filePath) {
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  })
);
app.get('/{*splat}', (_req, res) => {
  if (fs.existsSync(INDEX_HTML)) {
    res.sendFile(INDEX_HTML);
    return;
  }
  res.status(404).send('Frontend build not found. Run vite in dev or npm run build first.');
});

io.on('connection', (socket) => {
  socket.emit('state:revision', getAppDataRevision());
});

await initDb();
startClusterService();

server.listen(SERVER_PORT, () => {
  console.log(`Server listening on http://0.0.0.0:${SERVER_PORT}`);
  console.log(`Event URL for laptops: ${hostInfo().url}`);
});
