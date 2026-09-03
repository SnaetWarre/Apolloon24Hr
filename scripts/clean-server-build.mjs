#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const compiledServerDirectory = path.join(repositoryRoot, 'dist-server');

if (path.dirname(compiledServerDirectory) !== repositoryRoot) {
  throw new Error(`Refusing to clean unexpected path: ${compiledServerDirectory}`);
}

await fs.promises.rm(compiledServerDirectory, { recursive: true, force: true });
