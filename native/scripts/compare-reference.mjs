// Read parity against an untouched schema-17 snapshot from a disposable verification run.
import { DatabaseSync, backup } from 'node:sqlite';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
const runName = process.env.APOLLOON_VERIFY_RUN;
assert(runName && /^[\w-]+$/.test(runName), 'Set APOLLOON_VERIFY_RUN to the disposable reference run');
const run = JSON.parse(await readFile(`.tmp-verify/${runName}/state.json`, 'utf8'));
const destination = path.resolve(`.tmp-native-evidence/${runName}`);
await mkdir(destination, { recursive: true });
const source = new DatabaseSync(path.join(run.laptops[0].dataPath, 'data/app.db'), { readOnly: true });
await backup(source, path.join(destination, 'app.db'));
source.close();
const socket = createServer();
socket.listen(0, '127.0.0.1');
await once(socket, 'listening');
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const child = spawn(path.resolve('native/target/debug/apolloon-native'), ['--server'], {
  env: { ...process.env, PORT: String(port), APOLLOON_NATIVE_DATA: path.join(destination, 'app.db') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', (b) => (logs += b));
child.stderr.on('data', (b) => (logs += b));
try {
  const native = `http://127.0.0.1:${port}`;
  const reference = run.laptops[0].url;
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(`${native}/api/health`);
      if (r.ok) break;
    } catch {}
    if (attempt >= 100 || child.exitCode !== null) throw new Error(`Native startup failed: ${logs}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const get = async (url, route) => {
    const r = await fetch(url + route);
    assert(r.ok, `${route}: ${r.status}`);
    return r.json();
  };
  const [expected, actual, expectedHistory, actualHistory] = await Promise.all([
    get(reference, '/api/state'),
    get(native, '/api/state'),
    get(reference, '/api/history?scope=full'),
    get(native, '/api/history?scope=full'),
  ]);
  await writeFile(
    path.join(destination, 'fixture.json'),
    JSON.stringify({ snapshot: expected, history: expectedHistory, clock: Date.now() }, null, 2)
  );
  // Host endpoint and revision are process-local. All event fields must match exactly.
  for (const value of [expected, actual]) {
    delete value.host;
    delete value.revision;
  }
  for (const value of [expectedHistory, actualHistory]) delete value.revision;
  await writeFile(path.join(destination, 'reference-state.json'), JSON.stringify(expected, null, 2));
  await writeFile(path.join(destination, 'native-state.json'), JSON.stringify(actual, null, 2));
  assert(
    isDeepStrictEqual(actual, expected),
    'Rust live-state differs: inspect native-state.json and reference-state.json'
  );
  await writeFile(path.join(destination, 'native-history.json'), JSON.stringify(actualHistory, null, 2));
  await writeFile(path.join(destination, 'reference-history.json'), JSON.stringify(expectedHistory, null, 2));
  assert(
    isDeepStrictEqual(actualHistory, expectedHistory),
    'Rust lap-history differs: inspect native-history.json and reference-history.json'
  );
  for (const route of [
    '/api/history?scope=recent&limit=3',
    `/api/history?scope=runner&runnerId=${expected.runners[0].id}`,
    '/api/registrations',
  ]) {
    const [a, b] = await Promise.all([get(native, route), get(reference, route)]);
    delete a.revision;
    delete b.revision;
    assert(isDeepStrictEqual(a, b), `Read contract differs: ${route}`);
  }
  for (const input of [{ limit: 10 }, { limit: 2, queueMoves: false }, { limit: 10, search: 'lop' }]) {
    const route = '/trpc/activity.list?input=' + encodeURIComponent(JSON.stringify(input));
    const [a, b] = await Promise.all([get(native, route), get(reference, route)]);
    assert(isDeepStrictEqual(a, b), 'Activity pagination/filter contract differs');
  }
  for (const file of ['laps.csv', 'events.csv', 'laps.json', 'events.json', 'current-state.json']) {
    const route = '/api/export/' + file;
    const [a, b] = await Promise.all([fetch(native + route), fetch(reference + route)]);
    assert(a.ok && b.ok, `Export unavailable: ${file}`);
    assert.equal(a.headers.get('content-disposition'), b.headers.get('content-disposition'));
    if (file.endsWith('.csv')) assert.equal(await a.text(), await b.text(), `CSV differs: ${file}`);
    else {
      const av = await a.json(),
        bv = await b.json();
      if (file === 'current-state.json') {
        delete av.host;
        delete bv.host;
        delete av.revision;
        delete bv.revision;
      }
      assert(isDeepStrictEqual(av, bv), `JSON export differs: ${file}`);
    }
  }
  const workbooks = await Promise.all([
    fetch(native + '/api/export/race.xlsx'),
    fetch(reference + '/api/export/race.xlsx'),
  ]);
  assert(
    workbooks.every((r) => r.ok),
    'Workbook downloads must succeed'
  );
  const files = [path.join(destination, 'native.xlsx'), path.join(destination, 'reference.xlsx')];
  for (let i = 0; i < 2; i++) await writeFile(files[i], Buffer.from(await workbooks[i].arrayBuffer()));
  console.log(execFileSync('python3', ['native/scripts/compare-workbook.py', ...files], { encoding: 'utf8' }));
  console.log(
    'PASS: live state, full/recent/runner history, registrations, activity and five CSV/JSON exports match the reference'
  );
} finally {
  child.kill('SIGTERM');
  if (child.exitCode === null) await once(child, 'exit');
  await writeFile(path.join(destination, 'server.log'), logs);
}
