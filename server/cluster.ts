import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Express, NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import type { AutoLinkNote, ClusterMemberStatus, ClusterStatus, GroupState, NearbyGroup } from '../shared/schemas.js';
import { describeAutomaticOrigin } from './activity.js';
import { backupStatus } from './backups.js';
import { clusterNow, setClusterClockOffset } from './clock.js';
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
  logSettled,
  majority,
  members,
  removedBy,
  resyncFrom,
  startConsensus,
  startJoining,
  stopConsensus,
  takeOverAlone,
  voteRequestSchema,
  COMMIT_TIMEOUT_MS,
  ELECTION_TIMEOUT_MS,
  type GroupView,
  type VoteResponse,
} from './consensus.js';
import {
  DATABASE_SCHEMA_VERSION,
  countRunners,
  getAutoLinks,
  getClusterMembers,
  getLogHead,
  getRemovedMembers,
  getSetting,
  hasEventChanges,
  getUnreachableMembers,
  hostIdentity,
  keepOnlyClusterMember,
  logActivity,
  recordWrite,
  removeClusterMember,
  saveAutoLink,
  saveClusterMember,
  serializeDatabase,
  setLocalSetting,
  setRemovedMembers,
  setUnreachableMembers,
  type ClusterMember,
} from './db.js';
import { currentUrl, heardLaptops, startDiscovery, stopDiscovery } from './discovery.js';
import { APP_VERSION, isClusterEnabled, readPositiveInt } from './env.js';
import { hostInfo, LAPTOP_NAME, laptopName } from './host.js';
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
/** A group without runners links with the others on the network by itself; `CLUSTER_AUTO_LINK=false` leaves it to Koppelen. */
const autoLinkEnabled = enabled && process.env.CLUSTER_AUTO_LINK !== 'false';
/** How long a write may take while the laptops choose a new leader. */
const WRITE_DEADLINE_MS = readPositiveInt(process.env.CLUSTER_WRITE_DEADLINE_MS, 12_000);
const MAINTENANCE_MS = 5_000;
const MAX_KNOWN_PEERS = 16;
/** A laptop without a leader this long says so plainly instead of "taking over". */
const ELECTING_GRACE_MS = ELECTION_TIMEOUT_MS * 5;
/** How long a laptop asked to join may take: its own join, a full copy of the data included. */
const INVITE_TIMEOUT_MS = 30_000;
/** A laptop silent this long is listed in Beheer › Activiteit, so a short hiccup stays out of it. */
const UNREACHABLE_LISTED_AFTER_MS = 5_000;
/** A laptop silent this long can be taken out of the group in Beheer › Systeem; a restart or a cable takes less. */
const REMOVABLE_AFTER_MS = readPositiveInt(process.env.CLUSTER_REMOVABLE_AFTER_MS, 30_000);
/** How long to wait for the group to settle before a laptop is taken out of it. */
const SETTLE_TIMEOUT_MS = 3_000;

let joining = false;
let lastError: string | null = null;
/** Rounds in a row that linking by itself through the laptop at `url` failed, and why the last one did. */
let autoLinkFailure: { url: string; rounds: number; message: string } | null = null;
/**
 * A laptop that is starting or shutting down can fail two rounds (it is forgotten ten seconds
 * after its last announcement); the screens say why from the third one on, after 15 s.
 */
const AUTO_LINK_FAILED_ROUNDS_SHOWN = 3;
/** Durations here run on the monotonic clock, like consensus, so a clock correction cannot stretch or skip them. */
let startedAt = performance.now();
let maintenanceTimer: NodeJS.Timeout | null = null;
/** Since when (monotonic) this laptop, leading, has not heard from each other laptop. */
const silentSince = new Map<string, number>();

function selfMember(): ClusterMember {
  return { hostId: hostIdentity().hostId, url: selfUrl(), name: LAPTOP_NAME };
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
  const names = heardNames();
  const nearby = enabled ? nearbyGroups(new Set(group.map((member) => member.hostId))) : [];
  const memberStatuses: ClusterMemberStatus[] = group.map((member) => {
    const isSelf = member.hostId === identity.hostId;
    const isLeader = leader?.hostId === member.hostId;
    const seen = view.get(member.hostId);
    return {
      hostId: member.hostId,
      url: isSelf ? selfUrl() : member.url,
      name: isSelf ? LAPTOP_NAME : (names.get(member.hostId) ?? member.name ?? null),
      self: isSelf,
      leader: isLeader && writable,
      reachable: isSelf || (isLeader ? writable : Boolean(seen?.reachable)),
      caughtUp: (isLeader && writable) || Boolean(seen?.caughtUp) || group.length === 1,
      removable: writable && !isSelf && !isLeader && isRemovable(seen),
    };
  });
  const removedFrom = !writable ? removedBy(ELECTING_GRACE_MS) : null;
  return {
    enabled,
    hostId: identity.hostId,
    hostName: LAPTOP_NAME,
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
    runners: countRunners(),
    changed: hasEventChanges(),
    memberUrls: [...new Set(memberStatuses.filter((member) => !member.self).map((member) => member.url))],
    nearby,
    autoLink: {
      enabled: autoLinkEnabled,
      waiting: autoLinkWaiting(autoLinkPlan(nearby)),
      linked: autoLinkNotes(memberStatuses),
    },
    removedFrom: removedFrom && {
      url: removedFrom.url,
      name: names.get(removedFrom.hostId) ?? group.find((member) => member.hostId === removedFrom.hostId)?.name ?? null,
    },
    lastError: lastError ?? lastResyncProblem(),
    backup: backupStatus(),
  };
}

/** A laptop the leader has not heard from for a while, which may be taken out of the group. */
function isRemovable(seen: GroupView[number] | undefined): boolean {
  return Boolean(seen && !seen.reachable && seen.silentMs >= REMOVABLE_AFTER_MS);
}

/** The computer names laptops announce now, by host id. */
function heardNames(): Map<string, string> {
  const names = new Map<string, string>();
  for (const beacon of heardLaptops()) if (beacon.name) names.set(beacon.hostId, beacon.name);
  return names;
}

/** Other groups heard on the network, one entry each; laptops of this group's own lineage rejoin by themselves. */
function nearbyGroups(ownMembers: Set<string>): NearbyGroup[] {
  const clusterId = hostIdentity().clusterId;
  const own = ownGroup();
  const groups = new Map<string, Omit<NearbyGroup, 'link'> & { throughLeader: boolean }>();
  for (const beacon of heardLaptops()) {
    if (ownMembers.has(beacon.hostId) || beacon.clusterId === clusterId) continue;
    const known = groups.get(beacon.clusterId);
    const compatible = beacon.appVersion === APP_VERSION && beacon.schemaVersion === DATABASE_SCHEMA_VERSION;
    const through = known && (known.throughLeader || !beacon.leader) ? known : { url: beacon.url, name: beacon.name };
    groups.set(beacon.clusterId, {
      url: through.url,
      name: through.name,
      throughLeader: Boolean(known?.throughLeader || beacon.leader),
      laptops: Math.max(known?.laptops ?? 0, beacon.groupSize),
      runners: Math.max(known?.runners ?? 0, beacon.runners),
      changed: Boolean(known?.changed) || beacon.changed,
      appVersion: beacon.appVersion,
      compatible: (known?.compatible ?? true) && compatible,
    });
  }
  return [...groups]
    .map(([otherClusterId, { throughLeader: _throughLeader, ...group }]) => ({
      ...group,
      link: linkDirection(own, {
        clusterId: otherClusterId,
        runners: group.runners,
        changed: group.changed,
        laptops: group.laptops,
      }),
    }))
    .sort((a, b) => b.runners - a.runners || a.url.localeCompare(b.url));
}

type GroupData = { clusterId: string; runners: number; changed: boolean; laptops: number };

function ownGroup(): GroupData {
  return {
    clusterId: hostIdentity().clusterId,
    runners: countRunners(),
    changed: hasEventChanges(),
    laptops: members().length,
  };
}

/**
 * Which way Koppelen links two groups. The one with fewer runners takes the
 * other's data; with as many runners, a group nobody changed yet takes the
 * data of one that someone prepared (labels, logos, settings); then the
 * smaller group does, and then the group id decides. Both sides work this out
 * alike, so a press on both at once links them one way. The other side is
 * only asked to come over (`invite`) while it holds no runners.
 */
export function linkDirection(own: GroupData, other: GroupData): NearbyGroup['link'] {
  const otherKeeps =
    other.runners !== own.runners
      ? other.runners > own.runners
      : other.changed !== own.changed
        ? other.changed
        : other.laptops !== own.laptops
          ? other.laptops > own.laptops
          : other.clusterId < own.clusterId;
  if (otherKeeps) return 'join';
  return other.runners === 0 ? 'invite' : 'there';
}

/**
 * Which group this laptop links with by itself: none while its group holds
 * runners. A group that holds runners comes first; between empty groups,
 * linkDirection picks the same one on both sides, so only one of them moves.
 * Two groups that hold runners are left to a person.
 */
function autoLinkPlan(nearby: NearbyGroup[]): { target: NearbyGroup | null; waiting: string | null } {
  if (!autoLinkEnabled || countRunners() > 0) return { target: null, waiting: null };
  const candidates = nearby.filter((group) => group.compatible && group.link === 'join');
  const withRunners = candidates.filter((group) => group.runners > 0);
  if (withRunners.length > 1) {
    const names = withRunners.map((group) => group.name ?? shortUrl(group.url));
    return {
      target: null,
      waiting: `Niet vanzelf gekoppeld: ${listNames(names)} hebben elk lopers. Druk zelf op Koppelen naast de juiste laptop.`,
    };
  }
  return { target: withRunners[0] ?? candidates[0] ?? null, waiting: null };
}

/** Why this laptop does not link by itself now: two groups with runners, or the last rounds failed. */
function autoLinkWaiting({ target, waiting }: ReturnType<typeof autoLinkPlan>): string | null {
  if (waiting) return waiting;
  const failure = autoLinkFailure;
  if (!target || failure?.url !== target.url || failure.rounds < AUTO_LINK_FAILED_ROUNDS_SHOWN) return null;
  return failure.message;
}

/** The laptops of this group that linked by themselves, by name. */
function autoLinkNotes(statuses: ClusterMemberStatus[]): AutoLinkNote[] {
  const byId = new Map(statuses.map((member) => [member.hostId, member]));
  return getAutoLinks().flatMap((link) => {
    const member = byId.get(link.hostId);
    return member ? [{ ...link, name: member.name ?? shortUrl(member.url), self: member.self }] : [];
  });
}

function pressThereMessage(url: string, otherRunners: number): string {
  const other = shortUrl(url);
  return `Op deze laptop staan ${runnerLabel(countRunners())}, op ${other} ${runnerLabel(otherRunners)}. Druk op Koppelen op ${other}: die neemt dan de gegevens van deze laptop over.`;
}

/** A laptop's address without `http://`, as the screens show it. */
function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, '');
}

/** "A", "A en B", "A, B en C". */
function listNames(names: string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} en ${names.at(-1)}` : (names[0] ?? '');
}

function runnerLabel(count: number): string {
  return `${count} ${count === 1 ? 'loper' : 'lopers'}`;
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

  app.use(['/api/cluster/snapshot', '/api/cluster/members', '/api/cluster/invite'], requireSameVersion);
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
      .object({
        hostId: z.string().min(1).max(128),
        url: z.string().min(1).max(2_048),
        name: z.string().max(256).nullish(),
        /** Set when the laptop links by itself: the laptop it linked with. */
        autoLinkedWith: z.string().max(256).optional(),
      })
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
    addMember({ hostId: request.data.hostId, url, name: laptopName(request.data.name) }, request.data.autoLinkedWith);
    res.json({ ok: true, term: currentTerm() });
  });

  app.post('/api/cluster/invite', (req, res) => {
    const request = z
      .object({
        url: z.string().min(1).max(2_048),
        clusterId: z.string().min(1).max(128),
        autoLinkedWith: z.string().max(256).optional(),
      })
      .safeParse(req.body);
    if (!request.success) {
      sendPeerError(res, 400, 'invalid_request', 'Ongeldige koppelaanvraag.');
      return;
    }
    acceptInvite(request.data.url, request.data.clusterId, request.data.autoLinkedWith).then(
      () => res.json({ ok: true }),
      (error: unknown) => sendPeerError(res, 409, 'refused', error instanceof Error ? error.message : String(error))
    );
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
    const { candidateId, candidateUrl, clusterId } = request.data;
    if (clusterId === hostIdentity().clusterId && wasRemoved(candidateId)) {
      return { body: { term: currentTerm(), granted: false, removed: true } satisfies VoteResponse };
    }
    welcomeBack(candidateId, candidateUrl, clusterId);
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
function addMember(member: ClusterMember, autoLinkedWith?: string): void {
  recordWrite('cluster.addMember', () => {
    const self = selfMember();
    const storedMembers = getClusterMembers();
    const stored = storedMembers.find((existing) => existing.hostId === self.hostId);
    const known = storedMembers.find((existing) => existing.hostId === member.hostId);
    if (stored?.url !== self.url || stored.name !== self.name) saveClusterMember(self);
    for (const old of members()) {
      if (old.url === member.url && old.hostId !== member.hostId && old.hostId !== self.hostId) {
        removeClusterMember(old.hostId);
      }
    }
    saveClusterMember(member);
    const removed = getRemovedMembers();
    if (removed.includes(member.hostId)) setRemovedMembers(removed.filter((hostId) => hostId !== member.hostId));
    if (autoLinkedWith !== undefined) saveAutoLink(member.hostId, autoLinkedWith);
    const name = member.name ?? shortUrl(member.url);
    if (!known) {
      logLaptopActivity(
        'cluster.addMember',
        autoLinkedWith === undefined
          ? `${name} gekoppeld met Koppelen`
          : `${name} vanzelf gekoppeld met ${autoLinkedWith}`
      );
    } else if (known.url !== member.url) {
      logLaptopActivity('cluster.address', `${name} heeft een nieuw adres: ${shortUrl(member.url)}`);
    }
  });
}

/** Lists a change in the group in Beheer › Activiteit, inside the write that makes it. */
function logLaptopActivity(action: string, summary: string, origin?: string): void {
  logActivity({
    occurredAt: clusterNow(),
    action,
    summary,
    origin: origin ?? describeAutomaticOrigin(hostInfo().hostIpHint, LAPTOP_NAME),
  });
}

/**
 * Lists the laptops this laptop, leading, stopped hearing from for five seconds, and the
 * ones that came back. Only with a majority, when the entry can be saved.
 */
function logReachability(): void {
  if (!leaderAlive()) return;
  const now = performance.now();
  const selfId = hostIdentity().hostId;
  const reachable = new Map(leaderGroupView().map((member) => [member.hostId, member.reachable]));
  const listed = getUnreachableMembers();
  const next: string[] = [];
  const changes: string[] = [];
  const group = members();
  for (const member of group) {
    const name = member.hostId === selfId ? LAPTOP_NAME : (member.name ?? shortUrl(member.url));
    if (member.hostId === selfId || reachable.get(member.hostId)) {
      silentSince.delete(member.hostId);
      if (listed.includes(member.hostId)) changes.push(`${name} is weer bereikbaar`);
      continue;
    }
    const since = silentSince.get(member.hostId) ?? now;
    silentSince.set(member.hostId, since);
    if (listed.includes(member.hostId)) next.push(member.hostId);
    else if (now - since >= UNREACHABLE_LISTED_AFTER_MS) {
      next.push(member.hostId);
      changes.push(`${name} is niet bereikbaar`);
    }
  }
  for (const hostId of silentSince.keys())
    if (!group.some((member) => member.hostId === hostId)) silentSince.delete(hostId);
  if (!changes.length && next.length === listed.length) return;
  recordWrite('cluster.reachability', () => {
    setUnreachableMembers(next);
    for (const summary of changes) logLaptopActivity('cluster.reachability', summary);
  });
}

/**
 * A laptop asking for votes while this one leads is either back after being
 * left out (for example after "continue alone") or has a new address. The
 * leader takes it (back) in; it then catches up or re-syncs by itself. A
 * laptop the crew took out of the group on purpose never gets here
 * (answerPeer): it was broken, and taking it back in by itself would make the
 * group bigger again, so the next failure could stop all saving.
 */
function welcomeBack(hostId: string, url: string, clusterId: string): void {
  if (!isLeader() || busy() || clusterId !== hostIdentity().clusterId || hostId === hostIdentity().hostId) return;
  const address = normalizeUrl(url);
  const known = members().find((member) => member.hostId === hostId);
  if (address && known?.url !== address) addMember({ hostId, url: address });
}

/** Taken out of the group with "Uit de groep halen", and not linked again since. */
function wasRemoved(hostId: string): boolean {
  return getRemovedMembers().includes(hostId) && !members().some((member) => member.hostId === hostId);
}

/**
 * Waits until a majority holds everything this laptop, leading, has written, so a change to
 * the group never starts while an earlier one is still on its way. True once that holds.
 */
export async function groupSettled(): Promise<boolean> {
  const deadline = performance.now() + SETTLE_TIMEOUT_MS;
  while (!logSettled() && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  return logSettled();
}

/**
 * "Uit de groep halen" in Beheer › Systeem: takes a laptop that is gone for good out of the
 * group, so the group needs fewer laptops for a majority and a spare laptop linked in its
 * place adds safety again. Runs inside the leader's replicated write (router.ts), one laptop
 * at a time, and only for a laptop the leader has not heard from for REMOVABLE_AFTER_MS: never
 * the leader itself. The removed laptop is not taken back in when it returns (welcomeBack).
 */
export function removeLaptop(hostId: string): { name: string } {
  const member = members().find((candidate) => candidate.hostId === hostId);
  if (!member) throw new Error('Deze laptop hoort al niet meer bij de groep.');
  if (!logSettled()) throw new Error('De laptops zijn nog bezig met een vorige wijziging. Probeer het zo opnieuw.');
  if (!isRemovable(leaderGroupView().find((seen) => seen.hostId === hostId))) {
    throw new Error('Deze laptop is niet lang genoeg onbereikbaar om uit de groep te halen.');
  }
  removeClusterMember(hostId);
  setRemovedMembers([hostId, ...getRemovedMembers().filter((removed) => removed !== hostId)]);
  setUnreachableMembers(getUnreachableMembers().filter((unreachable) => unreachable !== hostId));
  return { name: heardNames().get(hostId) ?? member.name ?? shortUrl(member.url) };
}

/**
 * Koppelen, pressed on this laptop next to the laptop at `rawUrl`: the side
 * with fewer runners takes the other's data (linkDirection), so pressing it on
 * the laptop with the registrations never empties that laptop.
 */
export async function linkWith(rawUrl: string): Promise<{ backupFile: string | null }> {
  await waitWhileJoining();
  const { url, status } = await otherLaptop(rawUrl);
  if (status.clusterId === hostIdentity().clusterId) {
    // Already linked, for example because Koppelen was pressed on the other laptop too.
    if (status.members.some((member) => member.hostId === hostIdentity().hostId)) return { backupFile: null };
    // Taken out of that group: it takes this laptop back in, with the group's data.
    return joinGroup(url);
  }
  const direction = linkDirection(ownGroup(), {
    clusterId: status.clusterId,
    runners: status.runners,
    changed: status.changed,
    laptops: status.members.length,
  });
  if (direction === 'join') return joinOnce(url, status.clusterId);
  if (direction === 'there') throw new Error(pressThereMessage(url, status.runners));
  const response = await peerFetch(`${url}/api/cluster/invite`, {
    method: 'POST',
    body: { url: selfUrl(), clusterId: hostIdentity().clusterId },
    timeoutMs: INVITE_TIMEOUT_MS,
  });
  if (!response.ok) throw new Error((await readPeerError(response)).error || 'Koppelen mislukt.');
  return { backupFile: null };
}

/**
 * Another laptop pressed Koppelen next to this one and holds more runners, or
 * this laptop's group links by itself: this laptop joins that group, and its
 * own group follows. Only a laptop without runners can be asked.
 */
async function acceptInvite(url: string, clusterId: string, autoLinkedWith?: string): Promise<void> {
  await waitWhileJoining();
  if (hostIdentity().clusterId === clusterId) return;
  await joinOnce(url, clusterId, { emptyGroup: true, autoLinkedWith });
}

/**
 * Joins group `clusterId` through `url`. Koppelen pressed on both laptops at
 * once starts two joins here (one through acceptInvite); the second one waits
 * for the first instead of failing.
 */
async function joinOnce(url: string, clusterId: string, options?: JoinOptions): Promise<{ backupFile: string | null }> {
  try {
    return await joinGroup(url, options);
  } catch (error) {
    await waitWhileJoining();
    if (hostIdentity().clusterId === clusterId) return { backupFile: null };
    throw error;
  }
}

async function waitWhileJoining(): Promise<void> {
  const deadline = performance.now() + INVITE_TIMEOUT_MS / 2;
  while (busy() && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
}

/** The laptop at `rawUrl`, checked to be another laptop that can be linked with this one. */
async function otherLaptop(rawUrl: string): Promise<{ url: string; status: ClusterStatus }> {
  if (!enabled) throw new Error('Laptops koppelen staat uit op deze installatie.');
  const url = joinUrl(rawUrl);
  if (!url || url === selfUrl()) throw new Error('Vul het adres van een andere laptop in.');
  const status = await fetchStatus(url).catch(() => {
    throw new Error(`${url} is niet bereikbaar. Controleer het adres en de kabel.`);
  });
  if (!status.enabled) throw new Error('Op die laptop staat laptops koppelen uit.');
  if (status.hostId === hostIdentity().hostId) throw new Error('Dat adres is deze laptop zelf.');
  if (status.appVersion !== APP_VERSION || status.schemaVersion !== DATABASE_SCHEMA_VERSION) {
    throw new Error(versionMismatchMessage(status.appVersion));
  }
  return { url, status };
}

type JoinOptions = {
  /** Only while this laptop holds no runners, checked as the join starts; the rest of its group follows. */
  emptyGroup?: boolean;
  /** Set when the laptop links by itself: the laptop it linked with, which the group records. */
  autoLinkedWith?: string;
};

/**
 * Joins the group of the laptop at `rawUrl`, replacing this laptop's data
 * with the group's. A group this laptop never belonged to is only joined the
 * way linkDirection allows; rejoining its own group (maintain) is not limited.
 */
export async function joinGroup(rawUrl: string, options: JoinOptions = {}): Promise<{ backupFile: string | null }> {
  const { url, status } = await otherLaptop(rawUrl);
  if (
    status.clusterId !== hostIdentity().clusterId &&
    linkDirection(ownGroup(), {
      clusterId: status.clusterId,
      runners: status.runners,
      changed: status.changed,
      laptops: status.members.length,
    }) !== 'join'
  ) {
    throw new Error(pressThereMessage(url, status.runners));
  }
  if (busy()) throw new Error('Deze laptop wordt al gekoppeld of bijgewerkt.');
  if (options.emptyGroup && countRunners() > 0) {
    throw new Error('Op die laptop staan intussen lopers. Druk daar op Koppelen.');
  }
  // Nothing joins this laptop's group from here on (busy), so these are all the laptops that follow.
  const self = hostIdentity().hostId;
  const followers = options.emptyGroup ? members().filter((member) => member.hostId !== self) : [];
  joining = true;
  startJoining();
  let joined: Parameters<typeof finishJoining>[0] = null;
  try {
    const leader = status.leader;
    if (!leader) throw new Error('Die laptops kiezen net een hoofdlaptop. Probeer het zo opnieuw.');
    const leaderUrl = leader.hostId === status.hostId ? url : leader.url;
    const response = await peerFetch(`${leaderUrl}/api/cluster/members`, {
      method: 'POST',
      body: { ...selfMember(), autoLinkedWith: options.autoLinkedWith },
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
    if (joined) {
      for (const member of followers) {
        void peerFetch(`${member.url}/api/cluster/invite`, {
          method: 'POST',
          body: { url, clusterId: status.clusterId, autoLinkedWith: options.autoLinkedWith },
          timeoutMs: INVITE_TIMEOUT_MS,
        }).catch(() => undefined);
      }
    }
  }
}

/**
 * Makes this laptop a group of one when the others are gone for good. Only
 * allowed when no majority can be reached. Laptops that come back later are
 * taken in again by themselves; what they had that this one lacks stays in
 * their backup.
 */
export function continueAlone(origin?: string): { ok: true } {
  if (!enabled || isLeader()) throw new Error('Deze laptop werkt al.');
  if (clusterStatus().state !== 'no-majority') {
    throw new Error('Er zijn nog genoeg laptops bereikbaar; die kiezen zelf een hoofdlaptop.');
  }
  const selfId = hostIdentity().hostId;
  const others = members()
    .filter((member) => member.hostId !== selfId)
    .map((member) => member.name ?? shortUrl(member.url));
  takeOverAlone();
  recordWrite('cluster.continueAlone', () => {
    keepOnlyClusterMember(selfId);
    const left = others.length
      ? `; ${listNames(others)} ${others.length === 1 ? 'is' : 'zijn'} uit de groep gehaald`
      : '';
    logLaptopActivity('cluster.continueAlone', `Alleen verder gewerkt op ${LAPTOP_NAME}${left}`, origin);
  });
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
  // The leader's address or name changed (a new DHCP lease): tell the group.
  const storedSelf = stored.find((member) => member.hostId === self.hostId);
  if (stored.length && (storedSelf?.url !== self.url || storedSelf.name !== self.name)) addMember(self);
  // Another laptop announces a new address or name: store it, so it also holds when announcements stop.
  const names = heardNames();
  for (const member of stored) {
    if (member.hostId === self.hostId) continue;
    const url = currentUrl(member.hostId, member.url);
    const name = names.get(member.hostId) ?? member.name;
    if (url !== member.url || name !== member.name) addMember({ hostId: member.hostId, url, name });
  }
  logReachability();

  const group = new Set(members().map((member) => member.hostId));
  const identity = hostIdentity();
  for (const [hostId, url] of Object.entries(knownPeers())) {
    if (group.has(hostId)) continue;
    const status = await fetchStatus(url).catch(() => null);
    if (!status?.enabled || status.clusterId !== identity.clusterId || status.role !== 'leader') continue;
    if (!isLeader() || !otherGroupWins(status)) continue;
    try {
      await joinGroup(url);
      lastError = `Deze laptop werkte even apart en volgt nu weer de groep van ${status.hostName ?? url}. Wat ze apart bewaarde, staat in een backup.`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    return;
  }
  await autoLink(group);
}

/**
 * The leader of a group without runners links it with the group autoLinkPlan
 * picks, the way Koppelen would, and the rest of its group follows. A laptop
 * that is busy or has no leader is tried again next round.
 */
async function autoLink(group: Set<string>): Promise<void> {
  const { target } = autoLinkPlan(nearbyGroups(group));
  if (!target) {
    autoLinkFailure = null;
    return;
  }
  const name = target.name ?? shortUrl(target.url);
  const status = await fetchStatus(target.url).catch(() => null);
  if (!status) {
    // Its announcements arrive but its address does not answer: most often a firewall that lets one through.
    noteAutoLinkFailure(
      target.url,
      `Niet vanzelf gekoppeld: ${name} is te zien op het netwerk, maar ${shortUrl(target.url)} antwoordt niet. Staat Apolloon op die laptop toegelaten in de firewall? Op Windows doet Beheer › Systeem & herstel › Vast netwerkadres dat.`
    );
    return;
  }
  if (!status.leader || status.busy || !isLeader() || busy()) return;
  try {
    await joinOnce(target.url, status.clusterId, {
      emptyGroup: true,
      autoLinkedWith: status.hostName ?? shortUrl(target.url),
    });
    autoLinkFailure = null;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    noteAutoLinkFailure(target.url, `Vanzelf koppelen met ${name} lukt niet: ${reason}`);
  }
}

function noteAutoLinkFailure(url: string, message: string): void {
  const rounds = autoLinkFailure?.url === url ? autoLinkFailure.rounds + 1 : 1;
  autoLinkFailure = { url, rounds, message };
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
      name: LAPTOP_NAME,
      clusterId: identity.clusterId,
      appVersion: APP_VERSION,
      schemaVersion: DATABASE_SCHEMA_VERSION,
      leader: isLeader() && leaderAlive(),
      groupSize: members().length,
      runners: countRunners(),
      changed: hasEventChanges(),
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
