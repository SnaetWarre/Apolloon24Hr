import { workspaceChartPalette } from '../../../lib/chartPalette';
import type { HistoricalTeam } from '../../../lib/tactics';
import { buildBreakEvenSensitivity, findPaceChanges, findSlowLaps } from '../../../lib/tacticsDeepDive';
import { ChartPanel, xyChartOptions, xySeries } from './deepdiveChart';
import { formatSeconds, signedNumber, teamColor } from './deepdiveFormat';

export function DiagnosticTimelineChart({
  firstTeam,
  secondTeam,
  firstSlowLaps,
  secondSlowLaps,
  firstChanges,
  secondChanges,
}: {
  firstTeam: HistoricalTeam;
  secondTeam: HistoricalTeam;
  firstSlowLaps: ReturnType<typeof findSlowLaps>;
  secondSlowLaps: ReturnType<typeof findSlowLaps>;
  firstChanges: ReturnType<typeof findPaceChanges>;
  secondChanges: ReturnType<typeof findPaceChanges>;
}) {
  const diagnosticSeries = (
    label: string,
    laps: Array<{ raceHour: number; durationSeconds: number }>,
    color: string,
    markerStyle: 'circle' | 'triangle'
  ) => ({
    label,
    data: laps.map((lap) => ({ x: lap.raceHour, y: lap.durationSeconds })),
    showLine: false,
    borderColor: color,
    backgroundColor: color,
    pointRadius: 5,
    pointStyle: markerStyle,
  });
  return (
    <ChartPanel
      configuration={{
        type: 'scatter',
        data: {
          datasets: [
            diagnosticSeries(
              `Trage rondes ${firstTeam.teamName}`,
              firstSlowLaps,
              teamColor(firstTeam.teamId),
              'circle'
            ),
            diagnosticSeries(
              `Temposprongen ${firstTeam.teamName}`,
              firstChanges,
              teamColor(firstTeam.teamId),
              'triangle'
            ),
            diagnosticSeries(
              `Trage rondes ${secondTeam.teamName}`,
              secondSlowLaps,
              teamColor(secondTeam.teamId),
              'circle'
            ),
            diagnosticSeries(
              `Temposprongen ${secondTeam.teamName}`,
              secondChanges,
              teamColor(secondTeam.teamId),
              'triangle'
            ),
          ],
        },
        options: xyChartOptions('Rondetijd', formatSeconds),
      }}
    />
  );
}

export function BreakEvenChart({
  points,
  targetLaps,
  team,
}: {
  points: ReturnType<typeof buildBreakEvenSensitivity>;
  targetLaps: number;
  team: HistoricalTeam;
}) {
  return (
    <ChartPanel
      configuration={{
        type: 'line',
        data: {
          datasets: [
            xySeries(
              `Projectie ${team.teamName}`,
              points.map((point) => ({ x: point.improvementSeconds, y: point.projectedLaps })),
              teamColor(team.teamId),
              3
            ),
            xySeries(
              'Te kloppen resultaat',
              [
                { x: 0, y: targetLaps },
                { x: points[points.length - 1]?.improvementSeconds ?? 15, y: targetLaps },
              ],
              workspaceChartPalette.target,
              2,
              [6, 5]
            ),
          ],
        },
        options: xyChartOptions(
          'Totaal rondes',
          (value) => String(Math.round(Number(value))),
          false,
          'Verbetering per ronde (s)'
        ),
      }}
    />
  );
}

export function DiagnosticTable({ title, laps }: { title: string; laps: ReturnType<typeof findSlowLaps> }) {
  return (
    <div>
      <h3>{title}</h3>
      <div className="table-wrap">
        <table className="analysis-table">
          <thead>
            <tr>
              <th>Ronde</th>
              <th>Race-uur</th>
              <th>Tijd</th>
            </tr>
          </thead>
          <tbody>
            {laps.map((lap) => (
              <tr key={lap.lapNumber}>
                <td>{lap.lapNumber}</td>
                <td>{lap.raceHour.toFixed(2)}u</td>
                <td>{formatSeconds(lap.durationSeconds)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function PaceChangeTable({ title, changes }: { title: string; changes: ReturnType<typeof findPaceChanges> }) {
  return (
    <div>
      <h3>{title}</h3>
      <div className="table-wrap">
        <table className="analysis-table">
          <thead>
            <tr>
              <th>Ronde</th>
              <th>Race-uur</th>
              <th>Verschil</th>
            </tr>
          </thead>
          <tbody>
            {changes.map((change) => (
              <tr key={change.lapNumber}>
                <td>{change.lapNumber}</td>
                <td>{change.raceHour.toFixed(2)}u</td>
                <td>{signedNumber(change.differenceSeconds, 1)}s</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
