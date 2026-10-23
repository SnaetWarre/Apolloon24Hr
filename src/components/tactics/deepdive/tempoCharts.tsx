import type { ChartConfiguration } from 'chart.js';
import { workspaceChartPalette } from '../../../lib/chartPalette';
import type { HistoricalTeam } from '../../../lib/tactics';
import {
  buildHalfHourPaceDifferences,
  buildHourlyConsistency,
  calculateNightPenalty,
  summarizeHistoricalWindow,
  type PacePoint,
} from '../../../lib/tacticsDeepDive';
import { ChartPanel, categoryChartOptions, lineSeries, xyChartOptions, xySeries } from './deepdiveChart';
import { formatNullableSeconds, formatSeconds, signedNumber, teamColor } from './deepdiveFormat';
import { DeepStat } from './deepdiveWidgets';

export function DistributionRow({
  team,
  summary,
}: {
  team: HistoricalTeam;
  summary: ReturnType<typeof summarizeHistoricalWindow>;
}) {
  return (
    <tr>
      <td>
        <span className="tactics-team-key">
          <i style={{ background: teamColor(team.teamId) }} />
          {team.teamName}
        </span>
      </td>
      <td>{summary.laps}</td>
      <td>{formatNullableSeconds(summary.medianSeconds)}</td>
      <td>{summary.interquartileRangeSeconds == null ? '—' : `${summary.interquartileRangeSeconds.toFixed(1)}s`}</td>
      <td>{summary.outlierCount}</td>
    </tr>
  );
}

export function WindowFrequencyChart({
  firstTeam,
  secondTeam,
  startHour,
  endHour,
}: {
  firstTeam: HistoricalTeam;
  secondTeam: HistoricalTeam;
  startHour: number;
  endHour: number;
}) {
  const durations = (team: HistoricalTeam) =>
    team.lapDurationsMs
      .map((durationMs, lapIndex) => ({
        durationSeconds: durationMs / 1_000,
        raceHour: team.cumulativeLapTimesMs[lapIndex] / 3_600_000,
      }))
      .filter((lap) => lap.raceHour >= startHour && lap.raceHour < endHour)
      .map((lap) => lap.durationSeconds);
  const firstDurations = durations(firstTeam);
  const secondDurations = durations(secondTeam);
  const combinedDurations = [...firstDurations, ...secondDurations];
  const minimum = Math.floor(Math.max(0, percentileValue(combinedDurations, 0.02) - 4) / 2) * 2;
  const maximum = Math.ceil((percentileValue(combinedDurations, 0.98) + 4) / 2) * 2;
  const labels = Array.from({ length: Math.max(1, (maximum - minimum) / 2 + 1) }, (_, index) => minimum + index * 2);
  const frequency = (lapDurations: number[]) =>
    labels.map(
      (lowerBound) => lapDurations.filter((duration) => duration >= lowerBound && duration < lowerBound + 2).length
    );
  return (
    <ChartPanel
      configuration={{
        type: 'line',
        data: {
          labels,
          datasets: [
            lineSeries(firstTeam.teamName, frequency(firstDurations), teamColor(firstTeam.teamId)),
            lineSeries(secondTeam.teamName, frequency(secondDurations), teamColor(secondTeam.teamId)),
          ],
        },
        options: categoryChartOptions('Rondetijd (s)', 'Aantal rondes'),
      }}
    />
  );
}

export function PaceComparisonChart({
  points,
  firstTeam,
  secondTeam,
}: {
  points: PacePoint[];
  firstTeam: HistoricalTeam;
  secondTeam: HistoricalTeam;
}) {
  return (
    <ChartPanel
      configuration={xyLineConfiguration(points, firstTeam, secondTeam, 'Mediaan rondetijd', formatSeconds)}
    />
  );
}

export function HalfHourDifferenceChart({
  points,
  firstTeam,
  secondTeam,
}: {
  points: ReturnType<typeof buildHalfHourPaceDifferences>;
  firstTeam: HistoricalTeam;
  secondTeam: HistoricalTeam;
}) {
  return (
    <ChartPanel
      configuration={{
        type: 'bar',
        data: {
          labels: points.map((point) => `${point.raceHour.toFixed(2)}u`),
          datasets: [
            {
              label: `${firstTeam.teamName} min ${secondTeam.teamName}`,
              data: points.map((point) => point.differenceSeconds),
              backgroundColor: points.map((point) =>
                point.differenceSeconds == null
                  ? workspaceChartPalette.neutral
                  : point.differenceSeconds > 0
                    ? teamColor(secondTeam.teamId)
                    : teamColor(firstTeam.teamId)
              ),
              borderRadius: 3,
            },
          ],
        },
        options: categoryChartOptions('Halve race-uren', 'Verschil rondetijd', (value) => `${signedNumber(value, 0)}s`),
      }}
    />
  );
}

export function ConsistencyChart({
  points,
  firstTeam,
  secondTeam,
}: {
  points: ReturnType<typeof buildHourlyConsistency>;
  firstTeam: HistoricalTeam;
  secondTeam: HistoricalTeam;
}) {
  return (
    <ChartPanel
      configuration={{
        type: 'line',
        data: {
          datasets: [
            xySeries(
              `Mediaan ${firstTeam.teamName}`,
              points.map((point) => ({ x: point.raceHour, y: point.firstSeconds })),
              teamColor(firstTeam.teamId),
              3
            ),
            xySeries(
              `P10 ${firstTeam.teamName}`,
              points.map((point) => ({ x: point.raceHour, y: point.firstP10Seconds })),
              teamColor(firstTeam.teamId),
              1,
              [6, 5]
            ),
            xySeries(
              `P90 ${firstTeam.teamName}`,
              points.map((point) => ({ x: point.raceHour, y: point.firstP90Seconds })),
              teamColor(firstTeam.teamId),
              1,
              [6, 5]
            ),
            xySeries(
              `Mediaan ${secondTeam.teamName}`,
              points.map((point) => ({ x: point.raceHour, y: point.secondSeconds })),
              teamColor(secondTeam.teamId),
              3
            ),
            xySeries(
              `P10 ${secondTeam.teamName}`,
              points.map((point) => ({ x: point.raceHour, y: point.secondP10Seconds })),
              teamColor(secondTeam.teamId),
              1,
              [6, 5]
            ),
            xySeries(
              `P90 ${secondTeam.teamName}`,
              points.map((point) => ({ x: point.raceHour, y: point.secondP90Seconds })),
              teamColor(secondTeam.teamId),
              1,
              [6, 5]
            ),
          ],
        },
        options: xyChartOptions('Seconden', formatSeconds),
      }}
    />
  );
}

export function StandardDeviationChart({
  points,
  firstTeam,
  secondTeam,
}: {
  points: ReturnType<typeof buildHourlyConsistency>;
  firstTeam: HistoricalTeam;
  secondTeam: HistoricalTeam;
}) {
  return (
    <ChartPanel
      configuration={{
        type: 'line',
        data: {
          datasets: [
            xySeries(
              `Spreiding ${firstTeam.teamName}`,
              points.map((point) => ({ x: point.raceHour, y: point.firstStandardDeviationSeconds })),
              teamColor(firstTeam.teamId),
              2
            ),
            xySeries(
              `Spreiding ${secondTeam.teamName}`,
              points.map((point) => ({ x: point.raceHour, y: point.secondStandardDeviationSeconds })),
              teamColor(secondTeam.teamId),
              2
            ),
          ],
        },
        options: xyChartOptions('Standaardafwijking (s)', (value) => `${Number(value).toFixed(1)}s`),
      }}
    />
  );
}

export function NightPenaltyStat({
  team,
  penalty,
}: {
  team: HistoricalTeam;
  penalty: ReturnType<typeof calculateNightPenalty>;
}) {
  return (
    <DeepStat
      label={`Nachtpenalty ${team.teamName}`}
      value={penalty.penaltySeconds == null ? 'Geen data' : `${signedNumber(penalty.penaltySeconds, 1)}s`}
      detail={`Dag ${formatNullableSeconds(penalty.dayMedianSeconds)}, nacht ${formatNullableSeconds(penalty.nightMedianSeconds)}`}
    />
  );
}

function xyLineConfiguration(
  points: PacePoint[],
  firstTeam: HistoricalTeam,
  secondTeam: HistoricalTeam,
  yAxisTitle: string,
  formatter: (value: number) => string
): ChartConfiguration {
  return {
    type: 'line',
    data: {
      datasets: [
        xySeries(
          firstTeam.teamName,
          points.map((point) => ({ x: point.raceHour, y: point.firstSeconds })),
          teamColor(firstTeam.teamId),
          3
        ),
        xySeries(
          secondTeam.teamName,
          points.map((point) => ({ x: point.raceHour, y: point.secondSeconds })),
          teamColor(secondTeam.teamId),
          3
        ),
      ],
    },
    options: xyChartOptions(yAxisTitle, formatter),
  };
}

function percentileValue(values: number[], probability: number): number {
  if (!values.length) return 60;
  const sortedValues = [...values].sort((firstValue, secondValue) => firstValue - secondValue);
  const position = (sortedValues.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const fraction = position - lowerIndex;
  return (
    sortedValues[lowerIndex] +
    (sortedValues[Math.min(lowerIndex + 1, sortedValues.length - 1)] - sortedValues[lowerIndex]) * fraction
  );
}
