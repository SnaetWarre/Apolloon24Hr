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
import { appSnapshot, liveAppSnapshot } from './app-state.js';
import { raceHistory } from './app-history.js';
import {
  backupManifest,
  backupStatus,
  compactDatabaseStorage,
  createVerifiedBackup,
  latestBackupPath,
  startBackupService,
  stopBackupService,
  verifyStoredBackup,
} from './backups.js';
import {
  registerClusterRoutes,
  startClusterService,
  stopClusterService,
} from './cluster.js';
import {
  closeDb,
  databaseReadiness,
  getAllLaps,
  getAllRaceEvents,
  getAllRunners,
  getAppDataRevision,
  initDb,
} from './db.js';
import { hostInfo, SERVER_PORT } from './host.js';
import {
  getNetProfile,
  isLoopbackAddress,
  requestMakeStatic,
  requestRevertDhcp,
} from './net-setup.js';
import { sendJson } from './http-json.js';
import { setRealtimeEmitter } from './realtime.js';
import { appRouter } from './router.js';
import { relativeFileWithinRoot } from './static-files.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compiledDistDir = path.resolve(__dirname, '..', '..', 'dist');
const sourceDistDir = path.resolve(__dirname, '..', 'dist');
const DIST_DIR = fs.existsSync(compiledDistDir) ? compiledDistDir : sourceDistDir;
const INDEX_HTML = path.join(DIST_DIR, 'index.html');
const ASSETS_DIR = path.join(DIST_DIR, 'assets');
const COMPRESSED_ASSET_CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);

const app = express();
app.disable('x-powered-by');
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: true, credentials: false },
  serveClient: false,
});
let shuttingDown = false;
const processStartedAt = Date.now();

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

app.use(
  '/trpc',
  createExpressMiddleware({
    router: appRouter,
  })
);

app.get('/api/state', async (req, res, next) => {
  try {
    const snapshot = liveAppSnapshot();
    await sendJson(req, res, snapshot, {
      cacheKey: `live:${snapshot.revision || 0}:${Math.floor(snapshot.serverNowMs / 1_000)}`,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/history', async (req, res, next) => {
  try {
    const runnerId = typeof req.query.runnerId === 'string' ? req.query.runnerId.trim() : '';
    const requestedLimit = Number(req.query.limit);
    const history = runnerId
      ? raceHistory({ scope: 'runner', runnerId: runnerId.slice(0, 128) })
      : req.query.scope === 'recent'
        ? raceHistory({
            scope: 'recent',
            limit: Number.isFinite(requestedLimit) ? requestedLimit : 100,
          })
        : raceHistory({ scope: 'full' });
    await sendJson(req, res, history, {
      cacheKey: `history:${history.revision}:${history.scope}:${history.runnerId || ''}:${history.limit || ''}`,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/time', (_req, res) => {
  res.json({ serverNowMs: Date.now() });
});

app.get('/api/host-info', (_req, res) => {
  res.json(hostInfo());
});

// Event-netwerk: alleen uitlezen mag vanaf het LAN, vastzetten/terugzetten
// mag uitsluitend vanaf de laptop zelf (127.0.0.1). Zo kan een browser op een
// andere laptop nooit het netwerk van deze host omgooien; de Windows-UAC
// melding verschijnt bovendien alleen op het scherm van de host zelf.
app.get('/api/net/profile', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    res.json({ ok: true, profile: getNetProfile() });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'netwerkprofiel mislukt',
    });
  }
});

app.post('/api/net/make-static', (req, res) => {
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    res.status(403).json({
      ok: false,
      error: 'Dit kan alleen op de laptop zelf (open Admin op die laptop, niet via het netwerk).',
    });
    return;
  }
  const result = requestMakeStatic({
    ip: req.body?.ip,
    prefixLength: req.body?.prefixLength,
    gateway: req.body?.gateway,
  });
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  res.json(result);
});

app.post('/api/net/revert-dhcp', (req, res) => {
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    res.status(403).json({
      ok: false,
      error: 'Dit kan alleen op de laptop zelf (open Admin op die laptop, niet via het netwerk).',
    });
    return;
  }
  const result = requestRevertDhcp({
    eventOver: req.body?.eventOver,
    confirmText: req.body?.confirmText,
  });
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  res.json(result);
});

app.get('/api/health', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const database = databaseReadiness();
    const backup = backupStatus();
    res.json({
      ok: true,
      releaseId: process.env.APOLLOON_RELEASE_ID?.trim() || null,
      startedAt: processStartedAt,
      uptimeSeconds: Math.floor(process.uptime()),
      database,
      backup: {
        enabled: backup.enabled,
        latestCreatedAt: backup.latest?.createdAt || null,
        lastError: backup.lastError,
        diskLow: backup.diskLow,
        diskFreeBytes: backup.diskFreeBytes,
      },
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      releaseId: process.env.APOLLOON_RELEASE_ID?.trim() || null,
      error: error instanceof Error ? error.message : 'database unavailable',
    });
  }
});

app.get('/api/backups/status', (_req, res) => {
  res.json(backupStatus());
});

app.post('/api/backups', async (req, res) => {
  try {
    const backup = await createVerifiedBackup(
      typeof req.body?.reason === 'string' ? req.body.reason : 'manual'
    );
    res.status(201).json({ ok: true, backup, status: backupStatus() });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'backup maken mislukt',
    });
  }
});

app.post('/api/database/compact', async (_req, res) => {
  try {
    const result = await compactDatabaseStorage();
    if (!result.compacted) {
      res.status(409).json({
        ok: false,
        error:
          result.reason === 'race-active'
            ? 'Database compactie is geblokkeerd zolang de race actief is.'
            : result.reason === 'insufficient-disk'
              ? 'Er is onvoldoende vrije schijfruimte om veilig te compacten.'
              : 'Database compactie is momenteel niet nodig.',
        result,
      });
      return;
    }
    res.json({ ok: true, result, status: backupStatus() });
  } catch (error) {
    res.status(409).json({
      ok: false,
      error: error instanceof Error ? error.message : 'database compactie mislukt',
    });
  }
});

app.get('/api/backups/latest/manifest', (_req, res) => {
  const latest = latestBackupPath();
  if (!latest) {
    res.status(404).json({ ok: false, error: 'nog geen backup beschikbaar' });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.attachment(`${latest.record.fileName}.json`);
  res.json(backupManifest(latest.record));
});

app.get('/api/backups/latest', async (_req, res) => {
  const latest = latestBackupPath();
  if (!latest) {
    res.status(404).json({ ok: false, error: 'nog geen backup beschikbaar' });
    return;
  }
  try {
    await verifyStoredBackup(latest.record, latest.path);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Apolloon-Backup-SHA256', latest.record.sha256);
    res.attachment(latest.record.fileName);
    res.sendFile(latest.path, { dotfiles: 'allow' });
  } catch (error) {
    res.status(409).json({
      ok: false,
      error:
        error instanceof Error
          ? `backup kon niet opnieuw geverifieerd worden: ${error.message}`
          : 'backup kon niet opnieuw geverifieerd worden',
    });
  }
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

app.use((req, res, next) => {
  if ((req.method !== 'GET' && req.method !== 'HEAD') || !req.path.startsWith('/assets/')) {
    next();
    return;
  }
  const originalPath = path.resolve(DIST_DIR, `.${req.path}`);
  if (!originalPath.startsWith(`${ASSETS_DIR}${path.sep}`)) {
    next();
    return;
  }

  const preferredEncoding = req.acceptsEncodings('br', 'gzip');
  const compressed =
    preferredEncoding === 'br' && fs.existsSync(`${originalPath}.br`)
      ? { path: `${originalPath}.br`, encoding: 'br' }
      : preferredEncoding === 'gzip' && fs.existsSync(`${originalPath}.gz`)
        ? { path: `${originalPath}.gz`, encoding: 'gzip' }
        : null;
  if (!compressed) {
    next();
    return;
  }

  const contentType = COMPRESSED_ASSET_CONTENT_TYPES.get(path.extname(originalPath));
  if (contentType) res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Encoding', compressed.encoding);
  res.setHeader('Vary', 'Accept-Encoding');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  const relativePath = relativeFileWithinRoot(DIST_DIR, compressed.path);
  if (!relativePath) {
    next();
    return;
  }
  res.sendFile(relativePath, { root: DIST_DIR });
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
    res.sendFile('index.html', { root: DIST_DIR });
    return;
  }
  res.status(404).send('Frontend build not found. Run vite in dev or npm run build first.');
});

io.on('connection', (socket) => {
  socket.emit('state:revision', getAppDataRevision());
});

function shutdown(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Stopping server (${reason})`);
  stopClusterService();

  let finished = false;
  let forceExit: NodeJS.Timeout;
  const finish = () => {
    if (finished) return;
    finished = true;
    void stopBackupService().finally(() => {
      clearTimeout(forceExit);
      closeDb();
      process.exit(0);
    });
  };
  forceExit = setTimeout(() => {
    try {
      closeDb();
    } finally {
      process.exit(1);
    }
  }, 5_000);
  forceExit.unref?.();

  if (!server.listening) {
    finish();
    return;
  }
  server.close(finish);
  io.close(finish);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('disconnect', () => shutdown('parent disconnected'));

await initDb();
const startupCompaction = await compactDatabaseStorage({ force: false }).catch((error) => {
  console.warn(
    'Database could not be compacted safely at startup:',
    error instanceof Error ? error.message : String(error)
  );
  return null;
});
if (startupCompaction?.compacted) {
  console.log(
    `Database compacted after verified backup: ${startupCompaction.before.fileBytes} -> ${startupCompaction.after.fileBytes} bytes`
  );
}
startBackupService();
startClusterService();

server.listen(SERVER_PORT, () => {
  console.log(`Server listening on http://0.0.0.0:${SERVER_PORT}`);
  console.log(`Event URL for laptops: ${hostInfo().url}`);
});
