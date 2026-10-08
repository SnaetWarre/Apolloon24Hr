/**
 * Windows only: runs the built setup silently and checks that it opens the firewall for the
 * installed app, clears the block rule Windows' own question leaves behind, leaves the rules
 * alone on a second install (an update), and that uninstalling removes them. The CI runner is
 * an administrator without a UAC prompt, so a person saying no to that prompt is not covered.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const { version, build } = JSON.parse(readFileSync('package.json', 'utf8'));
const RULES = ['Apolloon TCP 5173', 'Apolloon UDP 45737'];
const BLOCK_RULE = 'Apolloon test: Windows blocks the app on public networks';

assert.equal(process.platform, 'win32', 'The installer check runs on Windows');
const setups = readdirSync('release').filter((file) => file.includes(version) && file.endsWith('-setup.exe'));
assert.equal(setups.length, 1, 'Expected exactly one Windows setup');
const setup = path.resolve('release', setups[0]);
// The per-user install folder; Windows' own rules spell the path in lower case.
const installDir = path.join(process.env.LOCALAPPDATA, 'Programs', build.productName);
const executable = path.join(installDir, `${build.productName}.exe`);

// Exits with 0 itself where a missing rule is an expected, non-terminating error.
function powershell(command) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    timeout: 60_000,
  }).trim();
}

function quote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function readRules() {
  const json = powershell(
    `@(Get-NetFirewallRule -DisplayName ${[...RULES, BLOCK_RULE].map(quote).join(',')} -ErrorAction SilentlyContinue | ForEach-Object {
      [pscustomobject]@{
        id = $_.Name
        name = $_.DisplayName
        action = $_.Action.ToString()
        profile = $_.Profile.ToString()
        program = ($_ | Get-NetFirewallApplicationFilter).Program
        protocol = ($_ | Get-NetFirewallPortFilter).Protocol
        port = [string]($_ | Get-NetFirewallPortFilter).LocalPort
      }
    }) | ConvertTo-Json -Compress; exit 0`
  );
  return json ? [JSON.parse(json)].flat() : [];
}

async function waitFor(label, check) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const rules = readRules();
    if (check(rules)) return rules;
    await sleep(1_000);
  }
  throw new Error(`${label}: ${JSON.stringify(readRules())}`);
}

function assertAppRules(rules) {
  assert.deepEqual(
    rules.map(({ name, action, profile, program, protocol, port }) => ({
      name,
      action,
      profile,
      program: program.toLowerCase(),
      protocol,
      port,
    })),
    [
      {
        name: RULES[0],
        action: 'Allow',
        profile: 'Any',
        program: executable.toLowerCase(),
        protocol: 'TCP',
        port: '5173',
      },
      {
        name: RULES[1],
        action: 'Allow',
        profile: 'Any',
        program: executable.toLowerCase(),
        protocol: 'UDP',
        port: '45737',
      },
    ]
  );
}

powershell(
  `Remove-NetFirewallRule -DisplayName ${[...RULES, BLOCK_RULE].map(quote).join(',')} -ErrorAction SilentlyContinue; exit 0`
);
// What Windows leaves when its "Allow access?" question is answered with the default tick.
powershell(
  `New-NetFirewallRule -DisplayName ${quote(BLOCK_RULE)} -Direction Inbound -Program ${quote(executable.toLowerCase())} -Action Block -Profile Public | Out-Null`
);

execFileSync(setup, ['/S'], { stdio: 'inherit', timeout: 300_000 });
const installed = await waitFor('The installer did not open the firewall', (rules) => rules.length === 2);
assert.ok(existsSync(executable), `Installed app at ${executable}`);
assertAppRules(installed);
console.log('install: both rules allow the app on every network type; the block rule is gone');

execFileSync(setup, ['/S', '--updated'], { stdio: 'inherit', timeout: 300_000 });
const updated = readRules();
assertAppRules(updated);
assert.deepEqual(
  updated.map((rule) => rule.id),
  installed.map((rule) => rule.id),
  'An update keeps the same rules instead of adding them again'
);
console.log('update: the same rules stay');

// The uninstaller copies itself to a temporary folder and returns at once.
execFileSync(path.join(installDir, `Uninstall ${build.productName}.exe`), ['/S'], {
  stdio: 'inherit',
  timeout: 300_000,
});
await waitFor('The uninstaller left the firewall rules', (rules) => rules.length === 0);
console.log('uninstall: both rules are gone');
