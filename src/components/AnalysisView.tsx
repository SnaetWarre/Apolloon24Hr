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
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { useAppData } from '../app/index';
import {
  buildDistribution,
  buildKpis,
  buildLabelComparisons,
  buildRunnerInsights,
  buildTimeBuckets,
  filterLaps,
  type AnalysisFilters,
  type DistributionBin,
  type LabelComparison,
  type RunnerInsight,
} from '../lib/analysis';
import { formatDurationMs } from '../lib/time';
import type { Label } from '../types';
import { LabelBadge, labelKindOrder, labelKindTitle } from './LabelBadge';

type RunnerInsightSort = 'laps' | 'average' | 'best' | 'consistency' | 'improvement';

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

const allLabelsEnabled: AnalysisFilters = {
  enabledLabelIds: null,
};

export function AnalysisView() {
  const { runners, labels, laps, events, race } = useAppData();
  const [filters, setFilters] = React.useState<AnalysisFilters>(allLabelsEnabled);
  const [runnerSearch, setRunnerSearch] = React.useState('');
  const [runnerSort, setRunnerSort] = React.useState<RunnerInsightSort>('laps');

  const enabledLabelIds = filters.enabledLabelIds ?? labels.map((label) => label.id);
  const enabledLabels = React.useMemo(
    () => labels.filter((label) => enabledLabelIds.includes(label.id)),
    [labels, enabledLabelIds]
  );
  const filteredLaps = React.useMemo(() => filterLaps(laps, filters), [laps, filters]);
  const kpis = React.useMemo(() => buildKpis(filteredLaps, race), [filteredLaps, race]);
  const timeBuckets = React.useMemo(() => buildTimeBuckets(filteredLaps, race), [filteredLaps, race]);
  const distribution = React.useMemo(() => buildDistribution(filteredLaps), [filteredLaps]);
  const labelComparisons = React.useMemo(
    () => buildLabelComparisons(enabledLabels, filteredLaps),
    [enabledLabels, filteredLaps]
  );
  const runnerInsights = React.useMemo(
    () => buildRunnerInsights(runners, filteredLaps),
    [runners, filteredLaps]
  );
  const visibleRunnerInsights = React.useMemo(
    () => runnerInsights.filter((insight) => runnerInsightMatches(insight, runnerSearch)).sort(sortRunnerInsight(runnerSort)),
    [runnerInsights, runnerSearch, runnerSort]
  );
  const burgieEvents = events.filter((event) => event.type === 'burgie_gepakt');

  function enableAllLabels() {
    setFilters(allLabelsEnabled);
  }

  function disableAllLabels() {
    setFilters({ enabledLabelIds: [] });
  }

  function toggleLabel(labelId: string) {
    setFilters((current) => {
      const currentIds = current.enabledLabelIds ?? labels.map((label) => label.id);
      return {
        enabledLabelIds: currentIds.includes(labelId)
          ? currentIds.filter((id) => id !== labelId)
          : [...currentIds, labelId],
      };
    });
  }

  return (
    <>
      <div className="hero hero--compact">
        <div>
          <img className="hero-logo" src="/brand/apolloon-logo.png" alt="Apolloon" />
          <h1 className="app-title">Analyse</h1>
          <p className="tagline">Grafieken op basis van de geselecteerde ploegen en categorieen.</p>
        </div>
      </div>

      <div className="analysis-top-grid">
        <section className="panel analysis-pace-panel">
          <SectionHeader
            title="Toertjestempo over tijd"
            text="Balken tonen hoeveel rondes er per uur liepen. De lijn toont hoe snel die rondes gemiddeld waren."
          />
          <RacePaceChart buckets={timeBuckets} />
        </section>

        <section className="panel analysis-filter-panel">
          <div className="panel-heading-row">
            <SectionHeader
              title="Ploegen aan/uit"
              text={`${filteredLaps.length} van ${laps.length} rondes tellen mee. Een ronde telt zodra minstens een van haar labels aan staat.`}
            />
            <div className="analysis-filter-actions">
              <button className="btn btn--ghost" onClick={enableAllLabels}>
                Alles aan
              </button>
              <button className="btn btn--ghost" onClick={disableAllLabels}>
                Alles uit
              </button>
            </div>
          </div>
          <LabelTogglePicker labels={labels} enabledLabelIds={enabledLabelIds} onToggle={toggleLabel} />
        </section>
      </div>

      <div className="stats-grid stats-grid--analysis">
        <StatPanel label="Geselecteerde toeren" value={kpis.count.toString()} />
        <StatPanel label="Gemiddelde ronde" value={formatDurationMs(kpis.averageMs)} />
        <StatPanel label="Mediaan" value={formatDurationMs(kpis.medianMs)} />
        <StatPanel label="Snelste" value={formatDurationMs(kpis.bestMs)} />
        <StatPanel label="Traagste" value={formatDurationMs(kpis.slowestMs)} />
        <StatPanel label="Toeren / uur" value={formatNumber(kpis.lapsPerHour, 1)} />
        <StatPanel label="Projectie 24u" value={formatNumber(kpis.projected24hLaps, 0)} />
        <StatPanel label="Burgie gepakt" value={burgieEvents.length.toString()} />
      </div>

      {kpis.outlierUnderMinuteCount > 0 && (
        <div className="warning-banner">
          {kpis.outlierUnderMinuteCount} ronde(s) onder 1:00 gevonden. Die worden niet opgenomen in de verdeling.
        </div>
      )}

      <div className="analysis-main-grid">
        <section className="panel">
          <SectionHeader
            title="Rondeverdeling"
            text="Vaste zones van 10 seconden, van 1:00 tot 2:00+."
          />
          <DistributionChart bins={distribution} />
        </section>

        <section className="panel">
          <SectionHeader
            title="Gemiddelde per label"
            text="Een loper kan in meerdere labels zitten; labels kunnen dus overlappen."
          />
          <LabelComparisonList comparisons={labelComparisons} />
        </section>
      </div>

      <section className="panel">
        <div className="panel-heading-row">
          <SectionHeader
            title="Loper inzichten"
            text="Zoek op nummer of naam. Trend vergelijkt de laatste ronde met de eerste ronde binnen de selectie."
          />
          <input
            className="input input--search analysis-runner-search"
            value={runnerSearch}
            onChange={(event) => setRunnerSearch(event.target.value)}
            placeholder="Zoek loper..."
          />
        </div>
        <div className="segmented-control analysis-sort-control">
          <button className={runnerSort === 'laps' ? 'is-active' : ''} onClick={() => setRunnerSort('laps')}>
            Meeste rondes
          </button>
          <button className={runnerSort === 'average' ? 'is-active' : ''} onClick={() => setRunnerSort('average')}>
            Snelste gem.
          </button>
          <button className={runnerSort === 'best' ? 'is-active' : ''} onClick={() => setRunnerSort('best')}>
            Snelste ronde
          </button>
          <button
            className={runnerSort === 'consistency' ? 'is-active' : ''}
            onClick={() => setRunnerSort('consistency')}
          >
            Consistent
          </button>
          <button
            className={runnerSort === 'improvement' ? 'is-active' : ''}
            onClick={() => setRunnerSort('improvement')}
          >
            Grootste winst
          </button>
        </div>
        <div className="table-wrap">
          <RunnerInsightsTable insights={visibleRunnerInsights} />
        </div>
      </section>

      <section className="panel analysis-export-panel">
        <SectionHeader title="Downloads" text="Exports blijven beschikbaar, maar staan bewust onderaan." />
        <div className="export-row export-row--secondary">
          <a className="btn btn--primary" href="/api/export/laps.csv">
            Download CSV
          </a>
          <a className="btn btn--ghost" href="/api/export/laps.json">
            Download laps.json
          </a>
          <a className="btn btn--ghost" href="/api/export/current-state.json">
            Download current-state.json
          </a>
          <a className="btn btn--ghost" href="/api/export/events.csv">
            Download events.csv
          </a>
          <a className="btn btn--ghost" href="/api/export/events.json">
            Download events.json
          </a>
        </div>
      </section>
    </>
  );
}

function StatPanel({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat-panel">
      <span className="muted-label">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SectionHeader({ title, text }: { title: string; text: string }) {
  return (
    <div className="analysis-section-header">
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
}

function LabelTogglePicker({
  labels,
  enabledLabelIds,
  onToggle,
}: {
  labels: Label[];
  enabledLabelIds: string[];
  onToggle: (labelId: string) => void;
}) {
  const enabled = new Set(enabledLabelIds);
  return (
    <div className="label-toggle-groups">
      {groupLabels(labels).map(([kind, groupedLabels]) => (
        <section key={kind} className="label-toggle-group">
          <h3>{labelKindTitle(kind)}</h3>
          <div className="label-toggle-list">
            {groupedLabels.map((label) => {
              const checked = enabled.has(label.id);
              return (
                <button
                  key={label.id}
                  className={`label-toggle-row${checked ? ' is-on' : ''}`}
                  onClick={() => onToggle(label.id)}
                  aria-pressed={checked}
                >
                  <span className="label-toggle-name">
                    {label.imageUrl ? (
                      <img src={label.imageUrl} alt="" className="label-image" />
                    ) : (
                      <i className="label-dot" style={{ background: label.color }} />
                    )}
                    {label.name}
                  </span>
                  <span className="label-switch">
                    <i />
                  </span>
                  <strong>{checked ? 'Aan' : 'Uit'}</strong>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function RacePaceChart({ buckets }: { buckets: ReturnType<typeof buildTimeBuckets> }) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);

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
            backgroundColor: 'rgba(40, 119, 246, 0.18)',
            borderColor: '#2877F6',
            borderWidth: 1,
            borderRadius: 4,
            yAxisID: 'laps',
          },
          {
            type: 'line',
            label: 'Gemiddelde rondetijd',
            data: buckets.map((bucket) => (bucket.averageMs == null ? null : bucket.averageMs / 1000)),
            borderColor: '#162033',
            backgroundColor: '#162033',
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
        interaction: {
          mode: 'index',
          intersect: false,
        },
        plugins: {
          legend: {
            position: 'top',
            labels: {
              boxWidth: 14,
              color: '#162033',
              font: { weight: 'bold' },
            },
          },
          tooltip: {
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
              color: '#64748b',
              font: { weight: 'bold' },
            },
            ticks: {
              precision: 0,
              color: '#64748b',
            },
            grid: {
              color: '#e2e8f0',
            },
          },
          seconds: {
            beginAtZero: false,
            position: 'right',
            title: {
              display: true,
              text: 'Gemiddelde rondetijd',
              color: '#64748b',
              font: { weight: 'bold' },
            },
            ticks: {
              color: '#64748b',
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
              color: '#64748b',
              font: { weight: 'bold' },
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
  }, [buckets]);

  if (!buckets.length) return <EmptyAnalyticsState message="Zet minstens een ploeg aan om de grafiek te tonen." />;
  return (
    <div className="analysis-chart-card">
      <canvas ref={canvasRef} />
    </div>
  );
}

function DistributionChart({ bins }: { bins: DistributionBin[] }) {
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

function LabelComparisonList({ comparisons }: { comparisons: LabelComparison[] }) {
  if (!comparisons.length) return <EmptyAnalyticsState message="Geen labels met rondes binnen deze selectie." />;

  return (
    <div className="table-wrap">
      <table className="analysis-table">
        <thead>
          <tr>
            <th>Label</th>
            <th>Rondes</th>
            <th>Gemiddeld</th>
            <th>Mediaan</th>
            <th>Snelste</th>
            <th>Traagste</th>
          </tr>
        </thead>
        <tbody>
          {comparisons.map((comparison) => (
            <tr key={comparison.label.id}>
              <td>
                <LabelBadge label={comparison.label} />
              </td>
              <td>{comparison.count}</td>
              <td>
                <strong>{formatDurationMs(comparison.averageMs)}</strong>
              </td>
              <td>{formatDurationMs(comparison.medianMs)}</td>
              <td>{formatDurationMs(comparison.bestMs)}</td>
              <td>{formatDurationMs(comparison.slowestMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RunnerInsightsTable({ insights }: { insights: RunnerInsight[] }) {
  const columns = React.useMemo<ColumnDef<RunnerInsight>[]>(
    () => [
      { header: 'Nr.', accessorFn: (runner) => runner.runnerNumber || '-' },
      { header: 'Naam', accessorKey: 'runnerName' },
      { header: 'Toeren', accessorKey: 'count' },
      { header: 'Totaal', cell: ({ row }) => formatDurationMs(row.original.totalMs) },
      { header: 'Gem.', cell: ({ row }) => formatDurationMs(row.original.averageMs) },
      { header: 'Mediaan', cell: ({ row }) => formatDurationMs(row.original.medianMs) },
      { header: 'Snelste', cell: ({ row }) => formatDurationMs(row.original.bestMs) },
      { header: 'Traagste', cell: ({ row }) => formatDurationMs(row.original.slowestMs) },
      { header: 'Spreiding', cell: ({ row }) => formatDurationMs(row.original.standardDeviationMs) },
      { header: 'Trend', cell: ({ row }) => formatTrend(row.original.latestVsFirstMs) },
    ],
    []
  );
  return insights.length ? (
    <DataTable data={insights} columns={columns} />
  ) : (
    <table>
      <tbody>
        <tr>
          <td>Geen lopers met rondes binnen deze selectie.</td>
        </tr>
      </tbody>
    </table>
  );
}

function EmptyAnalyticsState({ message }: { message: string }) {
  return <div className="empty-analytics-state">{message}</div>;
}

function DataTable<T>({ data, columns }: { data: T[]; columns: ColumnDef<T>[] }) {
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <table>
      <thead>
        {table.getHeaderGroups().map((headerGroup) => (
          <tr key={headerGroup.id}>
            {headerGroup.headers.map((header) => (
              <th key={header.id}>
                {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
              </th>
            ))}
          </tr>
        ))}
      </thead>
      <tbody>
        {table.getRowModel().rows.map((row) => (
          <tr key={row.id}>
            {row.getVisibleCells().map((cell) => (
              <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function groupLabels(labels: Label[]) {
  const grouped = new Map<string, Label[]>();
  [...labels]
    .sort(
      (a, b) =>
        labelKindOrder(a.kind) - labelKindOrder(b.kind) ||
        (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999) ||
        a.name.localeCompare(b.name)
    )
    .forEach((label) => {
      if (!grouped.has(label.kind)) grouped.set(label.kind, []);
      grouped.get(label.kind)?.push(label);
    });
  return [...grouped.entries()];
}

function formatNumber(value: number | null, digits: number) {
  if (value == null || Number.isNaN(value)) return '-';
  return value.toLocaleString('nl-BE', {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

function formatTrend(value: number | null) {
  if (value == null) return '-';
  if (value === 0) return 'gelijk';
  return `${value > 0 ? '+' : '-'}${formatDurationMs(Math.abs(value))}`;
}

function runnerInsightMatches(insight: RunnerInsight, query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return (
    insight.runnerName.toLowerCase().includes(normalized) ||
    (insight.runnerNumber || '').toLowerCase().includes(normalized)
  );
}

function sortRunnerInsight(mode: RunnerInsightSort) {
  return (a: RunnerInsight, b: RunnerInsight) => {
    if (mode === 'average') {
      return nullableAsc(a.averageMs, b.averageMs) || b.count - a.count;
    }
    if (mode === 'best') {
      return nullableAsc(a.bestMs, b.bestMs) || b.count - a.count;
    }
    if (mode === 'consistency') {
      return nullableAsc(a.standardDeviationMs, b.standardDeviationMs) || b.count - a.count;
    }
    if (mode === 'improvement') {
      return nullableAsc(a.latestVsFirstMs, b.latestVsFirstMs) || b.count - a.count;
    }
    return b.count - a.count || nullableAsc(a.averageMs, b.averageMs);
  };
}

function nullableAsc(a: number | null, b: number | null) {
  return (a ?? Number.MAX_SAFE_INTEGER) - (b ?? Number.MAX_SAFE_INTEGER);
}
