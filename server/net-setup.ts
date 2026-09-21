import { execFile, execFileSync, spawn } from 'node:child_process';
import os from 'node:os';
import { currentLanNetworkEndpoints } from './host.js';

export const NET_SETUP_UNDO_PHRASE = 'VOORBIJ';
const APP_PORT = 5173;
const DISCOVERY_PORT = 45737;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested, platform independent)
// ---------------------------------------------------------------------------

export function isLoopbackAddress(remoteAddress: string | undefined | null): boolean {
  if (!remoteAddress) return false;
  const normalized = remoteAddress.trim().toLowerCase();
  return (
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '::ffff:127.0.0.1' ||
    normalized === 'localhost'
  );
}

export function parseIpv4(value: unknown): number[] | null {
  if (typeof value !== 'string') return null;
  const parts = value.trim().split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    octets.push(octet);
  }
  return octets;
}

export function isApipaAddress(ip: string): boolean {
  const octets = parseIpv4(ip);
  return octets !== null && octets[0] === 169 && octets[1] === 254;
}

export function isPrivateLanAddress(ip: string): boolean {
  const octets = parseIpv4(ip);
  if (!octets) return false;
  const [a, b] = octets;
  return (
    (a === 192 && b === 168) ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31)
  );
}

/** True when both addresses share the first `octets` octets (default /24). */
export function sameSubnet(a: string, b: string, octets = 3): boolean {
  const left = parseIpv4(a);
  const right = parseIpv4(b);
  if (!left || !right) return false;
  return left.slice(0, octets).join('.') === right.slice(0, octets).join('.');
}

export function prefixLengthToMask(prefixLength: number): string | null {
  if (!Number.isInteger(prefixLength) || prefixLength < 8 || prefixLength > 30) return null;
  let mask = 0;
  for (let i = 0; i < prefixLength; i += 1) mask |= 1 << (31 - i);
  mask >>>= 0;
  return [(mask >>> 24) & 255, (mask >>> 16) & 255, (mask >>> 8) & 255, mask & 255].join('.');
}

export type StaticRequestValidation =
  | { ok: true; ip: string; prefixLength: number; gateway: string | null }
  | { ok: false; error: string };

export function validateStaticRequest(input: {
  ip?: unknown;
  prefixLength?: unknown;
  gateway?: unknown;
}): StaticRequestValidation {
  const rawIp = typeof input.ip === 'string' ? input.ip.trim() : '';
  const octets = parseIpv4(rawIp);
  if (!octets) return { ok: false, error: 'Dat is geen geldig IPv4-adres (bijv. 192.168.1.211).' };
  const ip = octets.join('.');
  if (isApipaAddress(ip)) {
    return {
      ok: false,
      error: '169.254.x.x is een noodadres, geen vast adres. Kies een adres in je eigen netwerk (bijv. 192.168.1.211).',
    };
  }
  if (octets[3] === 0 || octets[3] === 255) {
    return { ok: false, error: 'Adressen die eindigen op .0 of .255 werken niet. Kies bijv. .211.' };
  }
  let prefixLength = 24;
  if (input.prefixLength !== undefined && input.prefixLength !== null && input.prefixLength !== '') {
    const parsed = Number(input.prefixLength);
    if (!Number.isInteger(parsed) || parsed < 8 || parsed > 30) {
      return { ok: false, error: 'Gebruik een normaal subnetmasker (aanbevolen: 24).' };
    }
    if (parsed !== 24) {
      return { ok: false, error: 'Alleen /24 wordt ondersteund. Houd alle laptops in hetzelfde 192.168.N.x-netwerk.' };
    }
    prefixLength = parsed;
  }
  let gateway: string | null = null;
  if (typeof input.gateway === 'string' && input.gateway.trim()) {
    const gatewayOctets = parseIpv4(input.gateway);
    if (!gatewayOctets) return { ok: false, error: 'De gateway is geen geldig IPv4-adres.' };
    gateway = gatewayOctets.join('.');
    if (!sameSubnet(ip, gateway, 3)) {
      return { ok: false, error: 'De gateway moet in hetzelfde netwerk zitten als het vaste adres.' };
    }
  }
  return { ok: true, ip, prefixLength, gateway };
}

// ---------------------------------------------------------------------------
// Live profile (best effort; never throws)
// ---------------------------------------------------------------------------

export type NetAdapterProfile = {
  name: string;
  address: string;
  prefixLength: number | null;
  dhcp: boolean | null;
};

export type NetProfile = {
  platform: NodeJS.Platform;
  windows: boolean;
  adapters: NetAdapterProfile[];
  primary: NetAdapterProfile | null;
  apipa: boolean;
  suggestion: { ip: string; prefixLength: number; gateway: string | null } | null;
  eventUrl: string | null;
};

function readWindowsDhcpState(): Map<string, boolean> {
  const states = new Map<string, boolean>();
  if (process.platform !== 'win32') return states;
  try {
    // Get-NetIPInterface reports Dhcp Enabled/Disabled per interface index.
    const output = execFileSyncQuiet('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-NetIPInterface -AddressFamily IPv4 | Select-Object InterfaceAlias, Dhcp | ConvertTo-Csv -NoTypeInformation',
    ]);
    for (const line of output.split(/\r?\n/).slice(1)) {
      const match = line.match(/^"([^"]+)","([^"]+)"$/);
      if (match) states.set(match[1].toLowerCase(), match[2].toLowerCase() === 'enabled');
    }
  } catch {
    // Best effort: DHCP state stays unknown (null).
  }
  return states;
}

function readWindowsPrefixLengths(): Map<string, number> {
  const lengths = new Map<string, number>();
  if (process.platform !== 'win32') return lengths;
  try {
    const output = execFileSyncQuiet('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-NetIPAddress -AddressFamily IPv4 | Select-Object InterfaceAlias, IPAddress, PrefixLength | ConvertTo-Csv -NoTypeInformation',
    ]);
    for (const line of output.split(/\r?\n/).slice(1)) {
      const match = line.match(/^"([^"]+)","([^"]+)","([^"]+)"$/);
      if (match) {
        const prefix = Number(match[3]);
        if (Number.isInteger(prefix)) lengths.set(`${match[1].toLowerCase()}|${match[2]}`, prefix);
      }
    }
  } catch {
    // Best effort only.
  }
  return lengths;
}

function execFileSyncQuiet(file: string, args: string[]): string {
  // Synchronous but only used for small local queries with a hard timeout.
  return execFileSync(file, args, { encoding: 'utf8', timeout: 8_000, stdio: ['ignore', 'pipe', 'ignore'] });
}

export function getNetProfile(): NetProfile {
  const windows = process.platform === 'win32';
  const dhcpByAlias = readWindowsDhcpState();
  const prefixByAliasIp = readWindowsPrefixLengths();
  let endpoints: Array<{ address: string; score: number }> = [];
  try {
    endpoints = currentLanNetworkEndpoints();
  } catch {
    endpoints = [];
  }
  const aliasByAddress = new Map<string, string>();
  try {
    const interfaces = os.networkInterfaces();
    for (const [name, infos] of Object.entries(interfaces)) {
      for (const info of infos || []) {
        if (info.family === 'IPv4' && !info.internal && info.address) {
          if (!aliasByAddress.has(info.address)) aliasByAddress.set(info.address, name);
        }
      }
    }
  } catch {
    // Ignore; adapters list stays endpoint-based.
  }
  const adapters: NetAdapterProfile[] = endpoints.map((endpoint) => {
    const alias = aliasByAddress.get(endpoint.address) || '';
    const dhcp = alias ? (dhcpByAlias.get(alias.toLowerCase()) ?? null) : null;
    const prefixLength = alias
      ? (prefixByAliasIp.get(`${alias.toLowerCase()}|${endpoint.address}`) ?? 24)
      : 24;
    return { name: alias || 'onbekend', address: endpoint.address, prefixLength, dhcp };
  });
  const primary = adapters[0] || null;
  const apipa = primary ? isApipaAddress(primary.address) : false;
  let suggestion: NetProfile['suggestion'] = null;
  if (primary && !apipa && isPrivateLanAddress(primary.address)) {
    // "Pin wat je nu hebt": het huidige DHCP-adres wordt het vaste adres.
    suggestion = { ip: primary.address, prefixLength: primary.prefixLength ?? 24, gateway: null };
  }
  return {
    platform: process.platform,
    windows,
    adapters,
    primary,
    apipa,
    suggestion,
    eventUrl: primary && !apipa ? `http://${primary.address}:${APP_PORT}` : null,
  };
}

// ---------------------------------------------------------------------------
// Elevated execution (Windows only). Fire-and-forget: the UAC prompt appears
// on the host screen, so only someone physically behind that laptop can
// approve it. The HTTP call returns immediately; the UI polls the profile.
// ---------------------------------------------------------------------------

function toEncodedCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function launchElevated(encodedCommand: string): void {
  // No shell involved: argument list is passed verbatim to powershell.exe,
  // and the actual network script travels base64-encoded, so validated IPs
  // can never break out into extra commands.
  const launcher = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Start-Process powershell.exe -Verb RunAs -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${encodedCommand}'`,
    ],
    { detached: true, stdio: 'ignore', windowsHide: true }
  );
  launcher.unref();
}

function buildSetStaticScript(ip: string, prefixLength: number, gateway: string | null): string {
  const gatewayLine = gateway
    ? `New-NetIPAddress -InterfaceIndex $ifIndex -IPAddress '${ip}' -PrefixLength ${prefixLength} -DefaultGateway '${gateway}' | Out-Null`
    : `New-NetIPAddress -InterfaceIndex $ifIndex -IPAddress '${ip}' -PrefixLength ${prefixLength} | Out-Null`;
  const dnsLine = gateway
    ? `# Router-LAN: laat DNS met rust.`
    : `Set-DnsClientServerAddress -InterfaceIndex $ifIndex -ResetServerAddresses | Out-Null`;
  return [
    `$ErrorActionPreference = 'Stop'`,
    `$adapters = Get-NetAdapter -Physical | Where-Object { $_.Status -eq 'Up' } | Sort-Object { if ($_.MediaType -match '802.3|Ethernet') { 0 } else { 1 } }`,
    `$adapter = $adapters | Where-Object { $_.Name -notmatch 'Wi-?Fi|WLAN|VPN|vEthernet|Virtual|Bluetooth' } | Select-Object -First 1`,
    `if (-not $adapter) { exit 11 }`,
    `$ifIndex = $adapter.ifIndex`,
    `Get-NetIPAddress -InterfaceIndex $ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notmatch '^127\\.' } | ForEach-Object { Remove-NetIPAddress -InterfaceIndex $ifIndex -IPAddress $_.IPAddress -Confirm:$false -ErrorAction SilentlyContinue }`,
    `Get-NetRoute -InterfaceIndex $ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.DestinationPrefix -eq '0.0.0.0/0' } | ForEach-Object { Remove-NetRoute -InterfaceIndex $ifIndex -DestinationPrefix $_.DestinationPrefix -NextHop $_.NextHop -Confirm:$false -ErrorAction SilentlyContinue }`,
    gatewayLine,
    `Set-NetIPInterface -InterfaceIndex $ifIndex -Dhcp Disabled | Out-Null`,
    dnsLine,
    `foreach ($rule in @(@{ Name = 'Apolloon TCP ${APP_PORT}'; Proto = 'TCP'; Port = ${APP_PORT} }, @{ Name = 'Apolloon UDP ${DISCOVERY_PORT}'; Proto = 'UDP'; Port = ${DISCOVERY_PORT} })) {`,
    `  if (-not (Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue)) {`,
    `    New-NetFirewallRule -DisplayName $rule.Name -Direction Inbound -Protocol $rule.Proto -LocalPort $rule.Port -Action Allow -Profile Any | Out-Null`,
    `  }`,
    `}`,
  ].join('\r\n');
}

function buildRevertDhcpScript(): string {
  return [
    `$ErrorActionPreference = 'Stop'`,
    `$adapters = Get-NetAdapter -Physical | Where-Object { $_.Status -eq 'Up' } | Sort-Object { if ($_.MediaType -match '802.3|Ethernet') { 0 } else { 1 } }`,
    `$adapter = $adapters | Where-Object { $_.Name -notmatch 'Wi-?Fi|WLAN|VPN|vEthernet|Virtual|Bluetooth' } | Select-Object -First 1`,
    `if (-not $adapter) { exit 11 }`,
    `Set-NetIPInterface -InterfaceIndex $adapter.ifIndex -Dhcp Enabled | Out-Null`,
    `Set-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -ResetServerAddresses | Out-Null`,
    `Restart-NetAdapter -InterfaceIndex $adapter.ifIndex -Confirm:$false`,
  ].join('\r\n');
}

export type NetActionResult = { ok: true; uacRequired: true } | { ok: false; error: string };

export function requestMakeStatic(input: {
  ip?: unknown;
  prefixLength?: unknown;
  gateway?: unknown;
}): NetActionResult {
  if (process.platform !== 'win32') {
    return {
      ok: false,
      error: 'Automatisch vastzetten werkt alleen op Windows. Gebruik op dit toestel de handmatige stappen.',
    };
  }
  const validated = validateStaticRequest(input);
  if (!validated.ok) return validated;
  try {
    launchElevated(toEncodedCommand(buildSetStaticScript(validated.ip, validated.prefixLength, validated.gateway)));
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Kon PowerShell niet starten.' };
  }
  return { ok: true, uacRequired: true };
}

export function requestRevertDhcp(input: { eventOver?: unknown; confirmText?: unknown }): NetActionResult {
  if (process.platform !== 'win32') {
    return {
      ok: false,
      error: 'Automatisch terugzetten werkt alleen op Windows. Zet het adres handmatig terug op automatisch (DHCP).',
    };
  }
  if (input.eventOver !== true) {
    return { ok: false, error: 'Bevestig eerst dat het evenement helemaal voorbij is.' };
  }
  const text = typeof input.confirmText === 'string' ? input.confirmText.trim().toUpperCase() : '';
  if (text !== NET_SETUP_UNDO_PHRASE) {
    return { ok: false, error: `Typ eerst ${NET_SETUP_UNDO_PHRASE} om te bevestigen.` };
  }
  try {
    launchElevated(toEncodedCommand(buildRevertDhcpScript()));
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Kon PowerShell niet starten.' };
  }
  return { ok: true, uacRequired: true };
}

export function execFileAsync(
  file: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 8_000 }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}
