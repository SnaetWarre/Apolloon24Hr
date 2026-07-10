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
  getLastClusterOperationSeq,
  setClusterTerm,
  setClusterVotedFor,
  type ClusterOperation,
} from './db.js';
import { hostInfo } from './host.js';
import { emitRealtime } from './realtime.js';
import type { AppSnapshot, ClusterPeer, ClusterRole, ClusterStatus } from '../shared/schemas.js';

type PeerState = {
  id: string | null;
  url: string;
  reachable: boolean;
  lastSeenAt: number | null;
  lastSeq: number | null;
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

const enabled =
  process.env.CLUSTER_ENABLED === 'true' ||
  process.env.APOLLOON_CLUSTER === 'true' ||
  (process.env.NODE_ENV === 'production' &&
    process.env.CLUSTER_ENABLED !== 'false' &&
    process.env.APOLLOON_CLUSTER !== 'false');
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
const scanIntervalMs = readPositiveInt(process.env.CLUSTER_SCAN_INTERVAL_MS, 3_000);
const scanTimeoutMs = readPositiveInt(process.env.CLUSTER_SCAN_TIMEOUT_MS, 250);
const scanPorts = readScanPorts(process.env.CLUSTER_SCAN_PORTS, selfPort);
const peers = new Map<string, PeerState>();

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

for (const peerUrl of (process.env.CLUSTER_PEERS || '').split(',')) {
  const url = normalizeUrl(peerUrl);
  if (!url || url === selfUrl) continue;
  peers.set(url, { id: null, url, reachable: false, lastSeenAt: null, lastSeq: null });
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
  appendClusterOperation({
    id: uuidv4(),
    term: currentTerm,
    originHostId: hostId || 'unknown',
    type,
    payload: { snapshot: appSnapshot() },
  });
  void replicateToPeers();
}

export function registerClusterRoutes(app: Express): void {
  app.get('/api/cluster/status', (_req, res) => {
    res.json(clusterStatus());
  });

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
    const voteGranted = candidateIsCaughtUp && (!votedFor || votedFor === payload.candidateId);
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
      },
      body: JSON.stringify(req.body ?? {}),
    });
    res.status(response.status);
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() !== 'content-encoding') res.setHeader(key, value);
    });
    res.send(await response.text());
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
  tickHandle = setInterval(() => {
    promoteSingleHostAfterGrace();
    if (role === 'leader') {
      void sendHeartbeats();
      return;
    }
    if (Date.now() >= electionDeadlineAt) {
      void startElection();
    }
  }, heartbeatMs);
}

function isWritable(): boolean {
  return !enabled || role === 'leader';
}

function ensureClusterInitialized(): void {
  if (hostId) return;
  hostId = ensureHostId();
  currentTerm = getClusterTerm();
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
  if (!hostId) return;
  const urls = scanCandidateUrls();
  await Promise.all(urls.map(async (url) => {
    try {
      const payload = await getJson<Partial<HelloPayload>>(`${url}/api/cluster/hello`, scanTimeoutMs);
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
      // Most addresses on a /24 will not run Apolloon.
    }
  }));
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

async function startElection(): Promise<void> {
  const votingMembers = peers.size + 1;
  if (votingMembers < 2) {
    resetElectionDeadline();
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
      peer.reachable = false;
    }
  }));

  if (role === 'candidate' && votes >= quorumSize) {
    role = 'leader';
    leaderId = hostId;
    leaderUrl = selfUrl;
    lastLeaderSeenAt = Date.now();
    setClusterVotedFor(null);
    await sendHeartbeats();
    await replicateToPeers();
    return;
  }
  resetElectionDeadline();
}

async function sendHeartbeats(): Promise<void> {
  const payload: HeartbeatPayload = {
    term: currentTerm,
    leaderId: hostId || 'unknown',
    leaderUrl: selfUrl,
    lastSeq: getLastClusterOperationSeq(),
  };
  await Promise.all([...peers.values()].map(async (peer) => {
    try {
      const response = await postJson<{ ok: boolean; term: number; hostId?: string; lastSeq?: number }>(
        `${peer.url}/api/cluster/heartbeat`,
        payload
      );
      touchPeer(peer.url, response.hostId ?? peer.id, response.lastSeq ?? null);
      if (response.term > currentTerm) stepDown(response.term, null, null);
    } catch {
      peer.reachable = false;
    }
  }));
}

async function replicateToPeers(): Promise<void> {
  if (role !== 'leader') return;
  await Promise.all([...peers.values()].map(async (peer) => {
    try {
      const status = await getJson<OperationsPayload>(
        `${peer.url}/api/cluster/operations?after=${encodeURIComponent(String(peer.lastSeq || 0))}`
      );
      touchPeer(peer.url, status.hostId, status.lastSeq);
    } catch {
      peer.reachable = false;
    }
  }));
}

async function pullFromLeader(): Promise<void> {
  if (!leaderUrl || leaderId === hostId) return;
  try {
    const localSeq = getLastClusterOperationSeq();
    const payload = await getJson<OperationsPayload>(
      `${leaderUrl}/api/cluster/operations?after=${encodeURIComponent(String(localSeq))}`
    );
    if (payload.term > currentTerm) {
      currentTerm = payload.term;
      setClusterTerm(currentTerm);
    }
    for (const operation of payload.operations) {
      applyClusterOperation(operation);
    }
    touchPeer(leaderUrl, payload.hostId, payload.lastSeq);
  } catch {
    const peer = peers.get(leaderUrl);
    if (peer) peer.reachable = false;
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
  if (term > currentTerm) return true;
  if (term < currentTerm) return false;
  if (role !== 'leader') return true;
  return Boolean(hostId && remoteLeaderId < hostId);
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
  };
  peer.id = id ?? peer.id;
  peer.reachable = true;
  peer.lastSeenAt = Date.now();
  peer.lastSeq = lastSeq ?? peer.lastSeq;
  peers.set(normalizedUrl, peer);
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

async function getJson<T>(url: string, timeoutMs?: number): Promise<T> {
  const response = await fetch(url, {
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status}`);
  return response.json() as Promise<T>;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`POST ${url} failed: ${response.status}`);
  return response.json() as Promise<T>;
}
