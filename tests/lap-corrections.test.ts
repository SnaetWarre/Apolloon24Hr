import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { isFastestLapForRecordMode } from '../src/lib/analysis.ts';
import { temporaryDataPath } from './temporary-data.ts';

const dataPath = temporaryDataPath('lap-corrections');
process.env.DATA_PATH = dataPath;
process.env.NODE_ENV = 'test';

type Db = typeof import('../server/db.ts');

async function withDb(check: (db: Db) => void): Promise<void> {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');
  try {
    await db.initDb();
    check(db);
  } finally {
    // Windows cannot delete a database file that is still open.
    db.closeDb();
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
}

/** Runners in the queue in this order, each pressed off after `lapMs`; returns them and their laps, oldest first. */
function race(db: Db, names: string[], lapMs = 80_000) {
  const runners = names.map((name, index) => db.insertRunner({ name, runnerNumber: String(index + 1) }));
  runners.forEach((runner, index) =>
    db.updateRunnerStatus({ id: runner.id, status: 'waiting', statusSince: index, queueIndex: index })
  );
  for (let press = 0; press <= runners.length; press += 1) db.performHandoff(1_000 + press * lapMs);
  return { runners, laps: () => [...db.getAllLaps()].reverse() };
}

test('a lap moved to another runner takes that runner’s labels, and both runners are numbered again', async () => {
  await withDb((db) => {
    const { runners, laps } = race(db, ['Anna', 'Bert', 'Cas']);
    const [anna, bert, cas] = runners;
    const dames = db.getLabels().find((label) => label.name === 'Dames');
    assert.ok(dames);
    db.updateRunner(cas.id, { labels: [dames.id] });
    const [, bertLap] = laps();

    assert.deepEqual(db.moveLap(bertLap.id, cas.id), { ok: true });

    const moved = laps().find((lap) => lap.id === bertLap.id);
    assert.equal(moved?.runnerId, cas.id);
    assert.deepEqual(
      moved?.labels.map((label) => label.name),
      ['Dames']
    );
    // Cas ran after Bert: the moved lap is now Cas's first, the one Cas ran their second.
    assert.deepEqual(
      laps()
        .filter((lap) => lap.runnerId === cas.id)
        .map((lap) => lap.lapNumber),
      [1, 2]
    );
    assert.equal(db.getRunnerById(bert.id)?.lapCount, 0);
    assert.equal(db.getRunnerById(anna.id)?.lapCount, 1);
    assert.throws(() => db.moveLap(bertLap.id, cas.id), /staat al op die loper/);
    assert.throws(() => db.moveLap('gone', cas.id), /bestaat niet meer/);
  });
});

test('a lap split for a missed press gives each half its own runner, and undo takes back both halves', async () => {
  await withDb((db) => {
    const { runners, laps } = race(db, ['Anna', 'Bert'], 160_000);
    const [anna, bert] = runners;
    const last = laps().at(-1);
    assert.ok(last && last.runnerId === bert.id);
    assert.equal(last.durationMs, 160_000);

    const result = db.splitLap(last.id, anna.id);
    assert.equal(result.lapIds[0], last.id);

    const [first, second] = laps().filter((lap) => result.lapIds.includes(lap.id));
    assert.deepEqual(
      [first.runnerId, first.startedAt, first.finishedAt, first.durationMs],
      [bert.id, last.startedAt, last.startedAt + 80_000, 80_000]
    );
    assert.deepEqual(
      [second.runnerId, second.startedAt, second.finishedAt, second.durationMs, second.source],
      [anna.id, last.startedAt + 80_000, last.finishedAt, 80_000, 'split']
    );
    assert.deepEqual(
      laps()
        .filter((lap) => lap.runnerId === anna.id)
        .map((lap) => lap.lapNumber),
      [1, 2]
    );

    // The handoff that recorded the lap is the last one: undoing it removes both halves.
    const undone = db.undoLastHandoff();
    assert.ok(undone.ok);
    assert.deepEqual(undone.deletedLapIds.sort(), [...result.lapIds].sort());
    assert.equal(
      laps().some((lap) => result.lapIds.includes(lap.id)),
      false
    );
    assert.equal(db.getRaceState().activeRunnerId, bert.id);
  });
});

test('a lap split for a runner who ran twice keeps the labels it was recorded with, and neither half is a record', async () => {
  await withDb((db) => {
    const dames = db.getLabels().find((label) => label.name === 'Dames');
    const blue = db.findLabelByName('Speedteam Blue');
    assert.ok(dames && blue);
    const anna = db.insertRunner({ name: 'Anna', runnerNumber: '1', labels: [dames.id, blue.id] });
    const night = db.createLabel({ name: 'Nachtploeg', kind: 'temporary_team', color: '#7c3aed' });
    db.setTemporaryTeamMembers(night.id, [anna.id]);
    // The night team starts during Anna's second double lap, before its middle.
    db.setTemporaryTeamSchedule(night.id, 220_000, 400_000);
    db.updateRunnerStatus({ id: anna.id, status: 'waiting', statusSince: 0, queueIndex: 0 });
    db.performHandoff(1_000);
    db.performHandoff(101_000);
    db.updateRunnerStatus({ id: anna.id, status: 'waiting', statusSince: 150_000, queueIndex: 0 });
    db.performHandoff(201_000);
    db.performHandoff(301_000);
    const [early, late] = [...db.getAllLaps()].reverse();
    // Anna stopped counting as a lady after the race; her past laps still do.
    db.updateRunner(anna.id, { labels: [] });

    const halves = (lapId: string, startedAt: number) => {
      db.splitLap(lapId, anna.id);
      return db.getAllLaps().filter((lap) => lap.startedAt === startedAt || lap.startedAt === startedAt + 50_000);
    };
    const names = (lap: { labels: Array<{ name: string }> }) => lap.labels.map((label) => label.name).sort();
    for (const half of halves(early.id, early.startedAt)) {
      assert.deepEqual(names(half), ['Dames', 'Speedteam Blue']);
      assert.equal(half.source, 'split');
    }
    // The half after the night team started runs for the night team, still as a lady.
    const [lateFirst, lateSecond] = halves(late.id, late.startedAt).sort((a, b) => a.startedAt - b.startedAt);
    assert.deepEqual(names(lateFirst), ['Dames', 'Speedteam Blue']);
    assert.deepEqual(names(lateSecond), ['Dames', 'Nachtploeg']);

    // A measured 60 s lap beats the 50 s guesses: it is still the record of the day, hour and two hours.
    const race = db.getRaceState();
    const measured = {
      ...early,
      id: 'measured',
      startedAt: 301_000,
      finishedAt: 361_000,
      durationMs: 60_000,
      source: 'spacebar',
    };
    for (const mode of ['day', 'hour', 'two_hour'] as const) {
      assert.equal(isFastestLapForRecordMode(measured, db.getAllLaps(), race, mode), true, mode);
    }
  });
});

test('a deleted lap is gone and the runner’s other laps are numbered again', async () => {
  await withDb((db) => {
    const { runners, laps } = race(db, ['Anna', 'Bert']);
    const [anna] = runners;
    // Anna runs twice more, each time on her own.
    for (const at of [300_000, 400_000]) {
      db.updateRunnerStatus({ id: anna.id, status: 'waiting', statusSince: at - 1 });
      db.performHandoff(at);
      db.performHandoff(at + 80_000);
    }
    const annaLaps = () => laps().filter((lap) => lap.runnerId === anna.id);
    assert.deepEqual(
      annaLaps().map((lap) => lap.lapNumber),
      [1, 2, 3]
    );

    assert.deepEqual(db.deleteLap(annaLaps()[1].id), { ok: true });

    assert.deepEqual(
      annaLaps().map((lap) => [lap.lapNumber, lap.startedAt]),
      [
        [1, 1_000],
        [2, 400_000],
      ]
    );
    assert.equal(db.getRunnerById(anna.id)?.lapCount, 2);
  });
});
