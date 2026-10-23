import { SectionNavigation } from './SectionNavigation';
import { PageHeader } from './PageHeader';
import React from 'react';
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
  toggleLabelFilter,
  type AnalysisFilters,
} from '../lib/analysis';
import { collectRankingLabels } from '../lib/ranking';
import { useArrivals } from '../lib/motion';
import { formatDurationMs } from '../lib/time';
import type { LiveAppSnapshot } from '../types';
import { AnalysisExportMenu } from './analysis/AnalysisExportMenu';
import { DistributionChart, RacePaceChart, RollingLapTrendChart } from './analysis/analysisCharts';
import { SectionHeader, StatPanel } from './analysis/analysisParts';
import {
  FastestLapWindowList,
  LabelComparisonList,
  RunnerInsightsTable,
  type AnalysisRecordWindowMode,
} from './analysis/analysisTables';
import { LabelTogglePicker } from './analysis/LabelTogglePicker';
import { runnerInsightMatches, sortRunnerInsight, type RunnerInsightSort } from './analysis/runnerInsightSort';

const selectAnalysisData = ({ runners, labels, race }: LiveAppSnapshot) => ({
  runners,
  labels,
  race,
});

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
  // A section chosen after the page opened fades in; the first one is simply there.
  const sectionChanged = useArrivals([`section:${activeSection}`]).has(`section:${activeSection}`);

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
    setFilters((current) =>
      toggleLabelFilter(
        current,
        labelId,
        analysisLabels.map((label) => label.id)
      )
    );
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
        actions={<AnalysisExportMenu />}
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
                  <RacePaceChart
                    buckets={timeBuckets}
                    noLabelsOn={analysisLabels.length > 0 && !enabledLabels.length}
                  />
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

function formatNumber(value: number | null, digits: number) {
  if (value == null || Number.isNaN(value)) return '-';
  return value.toLocaleString('nl-BE', {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}
