import type { ClusterMember } from './db/members.js';
import type { LogHead } from './db/replication.js';
import type { AppendOutcome } from './db/append-rules.js';
import type { ReplicationLogEntry } from './db/types.js';

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
 *
 * Everything outside the algorithm (storage, network, clock, timers,
 * randomness) is passed in, so consensus.ts runs it on SQLite and HTTP and
 * the simulation tests run it on a fake network and a fake clock.
 */

export type Role = 'leader' | 'follower' | 'candidate';

/** What a leader tells its followers about the group, so every laptop can show it. */
export type GroupView = Array<{ hostId: string; reachable: boolean; caughtUp: boolean }>;

export type AppendRequest = {
  clusterId: string;
  term: number;
  leaderId: string;
  leaderUrl: string;
  prevSeq: number;
  prevId: string | null;
  entries: ReplicationLogEntry[];
  resync: boolean;
  group: GroupView;
};

export type AppendResponse = {
  term: number;
  ok: boolean;
  reason?: string;
  head: { seq: number; id: string | null };
};

export type VoteRequest = {
  clusterId: string;
  preVote: boolean;
  term: number;
  candidateId: string;
  candidateUrl: string;
  lastSeq: number;
  lastTerm: number;
};

/** A refusal names the laptop that leads, so a laptop coming back follows it instead of starting an election. */
export type VoteResponse = {
  term: number;
  granted: boolean;
  leader?: ClusterMember;
};

export type RaftStorage = {
  /** The persisted term; a laptop never votes twice in one term, even after a restart. */
  term(): number;
  setTerm(term: number): void;
  votedFor(term: number): string | null;
  recordVote(term: number, hostId: string): void;
  head(): LogHead;
  entryId(seq: number): string | null;
  entriesAfter(seq: number, limit: number): ReplicationLogEntry[];
  canContinueFrom(seq: number, id: string | null): boolean;
  appendFromLeader(prevSeq: number, prevId: string | null, entries: ReplicationLogEntry[]): AppendOutcome;
};

export type RaftDeps = {
  self(): ClusterMember;
  clusterId(): string;
  /** The group, this laptop included. */
  members(): ClusterMember[];
  storage: RaftStorage;
  /** Resolves with the answer, null when the other laptop refused the request; rejects when unreachable. */
  sendAppend(member: ClusterMember, request: AppendRequest): Promise<AppendResponse | null>;
  sendVote(member: ClusterMember, request: VoteRequest): Promise<VoteResponse | null>;
  /** Replaces this laptop's data with a full copy from `url`; resolves with that laptop's term. */
  installCopyFrom(url: string, backupReason: string, signal: AbortSignal): Promise<number>;
  /** Keeps this laptop on the leader's cluster time. */
  syncClock(leader: ClusterMember): Promise<void>;
  /** Called when this laptop starts following another leader. */
  leaderChanged(): void;
  /** A monotonic clock in milliseconds; the wall clock may jump when the system corrects it. */
  now(): number;
  every(ms: number, callback: () => void): () => void;
  after(ms: number, callback: () => void): () => void;
  random(): number;
  warn(message: string): void;
  heartbeatMs: number;
  electionTimeoutMs: number;
  commitTimeoutMs: number;
  maxEntriesPerAppend: number;
};

const CLOCK_SYNC_MS = 2_000;

type FollowerProgress = {
  member: ClusterMember;
  /** Last entry the follower confirmed; null until it has answered a probe. */
  matchSeq: number | null;
  lastAckAt: number | null;
  inFlight: boolean;
  needsResync: boolean;
};

export type Raft = ReturnType<typeof createRaft>;

export function createRaft(deps: RaftDeps) {
  const { storage, electionTimeoutMs } = deps;

  let role: Role = 'follower';
  let leader: ClusterMember | null = null;
  let lastLeaderContactAt: number | null = null;
  let electionDeadline = 0;
  let electing = false;
  let lastQuorumAt = deps.now();
  let lastClockSyncAt = Number.NEGATIVE_INFINITY;
  let resyncing = false;
  /** The laptop a re-sync copies from, and how to give up on it. */
  let resyncSource: { url: string; abort: AbortController } | null = null;
  /** Set while this laptop joins another group: it neither leads, votes, nor stores appends. */
  let joining = false;
  let resyncProblem: string | null = null;
  let groupView: GroupView = [];
  let stopTicking: (() => void) | null = null;
  const progress = new Map<string, FollowerProgress>();
  const commitWaiters = new Set<{ seq: number; resolve: (committed: boolean) => void }>();

  const currentTerm = () => storage.term();

  function setTerm(term: number): void {
    if (term !== currentTerm()) storage.setTerm(term);
  }

  function otherMembers(): ClusterMember[] {
    const selfId = deps.self().hostId;
    return deps.members().filter((member) => member.hostId !== selfId);
  }

  function majority(): number {
    return Math.floor(deps.members().length / 2) + 1;
  }

  /** True while a leader is known and was heard from within an election timeout. */
  function leaderAlive(): boolean {
    if (role === 'leader') return true;
    return leader !== null && lastLeaderContactAt !== null && deps.now() - lastLeaderContactAt < electionTimeoutMs;
  }

  function leaderGroupView(): GroupView {
    if (role !== 'leader') return groupView;
    const head = storage.head().seq;
    const now = deps.now();
    return otherMembers().map((member) => {
      const follower = progress.get(member.hostId);
      const reachable = follower?.lastAckAt != null && now - follower.lastAckAt < electionTimeoutMs;
      return { hostId: member.hostId, reachable, caughtUp: reachable && (follower?.matchSeq ?? -1) >= head };
    });
  }

  function resetElectionDeadline(): void {
    electionDeadline = deps.now() + electionTimeoutMs * (1 + deps.random());
  }

  function becomeFollower(term: number, nextLeader: ClusterMember | null): void {
    const wasLeader = role === 'leader';
    setTerm(term);
    role = 'follower';
    if (nextLeader) {
      if (leader?.hostId !== nextLeader.hostId) deps.leaderChanged();
      leader = nextLeader;
      lastLeaderContactAt = deps.now();
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
    leader = deps.self();
    lastLeaderContactAt = deps.now();
    lastQuorumAt = deps.now();
    progress.clear();
    groupView = [];
    replicateToAll();
  }

  // The loop: leaders send appends (which double as heartbeats); followers watch for a silent leader.

  function start(): void {
    resetElectionDeadline();
    if (deps.members().length === 1) becomeLeader();
    stopTicking = deps.every(deps.heartbeatMs, tick);
  }

  function stop(): void {
    stopTicking?.();
    stopTicking = null;
    settleCommitWaiters(false);
  }

  function tick(): void {
    if (joining) return;
    const now = deps.now();
    if (role === 'leader') {
      if (deps.members().length === 1) {
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
    if (deps.members().length === 1) {
      becomeLeader();
      return;
    }
    // A copy from a leader that went quiet would never arrive; give up, so this laptop can vote and follow again.
    if (resyncSource && (!leaderAlive() || leader?.url !== resyncSource.url)) {
      resyncSource.abort.abort(new Error('de hoofdlaptop is niet meer bereikbaar'));
    }
    if (leader && leaderAlive() && now - lastClockSyncAt > CLOCK_SYNC_MS) {
      lastClockSyncAt = now;
      void deps.syncClock(leader).catch(() => undefined);
    }
    if (now >= electionDeadline && !electing && !resyncing) void runElection();
  }

  async function runElection(): Promise<void> {
    electing = true;
    try {
      const head = storage.head();
      const request = (preVote: boolean, term: number): VoteRequest => ({
        clusterId: deps.clusterId(),
        preVote,
        term,
        candidateId: deps.self().hostId,
        candidateUrl: deps.self().url,
        lastSeq: head.seq,
        lastTerm: head.epoch,
      });
      // The pre-vote changes nothing: it only asks whether a real election could win.
      const preVotes = await askForVotes(request(true, currentTerm() + 1));
      if (role !== 'follower' || leaderAlive() || preVotes + 1 < majority()) return;

      const term = currentTerm() + 1;
      setTerm(term);
      storage.recordVote(term, deps.self().hostId);
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
    const answers = await Promise.all(otherMembers().map((member) => deps.sendVote(member, request).catch(() => null)));
    let granted = 0;
    for (const answer of answers) {
      if (!answer) continue;
      if (answer.leader && answer.term >= currentTerm() && answer.leader.hostId !== deps.self().hostId) {
        // Someone leads already: wait for it to get in touch rather than compete.
        becomeFollower(answer.term, answer.leader);
      } else if (answer.term > currentTerm()) becomeFollower(answer.term, null);
      else if (answer.granted) granted += 1;
    }
    return granted;
  }

  /** Answers another laptop's (pre-)vote request. */
  function handleVoteRequest(request: VoteRequest): VoteResponse {
    if (joining) return { term: currentTerm(), granted: false };
    if (request.clusterId !== deps.clusterId()) return { term: currentTerm(), granted: false };
    // While a leader is heard from, votes are refused, so a laptop returning from isolation cannot disrupt the group.
    if (leaderAlive() && leader) return { term: currentTerm(), granted: false, leader };
    if (!deps.members().some((member) => member.hostId === request.candidateId))
      return { term: currentTerm(), granted: false };

    const head = storage.head();
    const upToDate = request.lastTerm > head.epoch || (request.lastTerm === head.epoch && request.lastSeq >= head.seq);
    if (request.preVote) return { term: currentTerm(), granted: upToDate && request.term > currentTerm() };

    if (request.term < currentTerm()) return { term: currentTerm(), granted: false };
    if (request.term > currentTerm()) becomeFollower(request.term, null);
    const previousVote = storage.votedFor(request.term);
    if (!upToDate || (previousVote && previousVote !== request.candidateId))
      return { term: currentTerm(), granted: false };
    storage.recordVote(request.term, request.candidateId);
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
        const head = storage.head();
        const prevSeq = follower.matchSeq ?? head.seq;
        const prevId = prevSeq === 0 ? null : storage.entryId(prevSeq);
        const request: AppendRequest = {
          clusterId: deps.clusterId(),
          term,
          leaderId: deps.self().hostId,
          leaderUrl: deps.self().url,
          prevSeq,
          prevId,
          entries:
            follower.matchSeq === null || follower.needsResync
              ? []
              : storage.entriesAfter(prevSeq, deps.maxEntriesPerAppend),
          // Entries the follower needs may be pruned here; then it takes a full copy.
          resync: follower.needsResync || (prevSeq > 0 && prevId === null),
          group: leaderGroupView(),
        };
        const answer = await deps.sendAppend(member, request);
        if (!answer) return;
        if (answer.term > currentTerm()) {
          becomeFollower(answer.term, null);
          return;
        }
        follower.lastAckAt = deps.now();
        if (answer.ok) {
          follower.matchSeq = answer.head.seq;
          follower.needsResync = false;
          advanceCommit();
          if (answer.head.seq >= storage.head().seq) return;
          continue;
        }
        if (answer.reason === 'behind' && storage.canContinueFrom(answer.head.seq, answer.head.id)) {
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
    const matched = [storage.head().seq, ...otherMembers().map((member) => progress.get(member.hostId)?.matchSeq ?? 0)];
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
  function waitForCommit(seq: number): Promise<boolean> {
    if (deps.members().length === 1) return Promise.resolve(true);
    if (role !== 'leader') return Promise.resolve(false);
    return new Promise((resolve) => {
      const waiter = {
        seq,
        resolve: (committed: boolean) => {
          cancelTimer();
          resolve(committed);
        },
      };
      const cancelTimer = deps.after(deps.commitTimeoutMs, () => {
        commitWaiters.delete(waiter);
        resolve(false);
      });
      commitWaiters.add(waiter);
      replicateToAll();
      advanceCommit();
    });
  }

  // Follower side.

  /** Stores a leader's append; answers with this log's head so the leader knows what to send next. */
  function handleAppend(request: AppendRequest): AppendResponse {
    const head = () => {
      const current = storage.head();
      return { seq: current.seq, id: current.id };
    };
    if (joining) return { term: currentTerm(), ok: false, reason: 'joining', head: head() };
    if (request.term < currentTerm()) return { term: currentTerm(), ok: false, reason: 'stale-term', head: head() };
    const nextLeader = { hostId: request.leaderId, url: request.leaderUrl };
    if (role !== 'follower' || leader?.hostId !== nextLeader.hostId || request.term > currentTerm()) {
      becomeFollower(request.term, nextLeader);
    }
    leader = nextLeader;
    lastLeaderContactAt = deps.now();
    groupView = request.group;
    resetElectionDeadline();

    if (resyncing) return { term: currentTerm(), ok: false, reason: 'resyncing', head: head() };
    if (request.resync) {
      startResync(nextLeader.url);
      return { term: currentTerm(), ok: false, reason: 'resyncing', head: head() };
    }
    const outcome = storage.appendFromLeader(request.prevSeq, request.prevId, request.entries);
    if (!outcome.ok && outcome.reason === 'diverged') startResync(nextLeader.url);
    return { term: currentTerm(), ok: outcome.ok, reason: outcome.ok ? undefined : outcome.reason, head: head() };
  }

  function startResync(url: string): void {
    if (resyncing) return;
    const abort = new AbortController();
    resyncSource = { url, abort };
    resyncFrom(url, 'pre-resync', abort.signal).catch((error: unknown) => {
      resyncProblem = `Bijwerken vanaf de hoofdlaptop mislukt: ${error instanceof Error ? error.message : String(error)}`;
      deps.warn(resyncProblem);
    });
  }

  /** Replaces this laptop's data with a full copy from `url`, after a backup of what it had. */
  async function resyncFrom(url: string, backupReason = 'pre-resync', signal?: AbortSignal): Promise<void> {
    if (resyncing) return;
    resyncing = true;
    try {
      const term = await deps.installCopyFrom(url, backupReason, signal ?? new AbortController().signal);
      if (Number.isSafeInteger(term) && term > currentTerm()) setTerm(term);
      resyncProblem = null;
    } finally {
      resyncing = false;
      resyncSource = null;
    }
  }

  /** Becomes leader of a group of one; used only when the operator confirms the others are gone. */
  function takeOverAlone(): void {
    const term = currentTerm() + 1;
    setTerm(term);
    storage.recordVote(term, deps.self().hostId);
    becomeLeader();
  }

  /** Stops leading this laptop's own group while it joins another one. */
  function startJoining(): void {
    joining = true;
    if (role === 'leader') becomeFollower(currentTerm(), null);
  }

  /** After joining, follow the leader the copy came from; after a failed join, carry on as before. */
  function finishJoining(nextLeader: { term: number; leader: ClusterMember } | null): void {
    joining = false;
    if (nextLeader) becomeFollower(Math.max(nextLeader.term, currentTerm()), nextLeader.leader);
  }

  return {
    start,
    stop,
    tick,
    currentTerm,
    majority,
    leaderAlive,
    leaderGroupView,
    handleVoteRequest,
    handleAppend,
    waitForCommit,
    resyncFrom,
    takeOverAlone,
    startJoining,
    finishJoining,
    role: () => role,
    leader: () => leader,
    /** When this laptop last knew of a working leader (itself included), on the `now()` clock. */
    lastLeaderContact: () => lastLeaderContactAt,
    isResyncing: () => resyncing,
    /** Why the last re-sync failed, until one succeeds. */
    resyncProblem: () => resyncProblem,
  };
}
