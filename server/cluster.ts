import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Express, NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import type { ClusterMemberStatus, ClusterStatus, GroupState, NearbyGroup } from '../shared/schemas.js';
import { backupStatus } from './backups.js';
import { setClusterClockOffset } from './clock.js';
import {
  appendRequestSchema,
  currentLeader,
  currentRole,
  currentTerm,
  finishJoining,
  handleAppend,
  handleVoteRequest,
  isLeader,
  isResyncing,
  lastLeaderContact,
  lastResyncProblem,
  leaderAlive,
  leaderGroupView,
  majority,
  members,
  resyncFrom,
  startConsensus,
  startJoining,
  stopConsensus,
  takeOverAlone,
  voteRequestSchema,
  COMMIT_TIMEOUT_MS,
  ELECTION_TIMEOUT_MS,
} from './consensus.js';
import {
  DATABASE_SCHEMA_VERSION,
  countRunners,
  getClusterMembers,
  getLogHead,
  getSetting,
  hostIdentity,
  keepOnlyClusterMember,
  recordWrite,
  removeClusterMember,
  saveClusterMember,
  serializeDatabase,
  setLocalSetting,
  type ClusterMember,
} from './db.js';
import { currentUrl, heardLaptops, startDiscovery, stopDiscovery } from './discovery.js';
import { APP_VERSION, isClusterEnabled, readPositiveInt } from './env.js';
import { acceptPeerSocket, closePeerSockets, refusal, refuseUpgrade, type PeerAnswer } from './peer-socket.js';
import {
  isIsolated,
  joinUrl,
  normalizeUrl,
  peerFetch,
  readPeerError,
  selfUrl,
  setIsolated,
  versionMismatchMessage,
  versionRefusal,
} from './peers.js';

/*
 * The laptops in a group agree on one leader by majority vote
 * (consensus.ts). This module is the rest: the endpoints between laptops,
 * joining a group, passing writes made on any laptop to the leader, and the
 * status the screens show.
 */

const enabled = isClusterEnabled();
/** How long a write may take while the laptops choose a new leader. */
const WRITE_DEADLINE_MS = readPositiveInt(process.env.CLUSTER_WRITE_DEADLINE_MS, 12_000);
const MAINTENANCE_MS = 5_000;
const MAX_KNOWN_PEERS = 16;
/** A laptop without a leader this long says so plainly instead of "taking over". */
const ELECTING_GRACE_MS = ELECTION_TIMEOUT_MS * 5;

let joining = false;
let lastError: string | null = null;
/** Durations here run on the monotonic clock, like consensus, so a clock correction cannot stretch or skip them. */
let startedAt = performance.now();
let maintenanceTimer: NodeJS.Timeout | null = null;

function selfMember(): ClusterMember {
  return { hostId: hostIdentity().hostId, url: selfUrl() };
}

function busy(): ClusterStatus['busy'] {
  return joining ? 'joining' : isResyncing() ? 'resyncing' : null;
}

export function clusterStatus(): ClusterStatus {
  const identity = hostIdentity();
  const leader = enabled ? currentLeader() : selfMember();
  const writable = !busy() && leaderAlive();
  const view = new Map(leaderGroupView().map((member) => [member.hostId, member]));
  const group = members();
  const memberStatuses: ClusterMemberStatus[] = group.map((member) => {
    const isSelf = member.hostId === identity.hostId;
    const isLeader = leader?.hostId === member.hostId;
    const seen = view.get(member.hostId);
    return {
      hostId: member.hostId,
      url: isSelf ? selfUrl() : member.url,
      self: isSelf,
      leader: isLeader && writable,
      reachable: isSelf || (isLeader ? writable : Boolean(seen?.reachable)),
      caughtUp: (isLeader && writable) || Boolean(seen?.caughtUp) || group.length === 1,
    };
  });
  return {
    enabled,
    hostId: identity.hostId,
    clusterId: identity.clusterId,
    appVersion: APP_VERSION,
    schemaVersion: DATABASE_SCHEMA_VERSION,
    role: enabled ? currentRole() : 'leader',
    term: currentTerm(),
    state: groupState(writable, memberStatuses),
    leader: writable ? leader : null,
    members: memberStatuses,
    majority: majority(),
    writable,
    busy: busy(),
    selfUrl: selfUrl(),
    logHead: getLogHead().seq,
    memberUrls: [...new Set(memberStatuses.filter((member) => !member.self).map((member) => member.url))],
    nearby: enabled ? nearbyGroups(new Set(group.map((member) => member.hostId))) : [],
    lastError: lastError ?? lastResyncProblem(),
    backup: backupStatus(),
  };
}

/** Other groups heard on the network, one entry each; laptops of this group's own lineage rejoin by themselves. */
function nearbyGroups(ownMembers: Set<string>): NearbyGroup[] {
  const clusterId = hostIdentity().clusterId;
  const groups = new Map<string, NearbyGroup & { throughLeader: boolean }>();
  for (const beacon of heardLaptops()) {
    if (ownMembers.has(beacon.hostId) || beacon.clusterId === clusterId) continue;
    const known = groups.get(beacon.clusterId);
    const compatible = beacon.appVersion === APP_VERSION && beacon.schemaVersion === DATABASE_SCHEMA_VERSION;
    groups.set(beacon.clusterId, {
      url: known && (known.throughLeader || !beacon.leader) ? known.url : beacon.url,
      throughLeader: Boolean(known?.throughLeader || beacon.leader),
      laptops: Math.max(known?.laptops ?? 0, beacon.groupSize),
      runners: Math.max(known?.runners ?? 0, beacon.runners),
      appVersion: beacon.appVersion,
      compatible: (known?.compatible ?? true) && compatible,
    });
  }
  return [...groups.values()]
    .map(({ throughLeader: _throughLeader, ...group }) => group)
    .sort((a, b) => b.runners - a.runners || a.url.localeCompare(b.url));
}

function groupState(writable: boolean, statuses: ClusterMemberStatus[]): GroupState {
  if (!enabled || statuses.length === 1) return writable ? 'solo' : 'electing';
  if (!writable) {
    const since = Math.max(lastLeaderContact() ?? 0, startedAt);
    return performance.now() - since < ELECTING_GRACE_MS ? 'electing' : 'no-majority';
  }
  return statuses.every((member) => member.reachable && member.caughtUp) ? 'healthy' : 'degraded';
}

/** Throws when this laptop cannot commit a write itself right now. */
export function assertWritable(): void {
  if (!isLeader()) throw new Error('De laptops nemen net van elkaar over. Probeer opnieuw.');
  if (busy()) throw new Error('Deze laptop wordt gekoppeld of bijgewerkt. Probeer zo opnieuw.');
}

export const NO_LEADER_MESSAGE =
  'Niet opgeslagen: er zijn te weinig laptops bereikbaar. Controleer of de andere laptops aan staan en aan het netwerk hangen.';

export const NOT_CONFIRMED_MESSAGE =
  'Niet bevestigd: deze wijziging staat nog niet op een tweede laptop. Controleer of de andere laptops aan staan en probeer opnieuw.';

export function writeDeadline(): number {
  return performance.now() + WRITE_DEADLINE_MS;
}

/**
 * Where a write made on this laptop goes: here, to the leader, or nowhere
 * because no leader turned up before `deadline`. Waiting covers an election,
 * so a press during a takeover goes through instead of failing.
 */
export async function writeTarget(deadline: number): Promise<'self' | ClusterMember | null> {
  for (;;) {
    if (!busy() && leaderAlive()) return isLeader() ? 'self' : (currentLeader() ?? 'self');
    if (performance.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export function newRequestId(): string {
  return crypto.randomUUID();
}

type ForwardOutcome<T> = { ok: true; data: T } | { ok: false; code: string; message: string; retry: boolean };

/**
 * Passes a write made on this laptop's screen to the leader, then waits until
 * this laptop's copy has it, so the screen shows the result at once. When the
 * leader goes away or hands over meanwhile, the outcome says to retry: the
 * request id makes sure a repeat is applied only once.
 */
export async function forwardWrite<T>(
  leader: ClusterMember,
  path: string,
  input: unknown,
  requestId: string,
  origin: string
): Promise<ForwardOutcome<T>> {
  const retry = (message: string): ForwardOutcome<T> => ({
    ok: false,
    code: 'SERVICE_UNAVAILABLE',
    message,
    retry: true,
  });
  const abort = new AbortController();
  // Stop waiting as soon as another laptop takes over; the repeat goes there.
  const watch = setInterval(() => {
    if (currentLeader()?.hostId !== leader.hostId || isLeader()) abort.abort();
  }, 50);
  let response: globalThis.Response;
  try {
    response = await peerFetch(`${leader.url}/trpc/${path}`, {
      method: 'POST',
      body: input,
      headers: {
        'x-apolloon-forwarded': '1',
        'x-apolloon-request-id': requestId,
        'x-apolloon-origin': encodeURIComponent(origin),
      },
      timeoutMs: COMMIT_TIMEOUT_MS + 1_000,
      signal: abort.signal,
    });
  } catch {
    return retry(NO_LEADER_MESSAGE);
  } finally {
    clearInterval(watch);
  }
  // A tRPC error is the leader's answer to the write; a laptop that no longer leads answers
  // with a plain `{ code, error }` instead, and the write goes to the next leader.
  const payload = (await response.json().catch(() => null)) as {
    result?: { data?: T };
    error?: { message?: string; data?: { code?: string } } | string;
  } | null;
  if (payload?.error && typeof payload.error === 'object') {
    const code = payload.error.data?.code ?? 'INTERNAL_SERVER_ERROR';
    const message = payload.error.message ?? 'Opslaan mislukt';
    return { ok: false, code, message, retry: code === 'SERVICE_UNAVAILABLE' };
  }
  if (!response.ok || !payload?.result) return retry(NO_LEADER_MESSAGE);
  await waitForLocalSeq(Number(response.headers.get('x-apolloon-log-seq') || 0));
  return { ok: true, data: payload.result.data as T };
}

async function waitForLocalSeq(seq: number): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (getLogHead().seq < seq && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function registerClusterRoutes(app: Express): void {
  app.get('/api/cluster/status', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    // A screen whose laptop stopped answering asks the others whether they lost it too (useFailover.ts).
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(clusterStatus());
  });
  if (!enabled) return;

  if (process.env.NODE_ENV === 'test' && process.env.CLUSTER_TEST_FAULTS === 'true') {
    // Simulates a pulled network cable: requests from other laptops (they carry a version header) fail.
    app.post('/api/cluster/test/isolate', (req, res) => {
      setIsolated(Boolean(req.body?.isolated));
      if (isIsolated()) closePeerSockets();
      res.json({ ok: true, isolated: isIsolated() });
    });
    app.use((req, res, next) => {
      if (isIsolated() && req.header('x-apolloon-app-version')) sendPeerError(res, 503, 'isolated', 'isolated');
      else next();
    });
  }

  app.use(['/api/cluster/snapshot', '/api/cluster/members'], requireSameVersion);
  // A forwarded write that reaches a laptop that no longer leads is refused before anything runs, so it can be repeated.
  app.use('/trpc', (req, res, next) => {
    if (req.header('x-apolloon-forwarded') === '1' && (!isLeader() || busy())) {
      sendPeerError(res, 409, 'not_leader', 'Deze laptop is niet de hoofdlaptop.');
    } else next();
  });

  app.get('/api/cluster/snapshot', (_req, res) => {
    if (!isLeader() || busy()) {
      sendPeerError(res, 409, 'not_leader', 'Deze laptop is niet de hoofdlaptop.');
      return;
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Apolloon-Epoch', String(currentTerm()));
    res.end(serializeDatabase());
  });

  app.post('/api/cluster/members', (req, res) => {
    const request = z
      .object({ hostId: z.string().min(1).max(128), url: z.string().min(1).max(2_048) })
      .safeParse(req.body);
    const url = request.success ? normalizeUrl(request.data.url) : '';
    if (!request.success || !url) {
      sendPeerError(res, 400, 'invalid_request', 'Ongeldige koppelaanvraag.');
      return;
    }
    if (!isLeader() || busy()) {
      sendPeerError(res, 409, 'not_leader', 'Deze laptop is niet de hoofdlaptop.');
      return;
    }
    addMember({ hostId: request.data.hostId, url });
    res.json({ ok: true, term: currentTerm() });
  });
}

/** The socket another laptop sends appends and votes over (peer-socket.ts). */
export function handlePeerUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const header = (name: string) => [req.headers[name]].flat()[0];
  const mismatch = versionRefusal(header('x-apolloon-app-version'), header('x-apolloon-schema-version'));
  if (!enabled) refuseUpgrade(socket, 404, 'not_found', 'Laptops koppelen staat uit op deze installatie.');
  else if (isIsolated()) refuseUpgrade(socket, 503, 'isolated', 'isolated');
  else if (mismatch) refuseUpgrade(socket, 426, 'upgrade_required', mismatch);
  else acceptPeerSocket(req, socket, head, answerPeer);
}

function answerPeer(type: unknown, body: unknown): PeerAnswer {
  if (type === 'append') {
    const request = appendRequestSchema.safeParse(body);
    if (!request.success || request.data.clusterId !== hostIdentity().clusterId) {
      return refusal('cluster_mismatch', 'Deze laptops horen bij een andere groep.');
    }
    return { body: handleAppend(request.data) };
  }
  if (type === 'vote') {
    const request = voteRequestSchema.safeParse(body);
    if (!request.success) return refusal('invalid_request', 'Ongeldige stemaanvraag.');
    welcomeBack(request.data.candidateId, request.data.candidateUrl, request.data.clusterId);
    return { body: handleVoteRequest(request.data) };
  }
  return refusal('invalid_request', 'Onbekende aanvraag.');
}

function requireSameVersion(req: Request, res: Response, next: NextFunction): void {
  const mismatch = versionRefusal(req.header('x-apolloon-app-version'), req.header('x-apolloon-schema-version'));
  if (mismatch) sendPeerError(res, 426, 'upgrade_required', mismatch);
  else next();
}

function sendPeerError(res: Response, status: number, code: string, error: string): void {
  res.status(status).json({ ok: false, code, error });
}

/**
 * Adds a laptop to the group, or records its new address; a replicated write.
 * A laptop whose app data was wiped comes back with a new host id, usually at
 * its old address. Its old id can never answer again, so it is replaced in
 * the same write; otherwise the group would count a fourth laptop and need
 * three for a majority. An old id that still announces itself elsewhere (its
 * address went to another laptop) is a live laptop and stays.
 */
function addMember(member: ClusterMember): void {
  recordWrite('cluster.addMember', () => {
    const self = selfMember();
    const stored = getClusterMembers().find((existing) => existing.hostId === self.hostId);
    if (stored?.url !== self.url) saveClusterMember(self);
    for (const old of members()) {
      if (old.url === member.url && old.hostId !== member.hostId && old.hostId !== self.hostId) {
        removeClusterMember(old.hostId);
      }
    }
    saveClusterMember(member);
  });
}

/**
 * A laptop asking for votes while this one leads is either back after being
 * left out (for example after "continue alone") or has a new address. The
 * leader takes it (back) in; it then catches up or re-syncs by itself.
 */
function welcomeBack(hostId: string, url: string, clusterId: string): void {
  if (!isLeader() || busy() || clusterId !== hostIdentity().clusterId || hostId === hostIdentity().hostId) return;
  const address = normalizeUrl(url);
  const known = members().find((member) => member.hostId === hostId);
  if (address && known?.url !== address) addMember({ hostId, url: address });
}

/** Joins the group of the laptop at `rawUrl`, replacing this laptop's data with the group's. */
export async function joinGroup(rawUrl: string): Promise<{ backupFile: string | null }> {
  if (!enabled) throw new Error('Laptops koppelen staat uit op deze installatie.');
  const url = joinUrl(rawUrl);
  if (!url || url === selfUrl()) throw new Error('Vul het adres van een andere laptop in.');
  if (busy()) throw new Error('Deze laptop wordt al gekoppeld of bijgewerkt.');
  joining = true;
  startJoining();
  let joined: Parameters<typeof finishJoining>[0] = null;
  try {
    const status = await fetchStatus(url).catch(() => {
      throw new Error(`${url} is niet bereikbaar. Controleer het adres en de kabel.`);
    });
    if (!status.enabled) throw new Error('Op die laptop staat laptops koppelen uit.');
    if (status.hostId === hostIdentity().hostId) throw new Error('Dat adres is deze laptop zelf.');
    if (status.appVersion !== APP_VERSION || status.schemaVersion !== DATABASE_SCHEMA_VERSION) {
      throw new Error(versionMismatchMessage(status.appVersion));
    }
    const leader = status.leader;
    if (!leader) throw new Error('Die laptops kiezen net een hoofdlaptop. Probeer het zo opnieuw.');
    const leaderUrl = leader.hostId === status.hostId ? url : leader.url;
    const response = await peerFetch(`${leaderUrl}/api/cluster/members`, {
      method: 'POST',
      body: selfMember(),
      timeoutMs: 10_000,
    });
    if (!response.ok) throw new Error((await readPeerError(response)).error || 'Koppelen mislukt.');
    const { term } = z.object({ term: z.number().int().nonnegative() }).parse(await response.json());
    await resyncFrom(leaderUrl, 'pre-join');
    joined = { term, leader: { hostId: leader.hostId, url: leaderUrl } };
    lastError = null;
    return { backupFile: backupStatus().latest?.fileName ?? null };
  } finally {
    finishJoining(joined);
    joining = false;
  }
}

/**
 * Makes this laptop a group of one when the others are gone for good. Only
 * allowed when no majority can be reached. Laptops that come back later are
 * taken in again by themselves; what they had that this one lacks stays in
 * their backup.
 */
export function continueAlone(): { ok: true } {
  if (!enabled || isLeader()) throw new Error('Deze laptop werkt al.');
  if (clusterStatus().state !== 'no-majority') {
    throw new Error('Er zijn nog genoeg laptops bereikbaar; die kiezen zelf een hoofdlaptop.');
  }
  takeOverAlone();
  recordWrite('cluster.continueAlone', () => keepOnlyClusterMember(hostIdentity().hostId));
  lastError = null;
  return { ok: true };
}

// Laptops that once belonged to the group are remembered, also after "continue alone", so two
// groups that each went on alone find each other again: the smaller one re-syncs from the larger.

function knownPeers(): Record<string, string> {
  try {
    const parsed = z
      .record(z.string(), z.string())
      .safeParse(JSON.parse(getSetting('cluster_known_peers_json') || '{}'));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function rememberPeers(): void {
  const { hostId: selfId, clusterId } = hostIdentity();
  const current = knownPeers();
  const next = { ...current };
  for (const member of members()) if (member.hostId !== selfId) next[member.hostId] = member.url;
  for (const beacon of heardLaptops()) if (beacon.clusterId === clusterId) next[beacon.hostId] = beacon.url;
  const entries = Object.entries(next).slice(-MAX_KNOWN_PEERS);
  if (JSON.stringify(entries) !== JSON.stringify(Object.entries(current))) {
    setLocalSetting('cluster_known_peers_json', JSON.stringify(Object.fromEntries(entries)));
  }
}

async function maintain(): Promise<void> {
  rememberPeers();
  if (!isLeader() || busy()) return;
  const self = selfMember();
  const stored = getClusterMembers();
  // The leader's address changed (a new DHCP lease): tell the group.
  if (stored.length && stored.find((member) => member.hostId === self.hostId)?.url !== self.url) addMember(self);
  // Another laptop announces a new address: store it, so it also holds when announcements stop.
  for (const member of stored) {
    const announced = currentUrl(member.hostId, member.url);
    if (member.hostId !== self.hostId && announced !== member.url) addMember({ hostId: member.hostId, url: announced });
  }

  const group = new Set(members().map((member) => member.hostId));
  const identity = hostIdentity();
  for (const [hostId, url] of Object.entries(knownPeers())) {
    if (group.has(hostId)) continue;
    const status = await fetchStatus(url).catch(() => null);
    if (!status?.enabled || status.clusterId !== identity.clusterId || status.role !== 'leader') continue;
    if (!isLeader() || !otherGroupWins(status)) continue;
    try {
      await joinGroup(url);
      lastError = `Deze laptop werkte even apart en volgt nu weer de groep van ${url}. Wat ze apart bewaarde, staat in een backup.`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    return;
  }
}

/** Of two groups that went on separately, the one with more laptops, then the later term, carries on. */
function otherGroupWins(other: ClusterStatus): boolean {
  const own = members().length;
  if (other.members.length !== own) return other.members.length > own;
  if (other.term !== currentTerm()) return other.term > currentTerm();
  return other.hostId > hostIdentity().hostId;
}

async function fetchStatus(url: string): Promise<ClusterStatus> {
  const response = await peerFetch(`${url}/api/cluster/status`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as ClusterStatus;
}

export function startClusterService(): void {
  const storedOffset = Number(getSetting('cluster_clock_offset_ms') || 0);
  setClusterClockOffset(Number.isFinite(storedOffset) ? storedOffset : 0);
  if (!enabled) return;
  startedAt = performance.now();
  startConsensus();
  startDiscovery(() => {
    const identity = hostIdentity();
    return {
      hostId: identity.hostId,
      clusterId: identity.clusterId,
      appVersion: APP_VERSION,
      schemaVersion: DATABASE_SCHEMA_VERSION,
      leader: isLeader() && leaderAlive(),
      groupSize: members().length,
      runners: countRunners(),
    };
  });
  maintenanceTimer = setInterval(() => void maintain().catch(() => undefined), MAINTENANCE_MS);
  maintenanceTimer.unref();
}

export function stopClusterService(): void {
  stopConsensus();
  closePeerSockets();
  stopDiscovery();
  if (maintenanceTimer) clearInterval(maintenanceTimer);
  maintenanceTimer = null;
}
