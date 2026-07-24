import assert from 'node:assert/strict';
import test from 'node:test';
import { isClusterEnabled } from '../server/cluster-policy.ts';

test('cluster mode requires an explicit opt-in outside the packaged Electron wrapper', () => {
  assert.equal(isClusterEnabled({ NODE_ENV: 'production' }), false);
  assert.equal(isClusterEnabled({ CLUSTER_ENABLED: 'true' }), true);
  assert.equal(isClusterEnabled({ APOLLOON_CLUSTER: 'true' }), true);
  assert.equal(isClusterEnabled({ CLUSTER_ENABLED: 'false', NODE_ENV: 'production' }), false);
});
