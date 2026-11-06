import assert from 'node:assert/strict';
import test from 'node:test';
import { createRaft, type AppendRequest, type AppendResponse } from '../server/raft.ts';
import type { ReplicationLogEntry } from '../server/db/types.ts';

const self = { hostId: 'a', url: 'http://a' };
const other = { hostId: 'b', url: 'http://b' };
const logo: ReplicationLogEntry = {
  seq: 1,
  id: 'logo',
  epoch: 1,
  type: 'labels.uploadImage',
  statements: [{ sql: 'INSERT INTO label_images VALUES (?)', params: ['x'.repeat(1_000)] }],
  createdAt: 0,
};

/** A leader of two laptops whose answers to appends the test gives one by one. */
function leaderWithOneFollower() {
  const sent: AppendRequest[] = [];
  const answers: Array<(request: AppendRequest) => AppendResponse> = [];
  let term = 1;
  const raft = createRaft({
    self: () => self,
    clusterId: () => 'group',
    members: () => [self, other],
    storage: {
      term: () => term,
      setTerm: (next) => {
        term = next;
      },
      votedFor: () => null,
      recordVote: () => undefined,
      head: () => ({ seq: 1, id: logo.id, epoch: 1 }),
      entryId: (seq) => (seq === 1 ? logo.id : null),
      entriesAfter: (seq) => (seq === 0 ? [logo] : []),
      canContinueFrom: () => true,
      appendFromLeader: () => ({ ok: true }),
    },
    async sendAppend(_member, request) {
      sent.push(request);
      const answer = answers.shift();
      if (!answer) throw new Error('unreachable');
      return answer(request);
    },
    sendVote: async () => null,
    installCopyFrom: async () => 1,
    syncClock: async () => undefined,
    leaderChanged: () => undefined,
    now: () => performance.now(),
    every: () => () => undefined,
    after: () => () => undefined,
    random: () => 0.5,
    warn: () => undefined,
    heartbeatMs: 150,
    electionTimeoutMs: 1_500,
    commitTimeoutMs: 4_000,
    maxEntriesPerAppend: 500,
  });
  return { raft, sent, answers };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const behindAt = (seq: number) => () => ({ term: 1, ok: false, reason: 'behind', head: { seq, id: null } });

test('a laptop that stopped answering gets no entries until it answers again', async () => {
  const { raft, sent, answers } = leaderWithOneFollower();
  // It answers the first probe, then goes off while the logo is on its way.
  answers.push(behindAt(0));
  raft.takeOverAlone();
  await settle();
  assert.deepEqual(
    sent.map((request) => request.entries.length),
    [0, 1]
  );

  // While it is off, each heartbeat is an empty probe, not the logo again.
  raft.tick();
  await settle();
  raft.tick();
  await settle();
  assert.deepEqual(
    sent.slice(2).map((request) => request.entries.length),
    [0, 0]
  );

  // Back on: it says where it stands and gets the logo.
  answers.push(behindAt(0), () => ({ term: 1, ok: true, head: { seq: 1, id: logo.id } }));
  raft.tick();
  await settle();
  assert.deepEqual(
    sent.slice(4).map((request) => request.entries.map((entry) => entry.id)),
    [[], ['logo']]
  );
  assert.equal(raft.leaderGroupView()[0]?.caughtUp, true);
});

/** A follower of two laptops whose vote answers and copies the test controls. */
function followerOfTwo({ copy = async () => 1 }: { copy?: () => Promise<number> } = {}) {
  let term = 1;
  let now = 0;
  const votes: Array<(granted: boolean) => void> = [];
  const raft = createRaft({
    self: () => self,
    clusterId: () => 'group',
    members: () => [self, other],
    storage: {
      term: () => term,
      setTerm: (next) => {
        term = next;
      },
      votedFor: () => null,
      recordVote: () => undefined,
      head: () => ({ seq: 1, id: logo.id, epoch: 1 }),
      entryId: (seq) => (seq === 1 ? logo.id : null),
      entriesAfter: () => [],
      canContinueFrom: () => true,
      appendFromLeader: () => ({ ok: true }),
    },
    sendAppend: async () => null,
    // The other laptop answers in the term this one is in when the answer arrives.
    sendVote: () => new Promise((resolve) => votes.push((granted) => resolve({ term, granted }))),
    installCopyFrom: copy,
    syncClock: async () => undefined,
    leaderChanged: () => undefined,
    now: () => now,
    every: () => () => undefined,
    after: () => () => undefined,
    random: () => 0,
    warn: () => undefined,
    heartbeatMs: 150,
    electionTimeoutMs: 1_500,
    commitTimeoutMs: 4_000,
    maxEntriesPerAppend: 500,
  });
  const appendFrom = (leader: typeof other, resync = false): AppendRequest => ({
    clusterId: 'group',
    term,
    leaderId: leader.hostId,
    leaderUrl: leader.url,
    prevSeq: 1,
    prevId: logo.id,
    entries: [],
    resync,
    group: [],
  });
  return {
    raft,
    votes,
    appendFrom,
    passTime: (ms: number) => {
      now += ms;
    },
  };
}

test('a laptop that starts joining another group during an election never leads', async () => {
  const { raft, votes, passTime } = followerOfTwo();
  passTime(2_000);
  raft.tick();
  assert.equal(votes.length, 1);
  // The pre-vote is out when Koppelen starts a join; the answer that comes back must not make it lead.
  assert.equal(raft.startJoining(), true);
  votes.shift()?.(true);
  await settle();
  assert.equal(raft.role(), 'follower');
  assert.equal(votes.length, 0);

  // A join that ends without a group leaves it free to stand again, and then it can win.
  raft.finishJoining(null);
  passTime(2_000);
  raft.tick();
  votes.shift()?.(true);
  await settle();
  assert.equal(raft.role(), 'candidate');
  // Now Koppelen starts while it waits for the real votes.
  assert.equal(raft.startJoining(), true);
  assert.equal(raft.role(), 'follower');
  votes.shift()?.(true);
  await settle();
  assert.equal(raft.role(), 'follower');
});

test('going on alone and a second join are refused while a join runs', () => {
  const { raft } = followerOfTwo();
  assert.equal(raft.startJoining(), true);
  assert.equal(raft.startJoining(), false);
  assert.equal(raft.takeOverAlone(), false);
  assert.equal(raft.role(), 'follower');
  raft.finishJoining(null);
  assert.equal(raft.takeOverAlone(), true);
  assert.equal(raft.role(), 'leader');
});

test('a failed copy stops counting as a problem once the laptop holds the leader log again', async () => {
  const { raft, appendFrom } = followerOfTwo({ copy: async () => Promise.reject(new Error('geen antwoord')) });
  raft.handleAppend(appendFrom(other, true));
  await settle();
  assert.match(raft.resyncProblem() ?? '', /Bijwerken vanaf de hoofdlaptop mislukt: geen antwoord/);
  assert.equal(raft.handleAppend(appendFrom(other)).ok, true);
  assert.equal(raft.resyncProblem(), null);
});
