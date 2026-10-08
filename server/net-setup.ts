import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DISCOVERY_PORT, lanAddresses, PUBLIC_APP_PORT } from './host.js';

// Pins the host's wired adapter to a static address for the event LAN, and
// undoes that afterwards. The OS permission prompt (UAC / password dialog)
// appears on the host's own screen; the HTTP call returns immediately and the
// UI polls the profile until the change shows up or `lastElevation` fails.

const NET_SETUP_UNDO_PHRASE = 'VOORBIJ';

/** Windows ERROR_CANCELLED: the launcher's exit code when the UAC prompt is refused. */
const WINDOWS_UAC_CANCELLED_EXIT = 1223;
/** Exit code of the Windows network script when no wired adapter is up. */
const WINDOWS_NO_WIRED_ADAPTER_EXIT = 11;

const MANUAL_HINT = 'Gebruik de handmatige stappen of download hieronder het script voor dit toestel.';
const NO_WIRED_CONNECTION = `Geen bedrade verbinding gevonden. Steek de netwerkkabel in; wifi wordt nooit vastgezet. ${MANUAL_HINT}`;

// Pure helpers (unit-tested, platform independent).

export function isLoopbackAddress(remoteAddress: string | undefined | null): boolean {
  if (!remoteAddress) return false;
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'].includes(remoteAddress.trim().toLowerCase());
}

export function parseIpv4(value: unknown): number[] | null {
  if (typeof value !== 'string') return null;
  const parts = value.trim().split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

export function isApipaAddress(ip: string): boolean {
  const octets = parseIpv4(ip);
  return octets !== null && octets[0] === 169 && octets[1] === 254;
}

export function isPrivateLanAddress(ip: string): boolean {
  const octets = parseIpv4(ip);
  if (!octets) return false;
  const [a, b] = octets;
  return (a === 192 && b === 168) || a === 10 || (a === 172 && b >= 16 && b <= 31);
}

function ipv4ToNumber(octets: number[]): number {
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

function prefixMask(prefixLength: number): number {
  return (0xffffffff << (32 - prefixLength)) >>> 0;
}

/** True when both addresses are in the same network for `prefixLength` (default /24). */
export function sameSubnet(a: string, b: string, prefixLength = 24): boolean {
  const left = parseIpv4(a);
  const right = parseIpv4(b);
  if (!left || !right) return false;
  const mask = prefixMask(prefixLength);
  return (ipv4ToNumber(left) & mask) === (ipv4ToNumber(right) & mask);
}

export function prefixLengthToMask(prefixLength: number): string | null {
  if (!Number.isInteger(prefixLength) || prefixLength < 8 || prefixLength > 30) return null;
  const mask = (0xffffffff << (32 - prefixLength)) >>> 0;
  return [mask >>> 24, (mask >>> 16) & 255, (mask >>> 8) & 255, mask & 255].join('.');
}

/** Dotted mask (as macOS `networksetup` reports it) back to a prefix length. */
export function maskToPrefixLength(mask: unknown): number | null {
  const octets = parseIpv4(mask);
  if (!octets) return null;
  const bits = octets.map((octet) => octet.toString(2).padStart(8, '0')).join('');
  // A valid mask is contiguous ones followed by zeros.
  if (!/^1*0*$/.test(bits)) return null;
  const prefixLength = bits.indexOf('0') === -1 ? 32 : bits.indexOf('0');
  return prefixLength >= 8 && prefixLength <= 30 ? prefixLength : null;
}

/** Single-quotes a value for sh; system connection names are never trusted. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Escapes backslashes and double quotes for an AppleScript string literal. */
export function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

type NmActiveConnection = { name: string; device: string; type: string };

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
export function describeElevationFailure(platform: NodeJS.Platform, exitCode: number | null, stderr: string): string {
  const output = stderr.toLowerCase();
  if (platform === 'linux') {
    if (output.includes('authentication agent')) {
      return 'Er kon geen wachtwoordvenster openen: op deze Linux-desktop draait geen polkit-agent. Start er een (bijvoorbeeld polkit-kde-authentication-agent-1 of hyprpolkitagent) en probeer opnieuw, of gebruik het Linux-script hieronder.';
    }
    if (exitCode === 126)
      return 'De toestemming is geweigerd of het wachtwoordvenster werd gesloten. Er is niets veranderd.';
    if (exitCode === 127) return 'Het wachtwoord werd niet aanvaard. Er is niets veranderd.';
  }
  if (platform === 'win32') {
    if (exitCode === WINDOWS_UAC_CANCELLED_EXIT || output.includes('uac_cancelled')) {
      return 'De toestemming werd geweigerd (Nee in het Windows-venster). Er is niets veranderd.';
    }
    if (exitCode === WINDOWS_NO_WIRED_ADAPTER_EXIT) {
      return 'Geen bedrade netwerkadapter gevonden. Steek de netwerkkabel in; wifi wordt nooit vastgezet.';
    }
  }
  if (platform === 'darwin' && (output.includes('user canceled') || output.includes('-128'))) {
    return 'De toestemming werd geannuleerd. Er is niets veranderd.';
  }
  return `De netwerkwijziging is mislukt${exitCode === null ? '' : ` (code ${exitCode})`}. Er is niets veranderd.`;
}

/** Parses `nmcli -t -f NAME,DEVICE,TYPE connection show --active` (colons in names escaped as `\:`). */
export function parseNmcliActiveConnections(output: string): NmActiveConnection[] {
  const connections: NmActiveConnection[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // nmcli -t escapes a colon inside a value as `\:`.
    const parts = line.split(/(?<!\\):/);
    if (parts.length < 3) continue;
    const [name, device, type] = parts.map((part) => part.replace(/\\:/g, ':'));
    if (name && device) connections.push({ name, device, type });
  }
  return connections;
}

/** Parses `nmcli -t ... device show <iface>` (`KEY:value`, only the first colon separates). */
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

type MacHardwarePort = { port: string; device: string };

/** Parses `networksetup -listallhardwareports` ("Hardware Port:" / "Device:" blocks). */
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

type MacServiceInfo = {
  manual: boolean | null;
  ip: string | null;
  mask: string | null;
  router: string | null;
};

/** Parses `networksetup -getinfo "<service>"`. */
export function parseNetworksetupInfo(output: string): MacServiceInfo {
  let manual: boolean | null = null;
  if (/Manual Configuration/i.test(output)) manual = true;
  else if (/DHCP Configuration/i.test(output)) manual = false;
  const pick = (label: string): string | null => {
    const value = output.match(new RegExp(`^${label}:\\s*(.+?)\\s*$`, 'im'))?.[1].trim();
    return value && value.toLowerCase() !== 'none' ? value : null;
  };
  return { manual, ip: pick('IP address'), mask: pick('Subnet mask'), router: pick('Router') };
}

type StaticRequestValidation =
  | { ok: true; ip: string; prefixLength: number; gateway: string | null }
  | { ok: false; error: string };

export function validateStaticRequest(input: {
  ip?: unknown;
  prefixLength?: unknown;
  gateway?: unknown;
}): StaticRequestValidation {
  const octets = parseIpv4(typeof input.ip === 'string' ? input.ip.trim() : '');
  if (!octets) return { ok: false, error: 'Dat is geen geldig IPv4-adres (bijv. 192.168.1.211).' };
  const ip = octets.join('.');
  if (isApipaAddress(ip)) {
    return {
      ok: false,
      error: '169.254.x.x is een noodadres, geen vast adres. Kies een adres in je eigen netwerk (bijv. 192.168.1.211).',
    };
  }
  // Keep the network's own prefix, so pinning leaves the laptop in exactly the network it is in now.
  let prefixLength = 24;
  if (input.prefixLength !== undefined && input.prefixLength !== null && input.prefixLength !== '') {
    prefixLength = Number(input.prefixLength);
    if (!Number.isInteger(prefixLength) || prefixLength < 8 || prefixLength > 30) {
      return { ok: false, error: 'Gebruik een normaal subnetmasker (aanbevolen: 24).' };
    }
  }
  const hostMask = ~prefixMask(prefixLength) >>> 0;
  const hostBits = ipv4ToNumber(octets) & hostMask;
  if (hostBits === 0 || hostBits === hostMask) {
    return {
      ok: false,
      error: `${ip} is het eerste of laatste adres van dit netwerk (/${prefixLength}) en werkt niet. Kies bijv. .211.`,
    };
  }
  let gateway: string | null = null;
  if (typeof input.gateway === 'string' && input.gateway.trim()) {
    const gatewayOctets = parseIpv4(input.gateway);
    if (!gatewayOctets) return { ok: false, error: 'De gateway is geen geldig IPv4-adres.' };
    gateway = gatewayOctets.join('.');
    if (!sameSubnet(ip, gateway, prefixLength)) {
      return { ok: false, error: 'De gateway moet in hetzelfde netwerk zitten als het vaste adres.' };
    }
  }
  return { ok: true, ip, prefixLength, gateway };
}

// Live profile (best effort; never throws).

type NetAdapterProfile = {
  name: string;
  address: string;
  prefixLength: number | null;
  dhcp: boolean | null;
  /** System name of the connection (NetworkManager connection or macOS service), for actions. */
  connection: string | null;
};

type ElevateMethod = 'uac' | 'pkexec' | 'osascript' | null;

type ElevationOutcome = {
  id: string;
  state: 'waiting' | 'finished' | 'failed';
  message: string | null;
  startedAt: number;
};

type NetProfile = {
  platform: NodeJS.Platform;
  windows: boolean;
  /** How the button asks for permission (null = manual steps only). */
  elevateMethod: ElevateMethod;
  /** Short explanation for the UI, e.g. "Windows vraagt om toestemming (klik op Ja)". */
  elevateHint: string | null;
  /** What manages the address, e.g. "NetworkManager: Bekabeld". */
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

let lastElevation: ElevationOutcome | null = null;

function beginElevation(): ElevationOutcome {
  lastElevation = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    state: 'waiting',
    message: null,
    startedAt: Date.now(),
  };
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
    lastElevation =
      exitCode === 0
        ? { ...outcome, state: 'finished', message: null }
        : { ...outcome, state: 'failed', message: describeElevationFailure(process.platform, exitCode, stderr) };
  });
}

/**
 * Small local queries only, with a hard timeout. Never synchronous: PowerShell
 * can take seconds to start, and the server must keep sending heartbeats and
 * answering presses meanwhile.
 */
function execFileQuiet(file: string, args: string[], timeout = 8_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { encoding: 'utf8', timeout, windowsHide: true }, (error, stdout) =>
      error ? reject(error) : resolve(stdout)
    );
    child.stdin?.end();
  });
}

/** A cold PowerShell start on a slow laptop or a busy virus scanner can take well over 8 s. */
const WINDOWS_NET_READ_TIMEOUT_MS = 20_000;

/** One PowerShell start for both values: one tab-separated line per interface and per address. */
const WINDOWS_NET_READ_COMMAND =
  'Get-NetIPInterface -AddressFamily IPv4 -ErrorAction SilentlyContinue | ' +
  'ForEach-Object { "dhcp`t$($_.InterfaceAlias)`t$($_.Dhcp)" }; ' +
  'Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | ' +
  'ForEach-Object { "prefix`t$($_.InterfaceAlias)`t$($_.IPAddress)`t$($_.PrefixLength)" }';

export type WindowsNetReadout = {
  /** DHCP enabled per lowercased interface alias. */
  dhcpByAlias: Map<string, boolean>;
  /** Prefix length per `lowercased alias|address`. */
  prefixByAliasIp: Map<string, number>;
};

export function parseWindowsNetReadout(output: string): WindowsNetReadout {
  const readout: WindowsNetReadout = { dhcpByAlias: new Map(), prefixByAliasIp: new Map() };
  for (const line of output.split(/\r?\n/)) {
    const [kind, alias, ...rest] = line.split('\t');
    if (!alias) continue;
    if (kind === 'dhcp' && rest.length === 1) {
      readout.dhcpByAlias.set(alias.toLowerCase(), rest[0].trim().toLowerCase() === 'enabled');
    } else if (kind === 'prefix' && rest.length === 2) {
      const prefix = Number(rest[1].trim());
      if (Number.isInteger(prefix)) readout.prefixByAliasIp.set(`${alias.toLowerCase()}|${rest[0].trim()}`, prefix);
    }
  }
  return readout;
}

/**
 * Reads through `run` and keeps the last good readout, so a slow or failed read
 * shows the previous state instead of "unknown". Calls during a read share it.
 */
export function createWindowsNetReader(
  run: () => Promise<string>,
  warn: (message: string) => void = console.warn
): () => Promise<WindowsNetReadout> {
  let lastGood: WindowsNetReadout = { dhcpByAlias: new Map(), prefixByAliasIp: new Map() };
  let inFlight: Promise<WindowsNetReadout> | null = null;
  const read = async () => {
    const startedAt = Date.now();
    try {
      const readout = parseWindowsNetReadout(await run());
      if (readout.dhcpByAlias.size === 0) throw new Error('no network interfaces in the output');
      lastGood = readout;
    } catch (error) {
      warn(
        `Windows network read failed after ${Date.now() - startedAt} ms (${describeReadFailure(error)}); ` +
          'Beheer › Systeem shows the last known state'
      );
    }
    return lastGood;
  };
  return () => {
    inFlight ??= read().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

function describeReadFailure(error: unknown): string {
  if ((error as { killed?: boolean } | null)?.killed) return 'timed out';
  if (!(error instanceof Error)) return String(error);
  // execFile puts the command line first and stderr after it; stderr says more.
  const [commandLine, ...stderr] = error.message.split(/\r?\n/);
  return stderr.join(' ').trim().slice(0, 300) || commandLine;
}

const readWindowsNetState = createWindowsNetReader(() =>
  execFileQuiet(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', toEncodedCommand(WINDOWS_NET_READ_COMMAND)],
    WINDOWS_NET_READ_TIMEOUT_MS
  )
);

const TOOL_PROBE_ARGS: Record<string, string[]> = {
  nmcli: ['--version'],
  pkexec: ['--version'],
  networksetup: ['-version'],
  osascript: ['-e', 'return 1'],
};

const toolAvailability = new Map<string, boolean>();

async function toolAvailable(tool: string): Promise<boolean> {
  let available = toolAvailability.get(tool);
  if (available === undefined) {
    try {
      await execFileQuiet(tool, TOOL_PROBE_ARGS[tool] ?? ['--version']);
      available = true;
    } catch {
      available = false;
    }
    toolAvailability.set(tool, available);
  }
  return available;
}

async function readNmActiveConnections(): Promise<NmActiveConnection[]> {
  return parseNmcliActiveConnections(
    await execFileQuiet('nmcli', ['-t', '-f', 'NAME,DEVICE,TYPE', 'connection', 'show', '--active'])
  );
}

type LinuxNetState = {
  connection: string | null;
  connectionType: string | null;
  dhcp: boolean | null;
  prefixLength: number | null;
  gateway: string | null;
};

async function readLinuxNetState(iface: string, address: string): Promise<LinuxNetState> {
  const state: LinuxNetState = {
    connection: null,
    connectionType: null,
    dhcp: null,
    prefixLength: null,
    gateway: null,
  };
  if (!(await toolAvailable('nmcli'))) return state;
  try {
    const active = await readNmActiveConnections();
    const match =
      active.find((item) => item.device === iface) ?? active.find((item) => isWiredNmConnectionType(item.type));
    if (!match) return state;
    state.connection = match.name;
    state.connectionType = match.type;
    try {
      const method = (await execFileQuiet('nmcli', ['-t', '-f', 'ipv4.method', 'connection', 'show', match.name]))
        .split(':')[1]
        ?.trim()
        .toLowerCase();
      if (method === 'auto') state.dhcp = true;
      else if (method === 'manual') state.dhcp = false;
    } catch {
      // Unknown; stays null.
    }
    try {
      const fields = parseNmcliDeviceFields(
        await execFileQuiet('nmcli', ['-t', '-f', 'IP4.ADDRESS,IP4.GATEWAY', 'device', 'show', iface])
      );
      const cidr = fields.get('IP4.ADDRESS') || '';
      const prefix = Number(cidr.match(/\/(\d{1,2})\b/)?.[1]);
      if (cidr.includes(address) && Number.isInteger(prefix) && prefix >= 8 && prefix <= 30) {
        state.prefixLength = prefix;
      }
      const gateway = fields.get('IP4.GATEWAY');
      if (gateway && parseIpv4(gateway)) state.gateway = gateway;
    } catch {
      // Unknown; stays null.
    }
  } catch {
    // NetworkManager missing or unreadable; everything stays null.
  }
  return state;
}

type MacNetState = {
  service: string | null;
  dhcp: boolean | null;
  prefixLength: number | null;
  gateway: string | null;
};

async function readMacNetState(device: string): Promise<MacNetState> {
  const state: MacNetState = { service: null, dhcp: null, prefixLength: null, gateway: null };
  if (!(await toolAvailable('networksetup'))) return state;
  try {
    const ports = parseNetworksetupHardwarePorts(await execFileQuiet('networksetup', ['-listallhardwareports']));
    const match = ports.find((item) => item.device === device);
    if (!match) return state;
    state.service = match.port;
    const info = parseNetworksetupInfo(await execFileQuiet('networksetup', ['-getinfo', match.port]));
    state.dhcp = info.manual === null ? null : !info.manual;
    if (info.mask) state.prefixLength = maskToPrefixLength(info.mask);
    if (info.router && parseIpv4(info.router)) state.gateway = info.router;
  } catch {
    // Best effort only.
  }
  return state;
}

function interfaceNamesByAddress(): Map<string, string> {
  const names = new Map<string, string>();
  try {
    for (const [name, infos] of Object.entries(os.networkInterfaces())) {
      for (const info of infos ?? []) {
        if (info.family === 'IPv4' && !info.internal && info.address && !names.has(info.address)) {
          names.set(info.address, name);
        }
      }
    }
  } catch {
    // The adapter list then shows unknown names.
  }
  return names;
}

async function elevationSupport(platform: NodeJS.Platform): Promise<{ method: ElevateMethod; hint: string | null }> {
  if (platform === 'win32') return { method: 'uac', hint: 'Windows vraagt om toestemming (klik op Ja)' };
  if (platform === 'linux' && (await toolAvailable('nmcli')) && (await toolAvailable('pkexec'))) {
    return { method: 'pkexec', hint: 'Linux vraagt om je wachtwoord' };
  }
  if (platform === 'darwin' && (await toolAvailable('networksetup')) && (await toolAvailable('osascript'))) {
    return { method: 'osascript', hint: 'macOS vraagt om je wachtwoord' };
  }
  return { method: null, hint: null };
}

export async function getNetProfile(): Promise<NetProfile> {
  const platform = process.platform;
  const windows = platform === 'win32';
  const { dhcpByAlias, prefixByAliasIp } = windows
    ? await readWindowsNetState()
    : { dhcpByAlias: new Map<string, boolean>(), prefixByAliasIp: new Map<string, number>() };
  const aliasByAddress = interfaceNamesByAddress();
  const linuxStates = new Map<string, Promise<LinuxNetState>>();
  const linuxState = (iface: string, address: string) => {
    const key = `${iface}|${address}`;
    let state = linuxStates.get(key);
    if (!state) {
      state = readLinuxNetState(iface, address);
      linuxStates.set(key, state);
    }
    return state;
  };

  let manager: string | null = null;
  const adapters: NetAdapterProfile[] = [];
  for (const address of lanAddresses()) {
    const alias = aliasByAddress.get(address) || '';
    const aliasKey = alias.toLowerCase();
    let dhcp: boolean | null = alias ? (dhcpByAlias.get(aliasKey) ?? null) : null;
    let prefixLength: number | null = (alias ? prefixByAliasIp.get(`${aliasKey}|${address}`) : undefined) ?? 24;
    let connection: string | null = null;
    if (alias && platform === 'linux') {
      const linux = await linuxState(alias, address);
      connection = linux.connection;
      dhcp = linux.dhcp ?? dhcp;
      prefixLength = linux.prefixLength ?? prefixLength;
      if (linux.connection) manager = `NetworkManager: ${linux.connection}`;
    } else if (alias && platform === 'darwin') {
      const mac = await readMacNetState(alias);
      connection = mac.service;
      dhcp = mac.dhcp ?? dhcp;
      prefixLength = mac.prefixLength ?? prefixLength;
      if (mac.service) manager = `macOS-netwerkdienst: ${mac.service}`;
    }
    adapters.push({ name: alias || 'onbekend', address, prefixLength, dhcp, connection });
  }

  const primary = adapters[0] ?? null;
  let primaryWired: boolean | null = null;
  if (primary && windows && primary.name !== 'onbekend') {
    primaryWired = !isWirelessWindowsAdapter(primary.name);
  } else if (primary && platform === 'linux') {
    const type = (await linuxState(primary.name, primary.address)).connectionType;
    primaryWired = type ? isWiredNmConnectionType(type) : null;
  } else if (primary?.connection && platform === 'darwin') {
    primaryWired = !isWirelessMacService(primary.connection);
  }
  const apipa = primary ? isApipaAddress(primary.address) : false;
  const elevation = await elevationSupport(platform);
  return {
    platform,
    windows,
    elevateMethod: elevation.method,
    elevateHint: elevation.hint,
    manager,
    adapters,
    primary,
    apipa,
    // "Pin what you have": the current DHCP address becomes the static one.
    suggestion:
      primary && !apipa && isPrivateLanAddress(primary.address)
        ? { ip: primary.address, prefixLength: primary.prefixLength ?? 24, gateway: null }
        : null,
    eventUrl: primary && !apipa ? `http://${primary.address}:${PUBLIC_APP_PORT}` : null,
    primaryWired,
    lastElevation,
  };
}

// Elevated execution. Only validated values and quoted system names reach the
// scripts, and no shell parses the Windows command line.

function toEncodedCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

export function buildWindowsLauncherCommand(encodedCommand: string): string {
  // Wait for the elevated script so a refused prompt or a missing cable is
  // reported right away instead of after the polling timeout.
  const elevated =
    'Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ErrorAction Stop ' +
    `-ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${encodedCommand}'`;
  return (
    `try { $p = ${elevated}; if ($null -eq $p.ExitCode) { exit 0 }; exit $p.ExitCode } ` +
    `catch { [Console]::Error.WriteLine('UAC_CANCELLED'); exit ${WINDOWS_UAC_CANCELLED_EXIT} }`
  );
}

function launchElevatedWindows(script: string): ElevationOutcome {
  const outcome = beginElevation();
  const launcher = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      buildWindowsLauncherCommand(toEncodedCommand(script)),
    ],
    { detached: true, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
  );
  trackElevation(outcome, launcher);
  return outcome;
}

function launchElevatedLinuxScript(scriptText: string): ElevationOutcome {
  // One password prompt: pkexec runs the whole recipe from a temporary script.
  const tmpFile = path.join(os.tmpdir(), `apolloon-net-${Date.now()}-${process.pid}.sh`);
  fs.writeFileSync(tmpFile, `#!/bin/sh\nset -eu\n${scriptText}\n`, { mode: 0o700 });
  const outcome = beginElevation();
  const launcher = spawn('pkexec', ['sh', tmpFile], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  trackElevation(outcome, launcher);
  // Remove once pkexec has read it; harmless if it lingers (0700, in tmp).
  setTimeout(() => {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // Already gone.
    }
  }, 120_000).unref();
  return outcome;
}

function launchElevatedMacOs(innerCommand: string): ElevationOutcome {
  const appleScript = `do shell script "${escapeAppleScriptString(innerCommand)}" with administrator privileges`;
  const outcome = beginElevation();
  const launcher = spawn('osascript', ['-e', appleScript], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  trackElevation(outcome, launcher);
  return outcome;
}

export function buildLinuxSetStaticScript(
  connection: string,
  ip: string,
  prefixLength: number,
  gateway: string | null
): string {
  const quoted = shQuote(connection);
  const gatewayPart = gateway ? ` ipv4.gateway ${gateway}` : '';
  return [
    `nmcli con mod ${quoted} ipv4.addresses ${ip}/${prefixLength}${gatewayPart} ipv4.dns '' ipv4.method manual`,
    `nmcli con up ${quoted}`,
    `if command -v ufw >/dev/null 2>&1; then`,
    `  ufw allow ${PUBLIC_APP_PORT}/tcp >/dev/null 2>&1 || true`,
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
  return `networksetup -setmanual ${shQuote(service)} ${ip} ${mask}${gateway ? ` ${gateway}` : ''}`;
}

export function buildMacOsRevertDhcpCommand(service: string): string {
  return `networksetup -setdhcp ${shQuote(service)}`;
}

/** Wired adapter first, skipping wifi and virtual adapters; exits when none is up. */
const WINDOWS_SELECT_WIRED_ADAPTER = [
  `$ErrorActionPreference = 'Stop'`,
  `$adapters = Get-NetAdapter -Physical | Where-Object { $_.Status -eq 'Up' } | Sort-Object { if ($_.MediaType -match '802.3|Ethernet') { 0 } else { 1 } }`,
  `$adapter = $adapters | Where-Object { $_.Name -notmatch 'Wi-?Fi|WLAN|VPN|vEthernet|Virtual|Bluetooth' } | Select-Object -First 1`,
  `if (-not $adapter) { exit ${WINDOWS_NO_WIRED_ADAPTER_EXIT} }`,
];

export function buildWindowsSetStaticScript(ip: string, prefixLength: number, gateway: string | null): string {
  const gatewayArgument = gateway ? ` -DefaultGateway '${gateway}'` : '';
  return [
    ...WINDOWS_SELECT_WIRED_ADAPTER,
    `$ifIndex = $adapter.ifIndex`,
    `Get-NetIPAddress -InterfaceIndex $ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notmatch '^127\\.' } | ForEach-Object { Remove-NetIPAddress -InterfaceIndex $ifIndex -IPAddress $_.IPAddress -Confirm:$false -ErrorAction SilentlyContinue }`,
    `Get-NetRoute -InterfaceIndex $ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.DestinationPrefix -eq '0.0.0.0/0' } | ForEach-Object { Remove-NetRoute -InterfaceIndex $ifIndex -DestinationPrefix $_.DestinationPrefix -NextHop $_.NextHop -Confirm:$false -ErrorAction SilentlyContinue }`,
    `New-NetIPAddress -InterfaceIndex $ifIndex -IPAddress '${ip}' -PrefixLength ${prefixLength}${gatewayArgument} | Out-Null`,
    `Set-NetIPInterface -InterfaceIndex $ifIndex -Dhcp Disabled | Out-Null`,
    gateway
      ? `# Router-LAN: laat DNS met rust.`
      : `Set-DnsClientServerAddress -InterfaceIndex $ifIndex -ResetServerAddresses | Out-Null`,
    `if (-not (Get-NetFirewallRule -DisplayName 'Apolloon TCP ${PUBLIC_APP_PORT}' -ErrorAction SilentlyContinue)) {`,
    `  New-NetFirewallRule -DisplayName 'Apolloon TCP ${PUBLIC_APP_PORT}' -Direction Inbound -Protocol TCP -LocalPort ${PUBLIC_APP_PORT} -Action Allow -Profile Any | Out-Null`,
    `}`,
    `if (-not (Get-NetFirewallRule -DisplayName 'Apolloon UDP ${DISCOVERY_PORT}' -ErrorAction SilentlyContinue)) {`,
    `  New-NetFirewallRule -DisplayName 'Apolloon UDP ${DISCOVERY_PORT}' -Direction Inbound -Protocol UDP -LocalPort ${DISCOVERY_PORT} -Action Allow -Profile Any | Out-Null`,
    `}`,
  ].join('\r\n');
}

export function buildWindowsRevertDhcpScript(): string {
  return [
    ...WINDOWS_SELECT_WIRED_ADAPTER,
    `Set-NetIPInterface -InterfaceIndex $adapter.ifIndex -Dhcp Enabled | Out-Null`,
    `Set-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -ResetServerAddresses | Out-Null`,
    `Restart-NetAdapter -InterfaceIndex $adapter.ifIndex -Confirm:$false`,
  ].join('\r\n');
}

/** The wired connection behind the primary address, looked up fresh for an action. */
async function resolvePrimaryConnection(): Promise<{ kind: 'nm' | 'macos'; name: string } | null> {
  const profile = await getNetProfile();
  if (!profile.primary || profile.apipa) return null;
  if (process.platform === 'linux') {
    // Only a wired connection: the wifi at home or at school must never be pinned.
    try {
      const wired = (await readNmActiveConnections()).filter((connection) => isWiredNmConnectionType(connection.type));
      const match = wired.find((connection) => connection.device === profile.primary?.name) ?? wired[0];
      return match ? { kind: 'nm', name: match.name } : null;
    } catch {
      return null;
    }
  }
  if (process.platform === 'darwin') {
    const service = (await readMacNetState(profile.primary.name)).service;
    return service && !isWirelessMacService(service) ? { kind: 'macos', name: service } : null;
  }
  return null;
}

type NetActionResult = { ok: true; elevated: true; elevationId: string | null } | { ok: false; error: string };

function failed(error: string): NetActionResult {
  return { ok: false, error };
}

function started(outcome: ElevationOutcome): NetActionResult {
  return { ok: true, elevated: true, elevationId: outcome.id };
}

/** Runs one network change with the platform's elevation helper. */
async function launchNetAction(action: {
  verb: 'vastzetten' | 'terugzetten';
  windowsScript: () => string;
  linuxScript: (connection: string) => string;
  /** Null when the command cannot be built (invalid mask). */
  macCommand: (service: string) => string | null;
}): Promise<NetActionResult> {
  try {
    if (process.platform === 'win32') {
      return started(launchElevatedWindows(action.windowsScript()));
    }
    if (process.platform === 'linux') {
      if (!(await toolAvailable('nmcli')) || !(await toolAvailable('pkexec'))) {
        return failed(`Automatisch ${action.verb} kan hier niet (NetworkManager of pkexec ontbreekt). ${MANUAL_HINT}`);
      }
      const resolved = await resolvePrimaryConnection();
      if (resolved?.kind !== 'nm') return failed(NO_WIRED_CONNECTION);
      return started(launchElevatedLinuxScript(action.linuxScript(resolved.name)));
    }
    if (process.platform === 'darwin') {
      if (!(await toolAvailable('networksetup')) || !(await toolAvailable('osascript'))) {
        return failed(`Automatisch ${action.verb} kan hier niet. ${MANUAL_HINT}`);
      }
      const resolved = await resolvePrimaryConnection();
      if (resolved?.kind !== 'macos') return failed(NO_WIRED_CONNECTION);
      const command = action.macCommand(resolved.name);
      if (!command) return failed('Ongeldig subnetmasker.');
      return started(launchElevatedMacOs(command));
    }
    return failed(`Automatisch ${action.verb} werkt niet op dit systeem. ${MANUAL_HINT}`);
  } catch (error) {
    return failed(error instanceof Error ? error.message : 'Kon de netwerkactie niet starten.');
  }
}

export async function requestMakeStatic(input: {
  ip?: unknown;
  prefixLength?: unknown;
  gateway?: unknown;
}): Promise<NetActionResult> {
  const validated = validateStaticRequest(input);
  if (!validated.ok) return validated;
  const { ip, prefixLength, gateway } = validated;
  return launchNetAction({
    verb: 'vastzetten',
    windowsScript: () => buildWindowsSetStaticScript(ip, prefixLength, gateway),
    linuxScript: (connection) => buildLinuxSetStaticScript(connection, ip, prefixLength, gateway),
    macCommand: (service) => {
      const mask = prefixLengthToMask(prefixLength);
      return mask ? buildMacOsSetManualCommand(service, ip, mask, gateway) : null;
    },
  });
}

export async function requestRevertDhcp(input: {
  eventOver?: unknown;
  confirmText?: unknown;
}): Promise<NetActionResult> {
  if (input.eventOver !== true) {
    return failed('Bevestig eerst dat het evenement helemaal voorbij is.');
  }
  const text = typeof input.confirmText === 'string' ? input.confirmText.trim().toUpperCase() : '';
  if (text !== NET_SETUP_UNDO_PHRASE) {
    return failed(`Typ eerst ${NET_SETUP_UNDO_PHRASE} om te bevestigen.`);
  }
  return launchNetAction({
    verb: 'terugzetten',
    windowsScript: buildWindowsRevertDhcpScript,
    linuxScript: buildLinuxRevertDhcpScript,
    macCommand: buildMacOsRevertDhcpCommand,
  });
}
