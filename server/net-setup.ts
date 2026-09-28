import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

/** Dotted mask (zoals macOS `networksetup` toont) terug naar prefixlengte. */
export function maskToPrefixLength(mask: unknown): number | null {
  const octets = parseIpv4(mask);
  if (!octets) return null;
  let bits = 0;
  let seenZero = false;
  for (const octet of octets) {
    for (let bit = 7; bit >= 0; bit -= 1) {
      const set = (octet >> bit) & 1;
      if (set === 1) {
        if (seenZero) return null; // geen aaneengesloten masker
        bits += 1;
      } else {
        seenZero = true;
      }
    }
  }
  return bits >= 8 && bits <= 30 ? bits : null;
}

/** Single-quote voor sh-scripts (bestandsnamen uit het systeem zijn nooit blind te vertrouwen). */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Escape voor AppleScript-strings (dubbele quotes en backslashes). */
export function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// --- Parsers voor systeemtools (puur, unit-getest) -------------------------------

export type NmActiveConnection = { name: string; device: string; type: string };

/** Only wired connections may be pinned; a wifi profile at home must never be changed. */
export function isWiredNmConnectionType(type: string): boolean {
  return type === 'ethernet' || type === '802-3-ethernet';
}

/** Same rule as the pinning script, which skips adapters with these names. */
export function isWirelessWindowsAdapter(alias: string): boolean {
  return /wi-?fi|wlan|wireless|draadloos|bluetooth/i.test(alias);
}

export function isWirelessMacService(service: string): boolean {
  return /wi-?fi|airport|bluetooth|iphone/i.test(service);
}

/** Turns an elevation helper's exit into advice the operator can act on. */
export function describeElevationFailure(
  platform: NodeJS.Platform,
  exitCode: number | null,
  stderr: string
): string {
  const output = stderr.toLowerCase();
  if (platform === 'linux') {
    if (output.includes('authentication agent') || output.includes('textual authentication agent')) {
      return 'Er kon geen wachtwoordvenster openen: op deze Linux-desktop draait geen polkit-agent. Start er een (bijvoorbeeld polkit-kde-authentication-agent-1 of hyprpolkitagent) en probeer opnieuw, of gebruik het Linux-script hieronder.';
    }
    if (exitCode === 126) return 'De toestemming is geweigerd of het wachtwoordvenster werd gesloten. Er is niets veranderd.';
    if (exitCode === 127) return 'Het wachtwoord werd niet aanvaard. Er is niets veranderd.';
  }
  if (platform === 'win32') {
    if (exitCode === 1223 || output.includes('uac_cancelled')) {
      return 'De toestemming werd geweigerd (Nee in het Windows-venster). Er is niets veranderd.';
    }
    if (exitCode === 11) {
      return 'Geen bedrade netwerkadapter gevonden. Steek de netwerkkabel in; wifi wordt nooit vastgezet.';
    }
  }
  if (platform === 'darwin' && (output.includes('user canceled') || output.includes('-128'))) {
    return 'De toestemming werd geannuleerd. Er is niets veranderd.';
  }
  return `De netwerkwijziging is mislukt${exitCode === null ? '' : ` (code ${exitCode})`}. Er is niets veranderd.`;
}

/** Parse `nmcli -t -f NAME,DEVICE,TYPE connection show --active` (dubbele punt escaped als `\\:`). */
export function parseNmcliActiveConnections(output: string): NmActiveConnection[] {
  const connections: NmActiveConnection[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.replace(/\\:/g, '\u0000').split(':');
    if (parts.length < 3) continue;
    const [name, device, type] = parts.map((part) => part.replace(/\u0000/g, ':'));
    if (name && device) connections.push({ name, device, type });
  }
  return connections;
}

/** Parse `nmcli -t ... device show <iface>` (`SLEUTEL:waarde`, alleen eerste dubbele punt telt). */
export function parseNmcliDeviceFields(output: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key && !fields.has(key)) fields.set(key, value);
  }
  return fields;
}

export type MacHardwarePort = { port: string; device: string };

/** Parse `networksetup -listallhardwareports` (blokken van "Hardware Port:" / "Device:"). */
export function parseNetworksetupHardwarePorts(output: string): MacHardwarePort[] {
  const ports: MacHardwarePort[] = [];
  let currentPort: string | null = null;
  for (const line of output.split(/\r?\n/)) {
    const portMatch = line.match(/^Hardware Port:\s*(.+?)\s*$/);
    if (portMatch) {
      currentPort = portMatch[1];
      continue;
    }
    const deviceMatch = line.match(/^Device:\s*([a-z0-9]+)\s*$/i);
    if (deviceMatch && currentPort) {
      ports.push({ port: currentPort, device: deviceMatch[1] });
      currentPort = null;
    }
  }
  return ports;
}

export type MacServiceInfo = {
  manual: boolean | null;
  ip: string | null;
  mask: string | null;
  router: string | null;
};

/** Parse `networksetup -getinfo "<dienst>"`. */
export function parseNetworksetupInfo(output: string): MacServiceInfo {
  let manual: boolean | null = null;
  if (/Manual Configuration/i.test(output)) manual = true;
  else if (/DHCP Configuration/i.test(output)) manual = false;
  const pick = (label: string): string | null => {
    const match = output.match(new RegExp(`^${label}:\\s*(.+?)\\s*$`, 'im'));
    if (!match) return null;
    const value = match[1].trim();
    return value && value.toLowerCase() !== 'none' ? value : null;
  };
  return {
    manual,
    ip: pick('IP address'),
    mask: pick('Subnet mask'),
    router: pick('Router'),
  };
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
  /** Systeemnaam van de verbinding/dienst (NM-verbinding of macOS-dienst), voor acties. */
  connection: string | null;
};

export type ElevateMethod = 'uac' | 'pkexec' | 'osascript' | null;

export type ElevationOutcome = {
  id: string;
  state: 'waiting' | 'finished' | 'failed';
  message: string | null;
  startedAt: number;
};

let lastElevation: ElevationOutcome | null = null;

function beginElevation(): ElevationOutcome {
  lastElevation = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, state: 'waiting', message: null, startedAt: Date.now() };
  return lastElevation;
}

/** Follows the helper process so a refused or impossible password prompt is reported instead of silently waited on. */
function trackElevation(outcome: ElevationOutcome, launcher: ReturnType<typeof spawn>): void {
  let stderr = '';
  launcher.stderr?.setEncoding('utf8');
  launcher.stderr?.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-2_000);
  });
  launcher.on('error', (error) => {
    if (lastElevation?.id !== outcome.id) return;
    lastElevation = { ...outcome, state: 'failed', message: `Kon de toestemming niet vragen: ${error.message}` };
  });
  launcher.on('exit', (exitCode) => {
    if (lastElevation?.id !== outcome.id) return;
    lastElevation = exitCode === 0
      ? { ...outcome, state: 'finished', message: null }
      : { ...outcome, state: 'failed', message: describeElevationFailure(process.platform, exitCode, stderr) };
  });
}

export type NetProfile = {
  platform: NodeJS.Platform;
  windows: boolean;
  /** Waarmee een klik op de knop toestemming vraagt (null = alleen handmatig). */
  elevateMethod: ElevateMethod;
  /** Korte uitleg voor in de UI, bijv. "Windows vraagt om toestemming (klik op Ja)". */
  elevateHint: string | null;
  /** Waarmee het adres beheerd wordt, bijv. "NetworkManager: Bekabeld". */
  manager: string | null;
  adapters: NetAdapterProfile[];
  primary: NetAdapterProfile | null;
  apipa: boolean;
  suggestion: { ip: string; prefixLength: number; gateway: string | null } | null;
  eventUrl: string | null;
  /** Whether the primary adapter is a cable (true), wifi (false) or unknown (null). */
  primaryWired: boolean | null;
  /** Outcome of the latest elevated network change started from this server. */
  lastElevation: ElevationOutcome | null;
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

const toolProbeArgs: Record<string, string[]> = {
  nmcli: ['--version'],
  pkexec: ['--version'],
  networksetup: ['-version'],
  osascript: ['-e', 'return 1'],
};

const toolAvailability = new Map<string, boolean>();

function toolAvailable(tool: string): boolean {
  const cached = toolAvailability.get(tool);
  if (cached !== undefined) return cached;
  let available = false;
  try {
    execFileSyncQuiet(tool, toolProbeArgs[tool] || ['--version']);
    available = true;
  } catch {
    available = false;
  }
  toolAvailability.set(tool, available);
  return available;
}

export function clearToolAvailabilityCache(): void {
  toolAvailability.clear();
}

type LinuxNetState = {
  connection: string | null;
  connectionType: string | null;
  dhcp: boolean | null;
  prefixLength: number | null;
  gateway: string | null;
};

function readLinuxNetState(iface: string, address: string): LinuxNetState {
  const state: LinuxNetState = { connection: null, connectionType: null, dhcp: null, prefixLength: null, gateway: null };
  if (!toolAvailable('nmcli')) return state;
  try {
    const active = parseNmcliActiveConnections(
      execFileSyncQuiet('nmcli', ['-t', '-f', 'NAME,DEVICE,TYPE', 'connection', 'show', '--active'])
    );
    // Zoek de NetworkManager-verbinding die bij deze interface hoort.
    const match =
      active.find((item) => item.device === iface) ||
      active.find((item) => item.type === 'ethernet' || item.type === '802-3-ethernet');
    if (!match) return state;
    state.connection = match.name;
    state.connectionType = match.type;
    try {
      const method = execFileSyncQuiet('nmcli', ['-t', '-f', 'ipv4.method', 'connection', 'show', match.name])
        .split(':')[1]
        ?.trim()
        .toLowerCase();
      if (method === 'auto') state.dhcp = true;
      else if (method === 'manual') state.dhcp = false;
    } catch {
      // Onbekend; blijft null.
    }
    try {
      const fields = parseNmcliDeviceFields(execFileSyncQuiet('nmcli', ['-t', '-f', 'IP4.ADDRESS,IP4.GATEWAY', 'device', 'show', iface]));
      const cidr = fields.get('IP4.ADDRESS') || '';
      const cidrMatch = cidr.match(/\/(\d{1,2})\b/);
      if (cidrMatch && cidr.includes(address)) {
        const prefix = Number(cidrMatch[1]);
        if (Number.isInteger(prefix) && prefix >= 8 && prefix <= 30) state.prefixLength = prefix;
      }
      const gateway = fields.get('IP4.GATEWAY');
      if (gateway && parseIpv4(gateway)) state.gateway = gateway;
    } catch {
      // Onbekend; blijft null.
    }
  } catch {
    // NetworkManager afwezig of onleesbaar; alles blijft null.
  }
  return state;
}

type MacNetState = {
  service: string | null;
  dhcp: boolean | null;
  prefixLength: number | null;
  gateway: string | null;
};

function readMacNetState(device: string): MacNetState {
  const state: MacNetState = { service: null, dhcp: null, prefixLength: null, gateway: null };
  if (!toolAvailable('networksetup')) return state;
  try {
    const ports = parseNetworksetupHardwarePorts(execFileSyncQuiet('networksetup', ['-listallhardwareports']));
    const match = ports.find((item) => item.device === device);
    if (!match) return state;
    state.service = match.port;
    const info = parseNetworksetupInfo(execFileSyncQuiet('networksetup', ['-getinfo', match.port]));
    state.dhcp = info.manual === null ? null : !info.manual;
    if (info.mask) state.prefixLength = maskToPrefixLength(info.mask);
    if (info.router && parseIpv4(info.router)) state.gateway = info.router;
  } catch {
    // Best effort only.
  }
  return state;
}

export function getNetProfile(): NetProfile {
  const platform = process.platform;
  const windows = platform === 'win32';
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
  let elevateMethod: ElevateMethod = null;
  let elevateHint: string | null = null;
  let manager: string | null = null;
  if (windows) {
    elevateMethod = 'uac';
    elevateHint = 'Windows vraagt om toestemming (klik op Ja)';
  } else if (platform === 'linux' && toolAvailable('nmcli') && toolAvailable('pkexec')) {
    elevateMethod = 'pkexec';
    elevateHint = 'Linux vraagt om je wachtwoord';
  } else if (platform === 'darwin' && toolAvailable('networksetup') && toolAvailable('osascript')) {
    elevateMethod = 'osascript';
    elevateHint = 'macOS vraagt om je wachtwoord';
  }
  const adapters: NetAdapterProfile[] = endpoints.map((endpoint) => {
    const alias = aliasByAddress.get(endpoint.address) || '';
    let dhcp: boolean | null = alias ? (dhcpByAlias.get(alias.toLowerCase()) ?? null) : null;
    let prefixLength: number | null = alias
      ? (prefixByAliasIp.get(`${alias.toLowerCase()}|${endpoint.address}`) ?? 24)
      : 24;
    let connection: string | null = null;
    if (!windows && alias) {
      if (platform === 'linux') {
        const linux = readLinuxNetState(alias, endpoint.address);
        connection = linux.connection;
        if (linux.dhcp !== null) dhcp = linux.dhcp;
        if (linux.prefixLength !== null) prefixLength = linux.prefixLength;
        if (linux.connection) manager = `NetworkManager: ${linux.connection}`;
      } else if (platform === 'darwin') {
        const mac = readMacNetState(alias);
        connection = mac.service;
        if (mac.dhcp !== null) dhcp = mac.dhcp;
        if (mac.prefixLength !== null) prefixLength = mac.prefixLength;
        if (mac.service) manager = `macOS-netwerkdienst: ${mac.service}`;
      }
    }
    return { name: alias || 'onbekend', address: endpoint.address, prefixLength, dhcp, connection };
  });
  const primary = adapters[0] || null;
  let primaryWired: boolean | null = null;
  if (primary && windows && primary.name !== 'onbekend') {
    primaryWired = !isWirelessWindowsAdapter(primary.name);
  } else if (primary && platform === 'linux') {
    const type = readLinuxNetState(primary.name, primary.address).connectionType;
    primaryWired = type ? isWiredNmConnectionType(type) : null;
  } else if (primary?.connection && platform === 'darwin') {
    primaryWired = !isWirelessMacService(primary.connection);
  }
  const apipa = primary ? isApipaAddress(primary.address) : false;
  let suggestion: NetProfile['suggestion'] = null;
  if (primary && !apipa && isPrivateLanAddress(primary.address)) {
    // "Pin wat je nu hebt": het huidige DHCP-adres wordt het vaste adres.
    suggestion = { ip: primary.address, prefixLength: primary.prefixLength ?? 24, gateway: null };
  }
  return {
    platform,
    windows,
    elevateMethod,
    elevateHint,
    manager,
    adapters,
    primary,
    apipa,
    suggestion,
    eventUrl: primary && !apipa ? `http://${primary.address}:${APP_PORT}` : null,
    primaryWired,
    lastElevation,
  };
}

// ---------------------------------------------------------------------------
// Elevated execution. De toestemmingsvraag (UAC / wachtwoordvenster)
// verschijnt op het scherm van de host zelf, dus alleen iemand fysiek achter
// die laptop kan goedkeuren. De HTTP-call keert direct terug; de UI pollt het
// profiel tot de wijziging zichtbaar is of lastElevation een fout meldt.
// ---------------------------------------------------------------------------

function toEncodedCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** Exit code the launcher uses when the UAC prompt is answered with "Nee" (Windows ERROR_CANCELLED). */
export const WINDOWS_UAC_CANCELLED_EXIT = 1223;
/** Exit code of the network script when no wired adapter is up. */
export const WINDOWS_NO_WIRED_ADAPTER_EXIT = 11;

export function buildWindowsLauncherCommand(encodedCommand: string): string {
  // Wait for the elevated script so a refused prompt or a missing cable is reported
  // right away instead of after the polling timeout.
  const elevated =
    "Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ErrorAction Stop " +
    `-ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${encodedCommand}'`;
  return (
    `try { $p = ${elevated}; if ($null -eq $p.ExitCode) { exit 0 }; exit $p.ExitCode } ` +
    `catch { [Console]::Error.WriteLine('UAC_CANCELLED'); exit ${WINDOWS_UAC_CANCELLED_EXIT} }`
  );
}

function launchElevatedWindows(encodedCommand: string): ElevationOutcome {
  // No shell involved: argument list is passed verbatim to powershell.exe,
  // and the actual network script travels base64-encoded, so validated IPs
  // can never break out into extra commands.
  const outcome = beginElevation();
  const launcher = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', buildWindowsLauncherCommand(encodedCommand)],
    { detached: true, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
  );
  trackElevation(outcome, launcher);
  return outcome;
}

function launchElevatedLinuxScript(scriptText: string): ElevationOutcome {
  // Eén wachtwoordvraag: het hele recept staat in een tijdelijk script dat
  // pkexec als root uitvoert. Alleen gevalideerde waarden en shQuote'de
  // systeemnamen belanden erin.
  const tmpFile = path.join(os.tmpdir(), `apolloon-net-${Date.now()}-${process.pid}.sh`);
  fs.writeFileSync(tmpFile, `#!/bin/sh\nset -eu\n${scriptText}\n`, { mode: 0o700 });
  const outcome = beginElevation();
  const launcher = spawn('pkexec', ['sh', tmpFile], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  trackElevation(outcome, launcher);
  // Opruimen nadat pkexec het heeft kunnen lezen; ongevaarlijk als het blijft liggen (0700, tmp).
  setTimeout(() => {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // Al weg of tmp is geleegd; prima.
    }
  }, 120_000).unref?.();
  return outcome;
}

function launchElevatedMacOs(innerCommand: string): ElevationOutcome {
  // osascript toont zelf de wachtwoordvraag op het scherm van de host.
  const appleScript = `do shell script "${escapeAppleScriptString(innerCommand)}" with administrator privileges`;
  const outcome = beginElevation();
  const launcher = spawn('osascript', ['-e', appleScript], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  trackElevation(outcome, launcher);
  return outcome;
}

export function buildLinuxSetStaticScript(connection: string, ip: string, prefixLength: number, gateway: string | null): string {
  const quoted = shQuote(connection);
  const gatewayPart = gateway ? ` ipv4.gateway ${gateway}` : '';
  return [
    `nmcli con mod ${quoted} ipv4.addresses ${ip}/${prefixLength}${gatewayPart} ipv4.dns '' ipv4.method manual`,
    `nmcli con up ${quoted}`,
    `if command -v ufw >/dev/null 2>&1; then`,
    `  ufw allow ${APP_PORT}/tcp >/dev/null 2>&1 || true`,
    `  ufw allow ${DISCOVERY_PORT}/udp >/dev/null 2>&1 || true`,
    `fi`,
  ].join('\n');
}

export function buildLinuxRevertDhcpScript(connection: string): string {
  const quoted = shQuote(connection);
  return [
    `nmcli con mod ${quoted} ipv4.method auto ipv4.addresses '' ipv4.gateway '' ipv4.dns ''`,
    `nmcli con up ${quoted}`,
  ].join('\n');
}

export function buildMacOsSetManualCommand(service: string, ip: string, mask: string, gateway: string | null): string {
  const gatewayPart = gateway ? ` ${gateway}` : '';
  return `networksetup -setmanual ${shQuote(service)} ${ip} ${mask}${gatewayPart}`;
}

export function buildMacOsRevertDhcpCommand(service: string): string {
  return `networksetup -setdhcp ${shQuote(service)}`;
}

/** Verbindingsnaam van het primaire adres, vers opgevraagd voor een actie. */
function resolvePrimaryConnection(): { kind: 'nm' | 'macos'; name: string } | null {
  const profile = getNetProfile();
  if (!profile.primary || profile.apipa) return null;
  if (process.platform === 'linux') {
    // Only a wired connection: the wifi at home or at school must never be pinned.
    try {
      const wired = parseNmcliActiveConnections(
        execFileSyncQuiet('nmcli', ['-t', '-f', 'NAME,DEVICE,TYPE', 'connection', 'show', '--active'])
      ).filter((connection) => isWiredNmConnectionType(connection.type));
      const match = wired.find((connection) => connection.device === profile.primary?.name) ?? wired[0];
      return match ? { kind: 'nm', name: match.name } : null;
    } catch {
      return null;
    }
  }
  if (process.platform === 'darwin') {
    const state = readMacNetState(profile.primary.name);
    return state.service && !isWirelessMacService(state.service) ? { kind: 'macos', name: state.service } : null;
  }
  return null;
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

export type NetActionResult = { ok: true; elevated: true; elevationId: string | null } | { ok: false; error: string };

const MANUAL_HINT =
  'Gebruik de handmatige stappen of download hieronder het script voor dit toestel.';

export function requestMakeStatic(input: {
  ip?: unknown;
  prefixLength?: unknown;
  gateway?: unknown;
}): NetActionResult {
  const validated = validateStaticRequest(input);
  if (!validated.ok) return validated;
  const platform = process.platform;
  try {
    if (platform === 'win32') {
      const outcome = launchElevatedWindows(toEncodedCommand(buildSetStaticScript(validated.ip, validated.prefixLength, validated.gateway)));
      return { ok: true, elevated: true, elevationId: outcome.id };
    }
    if (platform === 'linux') {
      if (!toolAvailable('nmcli') || !toolAvailable('pkexec')) {
        return { ok: false, error: `Automatisch vastzetten kan hier niet (NetworkManager of pkexec ontbreekt). ${MANUAL_HINT}` };
      }
      const resolved = resolvePrimaryConnection();
      if (!resolved || resolved.kind !== 'nm') {
        return { ok: false, error: `Geen bedrade verbinding gevonden. Steek de netwerkkabel in; wifi wordt nooit vastgezet. ${MANUAL_HINT}` };
      }
      const outcome = launchElevatedLinuxScript(
        buildLinuxSetStaticScript(resolved.name, validated.ip, validated.prefixLength, validated.gateway)
      );
      return { ok: true, elevated: true, elevationId: outcome.id };
    }
    if (platform === 'darwin') {
      if (!toolAvailable('networksetup') || !toolAvailable('osascript')) {
        return { ok: false, error: `Automatisch vastzetten kan hier niet. ${MANUAL_HINT}` };
      }
      const resolved = resolvePrimaryConnection();
      if (!resolved || resolved.kind !== 'macos') {
        return { ok: false, error: `Geen bedrade verbinding gevonden. Steek de netwerkkabel in; wifi wordt nooit vastgezet. ${MANUAL_HINT}` };
      }
      const mask = prefixLengthToMask(validated.prefixLength);
      if (!mask) return { ok: false, error: 'Ongeldig subnetmasker.' };
      const outcome = launchElevatedMacOs(
        buildMacOsSetManualCommand(resolved.name, validated.ip, mask, validated.gateway)
      );
      return { ok: true, elevated: true, elevationId: outcome.id };
    }
    return { ok: false, error: `Automatisch vastzetten werkt niet op dit systeem. ${MANUAL_HINT}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Kon de netwerkactie niet starten.' };
  }
}

export function requestRevertDhcp(input: { eventOver?: unknown; confirmText?: unknown }): NetActionResult {
  if (input.eventOver !== true) {
    return { ok: false, error: 'Bevestig eerst dat het evenement helemaal voorbij is.' };
  }
  const text = typeof input.confirmText === 'string' ? input.confirmText.trim().toUpperCase() : '';
  if (text !== NET_SETUP_UNDO_PHRASE) {
    return { ok: false, error: `Typ eerst ${NET_SETUP_UNDO_PHRASE} om te bevestigen.` };
  }
  const platform = process.platform;
  try {
    if (platform === 'win32') {
      const outcome = launchElevatedWindows(toEncodedCommand(buildRevertDhcpScript()));
      return { ok: true, elevated: true, elevationId: outcome.id };
    }
    if (platform === 'linux') {
      if (!toolAvailable('nmcli') || !toolAvailable('pkexec')) {
        return { ok: false, error: `Automatisch terugzetten kan hier niet (NetworkManager of pkexec ontbreekt). ${MANUAL_HINT}` };
      }
      const resolved = resolvePrimaryConnection();
      if (!resolved || resolved.kind !== 'nm') {
        return { ok: false, error: `Geen bedrade verbinding gevonden. Steek de netwerkkabel in; wifi wordt nooit vastgezet. ${MANUAL_HINT}` };
      }
      const outcome = launchElevatedLinuxScript(buildLinuxRevertDhcpScript(resolved.name));
      return { ok: true, elevated: true, elevationId: outcome.id };
    }
    if (platform === 'darwin') {
      if (!toolAvailable('networksetup') || !toolAvailable('osascript')) {
        return { ok: false, error: `Automatisch terugzetten kan hier niet. ${MANUAL_HINT}` };
      }
      const resolved = resolvePrimaryConnection();
      if (!resolved || resolved.kind !== 'macos') {
        return { ok: false, error: `Geen bedrade verbinding gevonden. Steek de netwerkkabel in; wifi wordt nooit vastgezet. ${MANUAL_HINT}` };
      }
      const outcome = launchElevatedMacOs(buildMacOsRevertDhcpCommand(resolved.name));
      return { ok: true, elevated: true, elevationId: outcome.id };
    }
    return { ok: false, error: `Automatisch terugzetten werkt niet op dit systeem. ${MANUAL_HINT}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Kon de netwerkactie niet starten.' };
  }
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
