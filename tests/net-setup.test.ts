import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildLinuxRevertDhcpScript,
  buildLinuxSetStaticScript,
  buildMacOsRevertDhcpCommand,
  buildMacOsSetManualCommand,
  escapeAppleScriptString,
  isApipaAddress,
  isLoopbackAddress,
  isPrivateLanAddress,
  maskToPrefixLength,
  parseIpv4,
  parseNetworksetupHardwarePorts,
  parseNetworksetupInfo,
  parseNmcliActiveConnections,
  parseNmcliDeviceFields,
  prefixLengthToMask,
  sameSubnet,
  shQuote,
  validateStaticRequest,
  buildWindowsLauncherCommand,
  describeElevationFailure,
  isWirelessWindowsAdapter,
  isWiredNmConnectionType,
  isWirelessMacService,
} from '../server/net-setup.ts';

test('only real loopback callers may change host networking', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('192.168.1.211'), false);
  assert.equal(isLoopbackAddress('10.0.0.5'), false);
  assert.equal(isLoopbackAddress(undefined), false);
  assert.equal(isLoopbackAddress(''), false);
});

test('IPv4 parsing rejects hostnames and out-of-range octets', () => {
  assert.deepEqual(parseIpv4('192.168.1.211'), [192, 168, 1, 211]);
  assert.deepEqual(parseIpv4(' 10.0.0.5 '), [10, 0, 0, 5]);
  assert.deepEqual(parseIpv4('10.0.0.5'), [10, 0, 0, 5]);
  assert.equal(parseIpv4('192.168.1.256'), null);
  assert.equal(parseIpv4('192.168.1'), null);
  assert.equal(parseIpv4('telsysteem1.local'), null);
  assert.equal(parseIpv4('192.168.1.1; rm -rf /'), null);
  assert.equal(parseIpv4(''), null);
  assert.equal(parseIpv4(undefined), null);
});

test('APIPA and private ranges are classified correctly', () => {
  assert.equal(isApipaAddress('169.254.10.20'), true);
  assert.equal(isApipaAddress('192.168.1.211'), false);
  assert.equal(isPrivateLanAddress('192.168.1.211'), true);
  assert.equal(isPrivateLanAddress('10.3.0.9'), true);
  assert.equal(isPrivateLanAddress('172.20.4.4'), true);
  assert.equal(isPrivateLanAddress('8.8.8.8'), false);
  assert.equal(isPrivateLanAddress('169.254.10.20'), false);
});

test('same-subnet check catches third-octet mismatches', () => {
  assert.equal(sameSubnet('192.168.1.211', '192.168.1.1'), true);
  assert.equal(sameSubnet('192.168.1.211', '192.168.10.1'), false);
  assert.equal(sameSubnet('192.168.1.211', 'not-an-ip'), false);
});

test('prefix length helper only allows sane masks', () => {
  assert.equal(prefixLengthToMask(24), '255.255.255.0');
  assert.equal(prefixLengthToMask(16), '255.255.0.0');
  assert.equal(prefixLengthToMask(12), '255.240.0.0');
  assert.equal(prefixLengthToMask(33), null);
  assert.equal(prefixLengthToMask(7), null);
});

test('static-IP requests accept the happy path', () => {
  const result = validateStaticRequest({ ip: '192.168.1.211', prefixLength: 24, gateway: '192.168.1.1' });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.ip, '192.168.1.211');
    assert.equal(result.gateway, '192.168.1.1');
  }
  const isolated = validateStaticRequest({ ip: '192.168.10.11', gateway: '' });
  assert.equal(isolated.ok, true);
});

test('static-IP requests refuse APIPA, broadcast and cross-subnet gateways', () => {
  assert.equal(validateStaticRequest({ ip: '169.254.10.20' }).ok, false);
  assert.equal(validateStaticRequest({ ip: '192.168.1.0' }).ok, false);
  assert.equal(validateStaticRequest({ ip: '192.168.1.255' }).ok, false);
  assert.equal(validateStaticRequest({ ip: 'telsysteem1' }).ok, false);
  assert.equal(validateStaticRequest({ ip: '192.168.1.211', prefixLength: 12 }).ok, false);
  const crossGateway = validateStaticRequest({ ip: '192.168.1.211', gateway: '192.168.10.1' });
  assert.equal(crossGateway.ok, false);
});

test('mask round-trips between prefix length and dotted form', () => {
  assert.equal(maskToPrefixLength('255.255.255.0'), 24);
  assert.equal(maskToPrefixLength('255.255.0.0'), 16);
  assert.equal(maskToPrefixLength('255.240.0.0'), 12);
  assert.equal(maskToPrefixLength('255.0.255.0'), null);
  assert.equal(maskToPrefixLength('255.255.255.1'), null);
  assert.equal(maskToPrefixLength('not-a-mask'), null);
  assert.equal(maskToPrefixLength(''), null);
});

test('shell and AppleScript quoting neutralises system names', () => {
  assert.equal(shQuote('Wired connection 1'), "'Wired connection 1'");
  assert.equal(shQuote("a'b"), "'a'\\''b'");
  const quoted = shQuote('x; rm -rf /');
  assert.equal(quoted, "'x; rm -rf /'");
  // Binnen de buitenste quotes mag geen enkele losse quote staan (geen uitbraak mogelijk).
  assert.ok(!quoted.slice(1, -1).includes("'"));
  assert.equal(escapeAppleScriptString('a"b\\c'), 'a\\"b\\\\c');
});

test('nmcli active connections parse with escaped colons', () => {
  const parsed = parseNmcliActiveConnections(
    'Wired connection 1:enp0s3:ethernet\nMy\\:Colon\\:Name:wlan0:wifi\nbroken-line\n'
  );
  assert.deepEqual(parsed, [
    { name: 'Wired connection 1', device: 'enp0s3', type: 'ethernet' },
    { name: 'My:Colon:Name', device: 'wlan0', type: 'wifi' },
  ]);
});

test('nmcli device fields keep only the first colon as separator', () => {
  const fields = parseNmcliDeviceFields(
    'IP4.ADDRESS[1]:192.168.1.211/24\nIP4.GATEWAY:192.168.1.1\nGENERAL.STATE:100 (connected)\n'
  );
  assert.equal(fields.get('IP4.ADDRESS[1]'), '192.168.1.211/24');
  assert.equal(fields.get('IP4.GATEWAY'), '192.168.1.1');
});

test('macOS hardware ports and service info parse correctly', () => {
  const ports = parseNetworksetupHardwarePorts(
    'Hardware Port: Wi-Fi\nDevice: en0\nEthernet Address: aa:bb:cc:dd:ee:ff\n\nHardware Port: USB 10/100/1000 LAN\nDevice: en7\nEthernet Address: 11:22:33:44:55:66\n'
  );
  assert.deepEqual(ports, [
    { port: 'Wi-Fi', device: 'en0' },
    { port: 'USB 10/100/1000 LAN', device: 'en7' },
  ]);
  const manual = parseNetworksetupInfo(
    'Manual Configuration\nIP address: 192.168.10.11\nSubnet mask: 255.255.255.0\nRouter: 192.168.10.1\n'
  );
  assert.deepEqual(manual, { manual: true, ip: '192.168.10.11', mask: '255.255.255.0', router: '192.168.10.1' });
  const dhcp = parseNetworksetupInfo(
    'DHCP Configuration\nIP address: 192.168.1.50\nSubnet mask: 255.255.255.0\nRouter: 192.168.1.1\n'
  );
  assert.equal(dhcp.manual, false);
  const empty = parseNetworksetupInfo('An IPv6 address has been assigned\n');
  assert.equal(empty.manual, null);
  assert.equal(empty.ip, null);
});

test('Linux and macOS command builders quote names and carry validated values', () => {
  const setScript = buildLinuxSetStaticScript('Wired connection 1', '192.168.1.211', 24, null);
  assert.ok(setScript.includes(`nmcli con mod 'Wired connection 1' ipv4.addresses 192.168.1.211/24`));
  assert.ok(setScript.includes('ipv4.method manual'));
  assert.ok(setScript.includes('ufw allow 5173/tcp'));
  assert.ok(setScript.includes('ufw allow 45737/udp'), 'laptops announce themselves on UDP');
  const setGw = buildLinuxSetStaticScript('Eth', '192.168.1.211', 24, '192.168.1.1');
  assert.ok(setGw.includes('ipv4.gateway 192.168.1.1'));
  const revert = buildLinuxRevertDhcpScript('Eth');
  assert.ok(revert.includes('ipv4.method auto'));
  const macSet = buildMacOsSetManualCommand('USB 10/100/1000 LAN', '192.168.10.11', '255.255.255.0', null);
  assert.equal(macSet, `networksetup -setmanual 'USB 10/100/1000 LAN' 192.168.10.11 255.255.255.0`);
  const macGw = buildMacOsSetManualCommand('Ethernet', '192.168.1.211', '255.255.255.0', '192.168.1.1');
  assert.ok(macGw.endsWith('192.168.1.1'));
  assert.equal(buildMacOsRevertDhcpCommand('Ethernet'), `networksetup -setdhcp 'Ethernet'`);
});

test('only wired connections may be pinned, never wifi', () => {
  assert.equal(isWiredNmConnectionType('802-3-ethernet'), true);
  assert.equal(isWiredNmConnectionType('ethernet'), true);
  assert.equal(isWiredNmConnectionType('802-11-wireless'), false);
  assert.equal(isWiredNmConnectionType('wifi'), false);
  assert.equal(isWirelessMacService('Wi-Fi'), true);
  assert.equal(isWirelessMacService('USB 10/100/1000 LAN'), false);
});

test('a missing polkit agent or refused prompt is explained instead of silently waited on', () => {
  const noAgent = describeElevationFailure(
    'linux',
    127,
    "Error creating textual authentication agent: Error opening current controlling terminal for the process (`/dev/tty')"
  );
  assert.match(noAgent, /geen polkit-agent/);
  assert.match(describeElevationFailure('linux', 126, ''), /geweigerd/);
  assert.match(describeElevationFailure('darwin', 1, 'execution error: User canceled. (-128)'), /geannuleerd/);
});

test('Windows waits for the UAC prompt and reports a refusal or a missing cable', () => {
  const command = buildWindowsLauncherCommand('QUJD');
  assert.match(command, /Start-Process powershell\.exe -Verb RunAs -Wait -PassThru/);
  assert.match(command, /'-EncodedCommand','QUJD'/);
  assert.match(command, /catch \{ \[Console\]::Error\.WriteLine\('UAC_CANCELLED'\); exit 1223 \}/);
  assert.match(describeElevationFailure('win32', 1223, 'UAC_CANCELLED'), /geweigerd/);
  assert.match(describeElevationFailure('win32', 11, ''), /Steek de netwerkkabel in/);
  assert.equal(isWirelessWindowsAdapter('Wi-Fi'), true);
  assert.equal(isWirelessWindowsAdapter('WLAN 2'), true);
  assert.equal(isWirelessWindowsAdapter('Ethernet'), false);
  assert.equal(isWirelessWindowsAdapter('Ethernet 2'), false);
});
