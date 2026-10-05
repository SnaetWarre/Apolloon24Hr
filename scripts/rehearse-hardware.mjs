/*
 * The event laptops for `npm run rehearse -- --hardware`: the installed app on
 * three real laptops on the event router, driven over SSH (or directly, for
 * the laptop running the rehearsal). See docs/rehearse-hardware.md.
 *
 * - Screens: every laptop is reached through an SSH tunnel to its own
 *   127.0.0.1, like its Electron window, so the bots keep working on a laptop
 *   whose cable is "pulled".
 * - Cable: firewall rules (nft on Linux, Windows Defender Firewall on Windows)
 *   drop the app's traffic to and from the other laptops: TCP on the app port
 *   and UDP discovery. SSH stays open, so the rules can always be removed.
 *   Dropping only one other laptop splits the group partially: A and B lose
 *   each other while C still reaches both.
 * - Power: the whole app is killed (window, server and all), then started
 *   again in the logged-in desktop session.
 * - Lid: the app's processes are frozen, then resumed.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const RULES = 'apolloon_rehearse';
const WINDOWS_TASK = 'ApolloonRehearse';
const DISCOVERY_PORT = 45737;
const WINDOWS_PROCESS = 'Apolloon Telsysteem';
/** The AppImage runtime and everything started from its mount; the brackets keep pkill off its own shell. */
const LINUX_PROCESS = '[A]polloon Telsysteem|[.]mount_Apollo';

const sshOptions = [
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=5',
  '-o',
  'ServerAliveInterval=3',
  '-o',
  'ServerAliveCountMax=2',
];
/** Commands share one connection per laptop, so a fault costs one round trip instead of a handshake. */
const sshCommandOptions = [
  ...sshOptions,
  ...(process.platform === 'win32'
    ? []
    : [
        '-o',
        'ControlMaster=auto',
        '-o',
        `ControlPath=${path.join(os.tmpdir(), 'apolloon-ssh-%C')}`,
        '-o',
        'ControlPersist=60',
      ]),
];

const shellQuote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;
const psQuote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function readLaptopConfig(file) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(
      `Cannot read ${file}: ${error.message}. Copy scripts/rehearse-laptops.example.json and fill it in.`
    );
  }
  if (!Array.isArray(config.laptops) || config.laptops.length !== 3)
    throw new Error(`${file}: list exactly three laptops`);
  return config.laptops.map((entry) => {
    const { name, ip, os: system, ssh = null, app = null, port = 5173 } = entry;
    const where = `${file}, laptop ${name ?? '?'}`;
    if (!name) throw new Error(`${where}: give it a "name"`);
    if (!net.isIPv4(ip ?? '')) throw new Error(`${where}: "ip" must be its IPv4 address on the event router`);
    if (system !== 'linux' && system !== 'windows') throw new Error(`${where}: "os" is "linux" or "windows"`);
    if (system === 'linux' && !app) throw new Error(`${where}: "app" is the path of the AppImage`);
    if (!Number.isInteger(port)) throw new Error(`${where}: "port" must be a number`);
    return {
      name,
      ip,
      os: system,
      ssh,
      app,
      port,
      process: entry.process ?? (system === 'windows' ? WINDOWS_PROCESS : LINUX_PROCESS),
    };
  });
}

/** Runs a shell script (sh on Linux, PowerShell on Windows) on the laptop. */
function run(laptop, script, { timeoutMs = 60_000 } = {}) {
  let command;
  let args;
  if (laptop.os === 'windows') {
    const full = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'\n${script}`;
    const encoded = Buffer.from(full, 'utf16le').toString('base64');
    [command, args] = ['powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]];
  } else {
    [command, args] = ['sh', ['-c', script]];
  }
  if (laptop.ssh) {
    // Windows hands the command to cmd.exe, which has no quotes to speak of; base64 needs none.
    const remote = laptop.os === 'windows' ? [command, ...args] : [command, ...args.map(shellQuote)];
    args = [...sshCommandOptions, laptop.ssh, remote.join(' ')];
    command = 'ssh';
  }
  return new Promise((resolve, reject) => {
    // Its own process group: Ctrl+C in the terminal must not kill a firewall change halfway.
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    // A shared SSH connection holds the output open until the remote command ends, so a
    // timeout gives up at once instead of waiting for it.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${laptop.name}: no answer within ${timeoutMs / 1000} s`));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else
        reject(
          new Error(`${laptop.name}: ${(stderr || stdout).trim().split('\n').slice(-3).join(' ') || `exit ${code}`}`)
        );
    });
  });
}

// What each operating system runs.

function linuxScripts(laptop, laptops) {
  const ports = [...new Set(laptops.map((other) => other.port))].join(', ');
  const nft = (rules) => `sudo -n nft -f - <<'EOF'\n${rules}\nEOF`;
  return {
    preflight: `sudo -n nft list tables >/dev/null && test -x ${shellQuote(laptop.app)}`,
    stop: `pkill -i -KILL -f ${shellQuote(laptop.process)} || true`,
    freeze: `pkill -i -STOP -f ${shellQuote(laptop.process)} || true`,
    thaw: `pkill -i -CONT -f ${shellQuote(laptop.process)} || true`,
    // Over SSH the desktop's display is only known to the user's systemd manager.
    start: laptop.ssh
      ? `systemd-run --user --collect --quiet ${shellQuote(laptop.app)}`
      : `env -u ELECTRON_RUN_AS_NODE setsid -f ${shellQuote(laptop.app)} >/dev/null 2>&1 </dev/null`,
    cut: (peers, all) => {
      const addresses = peers.map((peer) => peer.ip).join(', ');
      return nft(`table inet ${RULES}
delete table inet ${RULES}
table inet ${RULES} {
  chain input {
    type filter hook input priority -50; policy accept;
    ip saddr { ${addresses} } tcp dport { ${ports} } drop
    ip saddr { ${addresses} } tcp sport { ${ports} } drop
    ${all ? 'iifname != "lo"' : `ip saddr { ${addresses} }`} udp dport ${DISCOVERY_PORT} drop
  }
  chain output {
    type filter hook output priority -50; policy accept;
    ip daddr { ${addresses} } tcp dport { ${ports} } drop
    ip daddr { ${addresses} } tcp sport { ${ports} } drop
    ${all ? `oifname != "lo" udp dport ${DISCOVERY_PORT} drop` : ''}
  }
}`);
    },
    reconnect: nft(`table inet ${RULES}\ndelete table inet ${RULES}`),
    log: `tail -n 3000 "$HOME/.config/Apolloon Telsysteem/server.log"`,
  };
}

function windowsScripts(laptop, laptops) {
  const ports = [...new Set(laptops.map((other) => String(other.port)))].map(psQuote).join(', ');
  const name = psQuote(laptop.process);
  const ntdll = `Add-Type -Namespace Apolloon -Name Ntdll -MemberDefinition '[DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr h); [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr h);'`;
  const exe = laptop.app
    ? psQuote(laptop.app)
    : `@("$env:LOCALAPPDATA\\Programs\\apolloon-telsysteem\\${WINDOWS_PROCESS}.exe", "$env:ProgramFiles\\${WINDOWS_PROCESS}\\${WINDOWS_PROCESS}.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1`;
  const block = (direction, protocol, port, remote) =>
    `New-NetFirewallRule -Group '${RULES}' -DisplayName 'Apolloon rehearsal' -Direction ${direction} -Action Block ` +
    `-Protocol ${protocol} ${port}${remote ? ' -RemoteAddress $peers' : ''} | Out-Null`;
  return {
    // Rules in a firewall profile that is off would do nothing. The task starts the app on the
    // desktop of the logged-in user (started from SSH, it would have no screen), at normal
    // priority instead of the task default below normal.
    preflight: `
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw 'the SSH user is not an administrator, so it cannot change the firewall' }
$profiles = @(Get-NetConnectionProfile) | ForEach-Object { if ("$($_.NetworkCategory)" -eq 'DomainAuthenticated') { 'Domain' } else { "$($_.NetworkCategory)" } }
$off = $profiles | ForEach-Object { Get-NetFirewallProfile -Name $_ } | Where-Object { -not $_.Enabled } | ForEach-Object Name
if ($off) { throw "Windows Firewall is off for the $($off -join ', ') network, so pulling the cable would do nothing" }
$exe = ${exe}
if (-not $exe) { throw 'Apolloon Telsysteem.exe not found; set "app" in the laptop list' }
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances Parallel -Priority 4
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\\$env:USERNAME" -LogonType Interactive
Register-ScheduledTask -TaskName '${WINDOWS_TASK}' -Action (New-ScheduledTaskAction -Execute $exe) -Principal $principal -Settings $settings -Force | Out-Null`,
    stop: `Stop-Process -Name ${name} -Force -ErrorAction SilentlyContinue`,
    freeze: `${ntdll}\nGet-Process -Name ${name} -ErrorAction SilentlyContinue | ForEach-Object { [void][Apolloon.Ntdll]::NtSuspendProcess($_.Handle) }`,
    thaw: `${ntdll}\nGet-Process -Name ${name} -ErrorAction SilentlyContinue | ForEach-Object { [void][Apolloon.Ntdll]::NtResumeProcess($_.Handle) }`,
    start: `Start-ScheduledTask -TaskName '${WINDOWS_TASK}'`,
    cut: (peers, all) =>
      [
        `Remove-NetFirewallRule -Group '${RULES}' -ErrorAction SilentlyContinue`,
        `$peers = @(${peers.map((peer) => psQuote(peer.ip)).join(', ')})`,
        block('Inbound', 'TCP', `-LocalPort ${ports}`, true),
        block('Outbound', 'TCP', `-RemotePort ${ports}`, true),
        block('Inbound', 'UDP', `-LocalPort ${DISCOVERY_PORT}`, !all),
        ...(all ? [block('Outbound', 'UDP', `-RemotePort ${DISCOVERY_PORT}`, false)] : []),
      ].join('\n'),
    reconnect: `Remove-NetFirewallRule -Group '${RULES}' -ErrorAction SilentlyContinue`,
    log: `Get-Content "$env:APPDATA\\Apolloon Telsysteem\\server.log" -Tail 3000`,
  };
}

// Screens, through a tunnel to the laptop's own 127.0.0.1.

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

/** Keeps a tunnel open, and opens it again when it drops (a laptop rebooted or its real cable was pulled). */
function keepTunnel(laptop, localPort, isClosing) {
  const open = () => {
    if (isClosing()) return;
    const child = spawn(
      'ssh',
      [
        ...sshOptions,
        '-o',
        'ControlMaster=no',
        '-o',
        'ControlPath=none',
        '-o',
        'ExitOnForwardFailure=yes',
        '-N',
        '-L',
        `127.0.0.1:${localPort}:127.0.0.1:${laptop.port}`,
        laptop.ssh,
      ],
      { stdio: 'ignore', detached: true }
    );
    laptop.tunnel = child;
    child.on('exit', () => setTimeout(open, 1_000));
  };
  open();
}

/**
 * The three laptops, in the shape the rehearsal drives: power, cable, lid,
 * and a URL that reaches the laptop as its own screen does.
 */
export async function hardwareLaptops(file) {
  const configs = readLaptopConfig(file);
  let closing = false;
  const laptops = [];
  process.on('exit', () => {
    for (const laptop of laptops) laptop.tunnel?.kill();
  });
  for (const config of configs) {
    const scripts = (config.os === 'windows' ? windowsScripts : linuxScripts)(config, configs);
    let url = `http://127.0.0.1:${config.port}`;
    const laptop = { ...config, state: 'up', tunnel: null, scripts };
    if (config.ssh) {
      const localPort = await freePort();
      keepTunnel(laptop, localPort, () => closing);
      url = `http://127.0.0.1:${localPort}`;
    }
    Object.assign(laptop, {
      url,
      lanUrl: `http://${config.ip}:${config.port}`,
      run: (script, options) => run(laptop, script, options),
    });
    laptops.push(laptop);
  }

  const answers = async (laptop) =>
    (await fetch(`${laptop.url}/api/host-info`, { signal: AbortSignal.timeout(2_000) }).catch(() => null))?.ok === true;

  const driver = {
    laptops,
    startupTimeoutMs: 120_000,
    answers,
    async preflight() {
      for (const laptop of laptops) {
        await laptop
          .run(laptop.os === 'windows' ? 'Write-Output ok' : 'echo ok', { timeoutMs: 15_000 })
          .catch((error) => {
            throw new Error(`no SSH to ${laptop.name} (${laptop.ssh}): ${error.message}`);
          });
        await laptop.run(laptop.scripts.preflight);
      }
    },
    async powerOff(laptop) {
      await laptop.run(laptop.scripts.stop);
      laptop.state = 'off';
    },
    async powerOn(laptop, timeoutMs = driver.startupTimeoutMs) {
      if (!(await answers(laptop))) await laptop.run(laptop.scripts.start);
      const deadline = Date.now() + timeoutMs;
      while (!(await answers(laptop))) {
        if (Date.now() > deadline)
          throw new Error(`${laptop.name} did not answer within ${timeoutMs / 1000} s of starting`);
        await sleep(500);
      }
      laptop.state = 'up';
    },
    /** Drops the app's traffic to and from `peers`; all other laptops is a pulled cable. */
    async cut(laptop, peers) {
      await laptop.run(laptop.scripts.cut(peers, peers.length === laptops.length - 1));
    },
    async reconnect(laptop) {
      await laptop.run(laptop.scripts.reconnect);
    },
    async freeze(laptop) {
      await laptop.run(laptop.scripts.freeze);
      laptop.state = 'asleep';
    },
    async thaw(laptop) {
      await laptop.run(laptop.scripts.thaw);
      laptop.state = 'up';
    },
    /** Cables in, lids open, apps running; also after an aborted run. */
    async heal() {
      const failures = [];
      for (const laptop of laptops) {
        await driver
          .reconnect(laptop)
          .catch((error) => failures.push(`firewall rules on ${laptop.name}: ${error.message}`));
        await driver.thaw(laptop).catch((error) => failures.push(`resuming ${laptop.name}: ${error.message}`));
      }
      await Promise.all(
        laptops.map((laptop) =>
          driver.powerOn(laptop).catch((error) => failures.push(`starting ${laptop.name}: ${error.message}`))
        )
      );
      return failures;
    },
    /** The end of each laptop's server log, for a failed run. */
    async saveLogs(directory) {
      fs.mkdirSync(directory, { recursive: true });
      for (const laptop of laptops) {
        const log = await laptop.run(laptop.scripts.log).catch((error) => `log unavailable: ${error.message}`);
        fs.writeFileSync(path.join(directory, `${laptop.name}.log`), `${log}\n`);
      }
    },
    async close() {
      closing = true;
      for (const laptop of laptops) laptop.tunnel?.kill();
    },
  };
  return driver;
}
