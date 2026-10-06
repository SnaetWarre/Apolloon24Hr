import { canContinueFrom, planAppend, type LogView } from '../server/db/append-rules.ts';
import type { ClusterMember } from '../server/db/members.ts';
import type { ReplicationLogEntry } from '../server/db/types.ts';
import { createRaft, type Raft } from '../server/raft.ts';

/*
 * A deterministic simulation of three laptops running the real consensus
 * code (server/raft.ts) on a fake clock and a fake network. One seed fixes
 * every delay, drop, crash, partition and clock jump, so a failing seed
 * replays exactly.
 *
 * The chaos phase crashes laptops, puts them to sleep (lid closed: nothing
 * runs, messages wait, and the monotonic clock may stop), cuts links (also
 * one way), drops, delays, duplicates and reorders messages, and jumps wall
 * clocks, while a timing bot presses Space and a desk bot makes other
 * changes, both through the same forward-and-retry path as the router.
 * Consensus runs on each laptop's monotonic clock, which also drifts, as in
 * consensus.ts. After every step the invariants are checked:
 *
 * - at most one leader per term; a laptop's term never goes back, and it
 *   never votes for two laptops in one term;
 * - no two different entries are ever committed at the same position;
 * - a leader holds every entry committed in an earlier term (no lost
 *   committed write; a leader of a term that is already over may lag, but
 *   it can commit nothing and steps down at the first answer);
 * - no press is counted as a lap twice, and lap numbers never skip or repeat.
 *
 * The heal phase then restores everything and checks that the group
 * recovers by itself: one leader, a press goes through, and every laptop
 * holds the same log and every confirmed lap.
 */

export type SimOptions = {
  seed: number;
  /** Virtual milliseconds of chaos, then of healing. */
  chaosMs?: number;
  healMs?: number;
  /** Keep the whole trace instead of only its tail. */
  fullTrace?: boolean;
};

export type SimResult = {
  seed: number;
  violation: string | null;
  trace: string[];
  stats: {
    events: number;
    terms: number;
    acked: number;
    conflicts: number;
    unavailable: number;
    resyncs: number;
    crashes: number;
    clockJumps: number;
  };
};

const NODE_COUNT = 3;
const HEARTBEAT_MS = 150;
const ELECTION_TIMEOUT_MS = 1_500;
const COMMIT_TIMEOUT_MS = 4_000;
const REQUEST_TIMEOUT_MS = 1_000;
/** How long a laptop waits for a leader to start sending its copy. */
const SNAPSHOT_ANSWER_TIMEOUT_MS = 10_000;
const WRITE_DEADLINE_MS = 12_000;
/** Small batches and a short log, so batching and re-syncing after pruning are exercised. */
const MAX_ENTRIES_PER_APPEND = 4;
/**
 * Entry sizes, as consensus.ts limits them in bytes: a desk change may be a
 * logo, which fills most of a batch, or a restore, too large for any message,
 * which makes a laptop that misses it take a full copy.
 */
const MAX_BATCH_SIZE = 4;
const MAX_ENTRY_SIZE = 10;
const ENTRY_SIZES: Record<string, number> = { logo: 3, restore: 20 };
const LOG_RETENTION = 24;
const PRUNE_EVERY = 8;
const TRACE_TAIL = 300;

// Deterministic randomness (sfc32).

function createRandom(seed: number) {
  let a = 0x9e3779b9 ^ seed;
  let b = 0x243f6a88 ^ Math.imul(seed, 0x85ebca6b);
  let c = 0xb7e15162 ^ Math.imul(seed, 0xc2b2ae35);
  let d = 1;
  const next = (): number => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    const t = (a + b + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) >>> 0;
    return t / 4_294_967_296;
  };
  for (let i = 0; i < 16; i += 1) next();
  return {
    next,
    between: (min: number, max: number) => min + next() * (max - min),
    int: (min: number, max: number) => Math.floor(min + next() * (max - min + 1)),
    chance: (p: number) => next() < p,
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
  };
}

// Virtual time: a queue of events ordered by time, then by scheduling order.

type SimEvent = {
  at: number;
  order: number;
  run: () => void;
  cancelled: boolean;
  /** The laptop whose code runs; while it sleeps, the event waits. */
  node?: SimNode;
};

class EventQueue {
  private heap: SimEvent[] = [];
  private order = 0;

  push(at: number, run: () => void, node?: SimNode): SimEvent {
    return this.insert({ at, order: 0, run, cancelled: false, node });
  }

  /** Puts an event (back) in the queue at `event.at`, after everything already due then. */
  insert(event: SimEvent): SimEvent {
    event.order = this.order++;
    this.heap.push(event);
    let index = this.heap.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!before(this.heap[index], this.heap[parent])) break;
      [this.heap[index], this.heap[parent]] = [this.heap[parent], this.heap[index]];
      index = parent;
    }
    return event;
  }

  pop(): SimEvent | undefined {
    const top = this.heap[0];
    const last = this.heap.pop();
    if (this.heap.length && last) {
      this.heap[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < this.heap.length && before(this.heap[left], this.heap[smallest])) smallest = left;
        if (right < this.heap.length && before(this.heap[right], this.heap[smallest])) smallest = right;
        if (smallest === index) break;
        [this.heap[index], this.heap[smallest]] = [this.heap[smallest], this.heap[index]];
        index = smallest;
      }
    }
    return top;
  }
}

function before(a: SimEvent, b: SimEvent): boolean {
  return a.at < b.at || (a.at === b.at && a.order < b.order);
}

// The event data each laptop stores: laps and desk changes, replayed from the log.

type Lap = { pressId: string; lapNumber: number };

type AppState = {
  laps: Lap[];
  notes: string[];
  /** Results of forwarded writes by request id, like the forwarded_writes table. */
  requests: Record<string, { kind: 'lap'; lapNumber: number } | { kind: 'note'; noteId: string }>;
};

/** What survives a crash: the SQLite file. */
type Disk = {
  term: number;
  votedFor: string | null;
  /** Retained log entries, oldest first; the newest is never pruned. */
  log: ReplicationLogEntry[];
  state: AppState;
};

type WriteOp = { kind: 'lap'; pressId: string; expectedLaps: number } | { kind: 'note'; noteId: string };

type WriteOutcome =
  | { ok: true; result: { kind: 'lap'; lapNumber: number } | { kind: 'note'; noteId: string } }
  | { ok: false; code: 'CONFLICT' | 'SERVICE_UNAVAILABLE'; retry: boolean };

type Incarnation = {
  id: number;
  node: SimNode;
  raft: Raft;
  events: Set<SimEvent>;
  lastRole: string;
};

type SimNode = {
  index: number;
  member: ClusterMember;
  disk: Disk;
  /** Local clocks: the monotonic one drifts, the wall clock may also jump. */
  rate: number;
  monotonicAtZero: number;
  wallOffset: number;
  running: Incarnation | null;
  /** Set while the laptop sleeps (lid closed): nothing on it runs, messages to it wait. */
  sleepsUntil: number;
};

type Message =
  | { kind: 'append'; body: Parameters<Raft['handleAppend']>[0] }
  | { kind: 'vote'; body: Parameters<Raft['handleVoteRequest']>[0] }
  | { kind: 'snapshot' }
  | { kind: 'write'; op: WriteOp; requestId: string };

export async function simulate(options: SimOptions): Promise<SimResult> {
  const { seed } = options;
  const chaosMs = options.chaosMs ?? 40_000;
  const healMs = options.healMs ?? 45_000;
  const random = createRandom(seed);
  const queue = new EventQueue();
  let now = 0;
  let nextId = 1;
  let incarnations = 0;
  let violation: string | null = null;
  const trace: string[] = [];
  const stats: SimResult['stats'] = {
    events: 0,
    terms: 0,
    acked: 0,
    conflicts: 0,
    unavailable: 0,
    resyncs: 0,
    crashes: 0,
    clockJumps: 0,
  };

  const log = (line: string) => {
    trace.push(`[${now.toFixed(1).padStart(9)}] ${line}`);
    if (!options.fullTrace && trace.length > TRACE_TAIL * 2) trace.splice(0, trace.length - TRACE_TAIL);
  };
  const fail = (message: string) => {
    if (violation) return;
    violation = message;
    log(`VIOLATION: ${message}`);
  };

  // The network: per-link cuts and a quality that the chaos changes.
  const cut = new Set<string>();
  const network = { drop: 0, duplicate: 0, slow: 0 };
  const linkCut = (from: number, to: number) => cut.has(`${from}>${to}`);
  const delay = () => (random.chance(network.slow) ? random.between(50, 2_500) : random.between(0.2, 6));

  const nodes: SimNode[] = Array.from({ length: NODE_COUNT }, (_, index) => ({
    index,
    member: { hostId: `n${index}`, url: `sim://n${index}` },
    disk: { term: 0, votedFor: null, log: [], state: { laps: [], notes: [], requests: {} } },
    rate: 1 + random.between(-0.02, 0.02),
    monotonicAtZero: random.between(0, 1e6),
    wallOffset: random.between(1.7e12, 1.8e12),
    running: null,
    sleepsUntil: 0,
  }));
  const members = nodes.map((node) => node.member);
  const byUrl = new Map(nodes.map((node) => [node.member.url, node]));

  const monotonic = (node: SimNode) => node.monotonicAtZero + now * node.rate;
  const wall = (node: SimNode) => monotonic(node) + node.wallOffset;

  // Committed entries as leaders learned them, with the term they were first known committed in.
  const committed = new Map<number, { id: string; term: number }>();
  const committedLaps = new Map<string, { lapNumber: number; term: number }>();
  const committedNotes = new Map<string, number>();
  const leaderOfTerm = new Map<number, string>();

  /**
   * Schedules on the virtual clock. Everything a laptop schedules dies with
   * it; anything that runs on a laptop (`on`) waits while it sleeps.
   */
  function at(delayMs: number, run: () => void, owner?: Incarnation, on = owner?.node): SimEvent {
    const event = queue.push(
      now + Math.max(0, delayMs),
      () => {
        owner?.events.delete(event);
        run();
      },
      on
    );
    owner?.events.add(event);
    return event;
  }

  // Storage: the SQLite log and tables of one laptop, with the same append rules.

  function logView(disk: Disk): LogView {
    const oldest = disk.log[0]?.seq ?? null;
    return {
      headSeq: disk.log.at(-1)?.seq ?? 0,
      idAt: (seq) => (oldest === null || seq < oldest ? null : (disk.log[seq - oldest]?.id ?? null)),
      oldestSeq: () => oldest,
    };
  }

  function entrySize(entry: ReplicationLogEntry): number {
    const noteId = entry.statements[0]?.sql === 'note' ? String(entry.statements[0].params[0]) : '';
    return ENTRY_SIZES[noteId.replace(/\d+$/, '')] ?? 1;
  }

  function applyEntry(node: SimNode, entry: ReplicationLogEntry): void {
    const { state } = node.disk;
    for (const { sql, params } of entry.statements) {
      if (sql === 'lap') {
        const [pressId, lapNumber, requestId] = params as [string, number, string | null];
        if (state.laps.some((lap) => lap.pressId === pressId))
          fail(`${node.member.hostId} counts press ${pressId} twice`);
        if (lapNumber !== state.laps.length + 1) {
          fail(`${node.member.hostId} stores lap ${lapNumber} after ${state.laps.length} laps (entry ${entry.seq})`);
        }
        state.laps.push({ pressId, lapNumber });
        if (requestId) state.requests[requestId] = { kind: 'lap', lapNumber };
      } else if (sql === 'note') {
        const [noteId, requestId] = params as [string, string | null];
        if (state.notes.includes(noteId)) fail(`${node.member.hostId} applies change ${noteId} twice`);
        state.notes.push(noteId);
        if (requestId) state.requests[requestId] = { kind: 'note', noteId };
      }
    }
    node.disk.log.push(entry);
    if (entry.seq % PRUNE_EVERY === 0) {
      const keepFrom = entry.seq - LOG_RETENTION;
      while (node.disk.log.length > 1 && node.disk.log[0].seq <= keepFrom) node.disk.log.shift();
    }
  }

  function votedFor(disk: Disk, term: number): string | null {
    return disk.votedFor?.startsWith(`${term}:`) ? disk.votedFor.slice(`${term}:`.length) : null;
  }

  function storage(node: SimNode): Parameters<typeof createRaft>[0]['storage'] {
    const disk = () => node.disk;
    return {
      term: () => disk().term,
      setTerm: (term) => {
        if (term < disk().term) fail(`${node.member.hostId} goes back from term ${disk().term} to ${term}`);
        disk().term = term;
      },
      votedFor: (term) => votedFor(disk(), term),
      recordVote: (term, hostId) => {
        const earlier = votedFor(disk(), term);
        if (earlier && earlier !== hostId)
          fail(`${node.member.hostId} votes for ${earlier} and ${hostId} in term ${term}`);
        disk().votedFor = `${term}:${hostId}`;
      },
      head: () => {
        const last = disk().log.at(-1);
        return last ? { seq: last.seq, id: last.id, epoch: last.epoch } : { seq: 0, id: null, epoch: 0 };
      },
      entryId: (seq) => logView(disk()).idAt(seq),
      entriesAfter: (seq, limit) => {
        const batch: ReplicationLogEntry[] = [];
        let size = 0;
        for (const entry of disk().log) {
          if (entry.seq <= seq) continue;
          if (!batch.length && entrySize(entry) > MAX_ENTRY_SIZE) return null;
          if (batch.length === limit || (batch.length && size + entrySize(entry) > MAX_BATCH_SIZE)) break;
          size += entrySize(entry);
          batch.push(entry);
        }
        return structuredClone(batch);
      },
      canContinueFrom: (seq, id) => canContinueFrom(logView(disk()), seq, id),
      appendFromLeader: (prevSeq, prevId, entries) => {
        const plan = planAppend(logView(disk()), prevSeq, prevId, entries);
        if (!plan.ok) return plan;
        const head = logView(disk()).headSeq;
        plan.fresh.forEach((entry, offset) => {
          if (entry.seq !== head + offset + 1) fail(`${node.member.hostId} got a gap at ${entry.seq}`);
          applyEntry(node, structuredClone(entry));
        });
        return { ok: true };
      },
    };
  }

  // The network between laptops: every request may be lost, delayed, duplicated, or answered too late.

  function request<T>(
    from: SimNode,
    owner: Incarnation,
    to: string,
    message: Message,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<T> {
    const target = byUrl.get(to);
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const giveUp = (reason: string) => {
        if (settled || from.running !== owner) return;
        settled = true;
        timer.cancelled = true;
        reject(new Error(reason));
      };
      const timer = at(timeoutMs / from.rate, () => giveUp('timeout'), owner);
      signal?.addEventListener('abort', () => giveUp('aborted'));
      const deliver = () => {
        if (!target) return;
        const receiver = target.running;
        if (!receiver || linkCut(from.index, target.index) || random.chance(network.drop)) return;
        void Promise.resolve(handle(target, receiver, structuredClone(message))).then((answer) => {
          if (target.running !== receiver) return;
          if (linkCut(target.index, from.index) || random.chance(network.drop)) return;
          at(
            delay(),
            () => {
              if (settled || from.running !== owner) return;
              settled = true;
              timer.cancelled = true;
              owner.events.delete(timer);
              resolve(structuredClone(answer) as T);
            },
            undefined,
            from
          );
        });
      };
      at(delay(), deliver, undefined, target);
      if (random.chance(network.duplicate)) at(delay() + random.between(0, 400), deliver, undefined, target);
    });
  }

  /** What a laptop answers; null stands for an HTTP error such as "not the leader". */
  function handle(node: SimNode, incarnation: Incarnation, message: Message): unknown {
    const { raft } = incarnation;
    switch (message.kind) {
      case 'append':
        return raft.handleAppend(message.body);
      case 'vote':
        return raft.handleVoteRequest(message.body);
      case 'snapshot':
        if (raft.role() !== 'leader' || raft.isResyncing()) return null;
        return { term: raft.currentTerm(), log: node.disk.log, state: node.disk.state };
      case 'write':
        return commitHere(node, incarnation, message.op, message.requestId);
    }
  }

  // The router's write path: commit on the leader, or pass it on and repeat it until it lands.

  function newEntry(node: SimNode, type: string, statements: ReplicationLogEntry['statements']): number {
    const seq = logView(node.disk).headSeq + 1;
    applyEntry(node, {
      seq,
      id: `e${nextId++}`,
      epoch: node.disk.term,
      type,
      statements,
      createdAt: Math.round(wall(node)),
    });
    return seq;
  }

  async function commitHere(
    node: SimNode,
    incarnation: Incarnation,
    op: WriteOp,
    requestId?: string
  ): Promise<WriteOutcome> {
    const { raft } = incarnation;
    if (raft.role() !== 'leader' || raft.isResyncing()) return { ok: false, code: 'SERVICE_UNAVAILABLE', retry: true };
    const { state } = node.disk;
    const earlier = requestId ? state.requests[requestId] : undefined;
    let result: Extract<WriteOutcome, { ok: true }>['result'];
    if (earlier) {
      newEntry(node, 'touch', [{ sql: 'touch', params: [requestId!] }]);
      result = earlier;
    } else if (op.kind === 'lap') {
      if (state.laps.length !== op.expectedLaps) return { ok: false, code: 'CONFLICT', retry: false };
      result = { kind: 'lap', lapNumber: state.laps.length + 1 };
      newEntry(node, 'lap', [{ sql: 'lap', params: [op.pressId, result.lapNumber, requestId ?? null] }]);
    } else {
      result = { kind: 'note', noteId: op.noteId };
      newEntry(node, 'note', [{ sql: 'note', params: [op.noteId, requestId ?? null] }]);
    }
    const seq = logView(node.disk).headSeq;
    const id = logView(node.disk).idAt(seq)!;
    if (!(await raft.waitForCommit(seq))) return { ok: false, code: 'SERVICE_UNAVAILABLE', retry: true };
    // Still leading, so this log is the one that was committed, up to `seq`.
    if (node.disk.log.at(-1)!.seq < seq || logView(node.disk).idAt(seq) !== id)
      fail(`${node.member.hostId} lost ${seq}`);
    for (const entry of node.disk.log) if (entry.seq <= seq) recordCommitted(entry, node.disk.term);
    log(
      `${node.member.hostId} committed ${seq} (${result.kind === 'lap' ? `lap ${result.lapNumber}` : result.noteId})`
    );
    return { ok: true, result };
  }

  function recordCommitted(entry: ReplicationLogEntry, term: number): void {
    const known = committed.get(entry.seq);
    if (known && known.id !== entry.id)
      fail(`two different entries committed at ${entry.seq}: ${known.id} and ${entry.id}`);
    if (known) return;
    committed.set(entry.seq, { id: entry.id, term });
    for (const { sql, params } of entry.statements) {
      if (sql === 'lap') {
        const [pressId, lapNumber] = params as [string, number];
        const knownLap = committedLaps.get(pressId);
        if (knownLap && knownLap.lapNumber !== lapNumber) {
          fail(`press ${pressId} committed as lap ${knownLap.lapNumber} and ${lapNumber}`);
        }
        committedLaps.set(pressId, { lapNumber, term });
      } else if (sql === 'note') committedNotes.set(params[0] as string, term);
    }
  }

  const sleep = (node: SimNode, owner: Incarnation, ms: number) =>
    new Promise<void>((resolve) => at(ms / node.rate, resolve, owner));

  /** router.write: wait for a leader, then commit here or forward; repeat after a takeover. */
  async function write(node: SimNode, owner: Incarnation, op: WriteOp): Promise<WriteOutcome> {
    const deadline = monotonic(node) + WRITE_DEADLINE_MS;
    let requestId: string | undefined;
    for (;;) {
      const raft = owner.raft;
      let target: 'self' | ClusterMember | null = null;
      while (monotonic(node) < deadline) {
        if (!raft.isResyncing() && raft.leaderAlive()) {
          target = raft.role() === 'leader' ? 'self' : (raft.leader() ?? 'self');
          break;
        }
        await sleep(node, owner, 50);
      }
      if (target === null) return { ok: false, code: 'SERVICE_UNAVAILABLE', retry: false };
      if (target === 'self') return commitHere(node, owner, op, requestId);
      requestId ??= `r${nextId++}`;
      const outcome = await request<WriteOutcome | null>(
        node,
        owner,
        target.url,
        { kind: 'write', op, requestId },
        COMMIT_TIMEOUT_MS + 1_000
      ).catch(() => null);
      if (outcome?.ok) return outcome;
      if ((!outcome || outcome.retry) && monotonic(node) < deadline) {
        await sleep(node, owner, 100);
        continue;
      }
      return outcome ?? { ok: false, code: 'SERVICE_UNAVAILABLE', retry: false };
    }
  }

  // Laptops: start, crash, restart.

  function boot(node: SimNode): void {
    const incarnation: Incarnation = {
      id: ++incarnations,
      node,
      raft: null!,
      events: new Set(),
      lastRole: 'follower',
    };
    node.running = incarnation;
    const alive = () => node.running === incarnation;
    incarnation.raft = createRaft({
      self: () => node.member,
      clusterId: () => 'sim',
      members: () => members,
      storage: storage(node),
      sendAppend: (member, body) =>
        request(node, incarnation, member.url, { kind: 'append', body }, REQUEST_TIMEOUT_MS),
      sendVote: (member, body) => request(node, incarnation, member.url, { kind: 'vote', body }, REQUEST_TIMEOUT_MS),
      async installCopyFrom(url, _backupReason, signal) {
        stats.resyncs += 1;
        log(`${node.member.hostId} re-syncs from ${url}`);
        const copy = await request<{ term: number; log: ReplicationLogEntry[]; state: AppState } | null>(
          node,
          incarnation,
          url,
          { kind: 'snapshot' },
          SNAPSHOT_ANSWER_TIMEOUT_MS,
          signal
        );
        if (!copy) throw new Error('not the leader');
        // The backup before installing takes a while, and may fail.
        await sleep(node, incarnation, random.between(20, 600));
        if (random.chance(0.05)) throw new Error('backup failed');
        if (!alive()) return new Promise<number>(() => undefined);
        node.disk.log = copy.log;
        node.disk.state = copy.state;
        log(`${node.member.hostId} installed a copy up to ${copy.log.at(-1)?.seq ?? 0} (term ${copy.term})`);
        return copy.term;
      },
      syncClock: async () => undefined,
      leaderChanged: () => undefined,
      now: () => monotonic(node),
      every(ms, callback) {
        let event: SimEvent;
        const schedule = () => {
          event = at(
            ms / node.rate,
            () => {
              schedule();
              callback();
            },
            incarnation
          );
        };
        schedule();
        return () => {
          event.cancelled = true;
        };
      },
      after(ms, callback) {
        const event = at(ms / node.rate, callback, incarnation);
        return () => {
          event.cancelled = true;
        };
      },
      random: random.next,
      warn: (message) => log(`${node.member.hostId}: ${message}`),
      heartbeatMs: HEARTBEAT_MS,
      electionTimeoutMs: ELECTION_TIMEOUT_MS,
      commitTimeoutMs: COMMIT_TIMEOUT_MS,
      maxEntriesPerAppend: MAX_ENTRIES_PER_APPEND,
    });
    incarnation.raft.start();
    log(`${node.member.hostId} starts (term ${node.disk.term}, log ${logView(node.disk).headSeq})`);
  }

  function crash(node: SimNode): void {
    const incarnation = node.running;
    if (!incarnation) return;
    for (const event of incarnation.events) event.cancelled = true;
    node.running = null;
    stats.crashes += 1;
    log(`${node.member.hostId} loses power`);
  }

  // Invariants, checked after every step.

  function checkLeader(node: SimNode): void {
    const incarnation = node.running!;
    const role = incarnation.raft.role();
    if (role !== incarnation.lastRole) {
      log(`${node.member.hostId} is ${role} in term ${node.disk.term} (log ${logView(node.disk).headSeq})`);
      incarnation.lastRole = role;
      if (role === 'leader') {
        stats.terms += 1;
        checkLeaderHoldsCommitted(node);
      }
    }
    if (role !== 'leader') return;
    const term = node.disk.term;
    const known = leaderOfTerm.get(term);
    if (known && known !== node.member.hostId) fail(`two leaders in term ${term}: ${known} and ${node.member.hostId}`);
    leaderOfTerm.set(term, node.member.hostId);
  }

  function checkLeaderHoldsCommitted(node: SimNode): void {
    const view = logView(node.disk);
    const term = node.disk.term;
    const who = `leader ${node.member.hostId} of term ${term}`;
    for (const [seq, entry] of committed) {
      if (entry.term >= term) continue;
      if (seq > view.headSeq) fail(`${who} lacks entry ${seq}, committed in term ${entry.term}`);
      else if (seq >= (view.oldestSeq() ?? Infinity) && view.idAt(seq) !== entry.id) {
        fail(`${who} holds ${view.idAt(seq)} at ${seq}, committed in term ${entry.term} was ${entry.id}`);
      }
    }
    checkStateHoldsCommitted(node, who, term);
  }

  /** The laps and changes committed before `beforeTerm` are all in this laptop's data. */
  function checkStateHoldsCommitted(node: SimNode, who: string, beforeTerm = Infinity): void {
    const laps = new Map(node.disk.state.laps.map((lap) => [lap.pressId, lap.lapNumber]));
    for (const [pressId, { lapNumber, term }] of committedLaps) {
      if (term < beforeTerm && laps.get(pressId) !== lapNumber)
        fail(`${who} lost committed lap ${lapNumber} (${pressId})`);
    }
    const notes = new Set(node.disk.state.notes);
    for (const [noteId, term] of committedNotes) {
      if (term < beforeTerm && !notes.has(noteId)) fail(`${who} lost committed change ${noteId}`);
    }
  }

  // The bots: an operator pressing Space on the timing screen, and a desk making other changes.

  let botsRunning = true;
  const acked = new Map<string, number>();

  /**
   * A bot acts every few hundred milliseconds on a random running laptop, one
   * write at a time; when that laptop dies mid-write, the bot moves on.
   */
  function runBot(minMs: number, maxMs: number, nextOp: (node: SimNode) => WriteOp): void {
    let pending: Incarnation | null = null;
    const step = () => {
      if (!botsRunning) return;
      at(random.between(minMs, maxMs), step);
      if (pending && nodes.some((node) => node.running === pending)) return;
      const running = nodes.filter((node) => node.running);
      if (!running.length) return;
      const node = random.pick(running);
      const owner = node.running!;
      const op = nextOp(node);
      pending = owner;
      void write(node, owner, op).then((outcome) => {
        if (pending === owner) pending = null;
        record(op, outcome);
      });
    };
    at(random.between(minMs, maxMs), step);
  }

  function timingPress(node: SimNode): WriteOp {
    const op: WriteOp = { kind: 'lap', pressId: `p${nextId++}`, expectedLaps: node.disk.state.laps.length };
    log(`${node.member.hostId}: Space (${op.pressId}, screen shows ${op.expectedLaps} laps)`);
    return op;
  }

  function record(op: WriteOp, outcome: WriteOutcome): void {
    const name = op.kind === 'lap' ? op.pressId : op.noteId;
    if (outcome.ok) {
      stats.acked += 1;
      if (outcome.result.kind === 'lap') {
        acked.set(name, outcome.result.lapNumber);
        if (committedLaps.get(name)?.lapNumber !== outcome.result.lapNumber)
          fail(`press ${name} confirmed but not committed`);
      } else if (!committedNotes.has(name)) fail(`change ${name} confirmed but not committed`);
      log(`${name} confirmed`);
    } else if (outcome.code === 'CONFLICT') {
      stats.conflicts += 1;
      log(`${name} refused: the screen was behind`);
    } else {
      stats.unavailable += 1;
      log(`${name} not saved`);
    }
  }

  // Chaos: something goes wrong every few hundred milliseconds.

  function scheduleChaos(): void {
    at(random.between(100, 2_000), () => {
      if (now >= chaosMs) return;
      const node = random.pick(nodes);
      const other = random.pick(nodes.filter((candidate) => candidate !== node));
      switch (random.int(0, 9)) {
        case 0:
        case 1:
          if (node.running) {
            crash(node);
            at(random.between(50, 8_000), () => {
              if (!node.running) boot(node);
            });
          }
          break;
        case 2:
          for (const peer of nodes) {
            if (peer === node) continue;
            cut.add(`${node.index}>${peer.index}`);
            cut.add(`${peer.index}>${node.index}`);
          }
          log(`${node.member.hostId} cable pulled`);
          break;
        case 3:
          cut.add(`${node.index}>${other.index}`);
          log(`link ${node.member.hostId} → ${other.member.hostId} breaks one way`);
          break;
        case 4:
          cut.clear();
          log('all cables back');
          break;
        case 5:
          network.drop = random.pick([0, 0, 0.05, 0.2, 0.5]);
          network.duplicate = random.pick([0, 0.05, 0.3]);
          network.slow = random.pick([0, 0.01, 0.1, 0.3]);
          log(`network: drop ${network.drop}, duplicate ${network.duplicate}, slow ${network.slow}`);
          break;
        case 7:
          if (node.running && node.sleepsUntil <= now) {
            // Closing the lid: on some systems the monotonic clock stops while asleep.
            const sleepMs = random.pick([300, 1_000, 3_000, 10_000]) * random.between(0.5, 1.5);
            node.sleepsUntil = now + sleepMs;
            const clockStops = random.chance(0.5);
            if (clockStops) node.monotonicAtZero -= sleepMs * node.rate;
            log(`${node.member.hostId} sleeps ${Math.round(sleepMs)} ms${clockStops ? ', its clock stops' : ''}`);
          }
          break;
        case 6: {
          const jump = random.pick([-1, 1]) * random.pick([200, 1_000, 5_000, 60_000, 600_000]) * random.next();
          node.wallOffset += jump;
          stats.clockJumps += 1;
          log(`${node.member.hostId} wall clock jumps ${Math.round(jump)} ms`);
          break;
        }
        default:
          break;
      }
      scheduleChaos();
    });
  }

  function heal(): void {
    botsRunning = false;
    cut.clear();
    Object.assign(network, { drop: 0, duplicate: 0, slow: 0 });
    for (const node of nodes) if (!node.running) boot(node);
    log('HEAL: everything back, bots stop');
    // Once the dust settles, one more press must go through.
    at(20_000, () => {
      const node = random.pick(nodes);
      const owner = node.running!;
      log(`${node.member.hostId}: final Space`);
      const op = timingPress(node);
      void write(node, owner, op).then((outcome) => {
        record(op, outcome);
        if (!outcome.ok) fail(`after healing, a press on ${node.member.hostId} failed (${outcome.code})`);
      });
    });
  }

  function checkRecovered(): void {
    const leaders = nodes.filter((node) => node.running?.raft.role() === 'leader');
    if (leaders.length !== 1) return fail(`after healing, ${leaders.length} leaders`);
    const [leader] = leaders;
    for (const node of nodes) {
      const raft = node.running!.raft;
      if (node !== leader && (raft.leader()?.hostId !== leader.member.hostId || !raft.leaderAlive())) {
        return fail(`after healing, ${node.member.hostId} does not follow ${leader.member.hostId}`);
      }
      if (raft.isResyncing()) return fail(`after healing, ${node.member.hostId} is still re-syncing`);
      const head = logView(node.disk);
      const leaderHead = logView(leader.disk);
      if (head.headSeq !== leaderHead.headSeq || head.idAt(head.headSeq) !== leaderHead.idAt(leaderHead.headSeq)) {
        return fail(`after healing, ${node.member.hostId} is at ${head.headSeq}, the leader at ${leaderHead.headSeq}`);
      }
      if (JSON.stringify(node.disk.state.laps) !== JSON.stringify(leader.disk.state.laps)) {
        return fail(`after healing, ${node.member.hostId} shows other laps than the leader`);
      }
      checkStateHoldsCommitted(node, node.member.hostId);
      for (const [pressId, lapNumber] of acked) {
        if (!node.disk.state.laps.some((lap) => lap.pressId === pressId && lap.lapNumber === lapNumber)) {
          return fail(`after healing, ${node.member.hostId} lacks confirmed lap ${lapNumber}`);
        }
      }
    }
  }

  // Run.

  for (const node of nodes) at(random.between(0, 300), () => boot(node));
  runBot(200, 1_500, timingPress);
  let deskChanges = 0;
  runBot(300, 3_000, () => {
    deskChanges += 1;
    const kind = deskChanges % 7 === 0 ? 'restore' : deskChanges % 3 === 0 ? 'logo' : 'c';
    return { kind: 'note', noteId: `${kind}${nextId++}` };
  });
  scheduleChaos();
  at(chaosMs, heal);
  const end = chaosMs + healMs;
  at(end, checkRecovered);

  for (let event = queue.pop(); event && !violation; event = queue.pop()) {
    if (event.cancelled) continue;
    if (event.at > end) break;
    if (event.node && event.node.sleepsUntil > event.at) {
      event.at = event.node.sleepsUntil;
      queue.insert(event);
      continue;
    }
    now = event.at;
    event.run();
    // Let every promise the step resolved run to completion before the next step.
    await new Promise((resolve) => setImmediate(resolve));
    stats.events += 1;
    for (const node of nodes) if (node.running) checkLeader(node);
  }

  return { seed, violation, trace: options.fullTrace ? trace : trace.slice(-TRACE_TAIL), stats };
}
