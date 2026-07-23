import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isClusterEnabled,
  shouldAcceptRemoteLeader,
  shouldGrantVote,
} from '../server/cluster-policy.ts';

test('cluster mode requires an explicit opt-in outside the packaged Electron wrapper', () => {
  assert.equal(isClusterEnabled({ NODE_ENV: 'production' }), false);
  assert.equal(isClusterEnabled({ CLUSTER_ENABLED: 'true' }), true);
  assert.equal(isClusterEnabled({ APOLLOON_CLUSTER: 'true' }), true);
  assert.equal(isClusterEnabled({ CLUSTER_ENABLED: 'false', NODE_ENV: 'production' }), false);
});

test('same-term leader selection is stable and converges on one leader', () => {
  assert.equal(
    shouldAcceptRemoteLeader({
      currentTerm: 4,
      remoteTerm: 4,
      role: 'follower',
      hostId: 'host-c',
      leaderId: 'host-b',
      remoteLeaderId: 'host-z',
    }),
    false
  );
  assert.equal(
    shouldAcceptRemoteLeader({
      currentTerm: 4,
      remoteTerm: 4,
      role: 'follower',
      hostId: 'host-c',
      leaderId: 'host-b',
      remoteLeaderId: 'host-a',
    }),
    true
  );
});

test('a follower does not vote for a competing candidate in its leader current term', () => {
  assert.equal(
    shouldGrantVote({
      candidateTerm: 7,
      currentTerm: 7,
      currentLeaderId: 'leader-a',
      candidateId: 'candidate-b',
      votedFor: null,
      candidateIsCaughtUp: true,
    }),
    false
  );
  assert.equal(
    shouldGrantVote({
      candidateTerm: 8,
      currentTerm: 7,
      currentLeaderId: 'leader-a',
      candidateId: 'candidate-b',
      votedFor: null,
      candidateIsCaughtUp: true,
    }),
    true
  );
});
