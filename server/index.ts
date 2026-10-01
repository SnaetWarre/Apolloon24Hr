import 'dotenv/config';
import http from 'node:http';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import { applyWSSHandler } from '@trpc/server/adapters/ws';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocketServer } from 'ws';
import { historyCacheKey, liveAppSnapshot, raceHistory, type HistoryRequest } from './app-state.js';
import { describeOrigin } from './activity.js';
import { backupStatus, latestBackupPath, startBackupService, stopBackupService } from './backups.js';
import { registerClusterRoutes, startClusterService, stopClusterService } from './cluster.js';
import {
  activeTemporaryTeamsKey,
  closeDb,
  databaseReadiness,
  getAppDataRevision,
  getLabelImage,
  getRaceState,
  initDb,
  markAppDataChanged,
} from './db.js';
import { RELEASE_ID } from './env.js';
import { registerExportRoutes } from './exports.js';
import { hostInfo, SERVER_PORT } from './host.js';
import { sendJson } from './http-json.js';
import { getNetProfile, isLoopbackAddress, requestMakeStatic, requestRevertDhcp } from './net-setup.js';
import { appRouter } from './router.js';
import { registerStaticFrontend } from './static-files.js';
import { clusterNow } from './clock.js';
import { isDemoRaceEnabled, startDemoRace } from './demo-race.js';

const app = express();
app.disable('x-powered-by');
const server = http.createServer(app);
const processStartedAt = Date.now();
let shuttingDown = false;
let temporaryTeamTimer: NodeJS.Timeout | null = null;
let stopDemoRace: (() => void) | null = null;

// Screens subscribe to live changes over a WebSocket on /trpc; queries and writes stay on HTTP.
const wss = new WebSocketServer({ noServer: true });
applyWSSHandler({
  wss,
  router: appRouter,
  createContext: () => ({}),
  // Drops a screen that vanished from the network instead of keeping its subscription.
  keepAlive: { enabled: true, pingMs: 10_000, pongWaitMs: 5_000 },
});
server.on('upgrade', (req, socket, head) => {
  if (req.url?.split('?')[0] !== '/trpc') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (client) => wss.emit('connection', client, req));
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
    createContext: ({ req, res }) => {
      const forwarded = req.header('x-apolloon-forwarded') === '1';
      return {
        forwarded,
        requestId: req.header('x-apolloon-request-id')?.slice(0, 128) || undefined,
        reportLogSeq: (seq: number) => res.setHeader('x-apolloon-log-seq', String(seq)),
        origin: forwarded
          ? forwardedOrigin(req.header('x-apolloon-origin'))
          : describeOrigin(req.header('x-apolloon-screen'), req.socket.remoteAddress, hostInfo().hostIpHint),
      };
    },
  })
);

/** The origin a laptop passed on with a forwarded write. */
function forwardedOrigin(header: string | undefined): string | undefined {
  try {
    return header ? decodeURIComponent(header).slice(0, 200) : undefined;
  } catch {
    return undefined;
  }
}

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

// Content-addressed, so a stored logo never changes under its URL.
app.get('/api/label-images/:id', (req, res) => {
  const image = getLabelImage(req.params.id);
  if (!image) {
    res.status(404).end();
    return;
  }
  res.setHeader('Content-Type', image.mime);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(image.bytes);
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
    const race = getRaceState();
    res.json({
      ok: true,
      releaseId: RELEASE_ID,
      startedAt: processStartedAt,
      uptimeSeconds: Math.floor(process.uptime()),
      database: databaseReadiness(),
      // The desktop app keeps the laptop awake and asks before closing while this is true.
      race: { active: race.raceStartedAt !== null && race.raceFinishedAt === null },
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

/** Screens report errors they hit, so `server.log` holds them after the event. */
const CLIENT_ERRORS_PER_MINUTE = 30;
let clientErrorWindowStart = 0;
let clientErrorCount = 0;
app.post('/api/client-errors', (req, res) => {
  const now = Date.now();
  if (now - clientErrorWindowStart > 60_000) {
    clientErrorWindowStart = now;
    clientErrorCount = 0;
  }
  clientErrorCount += 1;
  if (clientErrorCount <= CLIENT_ERRORS_PER_MINUTE) {
    const text = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '');
    const from = isLoopbackAddress(req.socket.remoteAddress) ? 'this laptop' : req.socket.remoteAddress;
    console.error(
      `Screen error on ${text(req.body?.path, 200)} (${from}): ${text(req.body?.message, 1_000)}\n` +
        [text(req.body?.stack, 4_000), text(req.body?.componentStack, 4_000)].filter(Boolean).join('\n')
    );
  }
  res.status(204).end();
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

// Operators see the reason on screen; the default handler only says "Internal Server Error".
app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
  console.error(`${req.method} ${req.path} failed:`, error);
  if (res.headersSent) {
    next(error);
    return;
  }
  res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
});

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
  stopDemoRace?.();

  const forceExit = setTimeout(() => {
    try {
      closeDb();
    } finally {
      process.exit(1);
    }
  }, 5_000);
  forceExit.unref();
  for (const client of wss.clients) client.terminate();

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
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('disconnect', () => shutdown('parent disconnected'));

await initDb();
startBackupService();
startClusterService();
watchTemporaryTeams();
if (isDemoRaceEnabled()) stopDemoRace = startDemoRace();

server.listen(SERVER_PORT, () => {
  console.log(`Server listening on http://0.0.0.0:${SERVER_PORT}`);
  console.log(`Event URL for laptops: ${hostInfo().url}`);
});
