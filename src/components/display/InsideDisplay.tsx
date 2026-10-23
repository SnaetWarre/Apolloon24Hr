import React from 'react';
import { lapPoints } from '../../../shared/points';
import { useAppData, useRaceHistory } from '../../app/index';
import { useArrivals } from '../../lib/motion';
import { buildRecentLapSummaries, buildRunnerRanking, collectRankingLabels } from '../../lib/ranking';
import { getNextWaitingRunner, lapRunnerLabel, runnerLabel } from '../../lib/runners';
import { formatClockTimeMs, formatDurationMs } from '../../lib/time';
import { LiveDot } from '../LiveDot';
import { DisplayBrand, DisplayTotals, PresentationSwitch, selectInsideDisplayData } from './displayParts';
import { useDisplayPresentation } from './displaySettings';

// The rows of both lists on the Binnenscherm.
const INSIDE_LIST_LENGTH = 25;

export function InsideDisplay() {
  const { runners, labels, race } = useAppData(selectInsideDisplayData);
  const [presentation, setPresentation] = useDisplayPresentation('inside', 'dark');
  const finished = Boolean(race.raceFinishedAt);
  const activeRunner = finished ? null : runners.find((runner) => runner.id === race.activeRunnerId) || null;
  const nextRunner = finished ? null : getNextWaitingRunner(runners);
  const { laps, initialized: historyIsInitialized } = useRaceHistory({ scope: 'full' });
  const [rankingLabelId, setRankingLabelId] = React.useState<string | null>(null);
  const recentLapSummaries = buildRecentLapSummaries(laps, INSIDE_LIST_LENGTH);
  const rankingLabels = collectRankingLabels(labels, laps);
  const ranking = buildRunnerRanking(runners, laps, 'coefficient', rankingLabelId).slice(0, INSIDE_LIST_LENGTH);
  const rankingLabelName = rankingLabels.find((label) => label.id === rankingLabelId)?.name;
  const activeKey = activeRunner?.id ?? 'none';
  const nextKey = nextRunner?.id ?? 'none';
  const rankingKey = `ranking:${rankingLabelId ?? ''}`;
  // What changes after the screen opened moves: a handover, a lap that lands, another label.
  const changed = useArrivals([`active:${activeKey}`, `next:${nextKey}`, rankingKey]);
  const newLapIds = useArrivals(
    recentLapSummaries.map(({ lap }) => lap.id),
    historyIsInitialized
  );

  return (
    <main className={`display-root display-root--inside display-root--${presentation}`}>
      <header className="inside-header">
        <DisplayBrand />
        <h1 className="visually-hidden">24 urenloop, live standen</h1>
        <section className="inside-now" aria-label="Nu op de piste">
          <span className="inside-now__label">
            {!finished && <LiveDot />}
            {finished ? 'Race afgelopen' : 'Nu op de piste'}
          </span>
          <strong
            key={activeKey}
            className={`inside-now__runner${changed.has(`active:${activeKey}`) ? ' display-rise' : ''}`}
          >
            {activeRunner
              ? runnerLabel(activeRunner)
              : finished
                ? 'Bedankt aan alle lopers'
                : race.raceStartedAt
                  ? 'Even niemand'
                  : 'Nog niemand gestart'}
          </strong>
          {!finished && (
            <span className="inside-now__next">
              Volgende{' '}
              <strong key={nextKey} className={changed.has(`next:${nextKey}`) ? 'display-rise' : undefined}>
                {nextRunner ? runnerLabel(nextRunner) : 'niemand klaar'}
              </strong>
            </span>
          )}
        </section>
        <DisplayTotals race={race} laps={laps} />
      </header>

      <div className="inside-board">
        <section className="display-panel inside-list" aria-label={`Laatste ${INSIDE_LIST_LENGTH} lopers`}>
          <div className="inside-panel-heading">
            <h2>Laatste {INSIDE_LIST_LENGTH} lopers</h2>
          </div>
          {recentLapSummaries.length ? (
            <table className="display-table recent-lap-table">
              <thead>
                <tr>
                  <th scope="col">Binnen om</th>
                  <th scope="col">Loper</th>
                  <th scope="col">Deze ronde</th>
                  <th scope="col">Punten</th>
                  <th scope="col">Snelste</th>
                  <th scope="col">Gem.</th>
                </tr>
              </thead>
              <tbody>
                {recentLapSummaries.map(({ lap, bestLapMs, averageLapMs }, index) => (
                  <tr
                    key={lap.id}
                    className={`recent-lap-row${index === 0 ? ' is-latest' : ''}${newLapIds.has(lap.id) ? ' is-new' : ''}`}
                  >
                    <td className="recent-lap-when">
                      {index === 0 ? (
                        <span className="recent-lap-badge">Net binnen</span>
                      ) : (
                        formatDisplayClockTime(lap.finishedAt)
                      )}
                    </td>
                    <td className="recent-lap-runner">
                      {lapRunnerLabel(lap)}
                      <span className="recent-lap-number">ronde {lap.lapNumber}</span>
                    </td>
                    <td className="recent-lap-time recent-lap-time--current">{formatDurationMs(lap.durationMs)}</td>
                    <td className="recent-lap-points">{formatPoints(lapPoints(lap))}</td>
                    <td className="recent-lap-time">{formatDurationMs(bestLapMs)}</td>
                    <td className="recent-lap-time">{formatDurationMs(averageLapMs)}</td>
                  </tr>
                ))}
                <EmptyRows count={INSIDE_LIST_LENGTH - recentLapSummaries.length} columns={6} />
              </tbody>
            </table>
          ) : (
            <div className="inside-empty">De eerste rondes verschijnen hier zodra de timing start.</div>
          )}
        </section>

        <section className="display-panel inside-list" aria-label="Ranking op punten">
          <div className="inside-panel-heading">
            <h2>Ranking op punten</h2>
            <span>
              {rankingLabelName
                ? `Alleen ${rankingLabelName}`
                : 'Snelle rondes en rondes tussen middernacht en 16 uur tellen zwaarder'}
            </span>
          </div>
          {ranking.length ? (
            <table
              key={rankingKey}
              className={`display-table points-table${changed.has(rankingKey) ? ' display-rise' : ''}`}
            >
              <thead>
                <tr>
                  <th scope="col">
                    <span className="visually-hidden">Plaats</span>
                  </th>
                  <th scope="col">Loper</th>
                  <th scope="col">Rondes</th>
                  <th scope="col">Punten</th>
                </tr>
              </thead>
              <tbody>
                {ranking.map((runner, index) => (
                  <tr key={runner.runnerId} className="points-row">
                    <td className="points-place">{index + 1}</td>
                    <td className="points-runner">{lapRunnerLabel(runner)}</td>
                    <td className="points-laps">{runner.lapCount}</td>
                    <td className="points-total">{formatPoints(runner.coefficientTotal)}</td>
                  </tr>
                ))}
                <EmptyRows count={INSIDE_LIST_LENGTH - ranking.length} columns={4} />
              </tbody>
            </table>
          ) : (
            <div className="inside-empty">Nog geen rondes voor deze selectie</div>
          )}
        </section>
      </div>

      <footer className="display-controls">
        <label className="ranking-label-filter">
          <span>Ranking voor</span>
          <select value={rankingLabelId ?? ''} onChange={(event) => setRankingLabelId(event.target.value || null)}>
            <option value="">Alle lopers</option>
            {rankingLabels.map((label) => (
              <option key={label.id} value={label.id}>
                {label.name}
              </option>
            ))}
          </select>
        </label>
        <PresentationSwitch presentation={presentation} onChange={setPresentation} />
      </footer>
    </main>
  );
}

/** Keeps a list at its full number of rows, so the rows of the two lists line up. */
function EmptyRows({ count, columns }: { count: number; columns: number }) {
  return Array.from({ length: Math.max(0, count) }, (_, index) => (
    <tr key={index} className="display-table__empty" aria-hidden="true">
      {Array.from({ length: columns }, (_, column) => (
        <td key={column}>{'\u00a0'}</td>
      ))}
    </tr>
  ));
}

function formatPoints(points: number) {
  return points.toLocaleString('nl-BE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function formatDisplayClockTime(finishedAt: number) {
  return formatClockTimeMs(finishedAt).split('.')[0];
}
