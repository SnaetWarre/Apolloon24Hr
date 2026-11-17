// Runs original and Rust import mutations against isolated copies of the same database.
import { DatabaseSync, backup } from 'node:sqlite';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import Papa from 'papaparse';
import path from 'node:path';
const runName = process.env.APOLLOON_VERIFY_RUN;
assert(runName && /^[\w-]+$/.test(runName), 'Set APOLLOON_VERIFY_RUN to an isolated verify-apolloon run');
const run = JSON.parse(await readFile(`.tmp-verify/${runName}/state.json`, 'utf8'));
const dir = path.resolve(`.tmp-native-evidence/${runName}-imports-${Date.now()}`);
await mkdir(dir, { recursive: true });
const source = new DatabaseSync(path.join(run.laptops[0].dataPath, 'data/app.db'), { readOnly: true });
await backup(source, path.join(dir, 'app.db'));
source.close();
const socket = createServer();
socket.listen(0, '127.0.0.1');
await once(socket, 'listening');
const port = socket.address().port;
await new Promise((r) => socket.close(r));
const child = spawn(path.resolve('native/target/debug/apolloon-native'), ['--server'], {
  env: { ...process.env, PORT: String(port), APOLLOON_NATIVE_DATA: path.join(dir, 'app.db'), BACKUP_ENABLED: 'false' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', (b) => (logs += b));
child.stderr.on('data', (b) => (logs += b));
const urls = [run.laptops[0].url, `http://127.0.0.1:${port}`];
const results = [];
try {
  for (let n = 0; ; n++) {
    try {
      if ((await fetch(urls[1] + '/api/health')).ok) break;
    } catch {}
    if (n > 100) throw Error(logs);
    await new Promise((r) => setTimeout(r, 50));
  }
  const action = async (i, method, input) => {
    const response = await fetch(urls[i] + (i ? '/api/action/' : '/trpc/') + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const data = await response.json();
    assert(response.ok, JSON.stringify(data));
    return i ? data : data.result.data;
  };
  const both = async (method, input) => {
    const [a, b] = await Promise.all([action(0, method, input), action(1, method, input)]);
    if (method.startsWith('runners.import')) assert.deepEqual(b, a);
    results.push({ method, input, result: a });
    return [a, b];
  };
  const form = (name, time, other = {}) => ({
    Tijdsstempel: time,
    'E-mailadres': 'same-club@example.be',
    'Voornaam + naam': name,
    'GSM-nummer': '0471',
    Studiefase: '1ste bach',
    'Behoor je tot': 'Vrouw, Eerstejaars',
    'Ik ben volgende uren beschikbaar': '20-21u, 21-22u',
    ...other,
  });
  await both('runners.importCsv', {
    csvText: Papa.unparse([form('Import Zoë', '04/10/2026 18:14:44'), form('Import Jan', '04/10/2026 18:15:44')]),
  });
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const state = await (await fetch(urls[i] + '/api/state')).json();
    const rid = state.runners.find((r) => r.name === 'Import Zoë').id;
    ids.push(rid);
    await action(i, 'runners.update', {
      id: rid,
      fields: {
        runnerNumber: '70001',
        name: 'Import Zoë Corrected',
        notes: 'Operator edits',
        labels: ['Speedteam'],
        registrationDetails: { phone: '0499', availableHours: ['22-23u'] },
      },
    });
    await action(i, 'runners.setStatus', { id: rid, status: 'waiting' });
  }
  await both('runners.importCsv', {
    csvText: Papa.unparse([
      form('Import Zoë', '04/10/2026 18:14:44', { 'Ik schat in totaal': '14' }),
      form('Import Jan', '04/10/2026 18:15:44'),
    ]),
  });
  await both('runners.importCsv', {
    csvText: Papa.unparse([form('Import Zoë Corrected', '05/10/2026 18:14:44', { 'GSM-nummer': '0488' })]),
  });
  await both('runners.importCsv', {
    csvText:
      'nummer;naam;gemiddelde;labels\n70001;Import Different Person;1:20;Dames\n70001;Import Other Person;1:17;\n70002;Import Plain;1:03,5;Dames\n70003;\n70004;Import Extra;;;extra',
  });
  await both('runners.importCsv', {
    csvText: 'nummer;naam\n70001;Import Different Person\n70001;Import Other Person\n70002;Import Renamed',
  });
  const projections = [];
  for (let i = 0; i < 2; i++) {
    const state = await (await fetch(urls[i] + '/api/state')).json();
    const profiles = await (await fetch(urls[i] + '/api/registrations')).json();
    projections.push(
      state.runners
        .filter((r) => r.name.startsWith('Import '))
        .map((r) => ({
          name: r.name,
          runnerNumber: r.runnerNumber,
          status: r.status,
          queueIndex: r.queueIndex,
          notes: r.notes,
          historicalAvgMs: r.historicalAvgMs,
          historicalBestMs: r.historicalBestMs,
          registrationSource: r.registrationSource,
          labels: r.labels.map((l) => l.name).sort(),
          registration: profiles[r.id] ?? null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    );
  }
  await writeFile(
    path.join(dir, 'comparison.json'),
    JSON.stringify({ results, reference: projections[0], native: projections[1] }, null, 2)
  );
  assert.deepEqual(projections[1], projections[0]);
  console.log(
    `PASS: import summaries, repeat identity, operator edits, shared email, duplicate bibs, queue state, and registration fields match the original. Evidence: ${dir}`
  );
} finally {
  child.kill('SIGTERM');
  if (child.exitCode === null) await once(child, 'exit');
  await writeFile(path.join(dir, 'server.log'), logs);
}
