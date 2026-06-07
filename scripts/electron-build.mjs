#!/usr/bin/env node
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const args = process.argv.slice(2);

const builderCli = path.join(
  repoRoot,
  'node_modules',
  'electron-builder',
  'out',
  'cli',
  'cli.js'
);
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

try {
  exitCode = await run(process.execPath, [builderCli, ...args]);
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
}

process.exit(exitCode);

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
