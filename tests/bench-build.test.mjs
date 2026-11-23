import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureBenchmarkBuild, runeBuildStamp } from '../scripts/bench/build.mjs';

const inputs = [
  'native/patches/rune/apolloon.patch',
  'native/patches/rune/revision',
  'native/scripts/prepare-rune.sh',
  'native/scripts/build-web.sh',
];
const artifacts = ['native/target/release/apolloon-native', 'native/web-dist/index.html'];
const stamp = 'native/target/release/.six-screens-build-stamp';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'apolloon-bench-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (file, content = file) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  };
  for (const file of [...inputs, ...artifacts]) await put(file);
  let builds = 0;
  const logs = [];
  const build = async () => {
    builds++;
    for (const file of artifacts) await put(file);
  };
  return { root, put, build, logs, options: { root, log: (line) => logs.push(line) }, builds: () => builds };
}

test('Rune stamp hashes content and preserves input boundaries', () => {
  assert.equal(runeBuildStamp(['patch', 'pin']), runeBuildStamp(['patch', 'pin']));
  assert.notEqual(runeBuildStamp(['patch', 'pin']), runeBuildStamp(['changed', 'pin']));
  assert.notEqual(runeBuildStamp(['ab', 'c']), runeBuildStamp(['a', 'bc']));
  assert.notEqual(runeBuildStamp([]), runeBuildStamp(['']));
});

test('existing artifacts without a stamp rebuild, then unchanged inputs skip', async (t) => {
  const f = await fixture(t);
  await ensureBenchmarkBuild(f.build, f.options);
  assert.equal(f.builds(), 1);
  assert.match(await readFile(path.join(f.root, stamp), 'utf8'), /^[a-f0-9]{64}\n$/);
  await ensureBenchmarkBuild(f.build, f.options);
  assert.equal(f.builds(), 1);
  assert.deepEqual(f.logs, [
    'bench build: rebuild (missing build stamp)',
    'bench build: skip (Rune inputs unchanged; binary and web-dist exist)',
  ]);
});

for (const input of inputs) {
  test(`changed ${input} rebuilds`, async (t) => {
    const f = await fixture(t);
    await ensureBenchmarkBuild(f.build, f.options);
    await appendFile(path.join(f.root, input), '\nchanged\n');
    await ensureBenchmarkBuild(f.build, f.options);
    assert.equal(f.builds(), 2);
    assert.equal(f.logs.at(-1), 'bench build: rebuild (Rune build inputs changed)');
    await ensureBenchmarkBuild(f.build, f.options);
    assert.equal(f.builds(), 2);
  });
}

for (const artifact of artifacts) {
  test(`missing ${artifact} rebuilds despite a matching stamp`, async (t) => {
    const f = await fixture(t);
    await ensureBenchmarkBuild(f.build, f.options);
    await rm(path.join(f.root, artifact));
    await ensureBenchmarkBuild(f.build, f.options);
    assert.equal(f.builds(), 2);
    assert.equal(f.logs.at(-1), `bench build: rebuild (missing ${artifact})`);
  });
}

test('a failed build leaves no stamp, even if the old inputs are restored', async (t) => {
  const f = await fixture(t);
  await ensureBenchmarkBuild(f.build, f.options);
  await appendFile(path.join(f.root, inputs[0]), '\nchanged\n');
  await assert.rejects(
    ensureBenchmarkBuild(() => {
      throw new Error('build failed');
    }, f.options),
    /build failed/
  );
  await assert.rejects(readFile(path.join(f.root, stamp)), { code: 'ENOENT' });
  await f.put(inputs[0]);
  await ensureBenchmarkBuild(f.build, f.options);
  assert.equal(f.builds(), 2);
  assert.equal(f.logs.at(-1), 'bench build: rebuild (missing build stamp)');
});

test('missing required Rune input fails rather than reusing old artifacts', async (t) => {
  const f = await fixture(t);
  await rm(path.join(f.root, inputs[0]));
  await assert.rejects(ensureBenchmarkBuild(f.build, f.options), { code: 'ENOENT' });
  assert.equal(f.builds(), 0);
});
