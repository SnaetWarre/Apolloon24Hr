import { workspaceChartPalette } from '../../../lib/chartPalette';
import type { DraftingTeamAnalysis } from '../../../lib/tacticsDeepDive';
import { ChartPanel, axisTitle, categoryChartOptions, chartPlugins, lineSeries, xySeries } from './deepdiveChart';
import { formatNullableSeconds, formatSeconds, signedNumber, teamColor } from './deepdiveFormat';

export function DraftingProximityChart({
  firstAnalysis,
  secondAnalysis,
}: {
  firstAnalysis: DraftingTeamAnalysis;
  secondAnalysis: DraftingTeamAnalysis;
}) {
  return (
    <ChartPanel
      configuration={{
        type: 'line',
        data: {
          labels: firstAnalysis.proximityBins.map((bin) => bin.label),
          datasets: [
            lineSeries(
              firstAnalysis.teamName,
              firstAnalysis.proximityBins.map((bin) => bin.medianSeconds),
              teamColor(firstAnalysis.teamId)
            ),
            lineSeries(
              secondAnalysis.teamName,
              secondAnalysis.proximityBins.map((bin) => bin.medianSeconds),
              teamColor(secondAnalysis.teamId)
            ),
          ],
        },
        options: categoryChartOptions('Afstand tot dichtstbijzijnde passage', 'Mediaan rondetijd', formatSeconds),
      }}
    />
  );
}

export function DraftingScatterChart({
  firstAnalysis,
  secondAnalysis,
}: {
  firstAnalysis: DraftingTeamAnalysis;
  secondAnalysis: DraftingTeamAnalysis;
}) {
  const scatterSeries = (analysis: DraftingTeamAnalysis) => ({
    label: analysis.teamName,
    data: analysis.signedGapSeconds.map((signedGap, lapIndex) => ({
      x: signedGap,
      y: analysis.lapDurationsSeconds[lapIndex],
    })),
    borderColor: teamColor(analysis.teamId),
    backgroundColor: `${teamColor(analysis.teamId)}55`,
    pointRadius: 2,
    pointHoverRadius: 5,
  });
  const trendSeries = (analysis: DraftingTeamAnalysis) => {
    const visiblePoints = analysis.signedGapSeconds
      .map((signedGap, lapIndex) => ({ x: signedGap, y: analysis.lapDurationsSeconds[lapIndex] }))
      .filter((point) => Number.isFinite(point.x) && Math.abs(point.x) <= 35);
    return xySeries(`Trend ${analysis.teamName}`, linearTrend(visiblePoints, -35, 35), teamColor(analysis.teamId), 3);
  };
  return (
    <ChartPanel
      configuration={{
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
            x: {
              type: 'linear',
              min: -35,
              max: 35,
              title: axisTitle('Positie: voor (-) of achter (+), seconden'),
              ticks: { color: workspaceChartPalette.muted },
              grid: { color: workspaceChartPalette.grid },
            },
            y: {
              title: axisTitle('Rondetijd'),
              ticks: { color: workspaceChartPalette.muted, callback: (value) => formatSeconds(Number(value)) },
              grid: { color: workspaceChartPalette.grid },
            },
          },
        },
      }}
    />
  );
}

export function DraftingResultsTable({ analyses }: { analyses: DraftingTeamAnalysis[] }) {
  return (
    <div className="table-wrap">
      <table className="analysis-table">
        <thead>
          <tr>
            <th>Team</th>
            <th>Vergelijking</th>
            <th>n eerste</th>
            <th>Mediaan eerste</th>
            <th>n tweede</th>
            <th>Mediaan tweede</th>
            <th>Effect</th>
            <th>p</th>
            <th>Sign.</th>
          </tr>
        </thead>
        <tbody>
          {analyses.flatMap((analysis) =>
            analysis.comparisons.map((comparison) => (
              <tr key={`${analysis.teamId}-${comparison.label}`}>
                <td>
                  <strong>{analysis.teamName}</strong>
                </td>
                <td>{comparison.label}</td>
                <td>{comparison.firstCount}</td>
                <td>{formatNullableSeconds(comparison.firstMedianSeconds)}</td>
                <td>{comparison.secondCount}</td>
                <td>{formatNullableSeconds(comparison.secondMedianSeconds)}</td>
                <td>
                  {comparison.effectSeconds == null ? 'Geen data' : `${signedNumber(comparison.effectSeconds, 2)}s`}
                </td>
                <td>{comparison.pValue == null ? 'Geen data' : comparison.pValue.toFixed(4)}</td>
                <td>
                  <span
                    className={`tactics-significance ${comparison.pValue != null && comparison.pValue < 0.05 ? 'is-significant' : ''}`}
                  >
                    {significanceLabel(comparison.pValue)}
                  </span>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function significanceLabel(pValue: number | null): string {
  if (pValue == null) return 'n.v.t.';
  if (pValue < 0.001) return '***';
  if (pValue < 0.01) return '**';
  if (pValue < 0.05) return '*';
  return 'n.s.';
}

function linearTrend(
  points: Array<{ x: number; y: number }>,
  minimumX: number,
  maximumX: number
): Array<{ x: number; y: number }> {
  if (points.length < 2) return [];
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const denominator = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
  const slope =
    denominator === 0 ? 0 : points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0) / denominator;
  const intercept = meanY - slope * meanX;
  return [
    { x: minimumX, y: intercept + slope * minimumX },
    { x: maximumX, y: intercept + slope * maximumX },
  ];
}
