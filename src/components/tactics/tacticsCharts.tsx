import React from 'react';
import {
  CategoryScale,
  Chart,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
  type ChartConfiguration,
} from 'chart.js';
import { chartTooltipColors, useChartTheme, workspaceChartPalette } from '../../lib/chartPalette';
import { RACE_DURATION_HOURS, type HourlyPacePoint, type RaceProgressPoint } from '../../lib/tactics';
import type { LiveTrendPoint, TimeGapPoint } from '../../lib/tacticsDeepDive';
import { formatPaceSeconds, formatRaceHour, formatSignedGap } from './tacticsFormat';

Chart.register(
  CategoryScale,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip
);

const MAX_CHART_PIXEL_RATIO = 1.5;

export function TacticsStat({
  label,
  value,
  detail,
  tone,
  unit,
}: {
  label: string;
  value: string;
  detail: string;
  tone?: 'positive' | 'negative';
  unit?: string;
}) {
  return (
    <div className={`stat-panel tactics-stat${tone ? ` tactics-stat--${tone}` : ''}`}>
      <span className="muted-label">{label}</span>
      <strong>
        {value}
        {unit && <small className="tactics-stat-unit">{unit}</small>}
      </strong>
      <small>{detail}</small>
    </div>
  );
}

export function TacticsSectionHeader({ kicker, title, text }: { kicker: string; title: string; text: string }) {
  return (
    <div className="analysis-section-header">
      <span className="page-kicker">{kicker}</span>
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
}

export function RaceProgressChart({
  points,
  showLive = false,
  showTarget = false,
  ownLabel = 'Apolloon vorig jaar',
  rivalLabel = 'VTK vorig jaar',
}: {
  points: RaceProgressPoint[];
  showLive?: boolean;
  showTarget?: boolean;
  ownLabel?: string;
  rivalLabel?: string;
}) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const chartTheme = useChartTheme();

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !points.length) return undefined;
    const datasets: ChartConfiguration<'line'>['data']['datasets'] = [];
    if (showLive) datasets.push(lineDataset('Apolloon live', points, 'liveLaps', workspaceChartPalette.live, 4));
    if (showTarget) datasets.push(lineDataset('Doelverloop', points, 'targetLaps', workspaceChartPalette.target, 2, [8, 6]));
    datasets.push(lineDataset(ownLabel, points, 'ownHistoricalLaps', workspaceChartPalette.own, 2, [7, 5], true));
    datasets.push(lineDataset(rivalLabel, points, 'rivalHistoricalLaps', workspaceChartPalette.rival, 2, [7, 5], true));

    const chart = new Chart(canvas, {
      type: 'line',
      data: { datasets },
      options: sharedLineChartOptions('Cumulatieve rondes', (value) => `${Math.round(Number(value))}`),
    });
    return () => chart.destroy();
  }, [chartTheme, ownLabel, points, rivalLabel, showLive, showTarget]);

  return <ChartCanvas canvasRef={canvasRef} />;
}

export function HourlyPaceChart({
  points,
  showPlan = false,
  showActual = false,
  ownLabel = 'Apolloon vorig jaar',
  rivalLabel = 'VTK vorig jaar',
}: {
  points: HourlyPacePoint[];
  showPlan?: boolean;
  showActual?: boolean;
  ownLabel?: string;
  rivalLabel?: string;
}) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const chartTheme = useChartTheme();

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !points.length) return undefined;
    const datasets: ChartConfiguration<'line'>['data']['datasets'] = [];
    if (showActual) datasets.push(paceDataset('Werkelijk live', points, 'actualSeconds', workspaceChartPalette.live, 4));
    if (showPlan) datasets.push(paceDataset('Doeltempo', points, 'plannedSeconds', workspaceChartPalette.target, 2, [8, 6]));
    datasets.push(paceDataset(ownLabel, points, 'ownHistoricalSeconds', workspaceChartPalette.own, 2));
    datasets.push(paceDataset(rivalLabel, points, 'rivalHistoricalSeconds', workspaceChartPalette.rival, 2));

    const chart = new Chart(canvas, {
      type: 'line',
      data: { datasets },
      options: sharedLineChartOptions('Mediaan rondetijd', (value) => formatPaceSeconds(Number(value))),
    });
    return () => chart.destroy();
  }, [chartTheme, ownLabel, points, rivalLabel, showActual, showPlan]);

  return <ChartCanvas canvasRef={canvasRef} />;
}

export function LiveTrendChart({ points }: { points: LiveTrendPoint[] }) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const chartTheme = useChartTheme();

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !points.length) return undefined;
    const trendDataset = (
      label: string,
      valueKey: keyof Pick<LiveTrendPoint, 'liveSeconds' | 'ownHistoricalSeconds' | 'rivalHistoricalSeconds'>,
      color: string,
      borderWidth: number,
      borderDash?: number[]
    ) => ({
      label,
      data: points.map((point) => ({ x: point.raceHour, y: point[valueKey] })),
      borderColor: color,
      backgroundColor: color,
      borderWidth,
      borderDash,
      pointRadius: 0,
      pointHoverRadius: 5,
      tension: 0.28,
      spanGaps: true,
    });
    const chart = new Chart(canvas, {
      type: 'line',
      data: {
        datasets: [
          trendDataset('Apolloon live', 'liveSeconds', workspaceChartPalette.live, 4),
          trendDataset('Apolloon vorig jaar', 'ownHistoricalSeconds', workspaceChartPalette.own, 2, [7, 5]),
          trendDataset('VTK vorig jaar', 'rivalHistoricalSeconds', workspaceChartPalette.rival, 2, [7, 5]),
        ],
      },
      options: sharedLineChartOptions('Mediaan rondetijd per kwartier', (value) => formatPaceSeconds(Number(value))),
    });
    return () => chart.destroy();
  }, [chartTheme, points]);

  return <ChartCanvas canvasRef={canvasRef} />;
}

export function LiveTimeGapChart({ points }: { points: TimeGapPoint[] }) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const chartTheme = useChartTheme();

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !points.length) return undefined;
    const actualPoints = points.filter((point) => !point.predicted);
    const predictionPoints = points.filter((point) => point.predicted);
    const lastActualPoint = actualPoints[actualPoints.length - 1];
    const chart = new Chart(canvas, {
      type: 'line',
      data: {
        datasets: [
          {
            label: 'Werkelijke tijdskloof',
            data: actualPoints.map((point) => ({ x: point.raceHour, y: point.gapSeconds })),
            borderColor: workspaceChartPalette.strong,
            backgroundColor: workspaceChartPalette.strong,
            borderWidth: 3,
            pointRadius: 0,
            tension: 0.2,
          },
          {
            label: 'Voorspeld met doelschema',
            data: [...(lastActualPoint ? [lastActualPoint] : []), ...predictionPoints]
              .map((point) => ({ x: point.raceHour, y: point.gapSeconds })),
            borderColor: workspaceChartPalette.live,
            backgroundColor: workspaceChartPalette.live,
            borderWidth: 3,
            borderDash: [8, 6],
            pointRadius: 0,
            tension: 0.2,
          },
          {
            label: 'Gelijke stand',
            data: [{ x: 0, y: 0 }, { x: 24, y: 0 }],
            borderColor: workspaceChartPalette.neutral,
            backgroundColor: workspaceChartPalette.neutral,
            borderWidth: 1,
            borderDash: [5, 5],
            pointRadius: 0,
          },
        ],
      },
      options: sharedLineChartOptions('Tijdskloof op VTK', (value) => formatSignedGap(Number(value))),
    });
    return () => chart.destroy();
  }, [chartTheme, points]);

  return <ChartCanvas canvasRef={canvasRef} />;
}

function ChartCanvas({ canvasRef }: { canvasRef: React.RefObject<HTMLCanvasElement | null> }) {
  return (
    <div className="analysis-chart-card tactics-chart-card">
      <canvas ref={canvasRef} />
    </div>
  );
}

function lineDataset(
  label: string,
  points: RaceProgressPoint[],
  valueKey: keyof Pick<RaceProgressPoint, 'liveLaps' | 'targetLaps' | 'ownHistoricalLaps' | 'rivalHistoricalLaps'>,
  color: string,
  borderWidth: number,
  borderDash?: number[],
  hiddenByDefault?: boolean
) {
  return {
    label,
    data: points.map((point) => ({ x: point.raceHour, y: point[valueKey] })),
    borderColor: color,
    backgroundColor: color,
    borderWidth,
    borderDash,
    hidden: hiddenByDefault,
    pointRadius: 0,
    pointHoverRadius: 5,
    tension: 0.18,
    spanGaps: false,
  };
}

function paceDataset(
  label: string,
  points: HourlyPacePoint[],
  valueKey: keyof Pick<HourlyPacePoint, 'plannedSeconds' | 'actualSeconds' | 'ownHistoricalSeconds' | 'rivalHistoricalSeconds'>,
  color: string,
  borderWidth: number,
  borderDash?: number[]
) {
  return {
    label,
    data: points.map((point) => ({ x: point.raceHour + 0.5, y: point[valueKey] })),
    borderColor: color,
    backgroundColor: color,
    borderWidth,
    borderDash,
    pointRadius: 3,
    pointHoverRadius: 6,
    tension: 0.25,
    spanGaps: false,
  };
}

function sharedLineChartOptions(
  yAxisTitle: string,
  yTickFormatter: (value: string | number) => string
): ChartConfiguration<'line'>['options'] {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    devicePixelRatio: Math.min(window.devicePixelRatio || 1, MAX_CHART_PIXEL_RATIO),
    interaction: { mode: 'nearest', intersect: false },
    parsing: false,
    plugins: {
      legend: { position: 'top', labels: { boxWidth: 14, color: workspaceChartPalette.text, font: { weight: 500 } } },
      tooltip: {
        ...chartTooltipColors(),
        callbacks: {
          title(items) { return items[0] ? `Race-uur ${formatRaceHour(Number(items[0].parsed.x))}` : ''; },
          label(context) {
            return context.parsed.y == null
              ? `${context.dataset.label}: geen data`
              : `${context.dataset.label}: ${yTickFormatter(context.parsed.y)}`;
          },
        },
      },
    },
    scales: {
      x: {
        type: 'linear',
        min: 0,
        max: RACE_DURATION_HOURS,
        title: { display: true, text: 'Uren sinds de start', color: workspaceChartPalette.muted, font: { weight: 500 } },
        ticks: { color: workspaceChartPalette.muted, stepSize: 2, callback: (value) => `${value}u` },
        grid: { color: workspaceChartPalette.grid },
      },
      y: {
        beginAtZero: yAxisTitle === 'Cumulatieve rondes',
        title: { display: true, text: yAxisTitle, color: workspaceChartPalette.muted, font: { weight: 500 } },
        ticks: { color: workspaceChartPalette.muted, callback: (value) => yTickFormatter(value) },
        grid: { color: workspaceChartPalette.grid },
      },
    },
  };
}
