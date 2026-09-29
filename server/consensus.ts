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
import { peerFetch, readPeerError, selfUrl } from './peers.js';

/*
 * Majority voting (the Raft algorithm) among the laptops in the group.
 *
 * - One leader per term orders every write and sends it to the others.
 * - A write counts once a majority of laptops has stored it, so losing any
 *   one laptop never loses an acknowledged change.
 * - When the leader goes quiet, the others vote. Only a laptop with the most
 *   complete log can win, and only with a majority, so there are never two
 *   leaders and nothing ever needs merging.
 * - A pre-vote round first checks that an election could succeed, so a
 *   laptop that was merely cut off cannot disrupt a working group when it
 *   returns.
 * - A laptop that cannot reach a majority stops accepting writes.
 */

export type Role = 'leader' | 'follower' | 'candidate';

const enabled = isClusterEnabled();
const heartbeatMs = readPositiveInt(process.env.CLUSTER_HEARTBEAT_MS, 150);
const electionTimeoutMs = readPositiveInt(process.env.CLUSTER_ELECTION_TIMEOUT_MS, 1_500);
const commitTimeoutMs = readPositiveInt(process.env.CLUSTER_COMMIT_TIMEOUT_MS, 4_000);
const CLOCK_SYNC_MS = 2_000;
const MAX_ENTRIES_PER_APPEND = 500;

type FollowerProgress = {
  member: ClusterMember;
  /** Last entry the follower confirmed; null until it has answered a probe. */
  matchSeq: number | null;
  lastAckAt: number | null;
  inFlight: boolean;
  needsResync: boolean;
};

/** What a leader tells its followers about the group, so every laptop can show it. */
export type GroupView = Array<{ hostId: string; reachable: boolean; caughtUp: boolean }>;

let role: Role = 'follower';
let leader: ClusterMember | null = null;
let lastLeaderContactAt: number | null = null;
let electionDeadline = 0;
let electing = false;
let lastQuorumAt = Date.now();
let lastClockSyncAt = 0;
let resyncing = false;
/** Set while this laptop joins another group: it neither leads, votes, nor stores appends. */
let joining = false;
let resyncProblem: string | null = null;
let groupView: GroupView = [];
let tickTimer: NodeJS.Timeout | null = null;
const progress = new Map<string, FollowerProgress>();
const commitWaiters = new Set<{ seq: number; resolve: (committed: boolean) => void }>();

const appendRequestSchema = z.object({
  clusterId: z.string(),
  term: z.number().int().nonnegative(),
  leaderId: z.string().min(1).max(128),
  leaderUrl: z.string().min(1).max(2_048),
  prevSeq: z.number().int().nonnegative(),
  prevId: z.string().nullable(),
  entries: z.array(replicationLogEntrySchema).max(MAX_ENTRIES_PER_APPEND),
  resync: z.boolean(),
  group: z.array(z.object({ hostId: z.string(), reachable: z.boolean(), caughtUp: z.boolean() })),
});
export type AppendRequest = z.infer<typeof appendRequestSchema>;

const appendResponseSchema = z.object({
  term: z.number().int().nonnegative(),
  ok: z.boolean(),
  reason: z.string().optional(),
  head: z.object({ seq: z.number().int().nonnegative(), id: z.string().nullable() }),
});
export type AppendResponse = z.infer<typeof appendResponseSchema>;

const voteRequestSchema = z.object({
  clusterId: z.string(),
  preVote: z.boolean(),
  term: z.number().int().nonnegative(),
  candidateId: z.string().min(1).max(128),
  candidateUrl: z.string().min(1).max(2_048),
  lastSeq: z.number().int().nonnegative(),
  lastTerm: z.number().int().nonnegative(),
});
export type VoteRequest = z.infer<typeof voteRequestSchema>;

const memberSchema = z.object({ hostId: z.string().min(1).max(128), url: z.string().min(1).max(2_048) });

/** A refusal names the laptop that leads, so a laptop coming back follows it instead of starting an election. */
const voteResponseSchema = z.object({
  term: z.number().int().nonnegative(),
  granted: z.boolean(),
  leader: memberSchema.optional(),
});
export type VoteResponse = z.infer<typeof voteResponseSchema>;

export { appendRequestSchema, voteRequestSchema };

// Term and vote are persisted, so a laptop never votes twice in one term, even after a restart.

export function currentTerm(): number {
  return getClusterEpoch();
}

function setTerm(term: number): void {
  if (term !== currentTerm()) setLocalSetting('cluster_epoch', String(term));
}

function votedFor(term: number): string | null {
  const [votedTerm, hostId] = (getSetting('cluster_voted_for') ?? '').split(':');
  return Number(votedTerm) === term && hostId ? hostId : null;
}

function recordVote(term: number, hostId: string): void {
  setLocalSetting('cluster_voted_for', `${term}:${hostId}`);
}

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

function otherMembers(): ClusterMember[] {
  const selfId = self().hostId;
  return members().filter((member) => member.hostId !== selfId);
}

export function majority(): number {
  return Math.floor(members().length / 2) + 1;
}

export function currentRole(): Role {
  return role;
}

export function currentLeader(): ClusterMember | null {
  return leader;
}

export function isLeader(): boolean {
  return !enabled || role === 'leader';
}

/** When this laptop last knew of a working leader (itself included). */
export function lastLeaderContact(): number | null {
  return lastLeaderContactAt;
}

/** True while a leader is known and was heard from within an election timeout. */
export function leaderAlive(): boolean {
  if (!enabled || role === 'leader') return true;
  return leader !== null && lastLeaderContactAt !== null && Date.now() - lastLeaderContactAt < electionTimeoutMs;
}

export function isResyncing(): boolean {
  return resyncing;
}

/** Why the last re-sync failed, until one succeeds. */
export function lastResyncProblem(): string | null {
  return resyncProblem;
}

export function leaderGroupView(): GroupView {
  if (role !== 'leader') return groupView;
  const head = getLogHead().seq;
  const now = Date.now();
  return otherMembers().map((member) => {
    const follower = progress.get(member.hostId);
    const reachable = follower?.lastAckAt != null && now - follower.lastAckAt < electionTimeoutMs;
    return { hostId: member.hostId, reachable, caughtUp: reachable && (follower?.matchSeq ?? -1) >= head };
  });
}

function resetElectionDeadline(): void {
  electionDeadline = Date.now() + electionTimeoutMs * (1 + Math.random());
}

function becomeFollower(term: number, nextLeader: ClusterMember | null): void {
  const wasLeader = role === 'leader';
  setTerm(term);
  role = 'follower';
  if (nextLeader) {
    if (leader?.hostId !== nextLeader.hostId) resetClockSamples();
    leader = nextLeader;
    lastLeaderContactAt = Date.now();
  } else {
    leader = null;
  }
  resetElectionDeadline();
  if (wasLeader) {
    progress.clear();
    settleCommitWaiters(false);
  }
}

function becomeLeader(): void {
  role = 'leader';
  leader = self();
  lastLeaderContactAt = Date.now();
  lastQuorumAt = Date.now();
  progress.clear();
  groupView = [];
  replicateToAll();
}

// The loop: leaders send appends (which double as heartbeats); followers watch for a silent leader.

export function startConsensus(): void {
  if (!enabled) return;
  resetElectionDeadline();
  if (members().length === 1) becomeLeader();
  tickTimer = setInterval(tick, heartbeatMs);
  tickTimer.unref();
}

export function stopConsensus(): void {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
  settleCommitWaiters(false);
}

function tick(): void {
  if (joining) return;
  const now = Date.now();
  if (role === 'leader') {
    if (members().length === 1) {
      lastQuorumAt = now;
      return;
    }
    replicateToAll();
    const reachable = 1 + leaderGroupView().filter((member) => member.reachable).length;
    if (reachable >= majority()) {
      lastQuorumAt = now;
      lastLeaderContactAt = now;
    }
    // A leader that lost the majority stops accepting writes; the majority side elects anew.
    else if (now - lastQuorumAt > electionTimeoutMs) becomeFollower(currentTerm(), null);
    return;
  }
  if (members().length === 1) {
    becomeLeader();
    return;
  }
  if (leader && leaderAlive() && now - lastClockSyncAt > CLOCK_SYNC_MS) void syncClock(leader);
  if (now >= electionDeadline && !electing && !resyncing) void runElection();
}

async function runElection(): Promise<void> {
  electing = true;
  try {
    const head = getLogHead();
    const request = (preVote: boolean, term: number): VoteRequest => ({
      clusterId: hostIdentity().clusterId,
      preVote,
      term,
      candidateId: self().hostId,
      candidateUrl: selfUrl(),
      lastSeq: head.seq,
      lastTerm: head.epoch,
    });
    // The pre-vote changes nothing: it only asks whether a real election could win.
    const preVotes = await askForVotes(request(true, currentTerm() + 1));
    if (role !== 'follower' || leaderAlive() || preVotes + 1 < majority()) return;

    const term = currentTerm() + 1;
    setTerm(term);
    recordVote(term, self().hostId);
    role = 'candidate';
    leader = null;
    const votes = await askForVotes(request(false, term));
    if (role === 'candidate' && currentTerm() === term && votes + 1 >= majority()) becomeLeader();
    else if (role === 'candidate') role = 'follower';
  } finally {
    electing = false;
    if (role !== 'leader') resetElectionDeadline();
  }
}

async function askForVotes(request: VoteRequest): Promise<number> {
  const answers = await Promise.all(
    otherMembers().map(async (member) => {
      try {
        const response = await peerFetch(`${member.url}/api/cluster/vote`, { method: 'POST', body: request });
        return response.ok ? voteResponseSchema.parse(await response.json()) : null;
      } catch {
        return null;
      }
    })
  );
  let granted = 0;
  for (const answer of answers) {
    if (!answer) continue;
    if (answer.leader && answer.term >= currentTerm() && answer.leader.hostId !== self().hostId) {
      // Someone leads already: wait for it to get in touch rather than compete.
      becomeFollower(answer.term, answer.leader);
    } else if (answer.term > currentTerm()) becomeFollower(answer.term, null);
    else if (answer.granted) granted += 1;
  }
  return granted;
}

/** Answers another laptop's (pre-)vote request. */
export function handleVoteRequest(request: VoteRequest): VoteResponse {
  if (joining) return { term: currentTerm(), granted: false };
  if (request.clusterId !== hostIdentity().clusterId) return { term: currentTerm(), granted: false };
  // While a leader is heard from, votes are refused, so a laptop returning from isolation cannot disrupt the group.
  if (leaderAlive() && leader) return { term: currentTerm(), granted: false, leader };
  if (!members().some((member) => member.hostId === request.candidateId))
    return { term: currentTerm(), granted: false };

  const head = getLogHead();
  const upToDate = request.lastTerm > head.epoch || (request.lastTerm === head.epoch && request.lastSeq >= head.seq);
  if (request.preVote) return { term: currentTerm(), granted: upToDate && request.term > currentTerm() };

  if (request.term < currentTerm()) return { term: currentTerm(), granted: false };
  if (request.term > currentTerm()) becomeFollower(request.term, null);
  const previousVote = votedFor(request.term);
  if (!upToDate || (previousVote && previousVote !== request.candidateId))
    return { term: currentTerm(), granted: false };
  recordVote(request.term, request.candidateId);
  resetElectionDeadline();
  return { term: currentTerm(), granted: true };
}

// Leader side: send each follower what it is missing, and learn how far it got.

function replicateToAll(): void {
  for (const member of otherMembers()) void replicateTo(member);
}

async function replicateTo(member: ClusterMember): Promise<void> {
  let follower = progress.get(member.hostId);
  if (!follower) {
    follower = { member, matchSeq: null, lastAckAt: null, inFlight: false, needsResync: false };
    progress.set(member.hostId, follower);
  }
  follower.member = member;
  if (follower.inFlight || role !== 'leader') return;
  follower.inFlight = true;
  const term = currentTerm();
  try {
    for (let rounds = 0; rounds < 20 && role === 'leader' && currentTerm() === term; rounds += 1) {
      const head = getLogHead();
      const prevSeq = follower.matchSeq ?? head.seq;
      const prevId = prevSeq === 0 ? null : getLogEntryId(prevSeq);
      const request: AppendRequest = {
        clusterId: hostIdentity().clusterId,
        term,
        leaderId: self().hostId,
        leaderUrl: selfUrl(),
        prevSeq,
        prevId,
        entries:
          follower.matchSeq === null || follower.needsResync ? [] : getLogEntriesAfter(prevSeq, MAX_ENTRIES_PER_APPEND),
        // Entries the follower needs may be pruned here; then it takes a full copy.
        resync: follower.needsResync || (prevSeq > 0 && prevId === null),
        group: leaderGroupView(),
      };
      const response = await peerFetch(`${member.url}/api/cluster/append`, { method: 'POST', body: request });
      if (!response.ok) return;
      const answer = appendResponseSchema.parse(await response.json());
      if (answer.term > currentTerm()) {
        becomeFollower(answer.term, null);
        return;
      }
      follower.lastAckAt = Date.now();
      if (answer.ok) {
        follower.matchSeq = answer.head.seq;
        follower.needsResync = false;
        advanceCommit();
        if (answer.head.seq >= getLogHead().seq) return;
        continue;
      }
      if (answer.reason === 'behind' && canContinueFrom(answer.head.seq, answer.head.id)) {
        follower.matchSeq = answer.head.seq;
        continue;
      }
      follower.matchSeq = null;
      follower.needsResync = answer.reason === 'behind' || answer.reason === 'diverged';
      return;
    }
  } catch {
    // Unreachable; the next heartbeat tries again.
  } finally {
    follower.inFlight = false;
  }
}

function advanceCommit(): void {
  const matched = [getLogHead().seq, ...otherMembers().map((member) => progress.get(member.hostId)?.matchSeq ?? 0)];
  matched.sort((a, b) => b - a);
  const committed = matched[majority() - 1] ?? 0;
  for (const waiter of commitWaiters) {
    if (waiter.seq <= committed) {
      commitWaiters.delete(waiter);
      waiter.resolve(true);
    }
  }
}

function settleCommitWaiters(committed: boolean): void {
  for (const waiter of commitWaiters) waiter.resolve(committed);
  commitWaiters.clear();
}

/** Resolves true once a majority stored entry `seq`; false when that fails in time or leadership is lost. */
export function waitForCommit(seq: number): Promise<boolean> {
  if (!enabled || members().length === 1) return Promise.resolve(true);
  if (role !== 'leader') return Promise.resolve(false);
  return new Promise((resolve) => {
    const waiter = {
      seq,
      resolve: (committed: boolean) => {
        clearTimeout(timer);
        resolve(committed);
      },
    };
    const timer = setTimeout(() => {
      commitWaiters.delete(waiter);
      resolve(false);
    }, commitTimeoutMs);
    timer.unref();
    commitWaiters.add(waiter);
    replicateToAll();
    advanceCommit();
  });
}

// Follower side.

/** Stores a leader's append; answers with this log's head so the leader knows what to send next. */
export function handleAppend(request: AppendRequest): AppendResponse {
  const head = () => {
    const current = getLogHead();
    return { seq: current.seq, id: current.id };
  };
  if (joining) return { term: currentTerm(), ok: false, reason: 'joining', head: head() };
  if (request.term < currentTerm()) return { term: currentTerm(), ok: false, reason: 'stale-term', head: head() };
  const nextLeader = { hostId: request.leaderId, url: request.leaderUrl };
  if (role !== 'follower' || leader?.hostId !== nextLeader.hostId || request.term > currentTerm()) {
    becomeFollower(request.term, nextLeader);
  }
  leader = nextLeader;
  lastLeaderContactAt = Date.now();
  groupView = request.group;
  resetElectionDeadline();

  if (resyncing) return { term: currentTerm(), ok: false, reason: 'resyncing', head: head() };
  if (request.resync) {
    startResync(nextLeader.url);
    return { term: currentTerm(), ok: false, reason: 'resyncing', head: head() };
  }
  const outcome = appendFromLeader(request.prevSeq, request.prevId, request.entries);
  if (!outcome.ok && outcome.reason === 'diverged') startResync(nextLeader.url);
  return { term: currentTerm(), ok: outcome.ok, reason: outcome.ok ? undefined : outcome.reason, head: head() };
}

function startResync(url: string): void {
  resyncFrom(url).catch((error: unknown) => {
    resyncProblem = `Bijwerken vanaf de hoofdlaptop mislukt: ${error instanceof Error ? error.message : String(error)}`;
    console.warn(resyncProblem);
  });
}

/** Replaces this laptop's data with a full copy from `url`, after a backup of what it had. */
export async function resyncFrom(url: string, backupReason = 'pre-resync'): Promise<void> {
  if (resyncing) return;
  resyncing = true;
  try {
    const response = await peerFetch(`${url}/api/cluster/snapshot`, { timeoutMs: 60_000 });
    if (!response.ok) {
      throw new Error((await readPeerError(response)).error || `Database ophalen mislukt (HTTP ${response.status}).`);
    }
    const term = Number(response.headers.get('x-apolloon-epoch') || 0);
    const image = Buffer.from(await response.arrayBuffer());
    await createVerifiedBackup(backupReason);
    installDatabaseImage(image, DATABASE_SCHEMA_VERSION);
    if (Number.isSafeInteger(term) && term > currentTerm()) setTerm(term);
    resyncProblem = null;
  } finally {
    resyncing = false;
  }
}

/** Keeps this laptop on the leader's cluster time. */
async function syncClock(target: ClusterMember): Promise<void> {
  lastClockSyncAt = Date.now();
  try {
    const sentAt = Date.now();
    const response = await peerFetch(`${target.url}/api/time`);
    const receivedAt = Date.now();
    if (!response.ok) return;
    const { serverNowMs } = (await response.json()) as { serverNowMs: number };
    if (observeReferenceClock(serverNowMs, sentAt, receivedAt)) {
      setLocalSetting('cluster_clock_offset_ms', String(clusterClockOffset()));
    }
  } catch {
    // Retried on a later tick.
  }
}

/** Becomes leader of a group of one; used only when the operator confirms the others are gone. */
export function takeOverAlone(): void {
  const term = currentTerm() + 1;
  setTerm(term);
  recordVote(term, self().hostId);
  becomeLeader();
}

/** Stops leading this laptop's own group while it joins another one. */
export function startJoining(): void {
  joining = true;
  if (role === 'leader') becomeFollower(currentTerm(), null);
}

/** After joining, follow the leader the copy came from; after a failed join, carry on as before. */
export function finishJoining(nextLeader: { term: number; leader: ClusterMember } | null): void {
  joining = false;
  if (nextLeader) becomeFollower(Math.max(nextLeader.term, currentTerm()), nextLeader.leader);
}
