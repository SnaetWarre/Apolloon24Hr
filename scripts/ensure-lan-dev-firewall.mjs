/**
 * Best-effort: open TCP 5173 for the Vite dev server on LAN. Does not block dev if the user
 * cancels or the step is unsupported.
 * - Windows: if rule "ApolloonVite5173" is missing, opens UAC and runs netsh advfirewall
 * - Linux: if ufw is available and 5173 is not listed, runs pkexec ufw (Polkit password dialog)
 * Skip: CI=1, SKIP_LAN_FIREWALL=1, or if rule already present
 */
import { execFileSync, spawnSync } from 'node:child_process';

const RULE_NAME = 'ApolloonVite5173';
const PORT = 5173;

function log(msg) {
  console.log(`[dev:firewall] ${msg}`);
}

function shouldSkip() {
  const e = process.env;
  if (e.SKIP_LAN_FIREWALL === '1' || e.CI === 'true' || e.CI === '1') {
    if (e.SKIP_LAN_FIREWALL === '1') {
      log('skip (SKIP_LAN_FIREWALL=1).');
    } else {
      log('skip (CI).');
    }
    return true;
  }
  return false;
}

function commandInPath(cmd) {
  if (process.platform === 'win32') {
    return spawnSync('where', [cmd], { stdio: 'ignore' }).status === 0;
  }
  return spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0;
}

function windowsRuleExists() {
  const r = spawnSync('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${RULE_NAME}`], {
    stdio: 'ignore',
  });
  return r.status === 0;
}

function ensureWindows() {
  if (windowsRuleExists()) {
    log(`Windows: inbound rule "${RULE_NAME}" already present.`);
    return;
  }
  log(
    'Windows: no firewall rule for this port — you should see a UAC prompt. Approve to allow other devices (same Wi-Fi / hotspot) to reach the dev server on port 5173.'
  );
  const args = [
    'advfirewall',
    'firewall',
    'add',
    'rule',
    `name=${RULE_NAME}`,
    'dir=in',
    'action=allow',
    'protocol=TCP',
    `localport=${String(PORT)}`,
  ];
  const argList = args.map((a) => `'${a.replace(/'/g, "''")}'`).join(',');
  const ps = `Start-Process -FilePath netsh -ArgumentList ${argList} -Verb RunAs -Wait`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    stdio: 'inherit',
  });
  if (r.status === 0) {
    if (windowsRuleExists()) {
      log('Windows: rule added. Inbound TCP ' + String(PORT) + ' is allowed.');
    } else {
      log(
        'Windows: UAC may have been cancelled or the rule was not created — another device may not reach :' +
          String(PORT) +
          '.'
      );
    }
  } else {
    log(
      'Windows: could not start elevation (status ' +
        String(r.status) +
        '). Add an inbound allow rule for TCP ' +
        String(PORT) +
        ' in Windows Defender Firewall if needed.'
    );
  }
}

function ufwMentionsPort() {
  try {
    const out = execFileSync('ufw', ['status'], { encoding: 'utf-8' });
    return new RegExp(String(PORT) + '/tcp').test(out);
  } catch {
    return false;
  }
}

function ensureLinuxUfw() {
  if (!commandInPath('ufw')) {
    return;
  }
  if (ufwMentionsPort()) {
    log('Linux (ufw): port ' + String(PORT) + '/tcp is already allowed in the ufw list.');
    return;
  }
  if (!commandInPath('pkexec')) {
    log('Linux: pkexec not found. To allow the port, run: sudo ufw allow ' + String(PORT) + '/tcp');
    return;
  }
  log(
    'Linux: a Polkit / password dialog may appear to add ufw allow ' +
      String(PORT) +
      '/tcp. You can cancel; dev will still start.'
  );
  const r = spawnSync('pkexec', ['ufw', 'allow', `${String(PORT)}/tcp`], { stdio: 'inherit' });
  if (r.status === 0) {
    log('Linux (ufw): done.');
  } else {
    log('Linux (ufw): pkexec exited ' + String(r.status) + ' — you can run: sudo ufw allow ' + String(PORT) + '/tcp');
  }
}

function ensureMac() {
  log(
    'macOS: if a remote device cannot connect, allow incoming connections for Node in System Settings when the system offers it, or for TCP ' +
      String(PORT) +
      ' in the firewall app you use.'
  );
}

function main() {
  if (shouldSkip()) {
    return;
  }
  try {
    if (process.platform === 'win32') {
      ensureWindows();
    } else if (process.platform === 'linux') {
      ensureLinuxUfw();
    } else {
      ensureMac();
    }
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    log('non-fatal: ' + m);
  }
}

main();
