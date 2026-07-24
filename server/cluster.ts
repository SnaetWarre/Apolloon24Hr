import type { Express, NextFunction, Request, Response } from 'express';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import path from 'node:path';
import {
  acknowledgeReplicationVector,
  applyRemoteReplicationOperations,
  ensureReplicationIdentity,
  getAllReplicationOperations,
  getOpenReplicationConflictCount,
  getPendingReplicationOperationCount,
  getReplicationCheckpoint,
  getReplicationConflicts,
  getReplicationOperationsMissing,
  getReplicationVector,
  getSetting,
  installReplicationBootstrap,
  type ReplicationCheckpoint,
  type ReplicationConflict,
  type ReplicationIdentity,
  type ReplicationOperation,
} from './db.js';
import { appSnapshot } from './app-state.js';
import { hostInfo } from './host.js';
import { emitRealtime } from './realtime.js';
import {
  appSnapshotSchema,
  type AppSnapshot,
  type ClusterPeer,
  type ClusterStatus,
} from '../shared/schemas.js';
import { isClusterEnabled } from './cluster-policy.js';

type PeerState = {
  id: string | null;
  url: string;
  reachable: boolean;
  lastSeenAt: number | null;
  vector: Record<string, number>;
  consecutiveFailures: number;
  nextProbeAt: number;
  clockSkewMs: number | null;
};

type DiscoveryPayload = {
  app: 'apolloon';
  protocol: 2;
  clusterId: string;
  hostId: string;
  url: string;
  vector: Record<string, number>;
  sentAt: number;
};

type ExchangePayload = {
  protocol: 2;
  clusterId: string;
  hostId: string;
  url: string;
  vector: Record<string, number>;
  operations: ReplicationOperation[];
  sentAt: number;
};

type BootstrapPayload = {
  protocol: 2;
  clusterId: string;
  clusterSecret: string;
  hostId: string;
  url: string;
  snapshot: AppSnapshot;
  checkpoint: ReplicationCheckpoint;
  operations: ReplicationOperation[];
  conflicts: ReplicationConflict[];
  timingControllerHostId: string | null;
};

const enabled = isClusterEnabled(process.env);
const selfUrl = normalizeUrl(process.env.CLUSTER_SELF_URL || hostInfo().url);
const discoveryEnabled = process.env.CLUSTER_DISCOVERY !== 'false';
const discoveryPort = readPositiveInt(process.env.CLUSTER_DISCOVERY_PORT, 45737);
const discoveryAddress = process.env.CLUSTER_DISCOVERY_ADDRESS || '255.255.255.255';
const discoveryIntervalMs = readPositiveInt(process.env.CLUSTER_DISCOVERY_INTERVAL_MS, 1_000);
const syncIntervalMs = readPositiveInt(process.env.CLUSTER_SYNC_INTERVAL_MS, 350);
const requestTimeoutMs = readPositiveInt(process.env.CLUSTER_REQUEST_TIMEOUT_MS, 1_500);
const peerRetryBaseMs = readPositiveInt(process.env.CLUSTER_PEER_RETRY_MS, 750);
const peers = new Map<string, PeerState>();

let discoverySocket: dgram.Socket | null = null;
let discoveryHandle: NodeJS.Timeout | null = null;
let syncHandle: NodeJS.Timeout | null = null;
let syncPromise: Promise<void> | null = null;
let identityCache: ReplicationIdentity | null = null;
let joinInProgress = false;

for (const peerUrl of (process.env.CLUSTER_PEERS || '').split(',')) {
  addPeer(peerUrl);
}

export function clusterStatus(): ClusterStatus {
  const identity = currentIdentity();
  const peerList = [...peers.values()];
  const reachable = peerList.filter((peer) => peer.reachable);
  const localVector = getReplicationVector();
  const skewSamples = reachable
    .map((peer) => peer.clockSkewMs)
    .filter((value): value is number => value !== null);
  return {
    enabled,
    hostId: identity.hostId,
    clusterId: identity.clusterId,
    pairingCode: pairingCode(identity.clusterSecret),
    role: enabled ? 'local-first' : 'standalone',
    writable: true,
    connectedHosts: 1 + reachable.length,
    knownHosts: 1 + peerList.length,
    pendingOperations: getPendingReplicationOperationCount(),
    conflictCount: getOpenReplicationConflictCount(),
    timingControllerHostId: getSetting('timing_controller_host_id'),
    clockSkewMs: skewSamples.length
      ? Math.max(...skewSamples.map((value) => Math.abs(value)))
      : null,
    lastAppliedSeq: Object.values(localVector).reduce((total, seq) => total + seq, 0),
    peers: peerList.map(toClusterPeer),
  };
}

export function assertWritable(): void {
  // Local-first nodes always commit to their own durable SQLite database.
}

export function recordLocalWrite(_type: string): void {
  // Writes are captured transactionally by commitReplicatedWrite in db.ts.
}

export function registerClusterRoutes(app: Express): void {
  app.get('/api/cluster/status', (_req, res) => {
    res.json(clusterStatus());
  });

  app.get('/api/cluster/hello', (_req, res) => {
    res.json(discoveryPayload());
  });

  if (!enabled) {
    app.use('/api/cluster/sync', (_req, res) => {
      res.status(404).json({ ok: false, error: 'cluster mode is disabled' });
    });
    return;
  }

  app.get('/api/cluster/bootstrap', (req, res) => {
    const identity = currentIdentity();
    if (!validPairingCode(req.query.code, identity.clusterSecret)) {
      res.status(401).json({ ok: false, error: 'ongeldige koppelcode' });
      return;
    }
    res.json({
      protocol: 2,
      clusterId: identity.clusterId,
      clusterSecret: identity.clusterSecret,
      hostId: identity.hostId,
      url: selfUrl,
      snapshot: appSnapshot(),
      checkpoint: getReplicationCheckpoint(),
      operations: getAllReplicationOperations(),
      conflicts: getReplicationConflicts('all'),
      timingControllerHostId: getSetting('timing_controller_host_id'),
    } satisfies BootstrapPayload);
  });

  app.post('/api/cluster/join', asyncJson(async (req, res) => {
    if (joinInProgress) {
      res.status(409).json({ ok: false, error: 'koppeling is al bezig' });
      return;
    }
    const remoteUrl = normalizeUrl(req.body?.remoteUrl);
    const code = String(req.body?.pairingCode || '').trim().toUpperCase();
    if (!remoteUrl || remoteUrl === selfUrl || !code) {
      res.status(400).json({ ok: false, error: 'vul een geldige laptop-URL en koppelcode in' });
      return;
    }

    joinInProgress = true;
    try {
      const response = await fetch(
        `${remoteUrl}/api/cluster/bootstrap?code=${encodeURIComponent(code)}`,
        { signal: AbortSignal.timeout(Math.max(requestTimeoutMs, 10_000)) }
      );
      if (!response.ok) {
        const reason = await response.text();
        throw new Error(
          response.status === 401
            ? 'De koppelcode klopt niet'
            : `De andere laptop antwoordde met ${response.status}: ${reason.slice(0, 160)}`
        );
      }
      const payload = (await response.json()) as Partial<BootstrapPayload>;
      const parsedSnapshot = appSnapshotSchema.safeParse(payload.snapshot);
      if (
        payload.protocol !== 2 ||
        !payload.clusterId ||
        !payload.clusterSecret ||
        !payload.hostId ||
        !parsedSnapshot.success ||
        !payload.checkpoint ||
        !Array.isArray(payload.operations) ||
        !Array.isArray(payload.conflicts)
      ) {
        throw new Error('De andere laptop stuurde geen geldige Apolloon-database');
      }
      const result = await installReplicationBootstrap({
        clusterId: payload.clusterId,
        clusterSecret: payload.clusterSecret,
        snapshot: parsedSnapshot.data,
        checkpoint: payload.checkpoint,
        operations: payload.operations,
        conflicts: payload.conflicts,
        timingControllerHostId: payload.timingControllerHostId || null,
      });
      identityCache = null;
      peers.clear();
      addPeer(payload.url || remoteUrl);
      emitRealtime({ type: 'state:revision', payload: Date.now() });
      res.json({
        ok: true,
        backupFile: path.basename(result.backupPath),
        status: clusterStatus(),
      });
    } finally {
      joinInProgress = false;
    }
  }));

  app.get('/api/cluster/conflicts', (_req, res) => {
    res.json(getReplicationConflicts());
  });

  app.post('/api/cluster/sync/exchange', asyncJson(async (req, res) => {
    const identity = currentIdentity();
    if (!authorized(req)) {
      res.status(401).json({ ok: false, error: 'invalid cluster secret' });
      return;
    }
    const payload = req.body as Partial<ExchangePayload>;
    if (
      payload.protocol !== 2 ||
      payload.clusterId !== identity.clusterId ||
      !payload.hostId ||
      !payload.url ||
      !payload.vector ||
      !Array.isArray(payload.operations)
    ) {
      res.status(409).json({ ok: false, error: 'cluster or protocol mismatch' });
      return;
    }

    const peer = touchPeer(payload.url, payload.hostId, payload.vector);
    peer.clockSkewMs = typeof payload.sentAt === 'number' ? payload.sentAt - Date.now() : null;
    const result = applyRemoteReplicationOperations(payload.operations);
    acknowledgeReplicationVector(payload.hostId, payload.vector);
    if (result.applied > 0 || result.conflicts > 0) {
      emitRealtime({ type: 'state:revision', payload: Date.now() });
    }

    const localVector = getReplicationVector();
    res.json({
      protocol: 2,
      clusterId: identity.clusterId,
      hostId: identity.hostId,
      url: selfUrl,
      vector: localVector,
      operations: getReplicationOperationsMissing(payload.vector),
      sentAt: Date.now(),
    } satisfies ExchangePayload);
  }));
}

export function proxyFollowerTrpcWrites(
  _req: Request,
  _res: Response,
  next: NextFunction
): void {
  next();
}

export function startClusterService(): void {
  if (!enabled) return;
  startDiscovery();
  scheduleSync(25);
}

function startDiscovery(): void {
  if (!discoveryEnabled || discoverySocket) return;
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  discoverySocket = socket;
  socket.on('error', (error) => {
    console.warn('Cluster discovery error:', error.message);
  });
  socket.on('message', (message) => {
    try {
      const identity = currentIdentity();
      const payload = JSON.parse(message.toString('utf8')) as Partial<DiscoveryPayload>;
      if (
        payload.app !== 'apolloon' ||
        payload.protocol !== 2 ||
        payload.clusterId !== identity.clusterId ||
        !payload.hostId ||
        payload.hostId === identity.hostId ||
        !payload.url
      ) {
        return;
      }
      const peer = touchPeer(payload.url, payload.hostId, payload.vector || {});
      peer.clockSkewMs = typeof payload.sentAt === 'number' ? payload.sentAt - Date.now() : null;
    } catch {
      // Ignore unrelated UDP traffic on the discovery port.
    }
  });
  socket.bind(discoveryPort, '0.0.0.0', () => {
    try {
      socket.setBroadcast(true);
    } catch {
      // Some test and container networks do not expose broadcast support.
    }
    broadcastDiscovery();
  });
  discoveryHandle = setInterval(broadcastDiscovery, discoveryIntervalMs);
  discoveryHandle.unref?.();
}

function broadcastDiscovery(): void {
  if (!discoverySocket) return;
  const message = Buffer.from(JSON.stringify(discoveryPayload()));
  discoverySocket.send(message, discoveryPort, discoveryAddress, (error) => {
    if (error) console.warn('Cluster discovery broadcast failed:', error.message);
  });
}

function discoveryPayload(): DiscoveryPayload {
  const identity = currentIdentity();
  return {
    app: 'apolloon',
    protocol: 2,
    clusterId: identity.clusterId,
    hostId: identity.hostId,
    url: selfUrl,
    vector: getReplicationVector(),
    sentAt: Date.now(),
  };
}

function scheduleSync(delayMs = syncIntervalMs): void {
  if (syncHandle) clearTimeout(syncHandle);
  syncHandle = setTimeout(() => {
    syncHandle = null;
    void syncAllPeers().finally(() => scheduleSync());
  }, delayMs);
  syncHandle.unref?.();
}

function syncAllPeers(): Promise<void> {
  if (joinInProgress) return Promise.resolve();
  if (syncPromise) return syncPromise;
  syncPromise = Promise.all(
    [...peers.values()]
      .filter((peer) => Date.now() >= peer.nextProbeAt)
      .map(syncPeer)
  )
    .then(() => undefined)
    .finally(() => {
      syncPromise = null;
    });
  return syncPromise;
}

async function syncPeer(peer: PeerState): Promise<void> {
  const identity = currentIdentity();
  const localVector = getReplicationVector();
  const payload: ExchangePayload = {
    protocol: 2,
    clusterId: identity.clusterId,
    hostId: identity.hostId,
    url: selfUrl,
    vector: localVector,
    operations: getReplicationOperationsMissing(peer.vector),
    sentAt: Date.now(),
  };
  try {
    const response = await fetch(`${peer.url}/api/cluster/sync/exchange`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-apolloon-cluster-secret': identity.clusterSecret,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!response.ok) throw new Error(`sync failed: ${response.status}`);
    const remote = (await response.json()) as ExchangePayload;
    if (
      remote.protocol !== 2 ||
      remote.clusterId !== identity.clusterId ||
      !remote.hostId ||
      !remote.vector ||
      !Array.isArray(remote.operations)
    ) {
      throw new Error('invalid sync response');
    }
    const result = applyRemoteReplicationOperations(remote.operations);
    peer.id = remote.hostId;
    peer.url = normalizeUrl(remote.url) || peer.url;
    peer.vector = remote.vector;
    peer.reachable = true;
    peer.lastSeenAt = Date.now();
    peer.consecutiveFailures = 0;
    peer.nextProbeAt = 0;
    peer.clockSkewMs = remote.sentAt - Date.now();
    acknowledgeReplicationVector(remote.hostId, remote.vector);
    if (result.applied > 0 || result.conflicts > 0) {
      emitRealtime({ type: 'state:revision', payload: Date.now() });
    }
  } catch (error) {
    if (peer.consecutiveFailures === 0) {
      console.warn(
        `Cluster sync with ${peer.url} failed:`,
        error instanceof Error ? error.message : String(error)
      );
    }
    peer.reachable = false;
    peer.consecutiveFailures += 1;
    peer.nextProbeAt =
      Date.now() + Math.min(10_000, peerRetryBaseMs * 2 ** Math.min(peer.consecutiveFailures - 1, 4));
  }
}

function addPeer(peerUrl: string): PeerState | null {
  const url = normalizeUrl(peerUrl);
  if (!url || url === selfUrl) return null;
  const existing = peers.get(url);
  if (existing) return existing;
  const peer: PeerState = {
    id: null,
    url,
    reachable: false,
    lastSeenAt: null,
    vector: {},
    consecutiveFailures: 0,
    nextProbeAt: 0,
    clockSkewMs: null,
  };
  peers.set(url, peer);
  return peer;
}

function touchPeer(
  peerUrl: string,
  peerId: string,
  vector: Record<string, number>
): PeerState {
  const url = normalizeUrl(peerUrl);
  let peer: PeerState | null | undefined = [...peers.values()].find(
    (item) => item.id === peerId
  );
  if (!peer) peer = addPeer(url);
  if (!peer) {
    throw new Error('peer points to this host');
  }
  peer.id = peerId;
  peer.vector = vector;
  peer.reachable = true;
  peer.lastSeenAt = Date.now();
  peer.consecutiveFailures = 0;
  peer.nextProbeAt = 0;
  return peer;
}

function toClusterPeer(peer: PeerState): ClusterPeer {
  return {
    id: peer.id,
    url: peer.url,
    reachable: peer.reachable,
    lastSeenAt: peer.lastSeenAt,
    lastSeq: peer.id ? peer.vector[peer.id] ?? null : null,
    operationVector: peer.vector,
  };
}

function authorized(req: Request): boolean {
  return req.header('x-apolloon-cluster-secret') === currentIdentity().clusterSecret;
}

function currentIdentity(): ReplicationIdentity {
  identityCache ??= ensureReplicationIdentity();
  return identityCache;
}

function pairingCode(clusterSecret: string): string {
  return crypto
    .createHash('sha256')
    .update(`apolloon-pairing:${clusterSecret}`)
    .digest('hex')
    .slice(0, 8)
    .toUpperCase();
}

function validPairingCode(value: unknown, clusterSecret: string): boolean {
  const expected = pairingCode(clusterSecret);
  const received = String(value || '').trim().toUpperCase();
  if (received.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

function normalizeUrl(value: unknown): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function readPositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function asyncJson(
  handler: (req: Request, res: Response) => Promise<void> | void
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      if (res.headersSent) {
        next(error);
        return;
      }
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : 'onbekende clusterfout',
      });
    });
  };
}
