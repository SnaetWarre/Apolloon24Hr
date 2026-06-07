#!/usr/bin/env node
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const args = process.argv.slice(2);

const builderBin = path.join(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder'
);
const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';

let exitCode = 0;

try {
  exitCode = await run(builderBin, args);
} finally {
  await run(npmBin, ['rebuild', 'better-sqlite3']).catch((err) => {
    console.error('Failed to restore Node better-sqlite3 binding after Electron build.');
    console.error(err instanceof Error ? err.message : err);
    exitCode = exitCode || 1;
  });
}

process.exit(exitCode);

function run(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
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
      resolve(code ?? 0);
    });
  });
}
