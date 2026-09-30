#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const outputName = process.argv[2];

if (!['dist-server', 'dist-electron'].includes(outputName)) {
  throw new Error(`Refusing to clean unexpected build output: ${outputName}`);
}

await fs.promises.rm(path.join(repositoryRoot, outputName), { recursive: true, force: true });
