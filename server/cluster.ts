import type { Express, NextFunction, Request, Response } from 'express';
import dgram from 'node:dgram';
import { v4 as uuidv4 } from 'uuid';
import { appSnapshot } from './app-state.js';
import {
  appendClusterOperation,
  applySnapshot,
  ensureHostId,
  getClusterOperationsAfter,
  getClusterTerm,
  getClusterVotedFor,
  hasPersistedAppState,
  getLastClusterOperationSeq,
  setClusterTerm,
  setClusterVotedFor,
  type ClusterOperation,
} from './db.js';
import { hostInfo } from './host.js';
import { emitRealtime } from './realtime.js';
import type { AppSnapshot, ClusterPeer, ClusterRole, ClusterStatus } from '../shared/schemas.js';
import {
  isClusterEnabled,
  shouldAcceptRemoteLeader,
  shouldGrantVote,
} from './cluster-policy.js';

type PeerState = {
  id: string | null;
  url: string;
  reachable: boolean;
  lastSeenAt: number | null;
  lastSeq: number | null;
  consecutiveFailures: number;
  nextProbeAt: number;
};

type HeartbeatPayload = {
  term: number;
  leaderId: string;
  leaderUrl: string;
  lastSeq: number;
};

type VoteRequestPayload = {
  term: number;
  candidateId: string;
  candidateUrl: string;
  lastSeq: number;
};

type OperationsPayload = {
  hostId: string;
  term: number;
  role: ClusterRole;
  lastSeq: number;
  operations: ClusterOperation[];
};

type SnapshotOperationPayload = {
  snapshot: AppSnapshot;
};

type DiscoveryPayload = {
  app: 'apolloon';
  version: 1;
  hostId: string;
  url: string;
  term: number;
  role: ClusterRole;
  lastSeq: number;
};

type HelloPayload = DiscoveryPayload;

const enabled = isClusterEnabled(process.env);
const selfUrl = normalizeUrl(process.env.CLUSTER_SELF_URL || hostInfo().url);
const selfHost = hostInfo().hostIpHint;
const selfPort = hostInfo().port;
const minVotingMembers = readPositiveInt(process.env.CLUSTER_MIN_HOSTS, 3);
const heartbeatMs = readPositiveInt(process.env.CLUSTER_HEARTBEAT_MS, 250);
const electionMinMs = readPositiveInt(process.env.CLUSTER_ELECTION_MIN_MS, 900);
const electionJitterMs = readPositiveInt(process.env.CLUSTER_ELECTION_JITTER_MS, 500);
const discoveryEnabled = process.env.CLUSTER_DISCOVERY !== 'false';
const discoveryPort = readPositiveInt(process.env.CLUSTER_DISCOVERY_PORT, 45737);
const discoveryAddress = process.env.CLUSTER_DISCOVERY_ADDRESS || '255.255.255.255';
const discoveryIntervalMs = readPositiveInt(process.env.CLUSTER_DISCOVERY_INTERVAL_MS, 1_000);
const startupDiscoveryGraceMs = readPositiveInt(process.env.CLUSTER_STARTUP_GRACE_MS, 2_000);
const scanEnabled = process.env.CLUSTER_SCAN !== 'false';
const scanIntervalMs = readPositiveInt(process.env.CLUSTER_SCAN_INTERVAL_MS, 30_000);
const scanTimeoutMs = readPositiveInt(process.env.CLUSTER_SCAN_TIMEOUT_MS, 250);
const scanConcurrency = readPositiveInt(process.env.CLUSTER_SCAN_CONCURRENCY, 16);
const clusterRequestTimeoutMs = readPositiveInt(process.env.CLUSTER_REQUEST_TIMEOUT_MS, 1_000);
const leaderProxyTimeoutMs = readPositiveInt(process.env.CLUSTER_PROXY_TIMEOUT_MS, 5_000);
const peerRetryBaseMs = readPositiveInt(process.env.CLUSTER_PEER_RETRY_MS, 2_000);
const scanPorts = readScanPorts(process.env.CLUSTER_SCAN_PORTS, selfPort);
const peers = new Map<string, PeerState>();
const strippedProxyResponseHeaders = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

let role: ClusterRole = enabled ? 'candidate' : 'standalone';
let hostId: string | null = null;
let currentTerm = 0;
let leaderId: string | null = null;
let leaderUrl: string | null = null;
let lastLeaderSeenAt: number | null = null;
let electionDeadlineAt = nextElectionDeadline();
let tickHandle: NodeJS.Timeout | null = null;
let discoverySocket: dgram.Socket | null = null;
let discoveryHandle: NodeJS.Timeout | null = null;
let scanHandle: NodeJS.Timeout | null = null;
let initializedAt = Date.now();
let electionPromise: Promise<void> | null = null;
let heartbeatPromise: Promise<void> | null = null;
let pullPromise: Promise<void> | null = null;
let pullAgain = false;
let scanPromise: Promise<void> | null = null;
let replicationCheckpointNeeded = false;

for (const peerUrl of (process.env.CLUSTER_PEERS || '').split(',')) {
  const url = normalizeUrl(peerUrl);
  if (!url || url === selfUrl) continue;
  peers.set(url, {
    id: null,
    url,
    reachable: false,
    lastSeenAt: null,
    lastSeq: null,
    consecutiveFailures: 0,
    nextProbeAt: 0,
  });
}

export function clusterStatus(): ClusterStatus {
  ensureClusterInitialized();
  const votingMembers = peers.size + 1;
  const quorumSize = Math.floor(votingMembers / 2) + 1;
  const enoughMembers = votingMembers >= minVotingMembers;
  const failoverHint = !enabled
    ? null
    : votingMembers === 1
      ? 'Single host mode. Start Apolloon on two more host laptops for automatic failover.'
      : !enoughMembers
        ? `Automatic failover needs ${minVotingMembers} host laptops; ${votingMembers} found.`
      : role === 'leader'
        ? null
        : leaderId
          ? null
          : 'No active leader detected yet.';

  return {
    enabled,
    hostId: hostId || 'uninitialized',
    role,
    term: currentTerm,
    leaderId,
    leaderUrl,
    writable: isWritable(),
    quorumSize,
    votingMembers,
    lastAppliedSeq: getLastClusterOperationSeq(),
    lastLeaderSeenAt,
    failoverHint,
    peers: [...peers.values()].map(toClusterPeer),
  };
}

export function assertWritable(): void {
  ensureClusterInitialized();
  if (isWritable()) return;
  const status = clusterStatus();
  const leader = status.leaderUrl ? ` Current leader: ${status.leaderUrl}` : '';
  throw new Error(`This host is ${status.role} and cannot accept writes.${leader}`);
}

export function recordLocalWrite(type: string): void {
  ensureClusterInitialized();
  if (!enabled) return;
  if (!isWritable()) return;
  if (![...peers.values()].some((peer) => peer.reachable)) {
    replicationCheckpointNeeded = true;
    return;
  }
  appendSnapshotOperation(type);
}

function appendSnapshotOperation(type: string): void {
  appendClusterOperation({
    id: uuidv4(),
    term: currentTerm,
    originHostId: hostId || 'unknown',
    type,
    payload: { snapshot: appSnapshot() },
  });
  replicationCheckpointNeeded = false;
}

export function registerClusterRoutes(app: Express): void {
  app.get('/api/cluster/status', (_req, res) => {
    res.json(clusterStatus());
  });

  if (!enabled) {
    app.use('/api/cluster', (_req, res) => {
      res.status(404).json({ ok: false, error: 'cluster mode is disabled' });
    });
    return;
  }

  app.get('/api/cluster/hello', (_req, res) => {
    ensureClusterInitialized();
    res.json(discoveryPayload() satisfies HelloPayload);
  });

  app.get('/api/cluster/operations', (req, res) => {
    ensureClusterInitialized();
    res.json({
      hostId: hostId || 'uninitialized',
      term: currentTerm,
      role,
      lastSeq: getLastClusterOperationSeq(),
      operations: getClusterOperationsAfter(Number(req.query.after || 0)),
    } satisfies OperationsPayload);
  });

  app.get('/api/cluster/snapshot', (_req, res) => {
    ensureClusterInitialized();
    res.json({
      hostId: hostId || 'uninitialized',
      term: currentTerm,
      lastSeq: getLastClusterOperationSeq(),
      snapshot: appSnapshot(),
    });
  });

  app.post('/api/cluster/heartbeat', asyncJson(async (req, res) => {
    ensureClusterInitialized();
    const payload = req.body as Partial<HeartbeatPayload>;
    if (!payload.leaderId || !payload.leaderUrl || typeof payload.term !== 'number') {
      res.status(400).json({ ok: false, error: 'invalid heartbeat' });
      return;
    }
    if (!isRemoteLeaderPreferred(payload.term, payload.leaderId)) {
      res.status(409).json({ ok: false, term: currentTerm, hostId: hostId || 'uninitialized' });
      return;
    }
    stepDown(payload.term, payload.leaderId, normalizeUrl(payload.leaderUrl));
    touchPeer(payload.leaderUrl, payload.leaderId, payload.lastSeq ?? null);
    res.json({ ok: true, term: currentTerm, hostId: hostId || 'uninitialized', lastSeq: getLastClusterOperationSeq() });
    await pullFromLeader();
  }));

  app.post('/api/cluster/request-vote', asyncJson(async (req, res) => {
    ensureClusterInitialized();
    const payload = req.body as Partial<VoteRequestPayload>;
    if (!payload.candidateId || !payload.candidateUrl || typeof payload.term !== 'number') {
      res.status(400).json({ voteGranted: false, term: currentTerm, hostId });
      return;
    }
    if (payload.term < currentTerm) {
      res.json({ voteGranted: false, term: currentTerm, hostId: hostId || 'uninitialized' });
      return;
    }
    if (payload.term > currentTerm) {
      stepDown(payload.term, null, null);
      setClusterVotedFor(null);
    }
    const votedFor = getClusterVotedFor();
    const candidateIsCaughtUp = (payload.lastSeq ?? 0) >= getLastClusterOperationSeq();
    const voteGranted = shouldGrantVote({
      candidateTerm: payload.term,
      currentTerm,
      currentLeaderId: leaderId,
      candidateId: payload.candidateId,
      votedFor,
      candidateIsCaughtUp,
    });
    if (voteGranted) {
      setClusterVotedFor(payload.candidateId);
      touchPeer(payload.candidateUrl, payload.candidateId, payload.lastSeq ?? null);
      resetElectionDeadline();
    }
    res.json({ voteGranted, term: currentTerm, hostId: hostId || 'uninitialized' });
  }));
}

export async function proxyFollowerTrpcWrites(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  ensureClusterInitialized();
  if (!enabled || role === 'leader' || req.method !== 'POST' || !leaderUrl || leaderId === hostId) {
    next();
    return;
  }

  try {
    const response = await fetch(`${leaderUrl}${req.originalUrl}`, {
      method: req.method,
      headers: {
        'content-type': req.headers['content-type'] || 'application/json',
        ...(req.headers.accept ? { accept: req.headers.accept } : {}),
        ...(req.headers['trpc-accept'] ? { 'trpc-accept': String(req.headers['trpc-accept']) } : {}),
      },
      body: JSON.stringify(req.body ?? {}),
      signal: AbortSignal.timeout(leaderProxyTimeoutMs),
    });
    res.status(response.status);
    response.headers.forEach((value, key) => {
      if (!strippedProxyResponseHeaders.has(key.toLowerCase())) res.setHeader(key, value);
    });
    res.send(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    res.status(503).json({
      error: {
        message: err instanceof Error ? err.message : 'leader proxy failed',
        data: { code: 'SERVICE_UNAVAILABLE', leaderUrl },
      },
    });
  }
}

export function startClusterService(): void {
  ensureClusterInitialized();
  if (!enabled || tickHandle) return;
  startDiscovery();
  startLanScan();
  scheduleClusterTick();
}

function scheduleClusterTick(): void {
  const idleSingleHost = role === 'leader' && peers.size === 0;
  const delayMs = idleSingleHost ? Math.max(heartbeatMs, 1_000) : heartbeatMs;
  tickHandle = setTimeout(() => {
    tickHandle = null;
    promoteSingleHostAfterGrace();
    if (role === 'leader') {
      if (peers.size > 0) void sendHeartbeats();
    } else if (Date.now() >= electionDeadlineAt) {
      void startElection();
    }
    scheduleClusterTick();
  }, delayMs);
}

function isWritable(): boolean {
  return !enabled || role === 'leader';
}

function ensureClusterInitialized(): void {
  if (hostId) return;
  hostId = ensureHostId();
  currentTerm = getClusterTerm();
  replicationCheckpointNeeded = hasPersistedAppState();
  initializedAt = Date.now();
  if (enabled && process.env.CLUSTER_BOOTSTRAP_LEADER === 'true') {
    role = 'leader';
    leaderId = hostId;
    leaderUrl = selfUrl;
    lastLeaderSeenAt = Date.now();
  }
}

function startDiscovery(): void {
  if (!discoveryEnabled || discoverySocket) return;
  discoverySocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  discoverySocket.on('message', (message) => {
    try {
      const payload = JSON.parse(message.toString('utf8')) as Partial<DiscoveryPayload>;
      if (payload.app !== 'apolloon' || payload.version !== 1) return;
      if (!payload.hostId || !payload.url || payload.hostId === hostId) return;
      touchPeer(payload.url, payload.hostId, payload.lastSeq ?? null);
      if (
        payload.role === 'leader' &&
        typeof payload.term === 'number' &&
        isRemoteLeaderPreferred(payload.term, payload.hostId)
      ) {
        stepDown(payload.term, payload.hostId, normalizeUrl(payload.url));
      }
    } catch {
      // Ignore unrelated UDP broadcasts on the event network.
    }
  });

  discoverySocket.on('error', (err) => {
    console.warn('Cluster discovery disabled:', err.message);
    discoverySocket?.close();
    discoverySocket = null;
    if (discoveryHandle) clearInterval(discoveryHandle);
    discoveryHandle = null;
  });

  discoverySocket.bind(discoveryPort, () => {
    discoverySocket?.setBroadcast(true);
    broadcastDiscovery();
    discoveryHandle = setInterval(broadcastDiscovery, discoveryIntervalMs);
  });
}

function startLanScan(): void {
  if (!scanEnabled || scanHandle) return;
  void scanForPeers();
  scanHandle = setInterval(() => {
    void scanForPeers();
  }, scanIntervalMs);
}

async function scanForPeers(): Promise<void> {
  if (scanPromise) return scanPromise;
  scanPromise = scanForPeersOnce().finally(() => {
    scanPromise = null;
  });
  return scanPromise;
}

async function scanForPeersOnce(): Promise<void> {
  if (!hostId) return;
  const reachablePeerCount = [...peers.values()].filter((peer) => peer.reachable).length;
  if (reachablePeerCount >= Math.max(1, minVotingMembers - 1)) return;
  const urls = scanCandidateUrls();
  let nextIndex = 0;
  const workerCount = Math.min(scanConcurrency, urls.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < urls.length) {
        const url = urls[nextIndex];
        nextIndex += 1;
        try {
          const payload = await getJson<Partial<HelloPayload>>(`${url}/api/cluster/hello`, scanTimeoutMs);
          if (payload.app !== 'apolloon' || payload.version !== 1) continue;
          if (!payload.hostId || !payload.url || payload.hostId === hostId) continue;
          touchPeer(payload.url, payload.hostId, payload.lastSeq ?? null);
          if (
            payload.role === 'leader' &&
            typeof payload.term === 'number' &&
            isRemoteLeaderPreferred(payload.term, payload.hostId)
          ) {
            stepDown(payload.term, payload.hostId, normalizeUrl(payload.url));
          }
        } catch {
          // Most addresses on a /24 will not run Apolloon.
        }
      }
    })
  );
}

function scanCandidateUrls(): string[] {
  const hosts = process.env.CLUSTER_SCAN_HOSTS
    ? process.env.CLUSTER_SCAN_HOSTS.split(',').map((host) => host.trim()).filter(Boolean)
    : sameSubnetHosts(selfHost);
  const urls = new Set<string>();
  for (const host of hosts) {
    for (const port of scanPorts) {
      const url = normalizeUrl(`${host}:${port}`);
      if (url && url !== selfUrl) urls.add(url);
    }
  }
  return [...urls];
}

function sameSubnetHosts(address: string): string[] {
  if (address === 'localhost' || address.startsWith('127.')) return ['127.0.0.1'];
  const parts = address.split('.');
  if (parts.length !== 4) return [];
  const prefix = parts.slice(0, 3).join('.');
  return Array.from({ length: 254 }, (_item, index) => `${prefix}.${index + 1}`).filter(
    (host) => host !== address
  );
}

function broadcastDiscovery(): void {
  if (!discoverySocket || !hostId) return;
  const payload = discoveryPayload();
  const message = Buffer.from(JSON.stringify(payload), 'utf8');
  discoverySocket.send(message, discoveryPort, discoveryAddress);
}

function discoveryPayload(): DiscoveryPayload {
  return {
    app: 'apolloon',
    version: 1,
    hostId: hostId || 'unknown',
    url: selfUrl,
    term: currentTerm,
    role,
    lastSeq: getLastClusterOperationSeq(),
  };
}

function promoteSingleHostAfterGrace(): void {
  if (role !== 'candidate' || peers.size > 0 || Date.now() - initializedAt < startupDiscoveryGraceMs) return;
  role = 'leader';
  leaderId = hostId;
  leaderUrl = selfUrl;
  lastLeaderSeenAt = Date.now();
}

function startElection(): Promise<void> {
  if (electionPromise) return electionPromise;
  electionPromise = runElection().finally(() => {
    electionPromise = null;
  });
  return electionPromise;
}

async function runElection(): Promise<void> {
  resetElectionDeadline();
  const votingMembers = peers.size + 1;
  if (votingMembers < 2) {
    return;
  }

  role = 'candidate';
  currentTerm += 1;
  setClusterTerm(currentTerm);
  setClusterVotedFor(hostId || null);
  leaderId = null;
  leaderUrl = null;
  let votes = 1;
  const quorumSize = Math.floor(votingMembers / 2) + 1;
  const payload: VoteRequestPayload = {
    term: currentTerm,
    candidateId: hostId || 'unknown',
    candidateUrl: selfUrl,
    lastSeq: getLastClusterOperationSeq(),
  };

  await Promise.all([...peers.values()].map(async (peer) => {
    try {
      const response = await postJson<{ voteGranted: boolean; term: number; hostId?: string }>(
        `${peer.url}/api/cluster/request-vote`,
        payload
      );
      touchPeer(peer.url, response.hostId ?? peer.id, null);
      if (response.term > currentTerm) {
        stepDown(response.term, null, null);
        return;
      }
      if (response.voteGranted) votes += 1;
    } catch {
      markPeerUnreachable(peer);
    }
  }));

  if (role === 'candidate' && votes >= quorumSize) {
    role = 'leader';
    leaderId = hostId;
    leaderUrl = selfUrl;
    lastLeaderSeenAt = Date.now();
    setClusterVotedFor(null);
    await sendHeartbeats();
    return;
  }
  resetElectionDeadline();
}

function sendHeartbeats(): Promise<void> {
  if (heartbeatPromise) return heartbeatPromise;
  heartbeatPromise = sendHeartbeatsOnce().finally(() => {
    heartbeatPromise = null;
  });
  return heartbeatPromise;
}

async function sendHeartbeatsOnce(): Promise<void> {
  const payload: HeartbeatPayload = {
    term: currentTerm,
    leaderId: hostId || 'unknown',
    leaderUrl: selfUrl,
    lastSeq: getLastClusterOperationSeq(),
  };
  const now = Date.now();
  const peersToProbe = [...peers.values()].filter((peer) => peer.reachable || peer.nextProbeAt <= now);
  await Promise.all(peersToProbe.map(async (peer) => {
    try {
      const response = await postJson<{ ok: boolean; term: number; hostId?: string; lastSeq?: number }>(
        `${peer.url}/api/cluster/heartbeat`,
        payload
      );
      touchPeer(peer.url, response.hostId ?? peer.id, response.lastSeq ?? null);
      if (response.term > currentTerm) stepDown(response.term, null, null);
    } catch {
      markPeerUnreachable(peer);
    }
  }));
}

function pullFromLeader(): Promise<void> {
  if (pullPromise) {
    pullAgain = true;
    return pullPromise;
  }
  pullPromise = drainLeaderPulls().finally(() => {
    pullPromise = null;
  });
  return pullPromise;
}

async function drainLeaderPulls(): Promise<void> {
  do {
    pullAgain = false;
    await pullFromLeaderOnce();
  } while (pullAgain);
}

async function pullFromLeaderOnce(): Promise<void> {
  const requestedLeaderUrl = leaderUrl;
  const requestedLeaderId = leaderId;
  if (!requestedLeaderUrl || requestedLeaderId === hostId) return;
  try {
    const localSeq = getLastClusterOperationSeq();
    const payload = await getJson<OperationsPayload>(
      `${requestedLeaderUrl}/api/cluster/operations?after=${encodeURIComponent(String(localSeq))}`
    );
    if (leaderUrl !== requestedLeaderUrl || leaderId !== requestedLeaderId || role === 'leader') return;
    if (payload.hostId !== requestedLeaderId || payload.role !== 'leader') {
      throw new Error('cluster operation source is not the active leader');
    }
    if (payload.term > currentTerm) {
      currentTerm = payload.term;
      setClusterTerm(currentTerm);
    }
    for (const operation of payload.operations) {
      const lastAppliedSeq = getLastClusterOperationSeq();
      if (operation.seq <= lastAppliedSeq) continue;
      const operationPayload = operation.payload as Partial<SnapshotOperationPayload>;
      if (operation.seq !== lastAppliedSeq + 1 && !operationPayload.snapshot) {
        throw new Error(`cluster operation gap: expected ${lastAppliedSeq + 1}, received ${operation.seq}`);
      }
      applyClusterOperation(operation);
    }
    touchPeer(requestedLeaderUrl, payload.hostId, payload.lastSeq);
  } catch {
    const peer = peers.get(requestedLeaderUrl);
    if (peer) markPeerUnreachable(peer);
  }
}

function applyClusterOperation(operation: ClusterOperation): void {
  const payload = operation.payload as Partial<SnapshotOperationPayload>;
  if (payload.snapshot) {
    applySnapshot(payload.snapshot);
    emitRealtime({ type: 'bootstrap', payload: appSnapshot() });
  }
  appendClusterOperation({
    seq: operation.seq,
    id: operation.id,
    term: operation.term,
    originHostId: operation.originHostId,
    type: operation.type,
    payload: operation.payload,
    createdAt: operation.createdAt,
    appliedAt: Date.now(),
  });
}

function stepDown(term: number, nextLeaderId: string | null, nextLeaderUrl: string | null): void {
  if (term > currentTerm) {
    currentTerm = term;
    setClusterTerm(currentTerm);
    setClusterVotedFor(null);
  }
  role = 'follower';
  leaderId = nextLeaderId;
  leaderUrl = nextLeaderUrl;
  lastLeaderSeenAt = nextLeaderId ? Date.now() : lastLeaderSeenAt;
  resetElectionDeadline();
}

function isRemoteLeaderPreferred(term: number, remoteLeaderId: string): boolean {
  return shouldAcceptRemoteLeader({
    currentTerm,
    remoteTerm: term,
    role,
    hostId,
    leaderId,
    remoteLeaderId,
  });
}

function touchPeer(url: string, id: string | null, lastSeq: number | null): void {
  const normalizedUrl = normalizeUrl(url);
  if (!normalizedUrl || normalizedUrl === selfUrl) return;
  const peer = peers.get(normalizedUrl) || {
    id: null,
    url: normalizedUrl,
    reachable: false,
    lastSeenAt: null,
    lastSeq: null,
    consecutiveFailures: 0,
    nextProbeAt: 0,
  };
  peer.id = id ?? peer.id;
  peer.reachable = true;
  peer.lastSeenAt = Date.now();
  peer.lastSeq = lastSeq ?? peer.lastSeq;
  peer.consecutiveFailures = 0;
  peer.nextProbeAt = 0;
  peers.set(normalizedUrl, peer);
  if (role === 'leader' && replicationCheckpointNeeded) {
    appendSnapshotOperation('cluster.checkpoint');
  }
}

function markPeerUnreachable(peer: PeerState): void {
  peer.reachable = false;
  peer.consecutiveFailures += 1;
  const retryMs =
    peer.lastSeenAt === null
      ? Math.min(peerRetryBaseMs, 250)
      : Math.min(peerRetryBaseMs * 2 ** Math.min(peer.consecutiveFailures - 1, 4), 30_000);
  peer.nextProbeAt = Date.now() + retryMs;
}

function nextElectionDeadline(): number {
  return Date.now() + electionMinMs + Math.floor(Math.random() * electionJitterMs);
}

function resetElectionDeadline(): void {
  electionDeadlineAt = nextElectionDeadline();
}

function normalizeUrl(url: unknown): string {
  const text = String(url || '').trim().replace(/\/+$/, '');
  if (!text) return '';
  return /^https?:\/\//i.test(text) ? text : `http://${text}`;
}

function readPositiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function readScanPorts(value: unknown, fallback: number): number[] {
  const ports = String(value || '')
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65536);
  return ports.length ? [...new Set(ports)] : [fallback];
}

function toClusterPeer(peer: PeerState): ClusterPeer {
  return {
    id: peer.id,
    url: peer.url,
    reachable: peer.reachable,
    lastSeenAt: peer.lastSeenAt,
    lastSeq: peer.lastSeq,
  };
}

function asyncJson(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    handler(req, res).catch((err) => {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'cluster error' });
    });
  };
}

async function getJson<T>(url: string, timeoutMs = clusterRequestTimeoutMs): Promise<T> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status}`);
  return response.json() as Promise<T>;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(clusterRequestTimeoutMs),
  });
  if (!response.ok) throw new Error(`POST ${url} failed: ${response.status}`);
  return response.json() as Promise<T>;
}
