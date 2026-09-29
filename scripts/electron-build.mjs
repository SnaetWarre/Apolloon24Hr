#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const builderCli = path.join(repoRoot, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
const sqliteBindingPath = path.join(
  repoRoot,
  'node_modules',
  'better-sqlite3',
  'build',
  'Release',
  'better_sqlite3.node'
);
const nodeBinding = readNativeBinding(sqliteBindingPath, process.versions.modules);
const electronRebuildMarker = path.join(path.dirname(sqliteBindingPath), '.forge-meta');
const builderArgs = process.argv.slice(2);

if (!builderArgs.some((arg) => arg === '--publish' || arg.startsWith('--publish='))) {
  builderArgs.push('--publish', 'never');
}

let exitCode = 1;

try {
  // electron-builder performs its standard native dependency rebuild for Electron.
  // The marker belongs to the Electron ABI that the previous build replaced locally.
  fs.rmSync(electronRebuildMarker, { force: true });
  exitCode = await run(process.execPath, [builderCli, ...builderArgs]);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
} finally {
  const packagedBindings = snapshotPackagedSqliteBindings();
  // Apolloon also runs its backend directly with Node.js. Restore the original
  // binding without changing a hard-linked binary in the packaged application.
  try {
    restoreNodeBinding(nodeBinding);
    fs.rmSync(electronRebuildMarker, { force: true });
  } catch (error) {
    console.error('Failed to restore better-sqlite3 for the local Node.js runtime.');
    console.error(error instanceof Error ? error.message : error);
    exitCode = 1;
  }
  try {
    for (const binding of packagedBindings) restoreBinding(binding, 'electron');
  } catch (error) {
    console.error('Failed to preserve better-sqlite3 in the packaged application.');
    console.error(error instanceof Error ? error.message : error);
    exitCode = 1;
  }
}

process.exit(exitCode);

function readNativeBinding(bindingPath, expectedAbi) {
  if (!fs.existsSync(bindingPath)) {
    throw new Error(`better-sqlite3 is not installed at ${bindingPath}`);
  }

  const contents = fs.readFileSync(bindingPath);
  const abiMarker = Buffer.from(`node_register_module_v${expectedAbi}`);
  if (!contents.includes(abiMarker)) {
    throw new Error(`better-sqlite3 does not match the local Node.js ABI ${expectedAbi}.`);
  }

  return {
    path: bindingPath,
    contents,
    mode: fs.statSync(bindingPath).mode,
  };
}

function restoreNodeBinding(binding) {
  restoreBinding(binding, 'node');
}

function snapshotPackagedSqliteBindings() {
  const releaseDirectory = path.join(repoRoot, 'release');
  if (!fs.existsSync(releaseDirectory)) return [];

  const bindings = [];
  const directories = [releaseDirectory];
  while (directories.length > 0) {
    const directory = directories.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(entryPath);
      } else if (
        entry.isFile() &&
        entry.name === 'better_sqlite3.node' &&
        entryPath.includes(`${path.sep}better-sqlite3${path.sep}`)
      ) {
        bindings.push({
          path: entryPath,
          contents: fs.readFileSync(entryPath),
          mode: fs.statSync(entryPath).mode,
        });
      }
    }
  }
  return bindings;
}

function restoreBinding(binding, runtime) {
  const temporaryPath = `${binding.path}.${runtime}-${process.pid}`;
  try {
    fs.writeFileSync(temporaryPath, binding.contents, { mode: binding.mode });
    fs.rmSync(binding.path, { force: true });
    fs.renameSync(temporaryPath, binding.path);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: false,
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited with signal ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}
