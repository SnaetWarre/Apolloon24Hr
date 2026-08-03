import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const dataPath = path.resolve('.tmp-test-temporary-teams');
process.env.DATA_PATH = dataPath;

test('temporary teams restore base teams and laps retain the team from their start', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');
  await db.initDb();

  const blue = db.findLabelByName('Speedteam Blue');
  const white = db.findLabelByName('Speedteam White');
  assert.ok(blue);
  assert.ok(white);

  const alice = db.insertRunner({ name: 'Alice', runnerNumber: '1', labels: [blue.id] });
  const bob = db.insertRunner({ name: 'Bob', runnerNumber: '2', labels: [white.id] });
  const trojan = db.createLabel({ name: 'Trojan', kind: 'temporary_team', color: '#7c3aed' });
  const trojanV2 = db.createLabel({ name: 'Trojan V2', kind: 'temporary_team', color: '#db2777' });

  db.setTemporaryTeamMembers(trojan.id, [alice.id]);
  db.setTemporaryTeamMembers(trojanV2.id, [bob.id]);
  assert.throws(
    () => db.setTemporaryTeamMembers(trojanV2.id, [alice.id]),
    /maar in een tijdelijke nachtploeg/
  );

  db.setTemporaryTeamActive(trojan.id, true, 500);
  db.setTemporaryTeamActive(trojanV2.id, true, 500);
  assert.deepEqual(db.getRunnerById(alice.id)?.labels.map((label) => label.id), [trojan.id]);
  assert.deepEqual(db.getRunnerById(bob.id)?.labels.map((label) => label.id), [trojanV2.id]);
  db.setTemporaryTeamActive(trojan.id, false, 600);
  db.setTemporaryTeamActive(trojanV2.id, false, 600);
  assert.ok(db.getRunnerById(alice.id)?.labels.some((label) => label.id === blue.id));
  assert.ok(db.getRunnerById(bob.id)?.labels.some((label) => label.id === white.id));

  db.updateRunnerStatus({ id: alice.id, status: 'waiting', statusSince: 900, queueIndex: 0 });
  db.performHandoff(1_000);
  db.setTemporaryTeamActive(trojan.id, true, 2_000);
  db.updateRunnerStatus({ id: bob.id, status: 'waiting', statusSince: 60_000, queueIndex: 0 });
  db.performHandoff(71_000);

  db.updateRunnerStatus({ id: alice.id, status: 'waiting', statusSince: 120_000, queueIndex: 0 });
  db.performHandoff(141_000);
  db.setTemporaryTeamActive(trojan.id, false, 150_000);
  db.updateRunnerStatus({ id: bob.id, status: 'waiting', statusSince: 200_000, queueIndex: 0 });
  db.performHandoff(211_000);

  const aliceLaps = db.getAllLaps().filter((lap) => lap.runnerId === alice.id).reverse();
  assert.equal(aliceLaps.length, 2);
  assert.deepEqual(aliceLaps[0].labels.map((label) => label.id), [blue.id]);
  assert.deepEqual(aliceLaps[1].labels.map((label) => label.id), [trojan.id]);
  assert.equal(aliceLaps[1].labels[0]?.targetLaps, null);
  const stored = new Database(path.join(dataPath, 'data', 'app.db'), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const rawLabels = JSON.parse(
      String(
        stored
          .prepare('SELECT labels_json FROM laps WHERE id = ?')
          .pluck()
          .get(aliceLaps[1].id)
      )
    ) as Array<Record<string, unknown>>;
    assert.deepEqual(Object.keys(rawLabels[0]).sort(), [
      'color',
      'icon',
      'id',
      'kind',
      'name',
    ]);
  } finally {
    stored.close();
  }
  assert.ok(db.getRunnerById(alice.id)?.labels.some((label) => label.id === blue.id));

  db.setTemporaryTeamActive(trojan.id, true, 220_000);
  assert.throws(
    () => db.deleteLabel(blue.id),
    /Deactiveer de tijdelijke nachtploeg/
  );
  assert.throws(
    () => db.updateLabel(blue.id, { kind: 'andere' }),
    /Deactiveer de tijdelijke nachtploeg/
  );
  assert.equal(db.findLabelByName('Speedteam Blue')?.id, blue.id);
  const { appSnapshot } = await import('../server/app-state.ts');
  const snapshot = appSnapshot();
  db.applySnapshot(snapshot);
  assert.equal(db.getTemporaryTeams().find((team) => team.labelId === trojan.id)?.active, true);
  db.setTemporaryTeamActive(trojan.id, false, 230_000);
  assert.ok(db.getRunnerById(alice.id)?.labels.some((label) => label.id === blue.id));
  assert.deepEqual(
    db.getAllLaps().filter((lap) => lap.runnerId === alice.id).reverse().map((lap) => lap.labels[0]?.id),
    [blue.id, trojan.id]
  );

  db.closeDb();
  fs.rmSync(dataPath, { recursive: true, force: true });
});
