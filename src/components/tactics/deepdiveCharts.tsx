import { chartTooltipColors, useChartTheme, workspaceChartPalette } from '../../lib/chartPalette';
import React from 'react';
import {
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  ScatterController,
  Tooltip,
  type ChartConfiguration,
} from 'chart.js';
import type { HistoricalRace, HistoricalTeam } from '../../lib/tactics';
import {
  analyzeDrafting,
  buildBreakEvenSensitivity,
  buildHalfHourPaceDifferences,
  buildHourlyConsistency,
  buildHourlyLapGains,
  buildQuarterHourPaces,
  buildRaceLeadCurve,
  buildSameLapIndexGap,
  buildTimeGapCurve,
  calculateBreakEven,
  calculateNightPenalty,
  defaultSlowLapThreshold,
  findPaceChanges,
  findSlowLaps,
  smoothPacePoints,
  summarizeHistoricalTeams,
  summarizeHistoricalWindow,
  type DraftingTeamAnalysis,
  type PacePoint,
} from '../../lib/tacticsDeepDive';
import { formatDurationMs } from '../../lib/time';

Chart.register(
  BarController,
  BarElement,
  CategoryScale,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  ScatterController,
  Tooltip
);
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
    <ChartPanel configuration={{
      type: 'scatter',
      data: {
        datasets: [
          {
            label: `Rondes team ${team.teamId}`,
            data: rawPoints,
            backgroundColor: withOpacity(teamColor(team.teamId), 0.35),
            borderColor: 'transparent',
            pointRadius: 2,
          },
          xySeries('Lopende mediaan (20)', rollingMedianPoints, workspaceChartPalette.strong, 2),
        ],
      },
      options: xyChartOptions('Rondetijd', formatSeconds),
    }} />
  );
}

export function DurationDistributionChart({ firstTeam, secondTeam }: { firstTeam: HistoricalTeam; secondTeam: HistoricalTeam }) {
  const firstSeconds = firstTeam.lapDurationsMs.map((durationMs) => durationMs / 1_000);
  const secondSeconds = secondTeam.lapDurationsMs.map((durationMs) => durationMs / 1_000);
  const minimum = Math.floor(Math.min(...firstSeconds, ...secondSeconds) / 2) * 2;
  const maximum = Math.ceil(Math.min(180, Math.max(...firstSeconds, ...secondSeconds)) / 2) * 2;
  const labels = Array.from({ length: Math.max(1, (maximum - minimum) / 2 + 1) }, (_, index) => minimum + index * 2);
  const frequency = (durations: number[]) => labels.map((lowerBound) =>
    durations.filter((duration) => duration >= lowerBound && duration < lowerBound + 2).length
  );
  return (
    <ChartPanel configuration={{
      type: 'line',
      data: {
        labels,
        datasets: [
          lineSeries(`Team ${firstTeam.teamId}`, frequency(firstSeconds), teamColor(firstTeam.teamId)),
          lineSeries(`Team ${secondTeam.teamId}`, frequency(secondSeconds), teamColor(secondTeam.teamId)),
        ],
      },
      options: categoryChartOptions('Rondetijd (s)', 'Aantal rondes'),
    }} />
  );
}

export function DistributionRow({
  team,
  summary,
}: {
  team: HistoricalTeam;
  summary: ReturnType<typeof summarizeHistoricalWindow>;
}) {
  return (
    <tr>
      <td><span className="tactics-team-key"><i style={{ background: teamColor(team.teamId) }} />Team {team.teamId}</span></td>
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
  const durations = (team: HistoricalTeam) => team.lapDurationsMs
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
  const frequency = (lapDurations: number[]) => labels.map((lowerBound) =>
    lapDurations.filter((duration) => duration >= lowerBound && duration < lowerBound + 2).length
  );
  return (
    <ChartPanel configuration={{
      type: 'line',
      data: {
        labels,
        datasets: [
          lineSeries(`Team ${firstTeam.teamId}`, frequency(firstDurations), teamColor(firstTeam.teamId)),
          lineSeries(`Team ${secondTeam.teamId}`, frequency(secondDurations), teamColor(secondTeam.teamId)),
        ],
      },
      options: categoryChartOptions('Rondetijd (s)', 'Aantal rondes'),
    }} />
  );
}

export function PaceComparisonChart({ points, firstTeam, secondTeam }: { points: PacePoint[]; firstTeam: HistoricalTeam; secondTeam: HistoricalTeam }) {
  return <ChartPanel configuration={xyLineConfiguration(points, firstTeam, secondTeam, 'Mediaan rondetijd', formatSeconds)} />;
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
    <ChartPanel configuration={{
      type: 'bar',
      data: {
        labels: points.map((point) => `${point.raceHour.toFixed(2)}u`),
        datasets: [{
          label: `Team ${firstTeam.teamId} min team ${secondTeam.teamId}`,
          data: points.map((point) => point.differenceSeconds),
          backgroundColor: points.map((point) => point.differenceSeconds == null
            ? workspaceChartPalette.neutral
            : point.differenceSeconds > 0 ? teamColor(secondTeam.teamId) : teamColor(firstTeam.teamId)),
          borderRadius: 3,
        }],
      },
      options: categoryChartOptions('Halve race-uren', 'Verschil rondetijd', (value) => `${signedNumber(value, 0)}s`),
    }} />
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
    <ChartPanel configuration={{
      type: 'line',
      data: {
        datasets: [
          xySeries(`Mediaan team ${firstTeam.teamId}`, points.map((point) => ({ x: point.raceHour, y: point.firstSeconds })), teamColor(firstTeam.teamId), 3),
          xySeries(`P10 team ${firstTeam.teamId}`, points.map((point) => ({ x: point.raceHour, y: point.firstP10Seconds })), teamColor(firstTeam.teamId), 1, [6, 5]),
          xySeries(`P90 team ${firstTeam.teamId}`, points.map((point) => ({ x: point.raceHour, y: point.firstP90Seconds })), teamColor(firstTeam.teamId), 1, [6, 5]),
          xySeries(`Mediaan team ${secondTeam.teamId}`, points.map((point) => ({ x: point.raceHour, y: point.secondSeconds })), teamColor(secondTeam.teamId), 3),
          xySeries(`P10 team ${secondTeam.teamId}`, points.map((point) => ({ x: point.raceHour, y: point.secondP10Seconds })), teamColor(secondTeam.teamId), 1, [6, 5]),
          xySeries(`P90 team ${secondTeam.teamId}`, points.map((point) => ({ x: point.raceHour, y: point.secondP90Seconds })), teamColor(secondTeam.teamId), 1, [6, 5]),
        ],
      },
      options: xyChartOptions('Seconden', formatSeconds),
    }} />
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
    <ChartPanel configuration={{
      type: 'line',
      data: {
        datasets: [
          xySeries(`Spreiding team ${firstTeam.teamId}`, points.map((point) => ({ x: point.raceHour, y: point.firstStandardDeviationSeconds })), teamColor(firstTeam.teamId), 2),
          xySeries(`Spreiding team ${secondTeam.teamId}`, points.map((point) => ({ x: point.raceHour, y: point.secondStandardDeviationSeconds })), teamColor(secondTeam.teamId), 2),
        ],
      },
      options: xyChartOptions('Standaardafwijking (s)', (value) => `${Number(value).toFixed(1)}s`),
    }} />
  );
}

export function TimeGapChart({ points, firstTeam, secondTeam }: { points: ReturnType<typeof buildTimeGapCurve>; firstTeam: HistoricalTeam; secondTeam: HistoricalTeam }) {
  return (
    <ChartPanel configuration={{
      type: 'line',
      data: {
        datasets: [
          xySeries(`Tijdskloof team ${firstTeam.teamId} op team ${secondTeam.teamId}`, points.map((point) => ({ x: point.raceHour, y: point.gapSeconds })), workspaceChartPalette.accent, 3),
          xySeries('Gelijke stand', [{ x: 0, y: 0 }, { x: 24, y: 0 }], workspaceChartPalette.neutral, 1, [6, 5]),
        ],
      },
      options: xyChartOptions('Tijdsverschil', formatSignedSeconds),
    }} />
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
    <ChartPanel configuration={{
      type: 'line',
      data: {
        datasets: [
          xySeries(`Team ${firstTeam.teamId} tegenover team ${secondTeam.teamId}`, points.map((point) => ({ x: point.raceHour, y: point.gapSeconds })), workspaceChartPalette.accent, 3),
          xySeries('Gelijke ronde-index', [{ x: 0, y: 0 }, { x: 24, y: 0 }], workspaceChartPalette.neutral, 1, [6, 5]),
        ],
      },
      options: xyChartOptions('Tijdsverschil', formatSignedSeconds),
    }} />
  );
}

export function HourlyGainChart({ points, firstTeam, secondTeam }: { points: ReturnType<typeof buildHourlyLapGains>; firstTeam: HistoricalTeam; secondTeam: HistoricalTeam }) {
  return (
    <ChartPanel configuration={{
      type: 'bar',
      data: {
        labels: points.map((point) => `${point.raceHour}u`),
        datasets: [{
          label: `Team ${secondTeam.teamId} min team ${firstTeam.teamId}`,
          data: points.map((point) => point.lapDifference),
          backgroundColor: points.map((point) => point.lapDifference > 0
            ? teamColor(secondTeam.teamId)
            : point.lapDifference < 0 ? teamColor(firstTeam.teamId) : workspaceChartPalette.neutral),
          borderRadius: 4,
        }],
      },
      options: categoryChartOptions('Race-uur', 'Verschil in rondes'),
    }} />
  );
}

export function CumulativeRaceChart({ firstTeam, secondTeam }: { firstTeam: HistoricalTeam; secondTeam: HistoricalTeam }) {
  const teamPoints = (team: HistoricalTeam) => [
    { x: 0, y: 0 },
    ...team.cumulativeLapTimesMs.map((timestampMs, lapIndex) => ({ x: timestampMs / 3_600_000, y: lapIndex + 1 })),
  ];
  return (
    <ChartPanel configuration={{
      type: 'line',
      data: {
        datasets: [
          xySeries(`Team ${firstTeam.teamId}`, teamPoints(firstTeam), teamColor(firstTeam.teamId), 3),
          xySeries(`Team ${secondTeam.teamId}`, teamPoints(secondTeam), teamColor(secondTeam.teamId), 3),
        ],
      },
      options: xyChartOptions('Cumulatieve rondes', (value) => String(Math.round(Number(value))), true),
    }} />
  );
}

export function RaceLeadChart({
  points,
  firstTeam,
  secondTeam,
  lapLengthMeters,
}: {
  points: ReturnType<typeof buildRaceLeadCurve>;
  firstTeam: HistoricalTeam;
  secondTeam: HistoricalTeam;
  lapLengthMeters: number;
}) {
  return (
    <ChartPanel configuration={{
      type: 'line',
      data: {
        datasets: [
          xySeries(
            `Voorsprong team ${firstTeam.teamId} in rondes`,
            points.map((point) => ({ x: point.raceHour, y: point.lapDifference })),
            workspaceChartPalette.accent,
            3
          ),
          xySeries('Gelijke stand', [{ x: 0, y: 0 }, { x: 24, y: 0 }], workspaceChartPalette.neutral, 1, [6, 5]),
        ],
      },
      options: xyChartOptions(
        `Rondeverschil · ${lapLengthMeters} m per ronde`,
        (value) => `${signedNumber(Number(value), 0)} (${signedNumber(Number(value) * lapLengthMeters, 0)} m)`
      ),
    }} />
  );
}

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
    <ChartPanel configuration={{
      type: 'scatter',
      data: {
        datasets: [
          diagnosticSeries(`Trage rondes team ${firstTeam.teamId}`, firstSlowLaps, teamColor(firstTeam.teamId), 'circle'),
          diagnosticSeries(`Temposprongen team ${firstTeam.teamId}`, firstChanges, teamColor(firstTeam.teamId), 'triangle'),
          diagnosticSeries(`Trage rondes team ${secondTeam.teamId}`, secondSlowLaps, teamColor(secondTeam.teamId), 'circle'),
          diagnosticSeries(`Temposprongen team ${secondTeam.teamId}`, secondChanges, teamColor(secondTeam.teamId), 'triangle'),
        ],
      },
      options: xyChartOptions('Rondetijd', formatSeconds),
    }} />
  );
}

export function BreakEvenChart({ points, targetLaps, teamId }: { points: ReturnType<typeof buildBreakEvenSensitivity>; targetLaps: number; teamId: number }) {
  return (
    <ChartPanel configuration={{
      type: 'line',
      data: {
        datasets: [
          xySeries(`Projectie team ${teamId}`, points.map((point) => ({ x: point.improvementSeconds, y: point.projectedLaps })), teamColor(teamId), 3),
          xySeries('Te kloppen resultaat', [{ x: 0, y: targetLaps }, { x: points[points.length - 1]?.improvementSeconds ?? 15, y: targetLaps }], workspaceChartPalette.target, 2, [6, 5]),
        ],
      },
      options: xyChartOptions('Totaal rondes', (value) => String(Math.round(Number(value))), false, 'Verbetering per ronde (s)'),
    }} />
  );
}

export function DraftingProximityChart({ firstAnalysis, secondAnalysis }: { firstAnalysis: DraftingTeamAnalysis; secondAnalysis: DraftingTeamAnalysis }) {
  return (
    <ChartPanel configuration={{
      type: 'line',
      data: {
        labels: firstAnalysis.proximityBins.map((bin) => bin.label),
        datasets: [
          lineSeries(`Team ${firstAnalysis.teamId}`, firstAnalysis.proximityBins.map((bin) => bin.medianSeconds), teamColor(firstAnalysis.teamId)),
          lineSeries(`Team ${secondAnalysis.teamId}`, secondAnalysis.proximityBins.map((bin) => bin.medianSeconds), teamColor(secondAnalysis.teamId)),
        ],
      },
      options: categoryChartOptions('Afstand tot dichtstbijzijnde passage', 'Mediaan rondetijd', formatSeconds),
    }} />
  );
}

export function DraftingScatterChart({ firstAnalysis, secondAnalysis }: { firstAnalysis: DraftingTeamAnalysis; secondAnalysis: DraftingTeamAnalysis }) {
  const scatterSeries = (analysis: DraftingTeamAnalysis) => ({
    label: `Team ${analysis.teamId}`,
    data: analysis.signedGapSeconds.map((signedGap, lapIndex) => ({ x: signedGap, y: analysis.lapDurationsSeconds[lapIndex] })),
    borderColor: teamColor(analysis.teamId),
    backgroundColor: `${teamColor(analysis.teamId)}55`,
    pointRadius: 2,
    pointHoverRadius: 5,
  });
  const trendSeries = (analysis: DraftingTeamAnalysis) => {
    const visiblePoints = analysis.signedGapSeconds
      .map((signedGap, lapIndex) => ({ x: signedGap, y: analysis.lapDurationsSeconds[lapIndex] }))
      .filter((point) => Number.isFinite(point.x) && Math.abs(point.x) <= 35);
    return xySeries(
      `Trend team ${analysis.teamId}`,
      linearTrend(visiblePoints, -35, 35),
      teamColor(analysis.teamId),
      3
    );
  };
  return (
    <ChartPanel configuration={{
      type: 'scatter',
      data: {
        datasets: [
          scatterSeries(firstAnalysis),
          scatterSeries(secondAnalysis),
          trendSeries(firstAnalysis),
          trendSeries(secondAnalysis),
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        parsing: false,
        interaction: { mode: 'nearest', intersect: false },
        plugins: chartPlugins(formatSeconds),
        scales: {
          x: { type: 'linear', min: -35, max: 35, title: axisTitle('Positie: voor (-) of achter (+), seconden'), ticks: { color: workspaceChartPalette.muted }, grid: { color: workspaceChartPalette.grid } },
          y: { title: axisTitle('Rondetijd'), ticks: { color: workspaceChartPalette.muted, callback: (value) => formatSeconds(Number(value)) }, grid: { color: workspaceChartPalette.grid } },
        },
      },
    }} />
  );
}

export function DraftingResultsTable({ analyses }: { analyses: DraftingTeamAnalysis[] }) {
  return (
    <div className="table-wrap">
      <table className="analysis-table">
        <thead>
          <tr><th>Team</th><th>Vergelijking</th><th>n eerste</th><th>Mediaan eerste</th><th>n tweede</th><th>Mediaan tweede</th><th>Effect</th><th>p</th><th>Sign.</th></tr>
        </thead>
        <tbody>
          {analyses.flatMap((analysis) => analysis.comparisons.map((comparison) => (
            <tr key={`${analysis.teamId}-${comparison.label}`}>
              <td><strong>Team {analysis.teamId}</strong></td>
              <td>{comparison.label}</td>
              <td>{comparison.firstCount}</td>
              <td>{formatNullableSeconds(comparison.firstMedianSeconds)}</td>
              <td>{comparison.secondCount}</td>
              <td>{formatNullableSeconds(comparison.secondMedianSeconds)}</td>
              <td>{comparison.effectSeconds == null ? 'Geen data' : `${signedNumber(comparison.effectSeconds, 2)}s`}</td>
              <td>{comparison.pValue == null ? 'Geen data' : comparison.pValue.toFixed(4)}</td>
              <td><span className={`tactics-significance ${comparison.pValue != null && comparison.pValue < 0.05 ? 'is-significant' : ''}`}>{significanceLabel(comparison.pValue)}</span></td>
            </tr>
          )))}
        </tbody>
      </table>
    </div>
  );
}

export function DiagnosticTable({ title, laps }: { title: string; laps: ReturnType<typeof findSlowLaps> }) {
  return (
    <div>
      <h3>{title}</h3>
      <div className="table-wrap">
        <table className="analysis-table">
          <thead><tr><th>Ronde</th><th>Race-uur</th><th>Tijd</th></tr></thead>
          <tbody>{laps.map((lap) => <tr key={lap.lapNumber}><td>{lap.lapNumber}</td><td>{lap.raceHour.toFixed(2)}u</td><td>{formatSeconds(lap.durationSeconds)}</td></tr>)}</tbody>
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
          <thead><tr><th>Ronde</th><th>Race-uur</th><th>Verschil</th></tr></thead>
          <tbody>{changes.map((change) => <tr key={change.lapNumber}><td>{change.lapNumber}</td><td>{change.raceHour.toFixed(2)}u</td><td>{signedNumber(change.differenceSeconds, 1)}s</td></tr>)}</tbody>
        </table>
      </div>
    </div>
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
      label={`Nachtpenalty team ${team.teamId}`}
      value={penalty.penaltySeconds == null ? 'Geen data' : `${signedNumber(penalty.penaltySeconds, 1)}s`}
      detail={`Dag ${formatNullableSeconds(penalty.dayMedianSeconds)}, nacht ${formatNullableSeconds(penalty.nightMedianSeconds)}`}
    />
  );
}

export function NumberControl({
  label,
  value,
  min,
  max,
  step = 1,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <div className="tactics-number-control">
        <input className="input" type="number" value={value} min={min} max={max} step={step} onChange={(event) => onChange(clamp(Number(event.target.value) || min, min, max))} />
        {suffix && <em>{suffix}</em>}
      </div>
    </label>
  );
}

export function DeepStat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="stat-panel tactics-stat"><span className="muted-label">{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

export function SectionHeader({ kicker, title, text }: { kicker: string; title: string; text: string }) {
  return <div className="analysis-section-header"><span className="page-kicker">{kicker}</span><h2>{title}</h2><p>{text}</p></div>;
}

export function ChartPanel({ configuration }: { configuration: ChartConfiguration }) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const chartTheme = useChartTheme();
  React.useEffect(() => {
    if (!canvasRef.current) return undefined;
    const chart = new Chart(canvasRef.current, configuration);
    return () => chart.destroy();
  }, [chartTheme, configuration]);
  return <div className="analysis-chart-card tactics-chart-card"><canvas ref={canvasRef} /></div>;
}

export function xyLineConfiguration(
  points: PacePoint[],
  firstTeam: HistoricalTeam,
  secondTeam: HistoricalTeam,
  yAxisTitle: string,
  formatter: (value: number) => string
): ChartConfiguration<'line'> {
  return {
    type: 'line',
    data: {
      datasets: [
        xySeries(`Team ${firstTeam.teamId}`, points.map((point) => ({ x: point.raceHour, y: point.firstSeconds })), teamColor(firstTeam.teamId), 3),
        xySeries(`Team ${secondTeam.teamId}`, points.map((point) => ({ x: point.raceHour, y: point.secondSeconds })), teamColor(secondTeam.teamId), 3),
      ],
    },
    options: xyChartOptions(yAxisTitle, formatter),
  };
}

export function xySeries(label: string, data: Array<{ x: number; y: number | null }>, color: string, borderWidth = 2, borderDash?: number[]) {
  return { label, data, borderColor: color, backgroundColor: color, borderWidth, borderDash, pointRadius: 0, pointHoverRadius: 5, tension: 0.2, spanGaps: false };
}

export function lineSeries(label: string, data: Array<number | null>, color: string) {
  return { label, data, borderColor: color, backgroundColor: color, borderWidth: 3, pointRadius: 2, pointHoverRadius: 5, tension: 0.25, spanGaps: false };
}

export function xyChartOptions(
  yAxisTitle: string,
  formatter: (value: number) => string,
  beginAtZero = false,
  xAxisTitle = 'Uren sinds de start'
): ChartConfiguration<'line'>['options'] {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    parsing: false,
    interaction: { mode: 'nearest', intersect: false },
    plugins: chartPlugins(formatter),
    scales: {
      x: { type: 'linear', min: 0, title: axisTitle(xAxisTitle), ticks: { color: workspaceChartPalette.muted }, grid: { color: workspaceChartPalette.grid } },
      y: { beginAtZero, title: axisTitle(yAxisTitle), ticks: { color: workspaceChartPalette.muted, callback: (value) => formatter(Number(value)) }, grid: { color: workspaceChartPalette.grid } },
    },
  };
}

export function categoryChartOptions(
  xAxisTitle: string,
  yAxisTitle: string,
  formatter: (value: number) => string = (value) => String(value)
): ChartConfiguration['options'] {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'nearest', intersect: false },
    plugins: chartPlugins(formatter),
    scales: {
      x: { title: axisTitle(xAxisTitle), ticks: { color: workspaceChartPalette.muted, maxTicksLimit: 18 }, grid: { color: workspaceChartPalette.grid } },
      y: { beginAtZero: true, title: axisTitle(yAxisTitle), ticks: { color: workspaceChartPalette.muted, callback: (value) => formatter(Number(value)) }, grid: { color: workspaceChartPalette.grid } },
    },
  };
}

export function chartPlugins(formatter: (value: number) => string) {
  return {
    legend: { position: 'top' as const, labels: { boxWidth: 14, color: workspaceChartPalette.text, font: { weight: 500 as const } } },
    tooltip: { ...chartTooltipColors(), callbacks: { label: (context: { dataset: { label?: string }; parsed: { y: number | null } }) => `${context.dataset.label}: ${context.parsed.y == null ? 'geen data' : formatter(context.parsed.y)}` } },
  };
}

export function axisTitle(text: string) {
  return { display: true, text, color: workspaceChartPalette.muted, font: { weight: 500 as const } };
}

export function teamColor(teamId: number, fallbackIndex = 0): string {
  if (teamId === 1) return workspaceChartPalette.live;
  if (teamId === 4) return workspaceChartPalette.rival;
  const alternatives = ['#009E73', '#D55E00', '#CC79A7', '#7F3FBF', '#8B4513', '#64748b'];
  return alternatives[fallbackIndex % alternatives.length];
}

export function formatSeconds(seconds: number): string {
  return formatDurationMs(seconds * 1_000);
}

export function formatNullableSeconds(seconds: number | null): string {
  return seconds == null ? 'Geen data' : formatSeconds(seconds);
}

export function formatSignedSeconds(seconds: number): string {
  return `${signedNumber(seconds, 0)}s`;
}

export function signedNumber(value: number, fractionDigits = 0): string {
  const roundedValue = Number(value.toFixed(fractionDigits));
  return `${roundedValue > 0 ? '+' : ''}${roundedValue.toLocaleString('nl-BE', { maximumFractionDigits: fractionDigits })}`;
}

export function significanceLabel(pValue: number | null): string {
  if (pValue == null) return 'n.v.t.';
  if (pValue < 0.001) return '***';
  if (pValue < 0.01) return '**';
  if (pValue < 0.05) return '*';
  return 'n.s.';
}

export function percentage(part: number, total: number): string {
  return total ? `${(part / total * 100).toFixed(1)}%` : '0%';
}

export function medianValue(values: number[]): number | null {
  if (!values.length) return null;
  const sortedValues = [...values].sort((firstValue, secondValue) => firstValue - secondValue);
  const middleIndex = Math.floor(sortedValues.length / 2);
  return sortedValues.length % 2
    ? sortedValues[middleIndex]
    : (sortedValues[middleIndex - 1] + sortedValues[middleIndex]) / 2;
}

export function percentileValue(values: number[], probability: number): number {
  if (!values.length) return 60;
  const sortedValues = [...values].sort((firstValue, secondValue) => firstValue - secondValue);
  const position = (sortedValues.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const fraction = position - lowerIndex;
  return sortedValues[lowerIndex] + (sortedValues[Math.min(lowerIndex + 1, sortedValues.length - 1)] - sortedValues[lowerIndex]) * fraction;
}

export function linearTrend(
  points: Array<{ x: number; y: number }>,
  minimumX: number,
  maximumX: number
): Array<{ x: number; y: number }> {
  if (points.length < 2) return [];
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const denominator = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
  const slope = denominator === 0
    ? 0
    : points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0) / denominator;
  const intercept = meanY - slope * meanX;
  return [
    { x: minimumX, y: intercept + slope * minimumX },
    { x: maximumX, y: intercept + slope * maximumX },
  ];
}

export function withOpacity(hexColor: string, opacity: number): string {
  const alpha = Math.round(clamp(opacity, 0, 1) * 255).toString(16).padStart(2, '0');
  return `${hexColor}${alpha}`;
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
