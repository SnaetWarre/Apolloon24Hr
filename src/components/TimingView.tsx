import React from 'react';
import { Link } from '@tanstack/react-router';
import { isModalDialogOpen, ModalDialog } from './ModalDialog';
import { useConfirm } from './ConfirmDialog';
import { useAppActions, useAppData, useClusterStatus, useRaceHistory } from '../app/index';
import { formatClockTimeMs, formatDurationMs, nowMs } from '../lib/time';
import { getNextWaitingRunner } from '../lib/runners';
import type { LiveAppSnapshot, Runner } from '../types';
import { LabelBadge } from './LabelBadge';
import { RunnerName } from './RunnerName';
import { PageHeader } from './PageHeader';
import { forgetLapStart, rememberLapStart, timePress } from '../lib/pressTiming';
import { LIVE_MILLISECOND_INTERVAL_MS, useClockTick } from '../lib/useClockTick';

const selectTimingData = ({ runners, race }: LiveAppSnapshot) => ({ runners, race });

export function TimingView() {
  const { runners, race } = useAppData(selectTimingData);
  const {
    laps,
    loading: historyLoading,
    error: historyError,
    refresh: refreshHistory,
  } = useRaceHistory({ scope: 'recent', limit: 10 });
  const {
    laps: activeRunnerLaps,
    loading: runnerHistoryLoading,
    error: runnerHistoryError,
  } = useRaceHistory({ scope: 'runner', runnerId: race.activeRunnerId || '' });
  const { cluster } = useClusterStatus();
  const { handoff, startNext, undoLastHandoff, finishRace } = useAppActions();
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [handoffBusy, setHandoffBusy] = React.useState(false);
  const [lastAction, setLastAction] = React.useState<string | null>(null);
  const [finishConfirmStep, setFinishConfirmStep] = React.useState<0 | 1 | 2>(0);
  const handoffBusyRef = React.useRef(false);
  const confirm = useConfirm();
  // Laps are recorded on the primary; another laptop can time while it reaches the primary.
  const timingBlocked = cluster?.role === 'standby' && !cluster.primary?.reachable;

  const activeRunner = runners.find((runner) => runner.id === race.activeRunnerId) || null;
  const nextRunner = getNextWaitingRunner(runners);
  const recentLaps = laps.slice(0, 10);
  const upcomingRunners = runners
    .filter((runner) => runner.status === 'waiting')
    .sort((first, second) => (first.queueIndex ?? 0) - (second.queueIndex ?? 0))
    .slice(0, 5);
  const activePreviousLap = activeRunner
    ? activeRunnerLaps.find((lap) => lap.runnerId === activeRunner.id) || null
    : null;

  const runExclusiveRaceAction = React.useCallback(
    async (action: () => Promise<unknown>, successMessage: string | null): Promise<boolean> => {
      if (handoffBusyRef.current) return false;
      handoffBusyRef.current = true;
      setHandoffBusy(true);
      setActionError(null);
      setLastAction(null);
      try {
        await action();
        if (successMessage) setLastAction(successMessage);
        return true;
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Timing actie mislukt');
        return false;
      } finally {
        handoffBusyRef.current = false;
        setHandoffBusy(false);
      }
    },
    []
  );

  const runHandoff = React.useCallback(
    async (eventTime: number) => {
      if (timingBlocked || finishConfirmStep > 0 || (!activeRunner && !nextRunner)) return;
      if (race.raceFinishedAt) {
        const resume = await confirm({
          title: 'Race hervatten?',
          message: 'De race is afgesloten. Hervatten start de volgende loper.',
          confirmLabel: 'Race hervatten',
          tone: 'danger',
        });
        if (!resume) return;
        // The lap starts at the confirmation, not at the press that opened it.
        eventTime = performance.now();
      }
      const press = timePress(eventTime, race.activeStartedAt);
      await runExclusiveRaceAction(async () => {
        const handoffResult = await (activeRunner ? handoff(press) : startNext(press));
        if (handoffResult.startedRunnerId) rememberLapStart(press, eventTime);
        else forgetLapStart();
        setLastAction(
          handoffResult.lapId
            ? handoffResult.startedRunnerId
              ? 'Ronde opgeslagen. Volgende loper gestart.'
              : 'Ronde opgeslagen. Niemand actief; de wachtrij is leeg.'
            : 'Loper gestart.'
        );
      }, null);
    },
    [
      activeRunner,
      nextRunner,
      finishConfirmStep,
      race.raceFinishedAt,
      race.activeStartedAt,
      confirm,
      handoff,
      runExclusiveRaceAction,
      startNext,
      timingBlocked,
    ]
  );

  React.useEffect(() => {
    // Navigation buttons can stay focused when this route opens. In that case,
    // the browser consumes Space as a button press instead of a timing action.
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) activeElement.blur();
  }, []);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        event.defaultPrevented ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        event.isComposing ||
        !isHandoffKey(event) ||
        isTextEntryTarget(target) ||
        finishConfirmStep > 0 ||
        timingBlocked ||
        race.raceFinishedAt ||
        isModalDialogOpen()
      )
        return;
      // Space is the dedicated timing control on this screen, even if a button
      // still has focus. Keep Enter's normal button/link behaviour intact.
      if (event.key === 'Enter' && isInteractiveTarget(target)) return;
      event.preventDefault();
      if (event.repeat || handoffBusy) return;
      void runHandoff(event.timeStamp);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [finishConfirmStep, handoffBusy, runHandoff, timingBlocked, race.raceFinishedAt]);

  async function undo() {
    if (handoffBusyRef.current) return;
    if (
      !(await confirm({
        title: 'Laatste wissel ongedaan maken?',
        message: 'Wachtrij, actieve loper en eventuele ronde gaan terug naar de toestand van vóór de laatste wissel.',
        confirmLabel: 'Ongedaan maken',
        tone: 'danger',
      }))
    )
      return;
    await runExclusiveRaceAction(undoLastHandoff, null);
  }

  async function finish(eventTime: number) {
    const press = timePress(eventTime, race.activeStartedAt);
    const succeeded = await runExclusiveRaceAction(() => finishRace(press), 'Race beëindigd.');
    if (succeeded) forgetLapStart();
    if (succeeded) {
      setFinishConfirmStep(0);
    }
  }

  const waitingCount = runners.filter((runner) => runner.status === 'waiting').length;
  const handoffDisabled = handoffBusy || timingBlocked || (!activeRunner && !nextRunner);
  const handoffLabel = handoffBusy
    ? 'Bezig...'
    : timingBlocked
      ? 'Timing geblokkeerd'
      : race.raceFinishedAt && nextRunner
        ? `Race hervatten met ${shortRunnerName(nextRunner)}`
        : activeRunner
          ? nextRunner
            ? `Klok ${shortRunnerName(activeRunner)} af, start ${shortRunnerName(nextRunner)}`
            : `Klok ${shortRunnerName(activeRunner)} af`
          : nextRunner
            ? `Start ${shortRunnerName(nextRunner)}`
            : 'Geen loper klaar';

  return (
    <>
      <PageHeader title="Timing" meta={<span>Spatie of Enter klokt de huidige loper af en start de volgende.</span>} />

      <div className="timing-workspace">
        <section className={`timing-station${activeRunner ? ' is-running' : ''}`} aria-label="Timing bedienen">
          <span className="timing-station__label">
            {race.raceFinishedAt ? 'Race afgesloten' : activeRunner ? 'Nu op de piste' : 'Nog niemand op de piste'}
          </span>
          <div className="timing-now">
            {activeRunner ? (
              <>
                <RunnerName runner={activeRunner} size="lg" />
                {activeRunner.labels.length > 0 && (
                  <div className="label-list">
                    {activeRunner.labels.map((label) => (
                      <LabelBadge key={label.id} label={label} />
                    ))}
                  </div>
                )}
              </>
            ) : (
              <span className="timing-now__empty">
                {race.raceFinishedAt
                  ? 'Niemand actief'
                  : nextRunner
                    ? 'Klaar om te starten'
                    : 'Wacht op de eerste loper'}
              </span>
            )}
          </div>

          <div className="timing-clock-row">
            {activeRunner && race.activeStartedAt ? (
              <TimingClock startedAt={race.activeStartedAt} />
            ) : (
              <span className="timing-clock timing-clock--idle" aria-hidden="true">
                0:00<small>.0</small>
              </span>
            )}
            <div className="timing-clock-stats">
              <div className="stat-panel">
                <span className="muted-label">Vorige ronde</span>
                <strong>
                  {runnerHistoryError
                    ? 'Niet beschikbaar'
                    : activePreviousLap
                      ? formatDurationMs(activePreviousLap.durationMs)
                      : activeRunner && runnerHistoryLoading
                        ? 'Laden...'
                        : '—'}
                </strong>
              </div>
              <div className="stat-panel">
                <span className="muted-label">Snelste ronde</span>
                <strong>{activeRunner?.bestLapMs ? formatDurationMs(activeRunner.bestLapMs) : '—'}</strong>
              </div>
            </div>
          </div>

          <div className="timing-actions">
            <button
              className="btn btn--primary btn--xl"
              onClick={(event) => void runHandoff(event.timeStamp)}
              disabled={handoffDisabled}
            >
              <span>{handoffLabel}</span>
              {!race.raceFinishedAt && !handoffDisabled && <kbd>Spatie / Enter</kbd>}
            </button>
          </div>

          <div className="timing-feedback">
            {timingBlocked && (
              <div className="warning-banner warning-banner--blocking">
                <span>
                  <strong>De primaire laptop is niet bereikbaar.</strong> Klokken lukt weer zodra die terug is. Is die
                  uitgevallen, neem dan over in <Link to="/admin">Beheer</Link>.
                </span>
              </div>
            )}

            {actionError && (
              <div className="warning-banner warning-banner--blocking" role="alert">
                {actionError}
              </div>
            )}
            {lastAction && (
              <div className="success-banner" role="status">
                {lastAction}
              </div>
            )}
            {!activeRunner && !nextRunner && !race.raceFinishedAt && !timingBlocked && (
              <p className="timing-feedback__hint">Zet in Wachtrij een opgewarmde loper klaar om te starten.</p>
            )}
            {activeRunner && !nextRunner && !race.raceFinishedAt && !timingBlocked && (
              <p className="timing-feedback__hint timing-feedback__hint--warn">
                Niemand klaar in de wachtrij. Na afklokken loopt er niemand op de piste.
              </p>
            )}
            {race.raceFinishedAt && (
              <p className="timing-feedback__hint">
                Race afgesloten. Spatie en Enter doen niets meer; hervat alleen bewust met de knop.
              </p>
            )}
          </div>

          <div className="timing-footer">
            <div className="stat-panel">
              <span className="muted-label">Race gestart</span>
              <strong>{race.raceStartedAt ? formatClockTimeMs(race.raceStartedAt).split('.')[0] : 'Nog niet'}</strong>
            </div>
            <button className="btn timing-undo" onClick={undo} disabled={handoffBusy || timingBlocked}>
              Laatste wissel ongedaan maken
            </button>
          </div>
        </section>
        <aside className="timing-sidebar">
          <section className="panel timing-upcoming" aria-label="Komende lopers">
            <header className="panel-header">
              <h2>Hierna op de piste</h2>
              <span>{waitingCount} klaar</span>
            </header>
            {upcomingRunners.length ? (
              <ol>
                {upcomingRunners.map((runner, index) => (
                  <li key={runner.id}>
                    <span className="queue-position">{index + 1}</span>
                    <RunnerName runner={runner} />
                  </li>
                ))}
              </ol>
            ) : (
              <p className="empty-inline">Niemand klaar. Zet lopers klaar via Wachtrij.</p>
            )}
          </section>
          <section className="panel timing-log">
            <header className="panel-header">
              <h2>Laatste 10 rondes</h2>
            </header>
            {historyError && (
              <div className="warning-banner" role="alert">
                <span>Rondes konden niet worden bijgewerkt.</span>
                <button className="btn btn--sm" onClick={() => void refreshHistory()}>
                  Opnieuw proberen
                </button>
              </div>
            )}
            {recentLaps.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Binnen</th>
                      <th>Loper</th>
                      <th className="num">Ronde</th>
                      <th className="num">Rondetijd</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentLaps.map((lap) => (
                      <tr key={lap.id}>
                        <td>{formatClockTimeMs(lap.finishedAt).split('.')[0]}</td>
                        <td className="cell-runner" title={lap.runnerName}>
                          {lap.runnerNumber && <span className="cell-number">{lap.runnerNumber}</span>}
                          {lap.runnerName}
                        </td>
                        <td className="num">{lap.lapNumber}</td>
                        <td className="num">
                          <strong>{formatDurationMs(lap.durationMs)}</strong>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty-inline">
                {historyLoading
                  ? 'Rondes laden...'
                  : historyError
                    ? 'Rondes niet beschikbaar'
                    : 'Nog geen rondes geregistreerd'}
              </div>
            )}
          </section>
          <section className="danger-zone">
            <h2>Race afsluiten</h2>
            <button
              className="btn btn--danger-outline btn--sm"
              onClick={() => setFinishConfirmStep(1)}
              disabled={handoffBusy || timingBlocked}
            >
              Race beëindigen
            </button>
          </section>
        </aside>
      </div>

      {finishConfirmStep > 0 && (
        <ModalDialog
          label="Race afsluiten"
          onRequestClose={() => {
            if (!handoffBusy) setFinishConfirmStep(0);
          }}
        >
          <div className="confirm-modal confirm-modal--danger">
            {finishConfirmStep === 1 ? (
              <>
                <h3>Race beëindigen?</h3>
                <p>De actieve loper stopt zonder extra ronde. Daarna vraagt de app nog één keer om bevestiging.</p>
                <div className="modal-actions">
                  <button className="btn" onClick={() => setFinishConfirmStep(0)} disabled={handoffBusy}>
                    Annuleer
                  </button>
                  <button className="btn btn--primary" onClick={() => setFinishConfirmStep(2)}>
                    Verder
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3>Definitief afsluiten</h3>
                <p>
                  Bevestig alleen als de race echt afgerond is. Spatie en Enter doen daarna niets meer op dit scherm.
                </p>
                <div className="modal-actions">
                  <button className="btn" onClick={() => setFinishConfirmStep(0)} disabled={handoffBusy}>
                    Annuleer
                  </button>
                  <button
                    className="btn btn--danger"
                    onClick={(event) => void finish(event.timeStamp)}
                    disabled={handoffBusy}
                  >
                    Race definitief beeindigen
                  </button>
                </div>
              </>
            )}
          </div>
        </ModalDialog>
      )}
    </>
  );
}

function TimingClock({ startedAt }: { startedAt: number }) {
  useClockTick(LIVE_MILLISECOND_INTERVAL_MS);
  const [main, fraction = '0'] = formatDurationMs(nowMs() - startedAt).split('.');
  return (
    <span className="timing-clock live-time" role="timer" aria-label="Lopende rondetijd">
      {main}
      <small>.{fraction.slice(0, 1)}</small>
    </span>
  );
}

function isHandoffKey(event: KeyboardEvent) {
  return event.code === 'Space' || event.key === 'Enter';
}

function isInteractiveTarget(target: HTMLElement | null) {
  if (!target) return false;
  return Boolean(target.closest('input, textarea, select, button, a, [contenteditable="true"]'));
}

function isTextEntryTarget(target: HTMLElement | null) {
  if (!target) return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

function shortRunnerName(runner: Runner) {
  const firstName = runner.name.trim().split(/\s+/)[0] || runner.name;
  return runner.runnerNumber ? `${runner.runnerNumber} ${firstName}` : firstName;
}
