import type { FastestLapWindow, LabelComparison, RunnerInsight } from '../../lib/analysis';
import { lapRunnerLabel } from '../../lib/runners';
import { formatClockTimeMs, formatDurationMs } from '../../lib/time';
import type { PublicRecordMode } from '../../types';
import { LabelBadge } from '../LabelBadge';
import { EmptyAnalyticsState } from './analysisParts';

export type AnalysisRecordWindowMode = Exclude<PublicRecordMode, 'off'>;

export function FastestLapWindowList({
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

export function LabelComparisonList({ comparisons }: { comparisons: LabelComparison[] }) {
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

export function RunnerInsightsTable({ insights }: { insights: RunnerInsight[] }) {
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
