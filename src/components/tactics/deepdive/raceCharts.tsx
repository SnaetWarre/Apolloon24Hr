import { workspaceChartPalette } from '../../../lib/chartPalette';
import type { HistoricalTeam } from '../../../lib/tactics';
import {
  buildHourlyLapGains,
  buildRaceLeadCurve,
  buildSameLapIndexGap,
  buildTimeGapCurve,
} from '../../../lib/tacticsDeepDive';
import { ChartPanel, categoryChartOptions, xyChartOptions, xySeries } from './deepdiveChart';
import { formatSignedSeconds, signedNumber, teamColor } from './deepdiveFormat';

export function TimeGapChart({
  points,
  firstTeam,
  secondTeam,
}: {
  points: ReturnType<typeof buildTimeGapCurve>;
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
              `Tijdskloof ${firstTeam.teamName} op ${secondTeam.teamName}`,
              points.map((point) => ({ x: point.raceHour, y: point.gapSeconds })),
              workspaceChartPalette.accent,
              3
            ),
            xySeries(
              'Gelijke stand',
              [
                { x: 0, y: 0 },
                { x: 24, y: 0 },
              ],
              workspaceChartPalette.neutral,
              1,
              [6, 5]
            ),
          ],
        },
        options: xyChartOptions('Tijdsverschil', formatSignedSeconds),
      }}
    />
  );
}

export function SameLapGapChart({
  points,
  firstTeam,
  secondTeam,
}: {
  points: ReturnType<typeof buildSameLapIndexGap>;
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
              `${firstTeam.teamName} tegenover ${secondTeam.teamName}`,
              points.map((point) => ({ x: point.raceHour, y: point.gapSeconds })),
              workspaceChartPalette.accent,
              3
            ),
            xySeries(
              'Gelijke ronde-index',
              [
                { x: 0, y: 0 },
                { x: 24, y: 0 },
              ],
              workspaceChartPalette.neutral,
              1,
              [6, 5]
            ),
          ],
        },
        options: xyChartOptions('Tijdsverschil', formatSignedSeconds),
      }}
    />
  );
}

export function HourlyGainChart({
  points,
  firstTeam,
  secondTeam,
}: {
  points: ReturnType<typeof buildHourlyLapGains>;
  firstTeam: HistoricalTeam;
  secondTeam: HistoricalTeam;
}) {
  return (
    <ChartPanel
      configuration={{
        type: 'bar',
        data: {
          labels: points.map((point) => `${point.raceHour}u`),
          datasets: [
            {
              label: `${secondTeam.teamName} min ${firstTeam.teamName}`,
              data: points.map((point) => point.lapDifference),
              backgroundColor: points.map((point) =>
                point.lapDifference > 0
                  ? teamColor(secondTeam.teamId)
                  : point.lapDifference < 0
                    ? teamColor(firstTeam.teamId)
                    : workspaceChartPalette.neutral
              ),
              borderRadius: 4,
            },
          ],
        },
        options: categoryChartOptions('Race-uur', 'Verschil in rondes'),
      }}
    />
  );
}

export function CumulativeRaceChart({
  firstTeam,
  secondTeam,
}: {
  firstTeam: HistoricalTeam;
  secondTeam: HistoricalTeam;
}) {
  const teamPoints = (team: HistoricalTeam) => [
    { x: 0, y: 0 },
    ...team.cumulativeLapTimesMs.map((timestampMs, lapIndex) => ({ x: timestampMs / 3_600_000, y: lapIndex + 1 })),
  ];
  return (
    <ChartPanel
      configuration={{
        type: 'line',
        data: {
          datasets: [
            xySeries(firstTeam.teamName, teamPoints(firstTeam), teamColor(firstTeam.teamId), 3),
            xySeries(secondTeam.teamName, teamPoints(secondTeam), teamColor(secondTeam.teamId), 3),
          ],
        },
        options: xyChartOptions('Cumulatieve rondes', (value) => String(Math.round(Number(value))), true),
      }}
    />
  );
}

export function RaceLeadChart({
  points,
  firstTeam,
  lapLengthMeters,
}: {
  points: ReturnType<typeof buildRaceLeadCurve>;
  firstTeam: HistoricalTeam;
  lapLengthMeters: number;
}) {
  return (
    <ChartPanel
      configuration={{
        type: 'line',
        data: {
          datasets: [
            xySeries(
              `Voorsprong ${firstTeam.teamName} in rondes`,
              points.map((point) => ({ x: point.raceHour, y: point.lapDifference })),
              workspaceChartPalette.accent,
              3
            ),
            xySeries(
              'Gelijke stand',
              [
                { x: 0, y: 0 },
                { x: 24, y: 0 },
              ],
              workspaceChartPalette.neutral,
              1,
              [6, 5]
            ),
          ],
        },
        options: xyChartOptions(
          `Rondeverschil · ${lapLengthMeters} m per ronde`,
          (value) => `${signedNumber(Number(value), 0)} (${signedNumber(Number(value) * lapLengthMeters, 0)} m)`
        ),
      }}
    />
  );
}
