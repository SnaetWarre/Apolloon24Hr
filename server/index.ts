import 'dotenv/config';
import http from 'node:http';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import express, { type NextFunction, type Request, type Response } from 'express';
import { Server as SocketIOServer } from 'socket.io';
import { raceHistory } from './app-history.js';
import { liveAppSnapshot } from './app-state.js';
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
import { registerClusterRoutes, startClusterService, stopClusterService } from './cluster.js';
import { closeDb, databaseReadiness, getAppDataRevision, initDb } from './db.js';
import { RELEASE_ID } from './env.js';
import { registerExportRoutes } from './exports.js';
import { hostInfo, SERVER_PORT } from './host.js';
import { sendJson } from './http-json.js';
import { getNetProfile, isLoopbackAddress, requestMakeStatic, requestRevertDhcp } from './net-setup.js';
import { setRealtimeEmitter } from './realtime.js';
import { appRouter, runTemporaryTeamSchedules } from './router.js';
import { registerStaticFrontend } from './static-files.js';

const app = express();
app.disable('x-powered-by');
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: true, credentials: false },
  serveClient: false,
  // Bridge short outages (cable pulled, switch restart): the server buffers
  // briefly and the client resumes without missing events.
  connectionStateRecovery: {},
});
const processStartedAt = Date.now();
let shuttingDown = false;
let temporaryTeamScheduleTimer: NodeJS.Timeout | null = null;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * Changing the host's network is only allowed from the laptop itself, so a
 * browser elsewhere on the LAN can never repoint it, and the OS permission
 * prompt appears on the screen of the person asking.
 */
function requireLoopback(req: Request, res: Response, next: NextFunction): void {
  if (isLoopbackAddress(req.socket.remoteAddress)) {
    next();
    return;
  }
  res.status(403).json({
    ok: false,
    error: 'Dit kan alleen op de laptop zelf (open Beheer op die laptop, niet via het netwerk).',
  });
}

setRealtimeEmitter((event) => {
  io.emit(event.type, event.payload);
});

app.use(express.json({ limit: '50mb' }));
registerClusterRoutes(app);
app.use('/trpc', createExpressMiddleware({ router: appRouter }));

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
        ? raceHistory({ scope: 'recent', limit: Number.isFinite(requestedLimit) ? requestedLimit : 100 })
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

app.get('/api/net/profile', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    res.json({ ok: true, profile: getNetProfile() });
  } catch (error) {
    res.status(500).json({ ok: false, error: errorMessage(error, 'netwerkprofiel mislukt') });
  }
});

app.post('/api/net/make-static', requireLoopback, (req, res) => {
  const result = requestMakeStatic({
    ip: req.body?.ip,
    prefixLength: req.body?.prefixLength,
    gateway: req.body?.gateway,
  });
  res.status(result.ok ? 200 : 400).json(result);
});

app.post('/api/net/revert-dhcp', requireLoopback, (req, res) => {
  const result = requestRevertDhcp({ eventOver: req.body?.eventOver, confirmText: req.body?.confirmText });
  res.status(result.ok ? 200 : 400).json(result);
});

app.get('/api/health', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const database = databaseReadiness();
    const backup = backupStatus();
    res.json({
      ok: true,
      releaseId: RELEASE_ID,
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
    res.status(503).json({ ok: false, releaseId: RELEASE_ID, error: errorMessage(error, 'database unavailable') });
  }
});

app.get('/api/backups/status', (_req, res) => {
  res.json(backupStatus());
});

app.post('/api/backups', async (req, res) => {
  try {
    const backup = await createVerifiedBackup(typeof req.body?.reason === 'string' ? req.body.reason : 'manual');
    res.status(201).json({ ok: true, backup, status: backupStatus() });
  } catch (error) {
    res.status(500).json({ ok: false, error: errorMessage(error, 'backup maken mislukt') });
  }
});

const COMPACTION_SKIPPED_MESSAGES = {
  'race-active': 'Database compactie is geblokkeerd zolang de race actief is.',
  'insufficient-disk': 'Er is onvoldoende vrije schijfruimte om veilig te compacten.',
  'not-needed': 'Database compactie is momenteel niet nodig.',
};

app.post('/api/database/compact', async (_req, res) => {
  try {
    const result = await compactDatabaseStorage();
    if (result.reason === 'compacted') {
      res.json({ ok: true, result, status: backupStatus() });
      return;
    }
    res.status(409).json({ ok: false, error: COMPACTION_SKIPPED_MESSAGES[result.reason], result });
  } catch (error) {
    res.status(409).json({ ok: false, error: errorMessage(error, 'database compactie mislukt') });
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

registerExportRoutes(app);
registerStaticFrontend(app);

io.on('connection', (socket) => {
  socket.emit('state:revision', getAppDataRevision());
});

function shutdown(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Stopping server (${reason})`);
  stopClusterService();
  if (temporaryTeamScheduleTimer) clearInterval(temporaryTeamScheduleTimer);

  const forceExit = setTimeout(() => {
    try {
      closeDb();
    } finally {
      process.exit(1);
    }
  }, 5_000);
  forceExit.unref();

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    void stopBackupService().finally(() => {
      clearTimeout(forceExit);
      closeDb();
      process.exit(0);
    });
  };
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
  console.warn('Database could not be compacted safely at startup:', errorMessage(error, String(error)));
  return null;
});
if (startupCompaction?.compacted) {
  console.log(
    `Database compacted after verified backup: ${startupCompaction.before.fileBytes} -> ${startupCompaction.after.fileBytes} bytes`
  );
}
startBackupService();
startClusterService();
runTemporaryTeamSchedules();
temporaryTeamScheduleTimer = setInterval(runTemporaryTeamSchedules, 1_000);

server.listen(SERVER_PORT, () => {
  console.log(`Server listening on http://0.0.0.0:${SERVER_PORT}`);
  console.log(`Event URL for laptops: ${hostInfo().url}`);
});
