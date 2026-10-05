#!/usr/bin/env node
// Replaces the compiled server entry (dist-server/server/index.js) with one file that holds the
// server and its packages. Loading some 300 modules one by one from app.asar took most of the
// server's start; one file starts in about a third of the time. The other compiled files stay
// next to it, for the backup worker (server/backups.ts) and the tests.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(repositoryRoot, 'dist-server', 'server', 'index.js');

await build({
  entryPoints: [entry],
  outfile: entry,
  allowOverwrite: true,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Packages written as CommonJS call require() for Node's own modules.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: 'warning',
});
