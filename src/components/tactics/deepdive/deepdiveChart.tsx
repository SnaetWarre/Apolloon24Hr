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
import { chartTooltipColors, useChartTheme, workspaceChartPalette } from '../../../lib/chartPalette';

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

export function ChartPanel({ configuration }: { configuration: ChartConfiguration }) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const chartTheme = useChartTheme();
  React.useEffect(() => {
    if (!canvasRef.current) return undefined;
    const chart = new Chart(canvasRef.current, configuration);
    return () => chart.destroy();
  }, [chartTheme, configuration]);
  return (
    <div className="analysis-chart-card tactics-chart-card">
      <canvas ref={canvasRef} />
    </div>
  );
}

export function xySeries(
  label: string,
  data: Array<{ x: number; y: number | null }>,
  color: string,
  borderWidth = 2,
  borderDash?: number[]
) {
  return {
    label,
    data,
    borderColor: color,
    backgroundColor: color,
    borderWidth,
    borderDash,
    type: 'line' as const,
    pointRadius: 0,
    pointHoverRadius: 5,
    tension: 0.2,
    spanGaps: false,
  };
}

export function lineSeries(label: string, data: Array<number | null>, color: string) {
  return {
    label,
    data,
    borderColor: color,
    backgroundColor: color,
    borderWidth: 3,
    pointRadius: 2,
    pointHoverRadius: 5,
    tension: 0.25,
    spanGaps: false,
  };
}

export function xyChartOptions(
  yAxisTitle: string,
  formatter: (value: number) => string,
  beginAtZero = false,
  xAxisTitle = 'Uren sinds de start'
): ChartConfiguration['options'] {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    parsing: false,
    interaction: { mode: 'nearest', intersect: false },
    plugins: chartPlugins(formatter),
    scales: {
      x: {
        type: 'linear',
        min: 0,
        title: axisTitle(xAxisTitle),
        ticks: { color: workspaceChartPalette.muted },
        grid: { color: workspaceChartPalette.grid },
      },
      y: {
        beginAtZero,
        title: axisTitle(yAxisTitle),
        ticks: { color: workspaceChartPalette.muted, callback: (value) => formatter(Number(value)) },
        grid: { color: workspaceChartPalette.grid },
      },
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
      x: {
        title: axisTitle(xAxisTitle),
        ticks: { color: workspaceChartPalette.muted, maxTicksLimit: 18 },
        grid: { color: workspaceChartPalette.grid },
      },
      y: {
        beginAtZero: true,
        title: axisTitle(yAxisTitle),
        ticks: { color: workspaceChartPalette.muted, callback: (value) => formatter(Number(value)) },
        grid: { color: workspaceChartPalette.grid },
      },
    },
  };
}

export function chartPlugins(formatter: (value: number) => string) {
  return {
    legend: {
      position: 'top' as const,
      labels: { boxWidth: 14, color: workspaceChartPalette.text, font: { weight: 500 as const } },
    },
    tooltip: {
      ...chartTooltipColors(),
      callbacks: {
        label: (context: { dataset: { label?: string }; parsed: { y: number | null } }) =>
          `${context.dataset.label}: ${context.parsed.y == null ? 'geen data' : formatter(context.parsed.y)}`,
      },
    },
  };
}

export function axisTitle(text: string) {
  return { display: true, text, color: workspaceChartPalette.muted, font: { weight: 500 as const } };
}
