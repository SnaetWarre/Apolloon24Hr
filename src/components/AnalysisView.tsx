import { SectionNavigation } from './SectionNavigation';
import { PageHeader } from './PageHeader';
import { Icon } from './Icon';
import { chartTooltipColors, useChartTheme, workspaceChartPalette } from '../lib/chartPalette';
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
import { useAppData, useRaceHistory } from '../app/index';
import {
  buildDistribution,
  buildFastestLapWindows,
  buildKpis,
  buildLabelComparisons,
  buildRollingLapTrend,
  buildRunnerInsights,
  buildTimeBuckets,
  filterLaps,
  type AnalysisFilters,
  type DistributionBin,
  type FastestLapWindow,
  type LabelComparison,
  type RunnerInsight,
} from '../lib/analysis';
import { groupLabels } from '../lib/labels';
import { collectRankingLabels } from '../lib/ranking';
import { foldSearchText, lapRunnerLabel } from '../lib/runners';
import { useArrivals } from '../lib/motion';
import { formatClockTimeMs, formatDurationMs } from '../lib/time';
import type { Label, LiveAppSnapshot, PublicRecordMode } from '../types';

const selectAnalysisData = ({ runners, labels, race }: LiveAppSnapshot) => ({
  runners,
  labels,
  race,
});
import { LabelBadge, labelKindTitle } from './LabelBadge';

type RunnerInsightSort = 'laps' | 'average' | 'best' | 'consistency';
type AnalysisRecordWindowMode = Exclude<PublicRecordMode, 'off'>;

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

type AnalysisSection = 'race' | 'runners' | 'teams';
const ANALYSIS_SECTIONS: ReadonlyArray<{ id: AnalysisSection; label: string }> = [
  { id: 'race', label: 'Wedstrijd' },
  { id: 'runners', label: 'Lopers' },
  { id: 'teams', label: 'Ploegen' },
];

export function AnalysisView() {
  const [activeSection, setActiveSection] = React.useState<AnalysisSection>('race');
  const { runners, labels, race } = useAppData(selectAnalysisData);
  const { laps, events, loading: historyLoading, error: historyError } = useRaceHistory({ scope: 'full' });
  const [filters, setFilters] = React.useState<AnalysisFilters>(allLabelsEnabled);
  const [runnerSearch, setRunnerSearch] = React.useState('');
  const [runnerSort, setRunnerSort] = React.useState<RunnerInsightSort>('laps');
  const [fastestWindowMode, setFastestWindowMode] = React.useState<AnalysisRecordWindowMode>('day');
  const exportRef = React.useRef<HTMLDetailsElement>(null);
  // A section chosen after the page opened fades in; the first one is simply there.
  const sectionChanged = useArrivals([`section:${activeSection}`]).has(`section:${activeSection}`);

  // The export menu closes like any menu: a click elsewhere or Escape.
  React.useEffect(() => {
    const details = exportRef.current;
    if (!details) return;
    const onPointerDown = (event: PointerEvent) => {
      if (details.open && !details.contains(event.target as Node)) details.open = false;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (details.open && event.key === 'Escape') details.open = false;
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const analysisLabels = collectRankingLabels(labels, laps);
  const enabledLabelIds = filters.enabledLabelIds ?? analysisLabels.map((label) => label.id);
  const enabledLabels = analysisLabels.filter((label) => enabledLabelIds.includes(label.id));
  const filteredLaps = filterLaps(laps, filters);
  const kpis = buildKpis(filteredLaps, race);
  const timeBuckets = buildTimeBuckets(filteredLaps, race);
  const rollingLapTrend = buildRollingLapTrend(filteredLaps, race);
  const distribution = buildDistribution(filteredLaps);
  const fastestLapWindows = buildFastestLapWindows(filteredLaps, race, fastestWindowMode);
  const labelComparisons = buildLabelComparisons(enabledLabels, filteredLaps);
  const runnerInsights = buildRunnerInsights(runners, filteredLaps);
  const visibleRunnerInsights = runnerInsights
    .filter((insight) => runnerInsightMatches(insight, runnerSearch))
    .sort(sortRunnerInsight(runnerSort));
  const burgieEventCount = events.reduce((count, event) => count + (event.type === 'burgie_gepakt' ? 1 : 0), 0);

  function enableAllLabels() {
    setFilters(allLabelsEnabled);
  }

  function disableAllLabels() {
    setFilters({ enabledLabelIds: [] });
  }

  function toggleLabel(labelId: string) {
    setFilters((current) => {
      const currentIds = current.enabledLabelIds ?? analysisLabels.map((label) => label.id);
      return {
        enabledLabelIds: currentIds.includes(labelId)
          ? currentIds.filter((id) => id !== labelId)
          : [...currentIds, labelId],
      };
    });
  }

  return (
    <>
      <PageHeader
        title="Analyse"
        meta={
          <span
            className={`header-tag${filteredLaps.length < laps.length ? ' header-tag--partial' : ''}`}
            role="status"
          >
            {filteredLaps.length} van {laps.length} rondes, {enabledLabels.length} van {analysisLabels.length} labels
          </span>
        }
        actions={
          <details ref={exportRef} className="analysis-export">
            <summary className="btn btn--sm">
              <Icon name="download" size={14} />
              Exporteren
            </summary>
            <div className="analysis-export__menu">
              <p>Exports bevatten altijd de volledige wedstrijd. De labelfilters op dit scherm tellen niet mee.</p>
              <a className="btn btn--sm" href="/api/export/race.xlsx">
                Excel: rondes en gebeurtenissen
              </a>
              <p className="analysis-export__group">Voor MATLAB, R of andere scripts</p>
              <a className="btn btn--quiet btn--sm" href="/api/export/laps.csv">
                Rondes (CSV)
              </a>
              <a className="btn btn--quiet btn--sm" href="/api/export/laps.json">
                Rondes (JSON)
              </a>
              <a className="btn btn--quiet btn--sm" href="/api/export/current-state.json">
                Volledige toestand (JSON)
              </a>
              <a className="btn btn--quiet btn--sm" href="/api/export/events.csv">
                Gebeurtenissen (CSV)
              </a>
              <a className="btn btn--quiet btn--sm" href="/api/export/events.json">
                Gebeurtenissen (JSON)
              </a>
            </div>
          </details>
        }
      />

      {historyLoading && (
        <div className="host-hint" role="status">
          Racegeschiedenis wordt geladen...
        </div>
      )}
      {historyError && (
        <div className="warning-banner" role="alert">
          De racegeschiedenis kon niet worden geladen: {historyError.message}
        </div>
      )}

      <div className="analysis-workspace">
        <aside className="analysis-scope">
          <section className="panel analysis-filter-panel">
            <div className="panel-heading-row">
              <SectionHeader title="Labels" text="Een ronde telt mee zodra één van haar labels aan staat." />
              <div className="analysis-filter-actions">
                <button className="btn btn--ghost" onClick={enableAllLabels}>
                  Alles aan
                </button>
                <button className="btn btn--ghost" onClick={disableAllLabels}>
                  Alles uit
                </button>
              </div>
            </div>
            <LabelTogglePicker labels={analysisLabels} enabledLabelIds={enabledLabelIds} onToggle={toggleLabel} />
          </section>
        </aside>
        <div className="analysis-content">
          <div className="stats-grid stats-grid--analysis">
            <StatPanel label="Rondes" value={kpis.count.toString()} />
            <StatPanel label="Gemiddelde ronde" value={formatDurationMs(kpis.averageMs)} hero />
            <StatPanel label="Mediaan" value={formatDurationMs(kpis.medianMs)} />
            <StatPanel label="Snelste" value={formatDurationMs(kpis.bestMs)} />
            <StatPanel label="Traagste" value={formatDurationMs(kpis.slowestMs)} />
            <StatPanel label="Rondes per uur" value={formatNumber(kpis.lapsPerHour, 1)} hero />
            <StatPanel label="Projectie na 24 uur" value={formatNumber(kpis.projected24hLaps, 0)} hero />
            <StatPanel label="Burgie gepakt" value={burgieEventCount.toString()} />
          </div>

          <SectionNavigation
            label="Analyseonderdelen"
            sections={ANALYSIS_SECTIONS}
            activeSectionId={activeSection}
            onSectionChange={setActiveSection}
          />
          {activeSection === 'race' && (
            <div key="race" className={`analysis-section${sectionChanged ? ' rise-in' : ''}`}>
              <div className="analysis-charts">
                <section className="panel analysis-pace-panel">
                  <SectionHeader
                    title="Rondes en tempo per uur"
                    text="Balken: aantal rondes per uur. Lijn: gemiddelde rondetijd in dat uur."
                  />
                  <RacePaceChart buckets={timeBuckets} />
                </section>

                <section className="panel analysis-trend-panel">
                  <SectionHeader title="Rondetijd over de race" text="Voortschrijdend gemiddelde van de rondetijden." />
                  <RollingLapTrendChart points={rollingLapTrend} />
                </section>
              </div>
              {kpis.outlierUnderMinuteCount > 0 && (
                <div className="warning-banner">
                  {kpis.outlierUnderMinuteCount} ronde(s) onder 1:00 gevonden. Die worden niet opgenomen in de
                  verdeling.
                </div>
              )}
              {kpis.outlierOverLimitCount > 0 && (
                <div className="warning-banner">
                  {kpis.outlierOverLimitCount} ronde(s) langer dan 10 minuten gevonden. Waarschijnlijk werd er niet
                  gewisseld; die tijden tellen niet mee in gemiddelden, traagste en grafieken.
                </div>
              )}

              <div className="analysis-main-grid">
                <section className="panel">
                  <SectionHeader title="Rondeverdeling" text="Aantal rondes per zone van 5 seconden." />
                  <DistributionChart bins={distribution} />
                </section>

                <section className="panel">
                  <SectionHeader title="Snelste rondes" text="Binnen de huidige selectie." />
                  <FastestLapWindowList
                    mode={fastestWindowMode}
                    windows={fastestLapWindows}
                    onModeChange={setFastestWindowMode}
                  />
                </section>
              </div>
            </div>
          )}
          {activeSection === 'runners' && (
            <div key="runners" className={`analysis-section${sectionChanged ? ' rise-in' : ''}`}>
              <section className="panel">
                <div className="panel-heading-row">
                  <SectionHeader
                    title="Lopers"
                    text="Binnen de huidige selectie. Sorteer op rondes, tempo of regelmaat."
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
                  <button
                    className={runnerSort === 'average' ? 'is-active' : ''}
                    onClick={() => setRunnerSort('average')}
                  >
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
                </div>
                <div className="table-wrap">
                  <RunnerInsightsTable insights={visibleRunnerInsights} />
                </div>
              </section>
            </div>
          )}
          {activeSection === 'teams' && (
            <div key="teams" className={`analysis-section${sectionChanged ? ' rise-in' : ''}`}>
              <section className="panel">
                <SectionHeader
                  title="Gemiddelde per label"
                  text="Een loper kan in meerdere labels zitten, dus labels overlappen."
                />
                <LabelComparisonList comparisons={labelComparisons} />
              </section>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function StatPanel({ label, value, hero }: { label: string; value: string; hero?: boolean }) {
  const hasLongValue = value.length >= 10;
  // A figure that changes with the filter lifts briefly; the first figure is simply there.
  const changed = useArrivals([value]).has(value);
  return (
    <div className={`stat-panel${hasLongValue ? ' stat-panel--long-value' : ''}${hero ? ' stat-panel--hero' : ''}`}>
      <span className="muted-label">{label}</span>
      <strong key={value} className={changed ? 'value-tick' : undefined} title={value}>
        {value}
      </strong>
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

function FastestLapWindowList({
  mode,
  windows,
  onModeChange,
}: {
  mode: AnalysisRecordWindowMode;
  windows: FastestLapWindow[];
  onModeChange: (mode: AnalysisRecordWindowMode) => void;
}) {
  return (
    <>
      <div className="segmented-control analysis-sort-control">
        <button className={mode === 'day' ? 'is-active' : ''} onClick={() => onModeChange('day')}>
          Per dag
        </button>
        <button className={mode === 'two_hour' ? 'is-active' : ''} onClick={() => onModeChange('two_hour')}>
          Per 2 uur
        </button>
        <button className={mode === 'hour' ? 'is-active' : ''} onClick={() => onModeChange('hour')}>
          Per uur
        </button>
      </div>
      {windows.length ? (
        <div className="table-wrap">
          <table className="analysis-table">
            <thead>
              <tr>
                <th>Periode</th>
                <th>Loper</th>
                <th>Ronde</th>
                <th>Tijd</th>
                <th>Moment</th>
              </tr>
            </thead>
            <tbody>
              {windows.map((window) => (
                <tr key={window.key}>
                  <td>{window.label}</td>
                  <td>{lapRunnerLabel(window.lap)}</td>
                  <td>{window.lap.lapNumber}</td>
                  <td>
                    <strong>{formatDurationMs(window.lap.durationMs)}</strong>
                  </td>
                  <td>{formatClockTimeMs(window.lap.finishedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyAnalyticsState message="Geen rondes binnen deze selectie." />
      )}
    </>
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

function RollingLapTrendChart({ points }: { points: ReturnType<typeof buildRollingLapTrend> }) {
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

function RacePaceChart({ buckets }: { buckets: ReturnType<typeof buildTimeBuckets> }) {
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

  if (!buckets.length) return <EmptyAnalyticsState message="Zet minstens een ploeg aan om de grafiek te tonen." />;
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
  return insights.length ? (
    <table>
      <thead>
        <tr>
          <th>Nr.</th>
          <th>Naam</th>
          <th>Toeren</th>
          <th>Totaal</th>
          <th>Gem.</th>
          <th>Mediaan</th>
          <th>Snelste</th>
          <th>Traagste</th>
          <th>Spreiding</th>
        </tr>
      </thead>
      <tbody>
        {insights.map((runner) => (
          <tr key={runner.runnerId}>
            <td>{runner.runnerNumber || '-'}</td>
            <td>{runner.runnerName}</td>
            <td>{runner.count}</td>
            <td>{formatDurationMs(runner.totalMs)}</td>
            <td>{formatDurationMs(runner.averageMs)}</td>
            <td>{formatDurationMs(runner.medianMs)}</td>
            <td>{formatDurationMs(runner.bestMs)}</td>
            <td>{formatDurationMs(runner.slowestMs)}</td>
            <td>{formatDurationMs(runner.standardDeviationMs)}</td>
          </tr>
        ))}
      </tbody>
    </table>
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

function formatNumber(value: number | null, digits: number) {
  if (value == null || Number.isNaN(value)) return '-';
  return value.toLocaleString('nl-BE', {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

function runnerInsightMatches(insight: RunnerInsight, query: string) {
  const normalized = foldSearchText(query.trim());
  if (!normalized) return true;
  return (
    foldSearchText(insight.runnerName).includes(normalized) ||
    foldSearchText(insight.runnerNumber || '').includes(normalized)
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
    return b.count - a.count || nullableAsc(a.averageMs, b.averageMs);
  };
}

function nullableAsc(a: number | null, b: number | null) {
  return (a ?? Number.MAX_SAFE_INTEGER) - (b ?? Number.MAX_SAFE_INTEGER);
}
