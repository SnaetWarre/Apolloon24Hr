import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { temporaryDataPath } from './temporary-data.ts';

const dataPath = temporaryDataPath('temporary-teams');
process.env.DATA_PATH = dataPath;
process.env.NODE_ENV = 'test';

test('night teams swap the speedteam only inside their window, and laps keep the team they started in', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');
  await db.initDb();
  try {
    const blue = db.findLabelByName('Speedteam Blue')!;
    const white = db.findLabelByName('Speedteam White')!;
    const alice = db.insertRunner({ name: 'Alice', runnerNumber: '1', labels: [blue.id] });
    const bob = db.insertRunner({ name: 'Bob', runnerNumber: '2', labels: [white.id] });
    const trojan = db.createLabel({ name: 'Trojan', kind: 'temporary_team', color: '#7c3aed' });
    const trojanV2 = db.createLabel({ name: 'Trojan V2', kind: 'temporary_team', color: '#db2777' });

    db.setTemporaryTeamMembers(trojan.id, [alice.id]);
    db.setTemporaryTeamMembers(trojanV2.id, [bob.id]);
    assert.throws(() => db.setTemporaryTeamMembers(trojanV2.id, [alice.id]), /maar in een tijdelijke nachtploeg/);

    // An unscheduled team is switched by hand.
    db.setTemporaryTeamActive(trojanV2.id, true, 500);
    assert.deepEqual(
      db.getRunnerById(bob.id)?.labels.map((label) => label.id),
      [trojanV2.id]
    );
    db.setTemporaryTeamActive(trojanV2.id, false, 600);
    assert.deepEqual(
      db.getRunnerById(bob.id)?.labels.map((label) => label.id),
      [white.id]
    );

    // A scheduled team follows its window; laps keep the labels of the moment they started.
    db.setTemporaryTeamSchedule(trojan.id, 2_000, 150_000);
    assert.throws(() => db.setTemporaryTeamActive(trojan.id, true), /volgt haar planning/);
    db.updateRunnerStatus({ id: alice.id, status: 'waiting', statusSince: 900, queueIndex: 0 });
    db.performHandoff(1_000);
    db.updateRunnerStatus({ id: bob.id, status: 'waiting', statusSince: 60_000, queueIndex: 0 });
    db.performHandoff(71_000);
    db.updateRunnerStatus({ id: alice.id, status: 'waiting', statusSince: 120_000, queueIndex: 0 });
    db.performHandoff(141_000);
    db.updateRunnerStatus({ id: bob.id, status: 'waiting', statusSince: 200_000, queueIndex: 0 });
    db.performHandoff(211_000);

    const aliceLaps = db
      .getAllLaps()
      .filter((lap) => lap.runnerId === alice.id)
      .reverse();
    assert.deepEqual(
      aliceLaps.map((lap) => lap.labels.map((label) => label.id)),
      [[blue.id], [trojan.id]]
    );
    assert.deepEqual(
      db.getRunnerById(alice.id)?.labels.map((label) => label.id),
      [blue.id],
      'window is over'
    );

    const stored = new DatabaseSync(path.join(dataPath, 'data', 'app.db'), { readOnly: true });
    try {
      const rawLabels = JSON.parse(
        String(stored.prepare('SELECT labels_json FROM laps WHERE id = ?').get(aliceLaps[1].id)?.labels_json)
      ) as Array<Record<string, unknown>>;
      assert.deepEqual(Object.keys(rawLabels[0]).sort(), ['color', 'icon', 'id', 'kind', 'name']);
    } finally {
      stored.close();
    }
  } finally {
    db.closeDb();
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test('editing labels during a night team keeps the runner in their own speedteam', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');
  await db.initDb();
  try {
    const blue = db.findLabelByName('Speedteam Blue')!;
    const white = db.findLabelByName('Speedteam White')!;
    const dames = db.findLabelByName('Dames')!;
    const alice = db.insertRunner({ name: 'Alice', runnerNumber: '1', labels: [blue.id] });
    const night = db.createLabel({ name: 'Nachtploeg', kind: 'temporary_team', color: '#7c3aed' });
    db.setTemporaryTeamMembers(night.id, [alice.id]);
    db.setTemporaryTeamSchedule(night.id, Date.now() - 60_000, Date.now() + 3_600_000);

    // The profile form sends the labels it shows, which include the night team.
    db.updateRunner(alice.id, { labels: [night.id, white.id, dames.id] });
    assert.deepEqual(
      db
        .getRunnerById(alice.id)
        ?.labels.map((label) => label.name)
        .sort(),
      ['Dames', 'Nachtploeg']
    );

    db.setTemporaryTeamSchedule(night.id, 0, 1);
    assert.deepEqual(
      db
        .getRunnerById(alice.id)
        ?.labels.map((label) => label.name)
        .sort(),
      ['Dames', 'Speedteam Blue']
    );

    // Removing the team gives every member their stored labels back.
    db.setTemporaryTeamSchedule(night.id, Date.now() - 60_000, Date.now() + 3_600_000);
    assert.ok(db.deleteLabel(night.id));
    assert.deepEqual(
      db
        .getRunnerById(alice.id)
        ?.labels.map((label) => label.name)
        .sort(),
      ['Dames', 'Speedteam Blue']
    );
    assert.deepEqual(db.getTemporaryTeams(), []);
  } finally {
    db.closeDb();
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});
