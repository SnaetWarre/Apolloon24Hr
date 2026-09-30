import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';

/**
 * A fresh data folder for one test file, in the system's temporary folder rather than the
 * repository, removed once the file's tests are done, also when one of them failed.
 */
export function temporaryDataPath(name: string): string {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), `apolloon-test-${name}-`));
  after(() => fs.rmSync(dataPath, { recursive: true, force: true }));
  return dataPath;
}
