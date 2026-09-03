import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  buildHourlyHistoricalPaces,
  buildRaceProgress,
  buildTargetPaces,
  historicalLapCountAt,
  parseHistoricalRace,
  projectedLapCount,
  targetLapCountAt,
  validLiveLaps,
} from '../src/lib/tactics';
import type { LapRecord } from '../src/types';

test('historical race parser validates and derives individual lap durations', () => {
  const race = parseHistoricalRace(JSON.stringify({
    teams: [
      { teamId: 4, lapTimes: [80_000, 162_000] },
      { teamId: 1, lapTimes: [75_000, 151_000, 228_000] },
    ],
  }));

  assert.deepEqual(race.teams.map((team) => team.teamId), [1, 4]);
  assert.deepEqual(race.teams[0].lapDurationsMs, [75_000, 76_000, 77_000]);
  const raceWithQuivrDuplicate = parseHistoricalRace(
    '[{"teamId":18,"lapTimes":[90000,80000,90000]}]'
  );
  assert.deepEqual(raceWithQuivrDuplicate.teams[0].cumulativeLapTimesMs, [80_000, 90_000]);
});

test('historical lap lookup returns the completed count at a race moment', () => {
  const [team] = parseHistoricalRace('[{"teamId":1,"lapTimes":[60000,120000,181000]}]').teams;

  assert.equal(historicalLapCountAt(team, 0), 0);
  assert.equal(historicalLapCountAt(team, 2 / 60), 2);
  assert.equal(historicalLapCountAt(team, 24), 3);
});

test('target pace plan reaches the selected lap target and retains reference shape', () => {
  const referenceLapTimes = Array.from({ length: 720 }, () => 0);
  let cumulativeMs = 0;
  for (let index = 0; index < referenceLapTimes.length; index += 1) {
    const raceHour = Math.min(23, Math.floor(cumulativeMs / 3_600_000));
    cumulativeMs += raceHour >= 8 && raceHour < 16 ? 130_000 : 110_000;
    referenceLapTimes[index] = cumulativeMs;
  }
  const [referenceTeam] = parseHistoricalRace(JSON.stringify([{ teamId: 1, lapTimes: referenceLapTimes }])).teams;
  const targetPaces = buildTargetPaces(800, referenceTeam);

  assert.ok(Math.abs(targetLapCountAt(targetPaces, 24) - 800) < 0.5);
  assert.ok(targetPaces[10] > targetPaces[2]);
  assert.equal(buildHourlyHistoricalPaces(referenceTeam).length, 24);
});

test('live filtering and projection use Apolloon lap records without file conversion', () => {
  const raceStartedAt = 1_000_000;
  const laps = [
    lap('valid-1', raceStartedAt + 80_000, 80_000),
    lap('too-fast', raceStartedAt + 120_000, 40_000),
    lap('valid-2', raceStartedAt + 200_000, 80_000),
  ];
  const filteredLaps = validLiveLaps(laps, raceStartedAt, 55, 140);
  const flatPaces = buildTargetPaces(720, null);

  assert.deepEqual(filteredLaps.map((raceLap) => raceLap.id), ['valid-1', 'valid-2']);
  assert.equal(targetLapCountAt(flatPaces, 12), 360);
  assert.equal(Math.round(projectedLapCount(360, 12, flatPaces)), 720);

  const progress = buildRaceProgress({
    liveLaps: filteredLaps,
    raceStartedAt,
    elapsedHours: 1,
    targetPacesSeconds: flatPaces,
    ownHistoricalTeam: null,
    rivalHistoricalTeam: null,
  });
  assert.equal(progress.find((point) => point.raceHour === 1)?.liveLaps, 2);
  assert.equal(progress.at(-1)?.liveLaps, null);
});

test("Kobe's tactiek is a dedicated route backed by Apolloon's realtime history hook", () => {
  const routerSource = fs.readFileSync('src/router.tsx', 'utf8');
  const viewSource = fs.readFileSync('src/components/KobeTacticsView.tsx', 'utf8');
  const realtimeSource = fs.readFileSync('src/app/realtimeClient.ts', 'utf8');

  assert.match(routerSource, /path: '\/tactics'/);
  assert.match(viewSource, /useRaceHistory\(\{ scope: 'full' \}\)/);
  assert.doesNotMatch(viewSource, /laps\.json/);
  assert.match(realtimeSource, /socket\.on\('lap:created'/);
  assert.match(realtimeSource, /patchRaceHistories/);
});

test('bundled Quivr 2025 data is valid and contains the Apolloon and VTK reference teams', () => {
  const bundledReference = parseHistoricalRace(
    fs.readFileSync('public/reference/quivr-2025-lap-times.json', 'utf8')
  );

  assert.equal(bundledReference.teams.length, 21);
  assert.equal(bundledReference.teams.find((team) => team.teamId === 1)?.cumulativeLapTimesMs.length, 1_095);
  assert.equal(bundledReference.teams.find((team) => team.teamId === 4)?.cumulativeLapTimesMs.length, 1_102);
});

function lap(id: string, finishedAt: number, durationMs: number): LapRecord {
  return {
    id,
    runnerId: `runner-${id}`,
    runnerNumber: null,
    runnerName: id,
    lapNumber: 1,
    startedAt: finishedAt - durationMs,
    finishedAt,
    durationMs,
    source: 'timing',
    createdAt: finishedAt,
    labels: [],
  };
}
