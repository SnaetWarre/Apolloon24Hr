import type { Express, NextFunction, Request, Response } from 'express';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import path from 'node:path';
import { isIP } from 'node:net';
import {
  acknowledgeReplicationVector,
  applyRemoteReplicationOperations,
  databaseReadiness,
  ensureReplicationIdentity,
  getAllReplicationOperations,
  getOpenReplicationConflictCount,
  getPendingReplicationOperationCount,
  getReplicationCheckpoint,
  getReplicationConflicts,
  getReplicationOperationsMissing,
  getReplicationVector,
  getSetting,
  getTimingControllerGeneration,
  installReplicationBootstrap,
  type ReplicationCheckpoint,
  type ReplicationConflict,
  type ReplicationIdentity,
  type ReplicationOperation,
} from './db.js';
import { appSnapshot } from './app-state.js';
import { backupStatus, createVerifiedBackup } from './backups.js';
import {
  currentLanNetworkEndpoints,
  hostInfo,
  PUBLIC_APP_PORT,
} from './host.js';
import { emitRealtime } from './realtime.js';
import {
  appSnapshotSchema,
  type AppSnapshot,
  type ClusterCompatibility,
  type ClusterPeer,
  type ClusterStatus,
  type TimingControlStatus,
} from '../shared/schemas.js';
import {
  normalizeOperationVector,
  secureEqual,
  signDiscoveryPayload,
  verifyDiscoveryPayload,
  type DiscoveryPayload,
  type OperationVector,
} from './cluster-protocol.js';
import { isClusterEnabled } from './cluster-policy.js';
import { encodedJsonRequest, sendJson } from './http-json.js';
import {
  CLUSTER_PROTOCOL_VERSION,
  clusterCompatibilityError,
  localClusterCompatibility,
  parseClusterCompatibility,
} from './cluster-compatibility.js';

type PeerState = {
  id: string | null;
  url: string;
  reachable: boolean;
  lastSeenAt: number | null;
  vector: OperationVector;
  consecutiveFailures: number;
  nextProbeAt: number;
  unreachableSinceAt: number | null;
  clockSkewMs: number | null;
  compatibility: ClusterCompatibility | null;
  compatibilityError: string | null;
  candidateUrls: Map<string, number>;
  probeController: AbortController | null;
};

type ExchangePayload = {
  protocol: number;
  compatibility: ClusterCompatibility;
  clusterId: string;
  hostId: string;
  url: string;
  vector: OperationVector;
  operations: ReplicationOperation[];
  sentAt: number;
};

type BootstrapPayload = {
  protocol: number;
  compatibility: ClusterCompatibility;
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
const configuredSelfUrl = normalizeUrl(process.env.CLUSTER_SELF_URL);
const discoveryEnabled = process.env.CLUSTER_DISCOVERY !== 'false';
const discoveryPort = readPositiveInt(process.env.CLUSTER_DISCOVERY_PORT, 45737);
const configuredDiscoveryAddress =
  process.env.CLUSTER_DISCOVERY_ADDRESS?.trim() || null;
const discoveryIntervalMs = readPositiveInt(process.env.CLUSTER_DISCOVERY_INTERVAL_MS, 1_000);
const syncIntervalMs = readPositiveInt(process.env.CLUSTER_SYNC_INTERVAL_MS, 350);
const requestTimeoutMs = readPositiveInt(process.env.CLUSTER_REQUEST_TIMEOUT_MS, 1_500);
const peerRetryBaseMs = readPositiveInt(process.env.CLUSTER_PEER_RETRY_MS, 750);
const timingTakeoverGraceMs = readPositiveInt(
  process.env.TIMING_TAKEOVER_GRACE_MS,
  10_000
);
const timingForcedTakeoverGraceMs = Math.max(
  timingTakeoverGraceMs,
  readPositiveInt(process.env.TIMING_FORCED_TAKEOVER_GRACE_MS, 30_000)
);
const peers = new Map<string, PeerState>();

let discoverySocket: dgram.Socket | null = null;
let discoveryHandle: NodeJS.Timeout | null = null;
let syncHandle: NodeJS.Timeout | null = null;
let syncPromise: Promise<void> | null = null;
let identityCache: ReplicationIdentity | null = null;
let joinInProgress = false;
let clusterStartedAt = Date.now();
let clusterStopping = false;

for (const peerUrl of (process.env.CLUSTER_PEERS || '').split(',')) {
  addPeer(peerUrl);
}

export function clusterStatus(): ClusterStatus {
  const identity = currentIdentity();
  const peerList = [...peers.values()];
  const reachable = peerList.filter((peer) => peer.reachable);
  const compatibility = currentCompatibility();
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
    compatibility,
    incompatiblePeerCount: peerList.filter((peer) => peer.compatibilityError).length,
    writable: true,
    connectedHosts: 1 + reachable.length,
    knownHosts: 1 + peerList.length,
    pendingOperations: getPendingReplicationOperationCount(),
    conflictCount: getOpenReplicationConflictCount(),
    timingControllerHostId: getSetting('timing_controller_host_id'),
    timingControl: timingControlStatus(),
    clockSkewMs: skewSamples.length
      ? Math.max(...skewSamples.map((value) => Math.abs(value)))
      : null,
    lastAppliedSeq: Object.values(localVector).reduce((total, seq) => total + seq, 0),
    peers: peerList.map((peer) => toClusterPeer(peer, localVector)),
    backup: backupStatus(),
  };
}

export function timingControlStatus(): TimingControlStatus {
  const identity = currentIdentity();
  const controllerHostId = getSetting('timing_controller_host_id');
  const generation = getTimingControllerGeneration();
  if (!controllerHostId) {
    return {
      state: 'unassigned',
      controllerHostId: null,
      generation,
      controllerUrl: null,
      controllerLastSeenAt: null,
      localReplicaCaughtUp: true,
      takeoverAllowed: true,
      takeoverAvailableAt: null,
      forcedTakeoverAllowed: false,
      forcedTakeoverAvailableAt: null,
    };
  }
  if (controllerHostId === identity.hostId) {
    return {
      state: 'local',
      controllerHostId,
      generation,
      controllerUrl: currentSelfUrl(),
      controllerLastSeenAt: Date.now(),
      localReplicaCaughtUp: true,
      takeoverAllowed: false,
      takeoverAvailableAt: null,
      forcedTakeoverAllowed: false,
      forcedTakeoverAvailableAt: null,
    };
  }

  const controllerPeer = [...peers.values()].find(
    (peer) => peer.id === controllerHostId
  );
  const localReplicaCaughtUp = Boolean(
    controllerPeer && vectorCovers(getReplicationVector(), controllerPeer.vector)
  );
  if (controllerPeer?.reachable) {
    return {
      state: 'remote-reachable',
      controllerHostId,
      generation,
      controllerUrl: controllerPeer.url,
      controllerLastSeenAt: controllerPeer.lastSeenAt,
      localReplicaCaughtUp,
      takeoverAllowed: false,
      takeoverAvailableAt: null,
      forcedTakeoverAllowed: false,
      forcedTakeoverAvailableAt: null,
    };
  }

  const unreachableSince =
    controllerPeer?.unreachableSinceAt ||
    controllerPeer?.lastSeenAt ||
    clusterStartedAt;
  const takeoverAvailableAt = enabled
    ? unreachableSince + timingTakeoverGraceMs
    : Date.now();
  const forcedTakeoverAvailableAt = enabled
    ? unreachableSince + timingForcedTakeoverGraceMs
    : Date.now();
  return {
    state: 'remote-unreachable',
    controllerHostId,
    generation,
    controllerUrl: controllerPeer?.url || null,
    controllerLastSeenAt: controllerPeer?.lastSeenAt || null,
    localReplicaCaughtUp,
    takeoverAllowed: localReplicaCaughtUp && Date.now() >= takeoverAvailableAt,
    takeoverAvailableAt,
    forcedTakeoverAllowed:
      !localReplicaCaughtUp && Date.now() >= forcedTakeoverAvailableAt,
    forcedTakeoverAvailableAt,
  };
}

export function assertEmergencyTimingTakeoverAllowed(
  expectedControllerHostId: string | null,
  force: boolean
): void {
  const currentControllerHostId = getSetting('timing_controller_host_id');
  if (currentControllerHostId !== expectedControllerHostId) {
    throw new Error('De timingtoewijzing is intussen gewijzigd. Vernieuw de status.');
  }
  const status = timingControlStatus();
  if (status.state === 'unassigned' || status.state === 'local') return;
  if (status.state === 'remote-reachable') {
    throw new Error(
      'De huidige timinglaptop is nog bereikbaar. Draag de timing daar gecontroleerd over.'
    );
  }
  if (status.takeoverAllowed || (force && status.forcedTakeoverAllowed)) return;
  if (!status.localReplicaCaughtUp) {
    const seconds = Math.max(
      1,
      Math.ceil(
        ((status.forcedTakeoverAvailableAt || Date.now()) - Date.now()) / 1_000
      )
    );
    throw new Error(
      status.forcedTakeoverAllowed
        ? 'De lokale replica is niet zeker volledig. Bevestig een geforceerde noodovername.'
        : `De lokale replica mist mogelijk timingdata. Wacht nog ${seconds} seconden of herstel de verbinding.`
    );
  }
  if (!status.takeoverAllowed) {
    const seconds = Math.max(
      1,
      Math.ceil(((status.takeoverAvailableAt || Date.now()) - Date.now()) / 1_000)
    );
    throw new Error(`Wacht nog ${seconds} seconden voor een noodovername.`);
  }
}

export function assertTimingTransferAllowed(targetHostId: string): void {
  const identity = currentIdentity();
  const currentControllerHostId = getSetting('timing_controller_host_id');
  if (getOpenReplicationConflictCount() > 0) {
    throw new Error('Los eerst het synchronisatieconflict op.');
  }
  if (currentControllerHostId !== identity.hostId) {
    throw new Error('Alleen de huidige timinglaptop kan een geplande overdracht starten.');
  }
  const target = [...peers.values()].find((peer) => peer.id === targetHostId);
  if (!target?.reachable) {
    throw new Error('De gekozen laptop is niet bereikbaar.');
  }
  if (!vectorCovers(target.vector, getReplicationVector())) {
    throw new Error('De gekozen laptop is nog niet volledig gesynchroniseerd. Wacht even.');
  }
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

  app.get('/api/cluster/bootstrap', asyncJson(async (req, res) => {
    const identity = currentIdentity();
    if (!validPairingCode(req.query.code, identity.clusterSecret)) {
      res.status(401).json({ ok: false, error: 'ongeldige koppelcode' });
      return;
    }
    const requesterCompatibility = compatibilityFromQuery(req);
    const compatibilityIssue = clusterCompatibilityError(
      requesterCompatibility,
      currentCompatibility()
    );
    if (compatibilityIssue) {
      res.status(426).json({
        ok: false,
        code: 'UPGRADE_REQUIRED',
        error: compatibilityIssue,
        compatibility: currentCompatibility(),
      });
      return;
    }
    await sendJson(req, res, {
      protocol: CLUSTER_PROTOCOL_VERSION,
      compatibility: currentCompatibility(),
      clusterId: identity.clusterId,
      clusterSecret: identity.clusterSecret,
      hostId: identity.hostId,
      url: currentSelfUrl(),
      snapshot: appSnapshot(),
      checkpoint: getReplicationCheckpoint(),
      operations: getAllReplicationOperations(),
      conflicts: getReplicationConflicts('all'),
      timingControllerHostId: getSetting('timing_controller_host_id'),
    } satisfies BootstrapPayload, { sensitive: true });
  }));

  app.post('/api/cluster/join', asyncJson(async (req, res) => {
    if (joinInProgress) {
      res.status(409).json({ ok: false, error: 'koppeling is al bezig' });
      return;
    }
    const remoteUrl = normalizeUrl(req.body?.remoteUrl);
    const code = String(req.body?.pairingCode || '').trim().toUpperCase();
    if (!remoteUrl || remoteUrl === currentSelfUrl() || !code) {
      res.status(400).json({ ok: false, error: 'vul een geldige laptop-URL en koppelcode in' });
      return;
    }

    joinInProgress = true;
    try {
      const response = await fetch(
        `${remoteUrl}/api/cluster/bootstrap?code=${encodeURIComponent(code)}&compatibility=${encodeURIComponent(JSON.stringify(currentCompatibility()))}`,
        { signal: AbortSignal.timeout(Math.max(requestTimeoutMs, 10_000)) }
      );
      if (!response.ok) {
        const reason = await response.text();
        const remoteError = responseErrorMessage(reason);
        throw new Error(
          response.status === 401
            ? 'De koppelcode klopt niet'
            : remoteError || `De andere laptop antwoordde met ${response.status}: ${reason.slice(0, 160)}`
        );
      }
      const payload = (await response.json()) as Partial<BootstrapPayload>;
      const remoteCompatibility = parseClusterCompatibility(payload.compatibility);
      const compatibilityIssue =
        payload.protocol === CLUSTER_PROTOCOL_VERSION
          ? clusterCompatibilityError(remoteCompatibility, currentCompatibility())
          : clusterCompatibilityError(remoteCompatibility, currentCompatibility()) ||
            `Upgrade vereist: clusterprotocol ${String(payload.protocol)} past niet bij ${CLUSTER_PROTOCOL_VERSION}.`;
      if (compatibilityIssue) throw new Error(compatibilityIssue);
      const parsedSnapshot = appSnapshotSchema.safeParse(payload.snapshot);
      if (
        payload.protocol !== CLUSTER_PROTOCOL_VERSION ||
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
      await createVerifiedBackup('pre-cluster-join');
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
      const joinedPeer = addPeer(payload.url || remoteUrl);
      if (joinedPeer) {
        joinedPeer.id = payload.hostId;
        joinedPeer.compatibility = remoteCompatibility;
        joinedPeer.compatibilityError = null;
      }
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
    const peerUrl = normalizeUrl(payload.url);
    const remoteCompatibility = parseClusterCompatibility(payload.compatibility);
    const compatibilityIssue = clusterCompatibilityError(
      remoteCompatibility,
      currentCompatibility()
    );
    if (
      payload.protocol !== CLUSTER_PROTOCOL_VERSION ||
      compatibilityIssue
    ) {
      res.status(426).json({
        ok: false,
        code: 'UPGRADE_REQUIRED',
        error:
          compatibilityIssue ||
          `Upgrade vereist: clusterprotocol ${String(payload.protocol)} past niet bij ${CLUSTER_PROTOCOL_VERSION}.`,
        compatibility: currentCompatibility(),
      });
      return;
    }
    if (
      payload.clusterId !== identity.clusterId ||
      typeof payload.hostId !== 'string' ||
      !payload.hostId ||
      payload.hostId.length > 128 ||
      !peerUrl ||
      !payload.vector ||
      !Array.isArray(payload.operations) ||
      typeof payload.sentAt !== 'number' ||
      !Number.isSafeInteger(payload.sentAt)
    ) {
      res.status(409).json({ ok: false, error: 'cluster or protocol mismatch' });
      return;
    }

    const vector = normalizeOperationVector(payload.vector);
    if (!vector) {
      res.status(409).json({ ok: false, error: 'invalid operation vector' });
      return;
    }
    if (joinInProgress) {
      res.status(503).json({ ok: false, error: 'cluster join in progress' });
      return;
    }
    if (payload.hostId === identity.hostId) {
      res.status(409).json({ ok: false, error: 'peer uses this host identity' });
      return;
    }
    const result = applyRemoteReplicationOperations(payload.operations);
    const peer = touchPeer(
      incomingPeerUrl(peerUrl, req.socket.remoteAddress),
      payload.hostId,
      vector,
      true,
      remoteCompatibility
    );
    peer.clockSkewMs = payload.sentAt - Date.now();
    acknowledgeReplicationVector(payload.hostId, vector);
    if (result.applied > 0 || result.conflicts > 0) {
      emitRealtime({ type: 'state:revision', payload: Date.now() });
    }

    const localVector = getReplicationVector();
    await sendJson(req, res, {
      protocol: CLUSTER_PROTOCOL_VERSION,
      compatibility: currentCompatibility(),
      clusterId: identity.clusterId,
      hostId: identity.hostId,
      url: currentSelfUrl(),
      vector: localVector,
      operations: getReplicationOperationsMissing(vector),
      sentAt: Date.now(),
    } satisfies ExchangePayload, { sensitive: true });
  }));
}

export function startClusterService(): void {
  if (!enabled) return;
  clusterStopping = false;
  clusterStartedAt = Date.now();
  startDiscovery();
  scheduleSync(25);
}

export function stopClusterService(): void {
  clusterStopping = true;
  if (discoveryHandle) clearInterval(discoveryHandle);
  if (syncHandle) clearTimeout(syncHandle);
  discoveryHandle = null;
  syncHandle = null;
  for (const peer of peers.values()) peer.probeController?.abort();
  if (discoverySocket) {
    try {
      discoverySocket.close();
    } catch {
      // The socket may still be between creation and bind during shutdown.
    }
    discoverySocket = null;
  }
}

function startDiscovery(): void {
  if (!discoveryEnabled || discoverySocket || clusterStopping) return;
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  discoverySocket = socket;
  socket.on('error', (error) => {
    console.warn('Cluster discovery error:', error.message);
    if (discoverySocket !== socket) return;
    discoverySocket = null;
    if (discoveryHandle) clearTimeout(discoveryHandle);
    try {
      socket.close();
    } catch {
      // A failed bind can leave the socket already closed.
    }
    discoveryHandle = null;
    if (!clusterStopping) {
      discoveryHandle = setTimeout(startDiscovery, discoveryIntervalMs);
      discoveryHandle.unref?.();
    }
  });
  socket.on('message', (packet) => {
    try {
      const identity = currentIdentity();
      const payload = verifyDiscoveryPayload(
        JSON.parse(packet.toString('utf8')),
        identity.clusterSecret
      );
      if (
        !payload ||
        payload.clusterId !== identity.clusterId ||
        payload.hostId === identity.hostId ||
        !normalizeUrl(payload.url)
      ) {
        return;
      }
      const peer = touchPeer(
        payload.url,
        payload.hostId,
        payload.vector,
        false,
        payload.compatibility
      );
      peer.clockSkewMs = typeof payload.sentAt === 'number' ? payload.sentAt - Date.now() : null;
    } catch {
      // Ignore unrelated UDP traffic on the discovery port.
    }
  });
  socket.bind(discoveryPort, '0.0.0.0', () => {
    if (discoverySocket !== socket || clusterStopping) return;
    try {
      socket.setBroadcast(true);
    } catch {
      // Some test and container networks do not expose broadcast support.
    }
    broadcastDiscovery();
    discoveryHandle = setInterval(broadcastDiscovery, discoveryIntervalMs);
    discoveryHandle.unref?.();
  });
}

function broadcastDiscovery(): void {
  if (!discoverySocket) return;
  for (const target of discoveryTargets()) {
    const message = Buffer.from(
      JSON.stringify(discoveryPayload(target.advertisedUrl))
    );
    discoverySocket.send(
      message,
      discoveryPort,
      target.broadcastAddress,
      (error) => {
        if (error) {
          console.warn(
            `Cluster discovery broadcast to ${target.broadcastAddress} failed:`,
            error.message
          );
        }
      }
    );
  }
}

function discoveryPayload(advertisedUrl = currentSelfUrl()): DiscoveryPayload {
  const identity = currentIdentity();
  return signDiscoveryPayload(
    {
      app: 'apolloon',
      protocol: CLUSTER_PROTOCOL_VERSION,
      compatibility: currentCompatibility(),
      clusterId: identity.clusterId,
      hostId: identity.hostId,
      url: advertisedUrl,
      vector: getReplicationVector(),
      sentAt: Date.now(),
    },
    identity.clusterSecret
  );
}

function discoveryTargets(): Array<{
  broadcastAddress: string;
  advertisedUrl: string;
}> {
  if (configuredDiscoveryAddress) {
    return [
      {
        broadcastAddress: configuredDiscoveryAddress,
        advertisedUrl: currentSelfUrl(),
      },
    ];
  }
  if (configuredSelfUrl || process.env.PUBLIC_HOST) {
    return [
      {
        broadcastAddress: '255.255.255.255',
        advertisedUrl: currentSelfUrl(),
      },
    ];
  }

  const targets = currentLanNetworkEndpoints().map((endpoint) => ({
    broadcastAddress: endpoint.broadcastAddress,
    advertisedUrl: `http://${endpoint.address}:${PUBLIC_APP_PORT}`,
  }));
  return targets.length
    ? targets
    : [
        {
          broadcastAddress: '255.255.255.255',
          advertisedUrl: currentSelfUrl(),
        },
      ];
}

function scheduleSync(delayMs = syncIntervalMs): void {
  if (clusterStopping) return;
  if (syncHandle) clearTimeout(syncHandle);
  syncHandle = setTimeout(() => {
    syncHandle = null;
    void syncAllPeers().finally(() => {
      if (!clusterStopping) scheduleSync();
    });
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
  const probeUrl = peer.url;
  const lastSeenBeforeProbe = peer.lastSeenAt;
  const probeController = new AbortController();
  peer.probeController = probeController;
  const probeIsCurrent = () =>
    !clusterStopping && !joinInProgress &&
    identity === currentIdentity() &&
    peers.get(probeUrl) === peer && peer.url === probeUrl &&
    peer.probeController === probeController && !probeController.signal.aborted;
  const localVector = getReplicationVector();
  const payload: ExchangePayload = {
    protocol: CLUSTER_PROTOCOL_VERSION,
    compatibility: currentCompatibility(),
    clusterId: identity.clusterId,
    hostId: identity.hostId,
    url: currentSelfUrl(),
    vector: localVector,
    operations: getReplicationOperationsMissing(peer.vector),
    sentAt: Date.now(),
  };
  try {
    const encodedPayload = await encodedJsonRequest(payload);
    if (!probeIsCurrent()) return;
    const response = await fetch(`${probeUrl}/api/cluster/sync/exchange`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-apolloon-cluster-secret': identity.clusterSecret,
        ...(encodedPayload.contentEncoding
          ? { 'content-encoding': encodedPayload.contentEncoding }
          : {}),
      },
      body: encodedPayload.body,
      signal: AbortSignal.any([probeController.signal, AbortSignal.timeout(requestTimeoutMs)]),
    });
    if (!response.ok) {
      const responseText = await response.text();
      if (!probeIsCurrent()) return;
      const responseError = responseErrorMessage(responseText);
      if (
        response.status === 426 ||
        /upgrade vereist/i.test(responseError) ||
        (response.status === 409 && /protocol mismatch/i.test(responseError))
      ) {
        peer.compatibilityError =
          response.status === 409
            ? 'Upgrade vereist of verkeerde cluster: de andere laptop herkent dit clusterprotocol niet. Controleer de cluster en werk beide laptops bij.'
            : responseError || 'Upgrade vereist: de andere laptop gebruikt een incompatibele versie.';
      }
      throw new Error(responseError || `sync failed: ${response.status}`);
    }
    const remote = (await response.json()) as ExchangePayload;
    if (!probeIsCurrent()) return;
    const remoteVector = normalizeOperationVector(remote.vector);
    const remoteUrl = normalizeUrl(remote.url);
    const remoteCompatibility = parseClusterCompatibility(remote.compatibility);
    const compatibilityIssue = clusterCompatibilityError(
      remoteCompatibility,
      currentCompatibility()
    );
    if (compatibilityIssue) {
      peer.compatibility = remoteCompatibility;
      peer.compatibilityError = compatibilityIssue;
      throw new Error(compatibilityIssue);
    }
    if (
      remote.protocol !== CLUSTER_PROTOCOL_VERSION ||
      remote.clusterId !== identity.clusterId ||
      typeof remote.hostId !== 'string' ||
      !remote.hostId ||
      remote.hostId.length > 128 ||
      remote.hostId === identity.hostId ||
      (peer.id !== null && remote.hostId !== peer.id) ||
      !remoteUrl ||
      !remoteVector ||
      !Array.isArray(remote.operations) ||
      typeof remote.sentAt !== 'number' ||
      !Number.isSafeInteger(remote.sentAt)
    ) {
      throw new Error('invalid sync response');
    }
    const result = applyRemoteReplicationOperations(remote.operations);
    // The request URL just worked. The peer's preferred interface may be on
    // another network, so its response must not replace this proven route.
    const confirmedPeer = touchPeer(
      probeUrl, remote.hostId, remoteVector, true, remoteCompatibility
    );
    confirmedPeer.clockSkewMs = remote.sentAt - Date.now();
    acknowledgeReplicationVector(remote.hostId, remoteVector);
    if (result.applied > 0 || result.conflicts > 0) {
      emitRealtime({ type: 'state:revision', payload: Date.now() });
    }
  } catch (error) {
    // Rediscovery, joining another cluster, or a newer inbound exchange can
    // supersede this request while fetch/compression is awaiting completion.
    if (!probeIsCurrent() || peer.lastSeenAt !== lastSeenBeforeProbe) return;
    if (peer.consecutiveFailures === 0) {
      console.warn(
        `Cluster sync with ${peer.url} failed:`,
        error instanceof Error ? error.message : String(error)
      );
    }
    if (peer.reachable || peer.unreachableSinceAt === null) {
      peer.unreachableSinceAt = Date.now();
    }
    peer.reachable = false;
    peer.consecutiveFailures += 1;
    peer.nextProbeAt =
      Date.now() + Math.min(10_000, peerRetryBaseMs * 2 ** Math.min(peer.consecutiveFailures - 1, 4));
    const alternateUrl = [...peer.candidateUrls.entries()].find(
      ([url, seenAt]) => url !== probeUrl && Date.now() - seenAt < candidateUrlLifetimeMs()
    )?.[0];
    if (alternateUrl) {
      // Retire this failed route until another announcement refreshes it.
      peer.candidateUrls.delete(probeUrl);
      rekeyPeer(peer, alternateUrl);
    }
  } finally {
    if (peer.probeController === probeController) peer.probeController = null;
  }
}

function addPeer(peerUrl: string): PeerState | null {
  const url = normalizeUrl(peerUrl);
  if (!url || url === currentSelfUrl()) return null;
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
    unreachableSinceAt: Date.now(),
    clockSkewMs: null,
    compatibility: null,
    compatibilityError: null,
    candidateUrls: new Map([[url, Date.now()]]),
    probeController: null,
  };
  peers.set(url, peer);
  return peer;
}

function touchPeer(
  peerUrl: string,
  peerId: string,
  vector: OperationVector,
  reachable = true,
  compatibility?: ClusterCompatibility | null
): PeerState {
  const url = normalizeUrl(peerUrl);
  let peer = [...peers.values()].find((knownPeer) => knownPeer.id === peerId);
  const peerAtUrl = peers.get(url);
  if (!peer) peer = peerAtUrl || addPeer(url) || undefined;
  if (!peer) {
    throw new Error('peer points to this host');
  }
  if (peerAtUrl && peerAtUrl !== peer) {
    peers.delete(peerAtUrl.url);
  }
  const isNewAddress = rememberPeerUrl(peer, url);
  if (reachable || (!peer.reachable && isNewAddress)) rekeyPeer(peer, url);
  peer.id = peerId;
  peer.vector = vector;
  if (compatibility !== undefined) {
    peer.compatibility = compatibility;
    peer.compatibilityError = clusterCompatibilityError(
      compatibility,
      currentCompatibility()
    );
  }
  if (reachable) {
    peer.reachable = peer.compatibilityError === null;
    peer.lastSeenAt = Date.now();
    peer.consecutiveFailures = 0;
    peer.nextProbeAt = 0;
    peer.unreachableSinceAt = null;
  }
  return peer;
}

function rekeyPeer(peer: PeerState, nextUrl: string): void {
  const url = normalizeUrl(nextUrl);
  if (!url || url === currentSelfUrl() || url === peer.url) return;
  peer.probeController?.abort();
  for (const [registeredUrl, registeredPeer] of peers) {
    if (registeredPeer === peer && registeredUrl !== url) peers.delete(registeredUrl);
  }
  peer.url = url;
  peer.reachable = false;
  peer.consecutiveFailures = 0;
  peer.nextProbeAt = 0;
  peers.set(url, peer);
}

function candidateUrlLifetimeMs(): number {
  return Math.max(10_000, discoveryIntervalMs * 5);
}

function rememberPeerUrl(peer: PeerState, url: string): boolean {
  const now = Date.now();
  for (const [candidateUrl, seenAt] of peer.candidateUrls) {
    if (now - seenAt >= candidateUrlLifetimeMs()) peer.candidateUrls.delete(candidateUrl);
  }
  const isNewAddress = !peer.candidateUrls.has(url);
  peer.candidateUrls.delete(url);
  peer.candidateUrls.set(url, now);
  // Bound interface history when DHCP assigns many addresses over a long event.
  if (peer.candidateUrls.size > 8) {
    peer.candidateUrls.delete(peer.candidateUrls.keys().next().value!);
  }
  return isNewAddress;
}

function incomingPeerUrl(advertisedUrl: string, remoteAddress?: string): string {
  const url = new URL(advertisedUrl);
  const sourceAddress = remoteAddress?.replace(/^::ffff:/, '');
  // On the physical LAN, the source address identifies the interface that
  // reached us. Keep configured hostnames/proxies and the advertised port.
  if (isIP(url.hostname) === 4 && sourceAddress && isIP(sourceAddress) === 4) {
    url.hostname = sourceAddress;
  }
  return normalizeUrl(url.toString());
}

function toClusterPeer(
  peer: PeerState,
  localVector: OperationVector
): ClusterPeer {
  return {
    id: peer.id,
    url: peer.url,
    reachable: peer.reachable,
    lastSeenAt: peer.lastSeenAt,
    lastSeq: peer.id ? peer.vector[peer.id] ?? null : null,
    synchronized:
      peer.compatibilityError === null && vectorCovers(peer.vector, localVector),
    operationVector: peer.vector,
    compatibility: peer.compatibility,
    compatibilityError: peer.compatibilityError,
  };
}

function vectorCovers(
  candidate: OperationVector,
  required: OperationVector
): boolean {
  return Object.entries(required).every(
    ([hostId, sequence]) => (candidate[hostId] || 0) >= sequence
  );
}

function authorized(req: Request): boolean {
  return secureEqual(
    req.header('x-apolloon-cluster-secret'),
    currentIdentity().clusterSecret
  );
}

function currentIdentity(): ReplicationIdentity {
  identityCache ??= ensureReplicationIdentity();
  return identityCache;
}

function currentCompatibility(): ClusterCompatibility {
  return localClusterCompatibility(databaseReadiness().schemaVersion);
}

function compatibilityFromQuery(req: Request): ClusterCompatibility | null {
  const encoded = req.query.compatibility;
  if (typeof encoded !== 'string' || encoded.length > 2_048) return null;
  try {
    return parseClusterCompatibility(JSON.parse(encoded));
  } catch {
    return null;
  }
}

function responseErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return typeof parsed.error === 'string' ? parsed.error.slice(0, 500) : '';
  } catch {
    return body.trim().slice(0, 500);
  }
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
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username ||
      url.password
    ) {
      return '';
    }
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function currentSelfUrl(): string {
  return configuredSelfUrl || normalizeUrl(hostInfo().url);
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
