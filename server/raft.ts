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

/**
 * What this laptop does in the group. Every change goes through `changeRole`, which allows only
 * the moves in ROLE_CHANGES: a follower stands for election (candidate) or, as the only laptop,
 * leads; a candidate leads once it wins; anyone steps back to follower. A laptop that is joining
 * another group or copying a leader's data only follows, since its log is about to be replaced.
 */
export type Role = 'leader' | 'follower' | 'candidate';

const ROLE_CHANGES: Record<Role, readonly Role[]> = {
  follower: ['follower', 'candidate', 'leader'],
  candidate: ['follower', 'leader'],
  leader: ['follower'],
};

/**
 * What a leader tells its followers about the group, so every laptop can show it. `silentMs`
 * is how long the leader has not heard from that laptop (0 while it answers).
 */
export type GroupView = Array<{ hostId: string; reachable: boolean; caughtUp: boolean; silentMs: number }>;

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

/**
 * A refusal names the laptop that leads, so a laptop coming back follows it instead of starting an
 * election. `removed` tells a laptop that the group took it out on purpose (cluster.ts).
 */
export type VoteResponse = {
  term: number;
  granted: boolean;
  leader?: ClusterMember;
  removed?: boolean;
};

export type RaftStorage = {
  /** The persisted term; a laptop never votes twice in one term, even after a restart. */
  term(): number;
  setTerm(term: number): void;
  votedFor(term: number): string | null;
  recordVote(term: number, hostId: string): void;
  head(): LogHead;
  entryId(seq: number): string | null;
  /** Null when the next entry is too large to send; the follower then takes a full copy. */
  entriesAfter(seq: number, limit: number): ReplicationLogEntry[] | null;
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
  /** When this leader started sending to it, for how long a follower that never answered has been silent. */
  since: number;
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
  /** The last entry this leader knows a majority holds. */
  let committedSeq = 0;
  let lastClockSyncAt = Number.NEGATIVE_INFINITY;
  /**
   * The full copy of a leader's data this laptop is taking, if any. A re-sync can be given up on
   * (`abort`) when that leader goes quiet; a copy made while joining runs until it ends.
   */
  let copying: { url: string; abort: AbortController | null } | null = null;
  /** Set while this laptop joins another group: it neither leads, votes, nor stores appends. */
  let joining = false;
  /** Why the last copy failed. It ends once this laptop holds the leader's log again or leads. */
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
      const silentMs = !follower || reachable ? 0 : now - (follower.lastAckAt ?? follower.since);
      return {
        hostId: member.hostId,
        reachable,
        caughtUp: reachable && (follower?.matchSeq ?? -1) >= head,
        silentMs,
      };
    });
  }

  function resetElectionDeadline(): void {
    electionDeadline = deps.now() + electionTimeoutMs * (1 + deps.random());
  }

  function roleChangeAllowed(next: Role): boolean {
    if (next !== 'follower' && (joining || copying)) return false;
    return ROLE_CHANGES[role].includes(next);
  }

  /**
   * The one place the role changes; false when ROLE_CHANGES or a join or copy forbids it. Becoming
   * leader does not call `leaderChanged`: the leader's own clock is the group's clock, so it takes
   * no samples, and following anyone after that is a change of leader again.
   */
  function changeRole(next: Role, nextLeader: ClusterMember | null = null): boolean {
    if (!roleChangeAllowed(next)) return false;
    const was = role;
    role = next;
    if (next === 'leader') {
      leader = deps.self();
      lastLeaderContactAt = deps.now();
      lastQuorumAt = deps.now();
      committedSeq = 0;
      // Only a laptop with the most complete log wins, so it lacks nothing a copy would bring.
      resyncProblem = null;
      progress.clear();
      groupView = [];
      replicateToAll();
      return true;
    }
    if (next === 'follower' && nextLeader) {
      if (leader?.hostId !== nextLeader.hostId) deps.leaderChanged();
      leader = nextLeader;
      lastLeaderContactAt = deps.now();
    } else {
      leader = null;
    }
    if (next === 'follower') resetElectionDeadline();
    if (was === 'leader') {
      progress.clear();
      settleCommitWaiters(false);
    }
    return true;
  }

  function becomeFollower(term: number, nextLeader: ClusterMember | null): void {
    setTerm(term);
    changeRole('follower', nextLeader);
  }

  // The loop: leaders send appends (which double as heartbeats); followers watch for a silent leader.

  function start(): void {
    resetElectionDeadline();
    if (deps.members().length === 1) changeRole('leader');
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
      changeRole('leader');
      return;
    }
    // A copy from a leader that went quiet would never arrive; give up, so this laptop can vote and follow again.
    if (copying?.abort && (!leaderAlive() || leader?.url !== copying.url)) {
      copying.abort.abort(new Error('de hoofdlaptop is niet meer bereikbaar'));
    }
    if (leader && leaderAlive() && now - lastClockSyncAt > CLOCK_SYNC_MS) {
      lastClockSyncAt = now;
      void deps.syncClock(leader).catch(() => undefined);
    }
    if (now >= electionDeadline && !electing && roleChangeAllowed('candidate')) void runElection();
  }

  function isCandidateIn(term: number): boolean {
    return role === 'candidate' && currentTerm() === term;
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
      // A join may have started meanwhile; roleChangeAllowed checks that again after every wait.
      if (role !== 'follower' || leaderAlive() || preVotes + 1 < majority() || !roleChangeAllowed('candidate')) return;

      const term = currentTerm() + 1;
      setTerm(term);
      storage.recordVote(term, deps.self().hostId);
      changeRole('candidate');
      const votes = await askForVotes(request(false, term));
      // An answer, a join or a newer term may have ended this candidacy while the votes came in.
      const won = isCandidateIn(term) && votes + 1 >= majority() && changeRole('leader');
      if (!won && isCandidateIn(term)) changeRole('follower');
    } finally {
      electing = false;
      if (role !== 'leader') resetElectionDeadline();
    }
  }

  async function askForVotes(request: VoteRequest): Promise<number> {
    const answers = await Promise.all(otherMembers().map((member) => deps.sendVote(member, request).catch(() => null)));
    let granted = 0;
    let someoneLeads = false;
    for (const answer of answers) {
      if (!answer) continue;
      if (answer.leader && answer.term >= currentTerm() && answer.leader.hostId !== deps.self().hostId) {
        // Someone leads already: stop this election and wait for it to get in touch rather than
        // compete. Only word from the leader itself counts as contact; two followers that passed
        // on each other's word would keep a leader that is gone alive and refuse every vote.
        becomeFollower(answer.term, null);
        someoneLeads = true;
      } else if (answer.term > currentTerm()) becomeFollower(answer.term, null);
      else if (answer.granted) granted += 1;
    }
    return someoneLeads ? 0 : granted;
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
    const others = otherMembers();
    // A laptop taken out of the group gets nothing more; were it added again, it starts afresh.
    for (const hostId of progress.keys()) {
      if (!others.some((member) => member.hostId === hostId)) progress.delete(hostId);
    }
    for (const member of others) void replicateTo(member);
  }

  async function replicateTo(member: ClusterMember): Promise<void> {
    let follower = progress.get(member.hostId);
    if (!follower) {
      follower = { member, matchSeq: null, lastAckAt: null, since: deps.now(), inFlight: false, needsResync: false };
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
        const entries =
          follower.matchSeq === null || follower.needsResync
            ? []
            : storage.entriesAfter(prevSeq, deps.maxEntriesPerAppend);
        const request: AppendRequest = {
          clusterId: deps.clusterId(),
          term,
          leaderId: deps.self().hostId,
          leaderUrl: deps.self().url,
          prevSeq,
          prevId,
          entries: entries ?? [],
          // Entries the follower needs may be pruned here, or too large to send; then it takes a full copy.
          resync: follower.needsResync || (prevSeq > 0 && prevId === null) || entries === null,
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
      // Unreachable; the next heartbeat tries again. It asks where the follower stands before sending
      // entries, so a laptop that is off costs a small message per heartbeat, not a batch of logos.
      follower.matchSeq = null;
    } finally {
      follower.inFlight = false;
    }
  }

  function advanceCommit(): void {
    const matched = [storage.head().seq, ...otherMembers().map((member) => progress.get(member.hostId)?.matchSeq ?? 0)];
    matched.sort((a, b) => b - a);
    const committed = matched[majority() - 1] ?? 0;
    committedSeq = Math.max(committedSeq, committed);
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
    // The same leader, perhaps at a new address.
    leader = nextLeader;
    lastLeaderContactAt = deps.now();
    groupView = request.group;
    resetElectionDeadline();

    if (copying) return { term: currentTerm(), ok: false, reason: 'resyncing', head: head() };
    if (request.resync) {
      startResync(nextLeader.url);
      return { term: currentTerm(), ok: false, reason: 'resyncing', head: head() };
    }
    const outcome = storage.appendFromLeader(request.prevSeq, request.prevId, request.entries);
    // This laptop holds the leader's log again, so an earlier failed copy no longer matters.
    if (outcome.ok) resyncProblem = null;
    if (!outcome.ok && outcome.reason === 'diverged') startResync(nextLeader.url);
    return { term: currentTerm(), ok: outcome.ok, reason: outcome.ok ? undefined : outcome.reason, head: head() };
  }

  function startResync(url: string): void {
    if (copying) return;
    copyFrom(url, 'pre-resync', new AbortController()).catch((error: unknown) => {
      resyncProblem = `Bijwerken vanaf de hoofdlaptop mislukt: ${error instanceof Error ? error.message : String(error)}`;
      deps.warn(resyncProblem);
    });
  }

  /** Replaces this laptop's data with a full copy from `url`, after a backup of what it had. */
  async function copyFrom(url: string, backupReason: string, abort: AbortController | null): Promise<void> {
    if (copying) throw new Error('Deze laptop haalt al een kopie op.');
    copying = { url, abort };
    try {
      const term = await deps.installCopyFrom(url, backupReason, abort?.signal ?? new AbortController().signal);
      if (Number.isSafeInteger(term) && term > currentTerm()) setTerm(term);
      resyncProblem = null;
    } finally {
      copying = null;
    }
  }

  /** The copy a join takes from the leader of the group it joins. */
  function resyncFrom(url: string, backupReason: string): Promise<void> {
    return copyFrom(url, backupReason, null);
  }

  /**
   * Becomes leader of a group of one; used only when the operator confirms the others are gone.
   * False while this laptop joins another group or copies data: it then leads nothing.
   */
  function takeOverAlone(): boolean {
    if (!roleChangeAllowed('leader')) return false;
    const term = currentTerm() + 1;
    setTerm(term);
    storage.recordVote(term, deps.self().hostId);
    return changeRole('leader');
  }

  /**
   * Stops taking part in this laptop's own group while it joins another one. False while a join
   * or a copy runs already, so only one change of group runs at a time.
   */
  function startJoining(): boolean {
    if (joining || copying) return false;
    joining = true;
    if (role !== 'follower') becomeFollower(currentTerm(), null);
    return true;
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
    isJoining: () => joining,
    isResyncing: () => copying !== null,
    /** Why the last copy failed, until this laptop holds the leader's log again or leads. */
    resyncProblem: () => resyncProblem,
    /** True while this laptop leads and a majority holds its whole log, so a change to the group can follow. */
    logSettled: () => role === 'leader' && (deps.members().length === 1 || committedSeq >= storage.head().seq),
  };
}
