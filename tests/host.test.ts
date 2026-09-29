import assert from 'node:assert/strict';
import test from 'node:test';
import type os from 'node:os';
import { isClusterEnabled } from '../server/env.ts';
import { lanAddresses, lanNetworks } from '../server/host.ts';

test('laptop coupling requires an explicit opt-in outside the packaged Electron app', () => {
  assert.equal(isClusterEnabled({ NODE_ENV: 'production' }), false);
  assert.equal(isClusterEnabled({ CLUSTER_ENABLED: 'true' }), true);
  assert.equal(isClusterEnabled({ CLUSTER_ENABLED: 'false' }), false);
});

test('the event URL prefers a wired private address over wifi and virtual adapters', () => {
  const address = (value: string): os.NetworkInterfaceInfo => ({
    address: value,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: `${value}/24`,
  });
  assert.deepEqual(
    lanAddresses({
      lo: [{ ...address('127.0.0.1'), internal: true }],
      docker0: [address('172.17.0.1')],
      wlan0: [address('192.168.1.40')],
      enp3s0: [address('192.168.50.10')],
    }),
    ['192.168.50.10', '192.168.1.40']
  );
  assert.deepEqual(lanAddresses({ tailscale0: [address('100.64.0.1')] }), []);
});

test('laptops announce themselves on the broadcast address of each network', () => {
  const network = (value: string, netmask: string): os.NetworkInterfaceInfo => ({
    address: value,
    netmask,
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: null,
  });
  assert.deepEqual(
    lanNetworks({
      enp3s0: [network('192.168.50.10', '255.255.255.0')],
      wlan0: [network('10.1.20.7', '255.255.240.0')],
    }),
    [
      { address: '192.168.50.10', broadcastAddress: '192.168.50.255' },
      { address: '10.1.20.7', broadcastAddress: '10.1.31.255' },
    ]
  );
});
