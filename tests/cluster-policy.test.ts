import assert from 'node:assert/strict';
import test from 'node:test';
import { isClusterEnabled } from '../server/cluster-policy.ts';
import {
  normalizeOperationVector,
  secureEqual,
  signDiscoveryPayload,
  verifyDiscoveryPayload,
} from '../server/cluster-protocol.ts';
import { lanNetworkEndpoints, selectLanIp } from '../server/host.ts';
import { clusterCompatibilityError } from '../server/cluster-compatibility.ts';

test('cluster mode requires an explicit opt-in outside the packaged Electron wrapper', () => {
  assert.equal(isClusterEnabled({ NODE_ENV: 'production' }), false);
  assert.equal(isClusterEnabled({ CLUSTER_ENABLED: 'true' }), true);
  assert.equal(isClusterEnabled({ APOLLOON_CLUSTER: 'true' }), true);
  assert.equal(isClusterEnabled({ CLUSTER_ENABLED: 'false', NODE_ENV: 'production' }), false);
});

test('UDP discovery only accepts payloads authenticated by the cluster secret', () => {
  const payload = signDiscoveryPayload(
    {
      app: 'apolloon',
      protocol: 3,
      compatibility: {
        protocolVersion: 3,
        schemaVersion: 8,
        minimumSchemaVersion: 8,
        replicationFormatVersion: 1,
        minimumReplicationFormatVersion: 1,
        appVersion: '1.0.0',
        minimumAppVersion: '1.0.0',
        releaseId: 'test',
      },
      clusterId: 'cluster-a',
      hostId: 'host-a',
      url: 'http://192.168.1.20:5173',
      vector: { 'host-b': 2, 'host-a': 4 },
      sentAt: 1_700_000_000_000,
    },
    'shared-cluster-secret'
  );

  assert.deepEqual(
    verifyDiscoveryPayload(payload, 'shared-cluster-secret'),
    payload
  );
  assert.equal(
    verifyDiscoveryPayload(
      { ...payload, url: 'http://attacker.invalid:5173' },
      'shared-cluster-secret'
    ),
    null
  );
  assert.equal(
    verifyDiscoveryPayload(
      {
        ...payload,
        compatibility: { ...payload.compatibility, schemaVersion: 999 },
      },
      'shared-cluster-secret'
    ),
    null
  );
  assert.equal(verifyDiscoveryPayload(payload, 'wrong-secret'), null);
  assert.equal(secureEqual('same', 'same'), true);
  assert.equal(secureEqual('short', 'a-longer-secret'), false);
});

test('cluster operation vectors reject malformed or unbounded peer input', () => {
  assert.deepEqual(normalizeOperationVector({ a: 0, b: 12 }), { a: 0, b: 12 });
  assert.equal(normalizeOperationVector({ a: -1 }), null);
  assert.equal(normalizeOperationVector({ a: 1.5 }), null);
  assert.equal(normalizeOperationVector([]), null);
  assert.equal(
    normalizeOperationVector(
      Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`host-${index}`, index]))
    ),
    null
  );
});

test('cluster compatibility rejects unsafe version skew before SQL replication', () => {
  const local = {
    protocolVersion: 3,
    schemaVersion: 8,
    minimumSchemaVersion: 8,
    replicationFormatVersion: 1,
    minimumReplicationFormatVersion: 1,
    appVersion: '1.2.0',
    minimumAppVersion: '1.0.0',
    releaseId: 'local-release',
  };

  assert.equal(
    clusterCompatibilityError(
      { ...local, appVersion: '1.1.0', releaseId: 'remote-compatible' },
      local
    ),
    null
  );
  assert.match(
    clusterCompatibilityError(
      { ...local, schemaVersion: 7, minimumSchemaVersion: 7 },
      local
    ) || '',
    /Upgrade vereist.*databaseschema/
  );
  assert.match(
    clusterCompatibilityError(
      { ...local, appVersion: '2.0.0', minimumAppVersion: '2.0.0' },
      local
    ) || '',
    /Upgrade vereist.*appversie/
  );
  assert.match(clusterCompatibilityError(null, local) || '', /compatibiliteitsinformatie/);
});

test('LAN host selection ignores virtual adapters and prefers physical private networks', () => {
  const address = (value: string) => ({
    address: value,
    netmask: '255.255.255.0',
    family: 'IPv4' as const,
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: `${value}/24`,
  });

  assert.equal(
    selectLanIp({
      docker0: [address('172.17.0.1')],
      tailscale0: [address('100.64.0.2')],
      wlan0: [address('10.0.0.7')],
      enp4s0: [address('192.168.1.44')],
    }),
    '192.168.1.44'
  );
  assert.equal(
    selectLanIp({
      wlan0: [address('192.168.1.20')],
      ethernet: [
        {
          ...address('169.254.12.8'),
          netmask: '255.255.0.0',
          cidr: '169.254.12.8/16',
        },
      ],
    }),
    '169.254.12.8'
  );
  assert.deepEqual(
    lanNetworkEndpoints({
      ethernet: [address('10.42.0.7')],
    })[0],
    {
      address: '10.42.0.7',
      broadcastAddress: '10.42.0.255',
      score: 300,
    }
  );
});
