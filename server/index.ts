import 'dotenv/config';
import http from 'node:http';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import express, { type NextFunction, type Request, type Response } from 'express';
import { Server as SocketIOServer } from 'socket.io';
import { historyCacheKey, liveAppSnapshot, raceHistory, type HistoryRequest } from './app-state.js';
import { backupStatus, latestBackupPath, startBackupService, stopBackupService } from './backups.js';
import { registerClusterRoutes, startClusterService, stopClusterService } from './cluster.js';
import {
  activeTemporaryTeamsKey,
  closeDb,
  databaseReadiness,
  getAppDataRevision,
  initDb,
  markAppDataChanged,
  onAppDataChanged,
} from './db.js';
import { RELEASE_ID } from './env.js';
import { registerExportRoutes } from './exports.js';
import { hostInfo, SERVER_PORT } from './host.js';
import { sendJson } from './http-json.js';
import { getNetProfile, isLoopbackAddress, requestMakeStatic, requestRevertDhcp } from './net-setup.js';
import { appRouter } from './router.js';
import { registerStaticFrontend } from './static-files.js';
import { clusterNow } from './clock.js';

const app = express();
app.disable('x-powered-by');
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: true, credentials: false },
  serveClient: false,
});
const processStartedAt = Date.now();
let shuttingDown = false;
let temporaryTeamTimer: NodeJS.Timeout | null = null;

// Clients refetch when the revision moves; several changes in one tick send one event.
let revisionEmitQueued = false;
onAppDataChanged(() => {
  if (revisionEmitQueued) return;
  revisionEmitQueued = true;
  setImmediate(() => {
    revisionEmitQueued = false;
    io.emit('state:revision', getAppDataRevision());
  });
});

io.on('connection', (socket) => {
  socket.emit('state:revision', getAppDataRevision());
});

/**
 * Changing the laptop's network is only allowed from the laptop itself, so a
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

app.use(express.json({ limit: '20mb' }));
registerClusterRoutes(app);
app.use(
  '/trpc',
  createExpressMiddleware({
    router: appRouter,
    createContext: ({ req, res }) => ({
      forwarded: req.header('x-apolloon-forwarded') === '1',
      requestId: req.header('x-apolloon-request-id')?.slice(0, 128) || undefined,
      reportLogSeq: (seq: number) => res.setHeader('x-apolloon-log-seq', String(seq)),
    }),
  })
);

app.get('/api/state', (req, res, next) => {
  sendJson(req, res, `live:${getAppDataRevision()}:${hostInfo().url}`, liveAppSnapshot).catch(next);
});

app.get('/api/history', (req, res, next) => {
  const runnerId = typeof req.query.runnerId === 'string' ? req.query.runnerId.trim().slice(0, 128) : '';
  const request: HistoryRequest = runnerId
    ? { scope: 'runner', runnerId }
    : req.query.scope === 'recent'
      ? { scope: 'recent', limit: Number(req.query.limit) || 100 }
      : { scope: 'full' };
  sendJson(req, res, historyCacheKey(request), () => raceHistory(request)).catch(next);
});

app.get('/api/time', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ serverNowMs: clusterNow() });
});

app.get('/api/host-info', (_req, res) => {
  res.json(hostInfo());
});

app.get('/api/net/profile', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    res.json({ ok: true, profile: getNetProfile() });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Netwerkprofiel lezen mislukt' });
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
    const backup = backupStatus();
    res.json({
      ok: true,
      releaseId: RELEASE_ID,
      startedAt: processStartedAt,
      uptimeSeconds: Math.floor(process.uptime()),
      database: databaseReadiness(),
      backup: {
        enabled: backup.enabled,
        latestCreatedAt: backup.latest?.createdAt ?? null,
        lastError: backup.lastError,
        diskLow: backup.diskLow,
        diskFreeBytes: backup.diskFreeBytes,
      },
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      releaseId: RELEASE_ID,
      error: error instanceof Error ? error.message : 'database unavailable',
    });
  }
});

app.get('/api/backups/latest', (_req, res) => {
  const latest = latestBackupPath();
  if (!latest) {
    res.status(404).json({ ok: false, error: 'Er is nog geen backup.' });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.attachment(latest.record.fileName);
  res.sendFile(latest.path, { dotfiles: 'allow' });
});

registerExportRoutes(app);
registerStaticFrontend(app);

/** Night-team labels are derived from the clock, so clients refresh when a team starts or stops. */
function watchTemporaryTeams(): void {
  let activeKey = activeTemporaryTeamsKey();
  temporaryTeamTimer = setInterval(() => {
    const nextKey = activeTemporaryTeamsKey();
    if (nextKey === activeKey) return;
    activeKey = nextKey;
    markAppDataChanged();
  }, 1_000);
}

function shutdown(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Stopping server (${reason})`);
  stopClusterService();
  if (temporaryTeamTimer) clearInterval(temporaryTeamTimer);

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
startBackupService();
startClusterService();
watchTemporaryTeams();

server.listen(SERVER_PORT, () => {
  console.log(`Server listening on http://0.0.0.0:${SERVER_PORT}`);
  console.log(`Event URL for laptops: ${hostInfo().url}`);
});
