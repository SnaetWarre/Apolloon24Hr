import { z } from 'zod';
import { createVerifiedBackup } from './backups.js';
import { clusterClockOffset, observeReferenceClock, resetClockSamples } from './clock.js';
import {
  DATABASE_SCHEMA_VERSION,
  appendFromLeader,
  canContinueFrom,
  getClusterEpoch,
  getClusterMembers,
  getLogEntriesAfter,
  getLogEntryId,
  getLogHead,
  getSetting,
  hostIdentity,
  installDatabaseImage,
  replicationLogEntrySchema,
  setLocalSetting,
  type ClusterMember,
} from './db.js';
import { isClusterEnabled, readPositiveInt } from './env.js';
import { currentUrl } from './discovery.js';
import { peerRequest, type PeerRequestType } from './peer-socket.js';
import { peerFetch, readPeerError, selfUrl } from './peers.js';
import {
  createRaft,
  type AppendRequest,
  type AppendResponse,
  type GroupView,
  type Role,
  type VoteRequest,
  type VoteResponse,
} from './raft.js';

/*
 * Runs the majority voting of raft.ts on this laptop: its SQLite log, a
 * socket to each other laptop (peer-socket.ts), and real timers.
 */

export type { AppendRequest, AppendResponse, GroupView, Role, VoteRequest, VoteResponse };

const enabled = isClusterEnabled();
/** Read once here; cluster.ts uses the same values. Tests shorten them. */
export const ELECTION_TIMEOUT_MS = readPositiveInt(process.env.CLUSTER_ELECTION_TIMEOUT_MS, 1_500);
export const COMMIT_TIMEOUT_MS = readPositiveInt(process.env.CLUSTER_COMMIT_TIMEOUT_MS, 4_000);
const MAX_ENTRIES_PER_APPEND = 500;
const SNAPSHOT_ANSWER_TIMEOUT_MS = 10_000;
const SNAPSHOT_TIMEOUT_MS = 60_000;

const groupViewSchema = z.array(
  z.object({ hostId: z.string(), reachable: z.boolean(), caughtUp: z.boolean(), silentMs: z.number().nonnegative() })
);

export const appendRequestSchema = z.object({
  clusterId: z.string(),
  term: z.number().int().nonnegative(),
  leaderId: z.string().min(1).max(128),
  leaderUrl: z.string().min(1).max(2_048),
  prevSeq: z.number().int().nonnegative(),
  prevId: z.string().nullable(),
  entries: z.array(replicationLogEntrySchema).max(MAX_ENTRIES_PER_APPEND),
  resync: z.boolean(),
  group: groupViewSchema,
}) satisfies z.ZodType<AppendRequest>;

const appendResponseSchema = z.object({
  term: z.number().int().nonnegative(),
  ok: z.boolean(),
  reason: z.string().optional(),
  head: z.object({ seq: z.number().int().nonnegative(), id: z.string().nullable() }),
}) satisfies z.ZodType<AppendResponse>;

export const voteRequestSchema = z.object({
  clusterId: z.string(),
  preVote: z.boolean(),
  term: z.number().int().nonnegative(),
  candidateId: z.string().min(1).max(128),
  candidateUrl: z.string().min(1).max(2_048),
  lastSeq: z.number().int().nonnegative(),
  lastTerm: z.number().int().nonnegative(),
}) satisfies z.ZodType<VoteRequest>;

const memberSchema = z.object({ hostId: z.string().min(1).max(128), url: z.string().min(1).max(2_048) });

const voteResponseSchema = z.object({
  term: z.number().int().nonnegative(),
  granted: z.boolean(),
  leader: memberSchema.optional(),
  removed: z.boolean().optional(),
}) satisfies z.ZodType<VoteResponse>;

function self(): ClusterMember {
  return { hostId: hostIdentity().hostId, url: selfUrl() };
}

/**
 * The group from the replicated table, at the addresses the laptops announce
 * now; a laptop that never joined one is a group of one.
 */
export function members(): ClusterMember[] {
  const stored = getClusterMembers().map((member) => ({ ...member, url: currentUrl(member.hostId, member.url) }));
  return stored.some((member) => member.hostId === self().hostId) ? stored : [self(), ...stored];
}

/** The last laptop that told this one it was taken out of the group, and when (monotonic). */
let lastRemovedAnswer: { member: ClusterMember; at: number } | null = null;

async function send<T>(member: ClusterMember, type: PeerRequestType, body: unknown, schema: z.ZodType<T>) {
  const answer = await peerRequest(member.url, type, body);
  return answer === null ? null : schema.parse(answer);
}

const raft = createRaft({
  self,
  clusterId: () => hostIdentity().clusterId,
  members,
  storage: {
    term: getClusterEpoch,
    setTerm: (term) => setLocalSetting('cluster_epoch', String(term)),
    votedFor(term) {
      const [votedTerm, hostId] = (getSetting('cluster_voted_for') ?? '').split(':');
      return Number(votedTerm) === term && hostId ? hostId : null;
    },
    recordVote: (term, hostId) => setLocalSetting('cluster_voted_for', `${term}:${hostId}`),
    head: getLogHead,
    entryId: getLogEntryId,
    entriesAfter: getLogEntriesAfter,
    canContinueFrom,
    appendFromLeader,
  },
  sendAppend: (member, request) => send(member, 'append', request, appendResponseSchema),
  async sendVote(member, request) {
    const answer = await send(member, 'vote', request, voteResponseSchema);
    if (answer?.removed) lastRemovedAnswer = { member, at: performance.now() };
    return answer;
  },
  async installCopyFrom(url, backupReason, signal) {
    // A leader answers at once; only the download itself may take a while.
    const answered = new AbortController();
    const timer = setTimeout(() => answered.abort(new Error('geen antwoord')), SNAPSHOT_ANSWER_TIMEOUT_MS);
    const response = await peerFetch(`${url}/api/cluster/snapshot`, {
      timeoutMs: SNAPSHOT_TIMEOUT_MS,
      signal: AbortSignal.any([signal, answered.signal]),
    }).finally(() => clearTimeout(timer));
    if (!response.ok) {
      throw new Error((await readPeerError(response)).error || `Database ophalen mislukt (HTTP ${response.status}).`);
    }
    const term = Number(response.headers.get('x-apolloon-epoch') || 0);
    const image = Buffer.from(await response.arrayBuffer());
    await createVerifiedBackup(backupReason);
    installDatabaseImage(image, DATABASE_SCHEMA_VERSION);
    return term;
  },
  async syncClock(target) {
    const sentAt = Date.now();
    const response = await peerFetch(`${target.url}/api/time`);
    const receivedAt = Date.now();
    if (!response.ok) return;
    const { serverNowMs } = (await response.json()) as { serverNowMs: number };
    if (observeReferenceClock(serverNowMs, sentAt, receivedAt)) {
      setLocalSetting('cluster_clock_offset_ms', String(clusterClockOffset()));
    }
  },
  leaderChanged: resetClockSamples,
  // Timeouts use the monotonic clock: a laptop whose clock is corrected must not wait minutes to vote.
  now: () => performance.now(),
  every(ms, callback) {
    const timer = setInterval(callback, ms);
    timer.unref();
    return () => clearInterval(timer);
  },
  after(ms, callback) {
    const timer = setTimeout(callback, ms);
    timer.unref();
    return () => clearTimeout(timer);
  },
  random: Math.random,
  warn: (message) => console.warn(message),
  heartbeatMs: readPositiveInt(process.env.CLUSTER_HEARTBEAT_MS, 150),
  electionTimeoutMs: ELECTION_TIMEOUT_MS,
  commitTimeoutMs: COMMIT_TIMEOUT_MS,
  maxEntriesPerAppend: MAX_ENTRIES_PER_APPEND,
});

export const currentTerm = raft.currentTerm;
export const majority = raft.majority;
export const leaderGroupView = raft.leaderGroupView;
export const handleVoteRequest = raft.handleVoteRequest;
export const handleAppend = raft.handleAppend;
export const resyncFrom = raft.resyncFrom;
export const takeOverAlone = raft.takeOverAlone;
export const startJoining = raft.startJoining;
export const finishJoining = raft.finishJoining;
export const currentRole = raft.role;
export const currentLeader = raft.leader;
export const isResyncing = raft.isResyncing;
export const lastResyncProblem = raft.resyncProblem;
export const lastLeaderContact = raft.lastLeaderContact;
export const logSettled = raft.logSettled;

/** The laptop that last said this one was taken out of the group, if one did within `withinMs`. */
export function removedBy(withinMs: number): ClusterMember | null {
  return lastRemovedAnswer && performance.now() - lastRemovedAnswer.at < withinMs ? lastRemovedAnswer.member : null;
}

export function isLeader(): boolean {
  return !enabled || raft.role() === 'leader';
}

/** True while a leader is known and was heard from within an election timeout. */
export function leaderAlive(): boolean {
  return !enabled || raft.leaderAlive();
}

/** Resolves true once a majority stored entry `seq`; false when that fails in time or leadership is lost. */
export function waitForCommit(seq: number): Promise<boolean> {
  return enabled ? raft.waitForCommit(seq) : Promise.resolve(true);
}

export function startConsensus(): void {
  if (enabled) raft.start();
}

export function stopConsensus(): void {
  raft.stop();
}
