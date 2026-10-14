import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { brusselsMoment, isAvailableAtMoment } from '../src/lib/availability.ts';
import { temporaryDataPath } from './temporary-data.ts';

const dataPath = temporaryDataPath('demo-race');
process.env.DATA_PATH = dataPath;
process.env.NODE_ENV = 'test';

test('the demo race starts at 20:00 Brussels time and keeps its laps between 1:08 and 1:25', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');
  const demo = await import('../server/demo-race.ts');
  await db.initDb();
  try {
    // 29 September 2026 15:21 CEST; the race started the evening before.
    const now = Date.parse('2026-09-29T13:21:00Z');
    assert.equal(demo.latestDemoRaceStart(now), Date.parse('2026-09-28T18:00:00Z'));
    // In winter Brussels is UTC+1.
    assert.equal(demo.latestDemoRaceStart(Date.parse('2026-12-01T20:30:00Z')), Date.parse('2026-12-01T19:00:00Z'));

    assert.equal(demo.advanceDemoRace(now), true);
    const race = db.getRaceState();
    assert.equal(race.raceStartedAt, Date.parse('2026-09-28T18:00:00Z'));
    assert.ok(race.activeRunnerId);
    assert.ok(now - race.activeStartedAt! < 85_000);

    const laps = db.getAllLaps();
    assert.ok(laps.length > 800 && laps.length < 1_100, `${laps.length} laps`);
    assert.ok(laps.every((lap) => lap.durationMs >= 68_000 && lap.durationMs <= 85_000));
    assert.equal(db.getAllRunners().filter((runner) => runner.status === 'waiting').length, 8);

    // Every runner has made-up form answers, and every hour of the race has runners free.
    const registrations = Object.values(db.getRunnerRegistrations());
    assert.equal(registrations.length, db.getAllRunners().length);
    for (const registration of registrations) {
      for (const [field, value] of Object.entries(registration)) {
        assert.ok(Array.isArray(value) ? value.length : value.trim(), `${field} is empty`);
      }
      assert.match(registration.email, /@example\.be$/);
    }
    for (let hour = 0; hour < 24; hour += 1) {
      const moment = brusselsMoment(race.raceStartedAt! + hour * 3_600_000);
      const free = registrations.filter((registration) => isAvailableAtMoment(registration.availableHours, moment));
      assert.ok(free.length >= 3, `${free.length} runners free at ${moment.hour}u ${moment.weekday}`);
    }

    // Nothing is due a second later; at the next 20:00 the race starts over.
    assert.equal(demo.advanceDemoRace(now + 1), false);
    demo.advanceDemoRace(Date.parse('2026-09-29T18:00:05Z'));
    assert.equal(db.getRaceState().raceStartedAt, Date.parse('2026-09-29T18:00:00Z'));
    assert.equal(db.getAllLaps().length, 0);
  } finally {
    db.closeDb();
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});
