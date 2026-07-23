#!/usr/bin/env node
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const args = process.argv.slice(2);
const require = createRequire(import.meta.url);
const packageJson = require(path.join(repoRoot, 'package.json'));
const electronVersion = require(
  path.join(repoRoot, 'node_modules', 'electron', 'package.json')
).version;
const { getAbi } = require('node-abi');
const electronAbi = String(getAbi(electronVersion, 'electron'));
const nodeAbi = String(process.versions.modules);

const builderCli = path.join(
  repoRoot,
  'node_modules',
  'electron-builder',
  'out',
  'cli',
  'cli.js'
);
const electronRebuildCli = path.join(
  repoRoot,
  'node_modules',
  '@electron',
  'rebuild',
  'lib',
  'cli.js'
);
const localBinding = path.join(
  repoRoot,
  'node_modules',
  'better-sqlite3',
  'build',
  'Release',
  'better_sqlite3.node'
);
const nativeBindingParts = [
  'app.asar.unpacked',
  'node_modules',
  'better-sqlite3',
  'build',
  'Release',
  'better_sqlite3.node',
];
const packagedBinding = resolvePackagedBinding();
const npmRestore = process.env.npm_execpath
  ? {
      command: process.execPath,
      args: [process.env.npm_execpath, 'rebuild', 'better-sqlite3'],
      shell: false,
    }
  : {
      command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
      args: ['rebuild', 'better-sqlite3'],
      shell: process.platform === 'win32',
    };

let exitCode = 0;
let packageCreated = false;

try {
  console.log(
    `Rebuilding better-sqlite3 for Electron ${electronVersion} (ABI ${electronAbi})...`
  );
  exitCode = await run(process.execPath, [
    electronRebuildCli,
    '--version',
    electronVersion,
    '--force',
    '--which-module',
    'better-sqlite3',
    '--build-from-source',
  ]);
  if (exitCode !== 0) {
    throw new Error('Electron better-sqlite3 rebuild failed.');
  }
  assertNativeAbi(localBinding, electronAbi, 'Electron build input');

  // electron-builder's automatic native dependency pass may select a regular
  // Node prebuild. We already built and verified the exact Electron ABI above.
  const builderArgs = [...args, '--config.npmRebuild=false'];
  if (!args.some((arg) => arg === '--publish' || arg.startsWith('--publish='))) {
    builderArgs.push('--publish', 'never');
  }
  exitCode = await run(process.execPath, [builderCli, ...builderArgs]);
  if (exitCode !== 0) {
    throw new Error(`electron-builder exited with code ${exitCode}.`);
  }

  if (packagedBinding) {
    assertNativeAbi(packagedBinding, electronAbi, 'Packaged application');
  }
  packageCreated = true;
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  exitCode = exitCode || 1;
} finally {
  await run(npmRestore.command, npmRestore.args, { shell: npmRestore.shell })
    .then((restoreCode) => {
      if (restoreCode !== 0) {
        console.error('Failed to restore Node better-sqlite3 binding after Electron build.');
        exitCode = exitCode || restoreCode;
      }
    })
    .catch((err) => {
      console.error('Failed to restore Node better-sqlite3 binding after Electron build.');
      console.error(err instanceof Error ? err.message : err);
      exitCode = exitCode || 1;
    });

  try {
    assertNativeAbi(localBinding, nodeAbi, 'Restored Node development binding');
    if (packageCreated && packagedBinding) {
      assertNativeAbi(packagedBinding, electronAbi, 'Packaged application after restore');
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    exitCode = exitCode || 1;
  }
}

process.exit(exitCode);

function assertNativeAbi(bindingPath, expectedAbi, label) {
  if (!fs.existsSync(bindingPath)) {
    throw new Error(`${label}: native binding is missing at ${bindingPath}`);
  }

  const marker = Buffer.from(`node_register_module_v${expectedAbi}`);
  if (!fs.readFileSync(bindingPath).includes(marker)) {
    throw new Error(
      `${label}: better-sqlite3 does not target the expected ABI ${expectedAbi}.`
    );
  }
  console.log(`${label}: verified better-sqlite3 ABI ${expectedAbi}.`);
}

function resolvePackagedBinding() {
  const targetPlatform = args.includes('--win')
    ? 'win32'
    : args.includes('--linux')
      ? 'linux'
      : args.includes('--mac')
        ? 'darwin'
        : process.platform;

  if (targetPlatform === 'win32') {
    return path.join(repoRoot, 'release', 'win-unpacked', 'resources', ...nativeBindingParts);
  }
  if (targetPlatform === 'linux') {
    return path.join(repoRoot, 'release', 'linux-unpacked', 'resources', ...nativeBindingParts);
  }
  if (targetPlatform === 'darwin') {
    const outputDirectory = process.arch === 'arm64' ? 'mac-arm64' : 'mac';
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
