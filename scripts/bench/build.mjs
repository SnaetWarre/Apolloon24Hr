import { createHash } from 'node:crypto';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const inputs = [
  'native/patches/rune/apolloon.patch',
  'native/patches/rune/revision',
  'native/scripts/prepare-rune.sh',
  'native/scripts/build-web.sh',
];
const artifacts = ['native/target/release/apolloon-native', 'native/web-dist/index.html'];
const stampFile = 'native/target/release/.six-screens-build-stamp';

export function runeBuildStamp(contents) {
  const hash = createHash('sha256');
  for (const content of contents) hash.update(content).update('\0');
  return hash.digest('hex');
}

async function optional(read) {
  try {
    return await read();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

export async function ensureBenchmarkBuild(build, { root = process.cwd(), log = console.log } = {}) {
  const stamp = path.join(root, stampFile);
  const current = runeBuildStamp(await Promise.all(inputs.map((file) => readFile(path.join(root, file)))));
  const saved = await optional(() => readFile(stamp, 'utf8'));
  const missing = [];
  for (const file of artifacts) {
    if (
      (await optional(async () => {
        await access(path.join(root, file));
        return true;
      })) === null
    )
      missing.push(file);
  }
  const reason = missing.length
    ? `missing ${missing.join(', ')}`
    : saved === null
      ? 'missing build stamp'
      : saved.trim() !== current
        ? 'Rune build inputs changed'
        : null;
  if (reason === null) {
    log('bench build: skip (Rune inputs unchanged; binary and web-dist exist)');
    return;
  }
  log(`bench build: rebuild (${reason})`);
  await rm(stamp, { force: true });
  await build();
  await writeFile(stamp, current + '\n');
}
