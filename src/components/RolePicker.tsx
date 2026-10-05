import React from 'react';
import { LiveDot } from './LiveDot';
import { Link, useNavigate } from '@tanstack/react-router';
import { useAppData, useClusterStatus, useRaceHistory } from '../app/index';
import { getNextWaitingRunner } from '../lib/runners';
import { deriveSystemStatus } from '../lib/systemStatus';
import { useCopyText } from '../lib/clipboard';
import { useArrivals } from '../lib/motion';
import { shouldShowWelcome, useWelcomeSkipped } from '../lib/welcome';
import { formatClockTimeMs, formatDurationMs } from '../lib/time';
import { Icon } from './Icon';
import { LiveDuration, LiveElapsed } from './LiveTime';
import { PageHeader } from './PageHeader';
import { RunnerName } from './RunnerName';
import type { LiveAppSnapshot } from '../types';

// Only a laptop without runners shows it, so it stays out of the first download.
const WelcomeView = React.lazy(() => import('./WelcomeView').then((module) => ({ default: module.WelcomeView })));

const selectOverviewData = ({ host, runners, race }: LiveAppSnapshot) => ({ host, runners, race });

/** Overzicht: what is happening in the race right now, at a glance. */
export function RolePicker() {
  const { host, runners, race } = useAppData(selectOverviewData);
  const [welcomeSkipped, skipWelcome] = useWelcomeSkipped();
  const navigate = useNavigate();
  const { laps: recentLaps, loading: lapsLoading } = useRaceHistory({ scope: 'recent', limit: 8 });
  const { cluster, error: clusterError } = useClusterStatus();
  const systemStatus = deriveSystemStatus(cluster, clusterError);
  const [copied, copyHostUrl] = useCopyText(host?.url ?? null);

  const activeRunner = runners.find((runner) => runner.id === race.activeRunnerId) || null;
  const nextRunner = getNextWaitingRunner(runners);
  const warmingCount = runners.filter((runner) => runner.status === 'warming_up').length;
  const waitingCount = runners.filter((runner) => runner.status === 'waiting').length;
  const ranCount = runners.filter((runner) => runner.lapCount > 0).length;
  const totalLaps = runners.reduce((sum, runner) => sum + runner.lapCount, 0);
  const fastestRunner = runners.reduce<(typeof runners)[number] | null>(
    (best, runner) => (runner.bestLapMs && (!best?.bestLapMs || runner.bestLapMs < best.bestLapMs) ? runner : best),
    null
  );
  // Same definition as Analyse: laps divided by the time until the latest lap.
  const latestLapAt = recentLaps[0]?.finishedAt ?? null;
  const lapsPerHour =
    race.raceStartedAt && latestLapAt && latestLapAt > race.raceStartedAt
      ? (totalLaps / ((race.raceFinishedAt ?? latestLapAt) - race.raceStartedAt)) * 3_600_000
      : null;
  const lapsPerHourText =
    lapsPerHour == null
      ? '—'
      : lapsPerHour.toLocaleString('nl-BE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const fastestLapText = fastestRunner?.bestLapMs ? formatDurationMs(fastestRunner.bestLapMs) : '—';
  const activeRunnerKey = activeRunner?.id ?? 'none';
  const nextRunnerKey = nextRunner?.id ?? 'none';

  // Values and runners that changed since the page opened get a small move; nothing moves on load.
  const changed = useArrivals([
    `laps:${totalLaps}`,
    `pace:${lapsPerHourText}`,
    `best:${fastestLapText}`,
    `active:${activeRunnerKey}`,
    `next:${nextRunnerKey}`,
  ]);
  const tick = (id: string) => (changed.has(id) ? 'value-tick' : undefined);
  const newLapIds = useArrivals(
    recentLaps.map((lap) => lap.id),
    !lapsLoading
  );

  if (
    shouldShowWelcome({
      runnerCount: runners.length,
      raceStarted: Boolean(race.raceStartedAt),
      skipped: welcomeSkipped,
    })
  )
    return (
      <React.Suspense fallback={null}>
        <WelcomeView
          onSkip={skipWelcome}
          onOpenAdmin={(section) => void navigate({ to: '/admin', search: { section } })}
        />
      </React.Suspense>
    );

  return (
    <>
      <PageHeader
        title="Overzicht"
        meta={
          !race.raceStartedAt ? (
            <span>Race nog niet gestart</span>
          ) : race.raceFinishedAt ? (
            <span>Race afgesloten</span>
          ) : (
            <span className="header-tag">
              <LiveDot />
              Gestart om {formatClockTimeMs(race.raceStartedAt).slice(0, 5)}
            </span>
          )
        }
        actions={
          host && (
            <button type="button" className="btn btn--sm" onClick={copyHostUrl} title={host.url}>
              <Icon name={copied ? 'check' : 'copy'} size={14} className={copied ? 'icon--pop' : undefined} />
              {copied ? 'Gekopieerd' : 'Adres voor andere laptop kopiëren'}
            </button>
          )
        }
      />
      <div className="overview">
        <section className="overview-kpis" aria-label="Kerncijfers">
          <div>
            <span>Racetijd</span>
            <strong>
              {!race.raceStartedAt ? (
                '0:00'
              ) : race.raceFinishedAt ? (
                formatDurationMs(race.raceFinishedAt - race.raceStartedAt).split('.')[0]
              ) : (
                <LiveElapsed startedAt={race.raceStartedAt} />
              )}
            </strong>
          </div>
          <div>
            <span>Rondes</span>
            <strong key={totalLaps} className={tick(`laps:${totalLaps}`)}>
              {totalLaps.toLocaleString('nl-BE')}
            </strong>
          </div>
          <div>
            <span>Rondes per uur</span>
            <strong key={lapsPerHourText} className={tick(`pace:${lapsPerHourText}`)}>
              {lapsPerHourText}
            </strong>
          </div>
          <div>
            <span>Snelste ronde</span>
            <strong key={fastestLapText} className={tick(`best:${fastestLapText}`)}>
              {fastestLapText}
            </strong>
            {fastestRunner?.bestLapMs ? (
              <small>
                <RunnerName runner={fastestRunner} />
              </small>
            ) : null}
          </div>
        </section>

        <div className="overview-row">
          <section className="panel overview-track">
            <header className="panel-header">
              <h2>Op de piste</h2>
              <Link className="btn btn--sm btn--quiet" to="/timing">
                Naar Timing
                <Icon name="arrowRight" size={14} />
              </Link>
            </header>
            {activeRunner ? (
              <div
                key={activeRunnerKey}
                className={`overview-track__now${changed.has(`active:${activeRunnerKey}`) ? ' rise-in' : ''}`}
              >
                <span className="overview-track__runner">
                  <RunnerName runner={activeRunner} />
                </span>
                {race.activeStartedAt && (
                  <LiveDuration
                    startedAt={race.activeStartedAt}
                    className="overview-track__time"
                    refreshMs={1_000}
                    format="seconds"
                  />
                )}
              </div>
            ) : (
              <p className="overview-empty">
                {race.raceFinishedAt
                  ? 'De race is afgesloten.'
                  : runners.length === 0
                    ? 'Nog geen lopers. Importeer de inschrijvingen in Beheer of voeg lopers toe in Wachtrij.'
                    : waitingCount
                      ? 'Nog niemand op de piste. Start de eerste loper in Timing.'
                      : 'Nog niemand op de piste. Zet eerst lopers klaar in Wachtrij.'}
              </p>
            )}
            <p className="overview-track__next">
              Volgende:{' '}
              <strong key={nextRunnerKey} className={tick(`next:${nextRunnerKey}`)}>
                {nextRunner ? <RunnerName runner={nextRunner} /> : 'niemand klaar'}
              </strong>
            </p>
          </section>

          <section className="panel overview-queue">
            <header className="panel-header">
              <h2>Wisselzone</h2>
              <Link className="btn btn--sm btn--quiet" to="/queue">
                Naar Wachtrij
                <Icon name="arrowRight" size={14} />
              </Link>
            </header>
            <dl className="overview-counts">
              <div>
                <dt>Opwarmen</dt>
                <dd>{warmingCount}</dd>
              </div>
              <div>
                <dt>Klaar</dt>
                <dd>{waitingCount}</dd>
              </div>
              <div>
                <dt>Met rondes</dt>
                <dd>{ranCount}</dd>
              </div>
            </dl>
            {waitingCount < 3 && race.raceStartedAt && !race.raceFinishedAt && (
              <p className="overview-warning">
                Nog maar {waitingCount} {waitingCount === 1 ? 'loper' : 'lopers'} klaar. Zet lopers klaar in Wachtrij.
              </p>
            )}
          </section>
        </div>

        <div className="overview-row">
          <section className="panel overview-laps">
            <header className="panel-header">
              <h2>Laatste rondes</h2>
              <Link className="btn btn--sm btn--quiet" to="/analysis">
                Naar Analyse
                <Icon name="arrowRight" size={14} />
              </Link>
            </header>
            {recentLaps.length ? (
              <table>
                <tbody>
                  {recentLaps.map((lap) => (
                    <tr key={lap.id} className={newLapIds.has(lap.id) ? 'is-new' : undefined}>
                      <td className="overview-laps__time">{formatClockTimeMs(lap.finishedAt).slice(0, 8)}</td>
                      <td className="cell-runner">
                        {lap.runnerNumber && <span className="cell-number">{lap.runnerNumber}</span>}
                        {lap.runnerName}
                      </td>
                      <td className="num overview-laps__lap">ronde {lap.lapNumber}</td>
                      <td className="num">
                        <strong>{formatDurationMs(lap.durationMs)}</strong>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="overview-empty">{lapsLoading ? 'Rondes laden...' : 'Nog geen rondes geregistreerd.'}</p>
            )}
          </section>

          <section className="panel overview-system">
            <header className="panel-header">
              <h2>Systeem</h2>
              <Link className="btn btn--sm btn--quiet" to="/admin">
                Naar Beheer
                <Icon name="arrowRight" size={14} />
              </Link>
            </header>
            {systemStatus && (
              <div className={`overview-status overview-status--${systemStatus.tone}`}>
                <span className="system-status__dot" aria-hidden="true" />
                <div>
                  <strong>{systemStatus.tone === 'healthy' ? 'Alles in orde' : systemStatus.title}</strong>
                  <span>{systemStatus.detail}</span>
                </div>
              </div>
            )}
            <dl className="overview-facts">
              <div>
                <dt>Adres voor andere laptops</dt>
                <dd>{host?.url ?? '—'}</dd>
              </div>
              <div>
                <dt>Lopers in de databank</dt>
                <dd>{runners.length}</dd>
              </div>
            </dl>
          </section>
        </div>
      </div>
    </>
  );
}
