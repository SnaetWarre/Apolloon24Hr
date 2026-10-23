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
  Tooltip,
  type ChartConfiguration,
} from 'chart.js';
import { chartTooltipColors, useChartTheme, workspaceChartPalette } from '../../lib/chartPalette';
import { buildRollingLapTrend, buildTimeBuckets, type DistributionBin } from '../../lib/analysis';
import { formatDurationMs } from '../../lib/time';
import { EmptyAnalyticsState } from './analysisParts';

Chart.register(
  BarController,
  BarElement,
  CategoryScale,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip
);

export function RollingLapTrendChart({ points }: { points: ReturnType<typeof buildRollingLapTrend> }) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const chartTheme = useChartTheme();

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !points.length) return undefined;

    const config: ChartConfiguration<'line'> = {
      type: 'line',
      data: {
        datasets: [
          {
            label: 'Lopend gemiddelde',
            data: points.map((point) => ({
              x: point.raceHour,
              y: point.averageMs / 1000,
            })),
            borderColor: workspaceChartPalette.live,
            backgroundColor: workspaceChartPalette.live,
            borderWidth: 3,
            pointRadius: 0,
            pointHoverRadius: 5,
            tension: 0.32,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: {
          mode: 'nearest',
          intersect: false,
        },
        parsing: false,
        plugins: {
          legend: {
            position: 'top',
            labels: {
              boxWidth: 14,
              color: workspaceChartPalette.text,
              font: { weight: 500 },
            },
          },
          tooltip: {
            ...chartTooltipColors(),
            callbacks: {
              title(items) {
                const point = points[items[0]?.dataIndex ?? 0];
                return point ? `Race-uur ${point.label}` : 'Race-uur';
              },
              label(context) {
                const point = points[context.dataIndex];
                const average = formatDurationMs(Number(context.parsed.y) * 1000);
                return point
                  ? [`Gemiddelde rondetijd: ${average}`, `Rondes in venster: ${point.count}`]
                  : `Gemiddelde rondetijd: ${average}`;
              },
            },
          },
        },
        scales: {
          x: {
            type: 'linear',
            title: {
              display: true,
              text: 'Tijd sinds start (u:mm)',
              color: workspaceChartPalette.muted,
              font: { weight: 500 },
            },
            ticks: {
              color: workspaceChartPalette.muted,
              maxTicksLimit: 9,
              callback(value) {
                const totalMinutes = Math.round(Number(value) * 60);
                const hours = Math.floor(totalMinutes / 60);
                const minutes = String(totalMinutes % 60).padStart(2, '0');
                return `${hours}:${minutes}`;
              },
            },
            grid: {
              color: workspaceChartPalette.grid,
            },
          },
          y: {
            beginAtZero: false,
            title: {
              display: true,
              text: 'Gemiddelde rondetijd',
              color: workspaceChartPalette.muted,
              font: { weight: 500 },
            },
            ticks: {
              color: workspaceChartPalette.muted,
              callback(value) {
                return formatDurationMs(Number(value) * 1000);
              },
            },
            grid: {
              color: workspaceChartPalette.grid,
            },
          },
        },
      },
    };

    const chart = new Chart(canvas, config);
    return () => chart.destroy();
  }, [chartTheme, points]);

  if (!points.length) return <EmptyAnalyticsState message="Geen rondes binnen deze selectie." />;
  return (
    <div className="analysis-chart-card">
      <canvas ref={canvasRef} />
    </div>
  );
}

export function RacePaceChart({
  buckets,
  noLabelsOn,
}: {
  buckets: ReturnType<typeof buildTimeBuckets>;
  noLabelsOn: boolean;
}) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const chartTheme = useChartTheme();

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !buckets.length) return undefined;

    const config: ChartConfiguration = {
      type: 'bar',
      data: {
        labels: buckets.map((bucket) => bucket.label),
        datasets: [
          {
            type: 'bar',
            label: 'Rondes per uur',
            data: buckets.map((bucket) => bucket.count),
            backgroundColor: workspaceChartPalette.liveFill,
            borderColor: workspaceChartPalette.live,
            borderWidth: 1,
            borderRadius: 4,
            maxBarThickness: 160,
            categoryPercentage: 0.6,
            barPercentage: 0.9,
            yAxisID: 'laps',
          },
          {
            type: 'line',
            label: 'Gemiddelde rondetijd',
            data: buckets.map((bucket) => (bucket.averageMs == null ? null : bucket.averageMs / 1000)),
            borderColor: workspaceChartPalette.strong,
            backgroundColor: workspaceChartPalette.strong,
            borderWidth: 3,
            pointRadius: 4,
            pointHoverRadius: 6,
            tension: 0.3,
            yAxisID: 'seconds',
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: {
          mode: 'index',
          intersect: false,
        },
        plugins: {
          legend: {
            position: 'top',
            labels: {
              boxWidth: 14,
              color: workspaceChartPalette.text,
              font: { weight: 500 },
            },
          },
          tooltip: {
            ...chartTooltipColors(),
            callbacks: {
              label(context) {
                if (context.dataset.yAxisID === 'seconds') {
                  return `Gemiddelde rondetijd: ${formatDurationMs(Number(context.parsed.y) * 1000)}`;
                }
                return `Rondes: ${context.parsed.y}`;
              },
            },
          },
        },
        scales: {
          laps: {
            beginAtZero: true,
            position: 'left',
            title: {
              display: true,
              text: 'Rondes per uur',
              color: workspaceChartPalette.muted,
              font: { weight: 500 },
            },
            ticks: {
              precision: 0,
              color: workspaceChartPalette.muted,
            },
            grid: {
              color: workspaceChartPalette.grid,
            },
          },
          seconds: {
            beginAtZero: false,
            position: 'right',
            title: {
              display: true,
              text: 'Gemiddelde rondetijd',
              color: workspaceChartPalette.muted,
              font: { weight: 500 },
            },
            ticks: {
              color: workspaceChartPalette.muted,
              callback(value) {
                return formatDurationMs(Number(value) * 1000);
              },
            },
            grid: {
              drawOnChartArea: false,
            },
          },
          x: {
            ticks: {
              color: workspaceChartPalette.muted,
              font: { weight: 500 },
            },
            grid: {
              display: false,
            },
          },
        },
      },
    };

    const chart = new Chart(canvas, config);
    return () => chart.destroy();
  }, [buckets, chartTheme]);

  if (!buckets.length) {
    return (
      <EmptyAnalyticsState
        message={
          noLabelsOn ? 'Zet minstens een ploeg aan om de grafiek te tonen.' : 'Geen rondes binnen deze selectie.'
        }
      />
    );
  }
  return (
    <>
      <div className="analysis-chart-card">
        <canvas ref={canvasRef} />
      </div>
      {buckets.length < 2 && (
        <p className="chart-note">Nog maar één uur met rondes. De trend wordt zichtbaar naarmate de race vordert.</p>
      )}
    </>
  );
}

export function DistributionChart({ bins }: { bins: DistributionBin[] }) {
  const maxCount = Math.max(...bins.map((bin) => bin.count), 1);
  return (
    <div className="histogram">
      {bins.map((bin) => (
        <div key={bin.label} className="histogram-row">
          <span>{bin.label}</span>
          <div className="histogram-track">
            <i style={{ width: `${(bin.count / maxCount) * 100}%` }} />
          </div>
          <strong>{bin.count}</strong>
        </div>
      ))}
    </div>
  );
}
