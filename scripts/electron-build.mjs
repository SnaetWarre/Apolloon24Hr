#!/usr/bin/env node
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const args = process.argv.slice(2);
const packageJson = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')
);

const builderCli = path.join(
  repoRoot,
  'node_modules',
  'electron-builder',
  'out',
  'cli',
  'cli.js'
);
const targetPlatform = resolveTargetPlatform();
const targetArch = resolveTargetArch();
const prebuildName = `${targetPlatform}-${targetArch}.node`;
const sourceBinding = path.join(
  repoRoot,
  'node_modules',
  'better-sqlite3',
  'prebuilds',
  prebuildName
);
const nativeBindingParts = [
  'app.asar.unpacked',
  'node_modules',
  'better-sqlite3',
  'prebuilds',
  prebuildName,
];
const packagedBinding = resolvePackagedBinding();

let exitCode = 0;

try {
  assertNapiBinding(sourceBinding, 'Electron build input');

  // better-sqlite3 v13 ships N-API prebuilds for every supported desktop target.
  // Keep electron-builder from replacing the selected prebuild with an ABI-specific build.
  const builderArgs = [...args, '--config.npmRebuild=false'];
  if (!args.some((arg) => arg === '--publish' || arg.startsWith('--publish='))) {
    builderArgs.push('--publish', 'never');
  }
  exitCode = await run(process.execPath, [builderCli, ...builderArgs]);
  if (exitCode !== 0) {
    throw new Error(`electron-builder exited with code ${exitCode}.`);
  }

  if (packagedBinding) {
    assertNapiBinding(packagedBinding, 'Packaged application');
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  exitCode = exitCode || 1;
}

process.exit(exitCode);

function assertNapiBinding(bindingPath, label) {
  if (!fs.existsSync(bindingPath)) {
    throw new Error(`${label}: native binding is missing at ${bindingPath}`);
  }

  const marker = Buffer.from('napi_register_module_v1');
  if (!fs.readFileSync(bindingPath).includes(marker)) {
    throw new Error(`${label}: better-sqlite3 is not an N-API binding.`);
  }
  console.log(`${label}: verified better-sqlite3 N-API binding ${prebuildName}.`);
}

function resolvePackagedBinding() {
  if (targetPlatform === 'win32') {
    return path.join(repoRoot, 'release', 'win-unpacked', 'resources', ...nativeBindingParts);
  }
  if (targetPlatform === 'linux') {
    return path.join(repoRoot, 'release', 'linux-unpacked', 'resources', ...nativeBindingParts);
  }
  if (targetPlatform === 'darwin') {
    const outputDirectory = targetArch === 'arm64' ? 'mac-arm64' : 'mac';
    return path.join(
      repoRoot,
      'release',
      outputDirectory,
      `${packageJson.build.productName}.app`,
      'Contents',
      'Resources',
      ...nativeBindingParts
    );
  }
  return null;
}

function resolveTargetPlatform() {
  if (args.includes('--win')) return 'win32';
  if (args.includes('--linux')) return 'linux';
  if (args.includes('--mac')) return 'darwin';
  return process.platform;
}

function resolveTargetArch() {
  if (args.includes('--arm64')) return 'arm64';
  if (args.includes('--x64')) return 'x64';
  if (process.arch === 'arm64' || process.arch === 'x64') return process.arch;
  throw new Error(`Unsupported desktop architecture: ${process.arch}`);
}

function run(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: options.shell ?? false,
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited with signal ${signal}`));
        return;
      }
      resolve(code ?? 0);
    });
  });
}
