import { workspaceChartPalette } from '../../../lib/chartPalette';
import type { HistoricalTeam } from '../../../lib/tactics';
import { ChartPanel, categoryChartOptions, lineSeries, xyChartOptions, xySeries } from './deepdiveChart';
import { formatSeconds, teamColor } from './deepdiveFormat';

export function TeamLapTimelineChart({ team }: { team: HistoricalTeam }) {
  const rawPoints = team.lapDurationsMs.map((durationMs, lapIndex) => ({
    x: team.cumulativeLapTimesMs[lapIndex] / 3_600_000,
    y: durationMs / 1_000,
  }));
  const rollingMedianPoints = rawPoints.map((point, pointIndex) => ({
    x: point.x,
    y: medianValue(rawPoints.slice(Math.max(0, pointIndex - 19), pointIndex + 1).map((candidate) => candidate.y)),
  }));
  return (
    <ChartPanel
      configuration={{
        type: 'scatter',
        data: {
          datasets: [
            {
              label: `Rondes ${team.teamName}`,
              data: rawPoints,
              backgroundColor: withOpacity(teamColor(team.teamId), 0.35),
              borderColor: 'transparent',
              pointRadius: 2,
            },
            xySeries('Lopende mediaan (20)', rollingMedianPoints, workspaceChartPalette.strong, 2),
          ],
        },
        options: xyChartOptions('Rondetijd', formatSeconds),
      }}
    />
  );
}

export function DurationDistributionChart({
  firstTeam,
  secondTeam,
}: {
  firstTeam: HistoricalTeam;
  secondTeam: HistoricalTeam;
}) {
  const firstSeconds = firstTeam.lapDurationsMs.map((durationMs) => durationMs / 1_000);
  const secondSeconds = secondTeam.lapDurationsMs.map((durationMs) => durationMs / 1_000);
  const minimum = Math.floor(Math.min(...firstSeconds, ...secondSeconds) / 2) * 2;
  const maximum = Math.ceil(Math.min(180, Math.max(...firstSeconds, ...secondSeconds)) / 2) * 2;
  const labels = Array.from({ length: Math.max(1, (maximum - minimum) / 2 + 1) }, (_, index) => minimum + index * 2);
  const frequency = (durations: number[]) =>
    labels.map(
      (lowerBound) => durations.filter((duration) => duration >= lowerBound && duration < lowerBound + 2).length
    );
  return (
    <ChartPanel
      configuration={{
        type: 'line',
        data: {
          labels,
          datasets: [
            lineSeries(firstTeam.teamName, frequency(firstSeconds), teamColor(firstTeam.teamId)),
            lineSeries(secondTeam.teamName, frequency(secondSeconds), teamColor(secondTeam.teamId)),
          ],
        },
        options: categoryChartOptions('Rondetijd (s)', 'Aantal rondes'),
      }}
    />
  );
}

function medianValue(values: number[]): number | null {
  if (!values.length) return null;
  const sortedValues = [...values].sort((firstValue, secondValue) => firstValue - secondValue);
  const middleIndex = Math.floor(sortedValues.length / 2);
  return sortedValues.length % 2
    ? sortedValues[middleIndex]
    : (sortedValues[middleIndex - 1] + sortedValues[middleIndex]) / 2;
}

function withOpacity(hexColor: string, opacity: number): string {
  const alpha = Math.round(clamp(opacity, 0, 1) * 255)
    .toString(16)
    .padStart(2, '0');
  return `${hexColor}${alpha}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
