import type { LapRecord } from '../types';

export const RACE_DURATION_HOURS = 24;
export const DEFAULT_MINIMUM_LAP_SECONDS = 55;
export const DEFAULT_MAXIMUM_LAP_SECONDS = 140;

export type HistoricalTeam = {
  teamId: number;
  cumulativeLapTimesMs: number[];
  lapDurationsMs: number[];
};

export type HistoricalRace = {
  teams: HistoricalTeam[];
};

export type RaceProgressPoint = {
  raceHour: number;
  liveLaps: number | null;
  targetLaps: number | null;
  ownHistoricalLaps: number | null;
  rivalHistoricalLaps: number | null;
};

export type HourlyPacePoint = {
  raceHour: number;
  plannedSeconds: number | null;
  actualSeconds: number | null;
  ownHistoricalSeconds: number | null;
  rivalHistoricalSeconds: number | null;
};

export function parseHistoricalRace(jsonText: string): HistoricalRace {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error('Het bestand bevat geen geldige JSON.');
  }

  const entries = historicalEntries(parsed);
  if (!entries.length) throw new Error('Het bestand bevat geen teams.');

  const seenTeamIds = new Set<number>();
  const teams = entries.map((entry, entryIndex) => {
    if (!isRecord(entry)) throw new Error(`Team ${entryIndex + 1} heeft geen geldig formaat.`);
    const teamId = Number(entry.teamId);
    if (!Number.isInteger(teamId) || teamId <= 0) {
      throw new Error(`Team ${entryIndex + 1} heeft geen geldig teamnummer.`);
    }
    if (seenTeamIds.has(teamId)) throw new Error(`Team ${teamId} staat meer dan één keer in het bestand.`);
    seenTeamIds.add(teamId);
    if (!Array.isArray(entry.lapTimes)) throw new Error(`Team ${teamId} heeft geen lijst met rondetijden.`);

    const cumulativeLapTimesMs = entry.lapTimes
      .map((rawTimestamp, lapIndex) => {
        const timestamp = Number(rawTimestamp);
        if (!Number.isFinite(timestamp) || timestamp < 0) {
          throw new Error(`Team ${teamId}, ronde ${lapIndex + 1} heeft geen geldige tijd.`);
        }
        return timestamp;
      })
      .sort((firstTimestamp, secondTimestamp) => firstTimestamp - secondTimestamp)
      .filter((timestamp, index, timestamps) => index === 0 || timestamp > timestamps[index - 1]);

    return {
      teamId,
      cumulativeLapTimesMs,
      lapDurationsMs: cumulativeLapTimesMs.map((timestamp, index) =>
        index === 0 ? timestamp : timestamp - cumulativeLapTimesMs[index - 1]
      ),
    };
  });

  return { teams: teams.sort((firstTeam, secondTeam) => firstTeam.teamId - secondTeam.teamId) };
}

export function validLiveLaps(
  laps: LapRecord[],
  raceStartedAt: number,
  minimumLapSeconds = DEFAULT_MINIMUM_LAP_SECONDS,
  maximumLapSeconds = DEFAULT_MAXIMUM_LAP_SECONDS
): LapRecord[] {
  const minimumDurationMs = minimumLapSeconds * 1_000;
  const maximumDurationMs = maximumLapSeconds * 1_000;
  return laps
    .filter(
      (lap) =>
        lap.finishedAt >= raceStartedAt && lap.durationMs >= minimumDurationMs && lap.durationMs <= maximumDurationMs
    )
    .sort((firstLap, secondLap) => firstLap.finishedAt - secondLap.finishedAt);
}

export function historicalLapCountAt(team: HistoricalTeam | null, elapsedHours: number): number | null {
  if (!team) return null;
  const elapsedMs = Math.max(0, elapsedHours) * 3_600_000;
  return upperBound(team.cumulativeLapTimesMs, elapsedMs);
}

export function buildHourlyHistoricalPaces(team: HistoricalTeam | null): Array<number | null> {
  if (!team) return Array.from({ length: RACE_DURATION_HOURS }, () => null);
  const durationsByHour = Array.from({ length: RACE_DURATION_HOURS }, () => [] as number[]);
  team.cumulativeLapTimesMs.forEach((timestamp, index) => {
    const raceHour = Math.min(RACE_DURATION_HOURS - 1, Math.max(0, Math.floor(timestamp / 3_600_000)));
    const durationMs = team.lapDurationsMs[index];
    if (durationMs > 0) durationsByHour[raceHour].push(durationMs / 1_000);
  });
  return durationsByHour.map((durations) => median(durations));
}

export function buildTargetPaces(targetLaps: number, referenceTeam: HistoricalTeam | null): number[] {
  const safeTargetLaps = Math.max(1, targetLaps);
  const constantPace = (RACE_DURATION_HOURS * 3_600) / safeTargetLaps;
  const referencePaces = fillMissingPaces(buildHourlyHistoricalPaces(referenceTeam), constantPace);
  if (!referenceTeam) return referencePaces;

  const referenceCapacity = referencePaces.reduce((laps, paceSeconds) => laps + 3_600 / paceSeconds, 0);
  const paceScale = referenceCapacity / safeTargetLaps;
  // Keep full precision: rounding each hour to 0.1 s shifted a 1095-lap target to 1094.4 laps.
  return referencePaces.map((paceSeconds) => paceSeconds * paceScale);
}

export function targetLapCountAt(hourlyPacesSeconds: number[], elapsedHours: number): number {
  const boundedElapsedHours = Math.max(0, Math.min(RACE_DURATION_HOURS, elapsedHours));
  let expectedLaps = 0;
  for (let raceHour = 0; raceHour < Math.ceil(boundedElapsedHours); raceHour += 1) {
    const coveredHourFraction = Math.min(1, boundedElapsedHours - raceHour);
    const paceSeconds = validPace(hourlyPacesSeconds[raceHour]);
    expectedLaps += (coveredHourFraction * 3_600) / paceSeconds;
  }
  return expectedLaps;
}

export function projectedLapCount(completedLaps: number, elapsedHours: number, hourlyPacesSeconds: number[]): number {
  const boundedElapsedHours = Math.max(0, Math.min(RACE_DURATION_HOURS, elapsedHours));
  let projectedLaps = completedLaps;
  for (let raceHour = Math.floor(boundedElapsedHours); raceHour < RACE_DURATION_HOURS; raceHour += 1) {
    const remainingHourFraction =
      raceHour === Math.floor(boundedElapsedHours) ? 1 - (boundedElapsedHours - raceHour) : 1;
    if (remainingHourFraction <= 0) continue;
    projectedLaps += (remainingHourFraction * 3_600) / validPace(hourlyPacesSeconds[raceHour]);
  }
  return projectedLaps;
}

function buildLiveHourlyPaces(laps: LapRecord[], raceStartedAt: number): Array<number | null> {
  const durationsByHour = Array.from({ length: RACE_DURATION_HOURS }, () => [] as number[]);
  for (const lap of laps) {
    const raceHour = Math.floor((lap.finishedAt - raceStartedAt) / 3_600_000);
    if (raceHour >= 0 && raceHour < RACE_DURATION_HOURS) {
      durationsByHour[raceHour].push(lap.durationMs / 1_000);
    }
  }
  return durationsByHour.map((durations) => median(durations));
}

export function buildRaceProgress(input: {
  liveLaps: LapRecord[];
  raceStartedAt: number;
  elapsedHours: number;
  targetPacesSeconds: number[];
  ownHistoricalTeam: HistoricalTeam | null;
  rivalHistoricalTeam: HistoricalTeam | null;
  intervalMinutes?: number;
}): RaceProgressPoint[] {
  const intervalHours = Math.max(5, input.intervalMinutes ?? 15) / 60;
  const points: RaceProgressPoint[] = [];
  const liveFinishTimes = input.liveLaps.map((lap) => lap.finishedAt);
  const maximumHour = Math.max(RACE_DURATION_HOURS, input.elapsedHours);

  for (let raceHour = 0; raceHour <= maximumHour + 0.0001; raceHour += intervalHours) {
    const pointHour = Math.min(maximumHour, Math.round(raceHour * 100) / 100);
    const timestamp = input.raceStartedAt + pointHour * 3_600_000;
    points.push({
      raceHour: pointHour,
      liveLaps: pointHour <= input.elapsedHours ? upperBound(liveFinishTimes, timestamp) : null,
      targetLaps: pointHour <= RACE_DURATION_HOURS ? targetLapCountAt(input.targetPacesSeconds, pointHour) : null,
      ownHistoricalLaps: historicalLapCountAt(input.ownHistoricalTeam, pointHour),
      rivalHistoricalLaps: historicalLapCountAt(input.rivalHistoricalTeam, pointHour),
    });
  }
  return points;
}

export function buildHourlyPaceComparison(input: {
  targetPacesSeconds: number[];
  liveLaps: LapRecord[];
  raceStartedAt: number;
  ownHistoricalTeam: HistoricalTeam | null;
  rivalHistoricalTeam: HistoricalTeam | null;
}): HourlyPacePoint[] {
  const actualPaces = buildLiveHourlyPaces(input.liveLaps, input.raceStartedAt);
  const ownHistoricalPaces = buildHourlyHistoricalPaces(input.ownHistoricalTeam);
  const rivalHistoricalPaces = buildHourlyHistoricalPaces(input.rivalHistoricalTeam);
  return Array.from({ length: RACE_DURATION_HOURS }, (_, raceHour) => ({
    raceHour,
    plannedSeconds: input.targetPacesSeconds[raceHour] ?? null,
    actualSeconds: actualPaces[raceHour],
    ownHistoricalSeconds: ownHistoricalPaces[raceHour],
    rivalHistoricalSeconds: rivalHistoricalPaces[raceHour],
  }));
}

export function recentMedianPaceSeconds(laps: LapRecord[], recentLapCount: number): number | null {
  const recentDurations = laps.slice(-Math.max(1, recentLapCount)).map((lap) => lap.durationMs / 1_000);
  return median(recentDurations);
}

/**
 * Uncertainty of the average pace from recent laps: the standard error
 * (sample standard deviation / sqrt(n)). A single lap's spread would be far too
 * wide as a sustained offset for the rest of the race.
 */
export function paceUncertaintySeconds(durationsSeconds: number[]): number {
  const count = durationsSeconds.length;
  if (count < 2) return 0;
  const average = durationsSeconds.reduce((sum, value) => sum + value, 0) / count;
  const variance = durationsSeconds.reduce((sum, value) => sum + (value - average) ** 2, 0) / (count - 1);
  return Math.sqrt(variance / count);
}

export function teamById(race: HistoricalRace | null, teamId: number): HistoricalTeam | null {
  return race?.teams.find((team) => team.teamId === teamId) ?? null;
}

export function formatSignedLapDifference(difference: number | null): string {
  if (difference == null || !Number.isFinite(difference)) return 'Geen referentie';
  const roundedDifference = Math.round(difference * 10) / 10;
  return `${roundedDifference > 0 ? '+' : ''}${roundedDifference.toLocaleString('nl-BE', {
    maximumFractionDigits: 1,
  })}`;
}

function historicalEntries(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (isRecord(parsed) && Array.isArray(parsed.teams)) return parsed.teams;
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function fillMissingPaces(paces: Array<number | null>, fallbackPace: number): number[] {
  const validPaces = paces.filter((pace): pace is number => pace != null && pace > 0);
  const centralPace = median(validPaces) ?? fallbackPace;
  return paces.map((pace) => pace ?? centralPace);
}

function upperBound(sortedValues: number[], maximumValue: number): number {
  let lowerIndex = 0;
  let upperIndex = sortedValues.length;
  while (lowerIndex < upperIndex) {
    const middleIndex = Math.floor((lowerIndex + upperIndex) / 2);
    if (sortedValues[middleIndex] <= maximumValue) lowerIndex = middleIndex + 1;
    else upperIndex = middleIndex;
  }
  return lowerIndex;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sortedValues = [...values].sort((firstValue, secondValue) => firstValue - secondValue);
  const middleIndex = Math.floor(sortedValues.length / 2);
  if (sortedValues.length % 2 === 1) return sortedValues[middleIndex];
  return (sortedValues[middleIndex - 1] + sortedValues[middleIndex]) / 2;
}

function validPace(paceSeconds: number | undefined): number {
  return Number.isFinite(paceSeconds) && Number(paceSeconds) > 0 ? Number(paceSeconds) : 1;
}
