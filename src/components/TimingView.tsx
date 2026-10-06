import { LiveDot } from './LiveDot';
import React from 'react';
import { Link } from '@tanstack/react-router';
import { isModalDialogOpen, ModalDialog } from './ModalDialog';
import { useConfirm } from './ConfirmDialog';
import { useAppActions, useAppData, useClusterStatus, useRaceHistory } from '../app/index';
import { formatClockTimeMs, formatDurationMs } from '../lib/time';
import type { LiveAppSnapshot, Runner } from '../types';
import { LabelBadge } from './LabelBadge';
import { RunnerName } from './RunnerName';
import { PageHeader } from './PageHeader';
import { useArrivals, usePulse } from '../lib/motion';
import { forgetLapStart, rememberLapStart, timePress, tooShortLapMs, type PressTime } from '../lib/pressTiming';
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
  const { cluster } = useClusterStatus();
  const { handoff, startNext, undoLastHandoff, finishRace } = useAppActions();
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [handoffBusy, setHandoffBusy] = React.useState(false);
  const [lastAction, setLastAction] = React.useState<string | null>(null);
  const [finishConfirmStep, setFinishConfirmStep] = React.useState<0 | 1 | 2>(0);
  // The first "Race beëindigen" click stops the clock; the confirmations only decide whether it counts.
  const [finishStop, setFinishStop] = React.useState<{ press: PressTime; activeStartedAt: number | null } | null>(null);
  // The screen shows a handoff the moment it is pressed; the server's answer then confirms it.
  const [pressedHandoff, setPressedHandoff] = React.useState<{
    fromStartedAt: number | null;
    runnerId: string | null;
    startedAt: number;
  } | null>(null);
  const handoffBusyRef = React.useRef(false);
  // A question can stay open while another laptop clocks; its answer then belongs to an old lap.
  const activeStartedAtRef = React.useRef(race.activeStartedAt);
  React.useEffect(() => {
    activeStartedAtRef.current = race.activeStartedAt;
  });
  const confirm = useConfirm();
  // A press flashes the key, also when it came from the keyboard.
  const [pressed, flashPress] = usePulse(240);
  // While the laptops choose who orders the changes a press waits and then counts; without a majority nothing is saved.
  const timingBlocked = cluster?.state === 'no-majority';

  const activeRunner = runners.find((runner) => runner.id === race.activeRunnerId) || null;
  const waitingRunners = runners
    .filter((runner) => runner.status === 'waiting')
    .sort((first, second) => (first.queueIndex ?? 0) - (second.queueIndex ?? 0));
  const nextRunner = waitingRunners[0] ?? null;
  const recentLaps = laps.slice(0, 10);
  const runExclusiveRaceAction = React.useCallback(
    async (action: () => Promise<unknown>, successMessage: string | null): Promise<boolean> => {
      if (handoffBusyRef.current) return false;
      handoffBusyRef.current = true;
      setHandoffBusy(true);
      setActionError(null);
      // The previous confirmation stays until this one lands, so the line under the button never blinks.
      try {
        await action();
        if (successMessage) setLastAction(successMessage);
        return true;
      } catch (err) {
        setLastAction(null);
        setActionError(err instanceof Error ? err.message : 'Timing actie mislukt');
        return false;
      } finally {
        handoffBusyRef.current = false;
        setHandoffBusy(false);
      }
    },
    []
  );

  async function runHandoff(eventTime: number) {
    if (handoffBusyRef.current || timingBlocked || finishConfirmStep > 0 || (!activeRunner && !nextRunner)) return;
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
    const shortLapMs = tooShortLapMs(press, race.activeStartedAt);
    if (activeRunner && shortLapMs !== null) {
      const seconds = (shortLapMs / 1000).toLocaleString('nl-BE', { maximumFractionDigits: 1 });
      const count = await confirm({
        title: 'Toch afklokken?',
        message: `${shortRunnerName(activeRunner)} is pas ${seconds} s onderweg. Dubbel gedrukt? Kies Annuleer.`,
        confirmLabel: 'Toch afklokken',
        tone: 'danger',
      });
      if (!count) return;
      // The lap still ends at the press, not at the answer, unless another laptop clocked in between.
      if (activeStartedAtRef.current !== race.activeStartedAt) {
        setActionError('De loper is intussen gewisseld. Druk opnieuw.');
        return;
      }
    }
    setPressedHandoff({
      fromStartedAt: race.activeStartedAt,
      runnerId: nextRunner?.id ?? null,
      startedAt: press.pressedAt,
    });
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
    setPressedHandoff(null);
  }

  // A press in flight never disables the button: it would fade on every handoff. Presses meanwhile are ignored.
  const handoffDisabled = timingBlocked || (!activeRunner && !nextRunner);

  React.useEffect(() => {
    // Navigation buttons can stay focused when this route opens. In that case,
    // the browser consumes Space as a button press instead of a timing action.
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) activeElement.blur();
  }, []);

  const onHandoffKey = React.useEffectEvent((event: KeyboardEvent) => {
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
    if (event.repeat || handoffBusyRef.current || handoffDisabled) return;
    flashPress();
    void runHandoff(event.timeStamp);
  });

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => onHandoffKey(event);
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

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
    await runExclusiveRaceAction(undoLastHandoff, 'Laatste wissel ongedaan gemaakt.');
  }

  function startFinish(eventTime: number) {
    if (handoffBusyRef.current) return;
    setFinishStop({ press: timePress(eventTime, race.activeStartedAt), activeStartedAt: race.activeStartedAt });
    setFinishConfirmStep(1);
  }

  function cancelFinish() {
    setFinishStop(null);
    setFinishConfirmStep(0);
  }

  async function finish() {
    if (!finishPress) {
      // Another laptop changed the runner while this dialog was open; the stopped time belongs to someone else.
      cancelFinish();
      setActionError('De loper is intussen gewisseld. Beëindig de race opnieuw.');
      return;
    }
    const succeeded = await runExclusiveRaceAction(() => finishRace(finishPress), 'Race beëindigd.');
    if (succeeded) {
      forgetLapStart();
      cancelFinish();
    }
  }

  const finishPress = finishStop?.activeStartedAt === race.activeStartedAt ? finishStop.press : null;
  // Until the server answers a press, show the runner it started; its answer carries the same start time.
  const pending = handoffBusy && pressedHandoff?.fromStartedAt === race.activeStartedAt ? pressedHandoff : null;
  const shownRunner = pending ? (runners.find((runner) => runner.id === pending.runnerId) ?? null) : activeRunner;
  const shownStartedAt = pending ? (pending.runnerId ? pending.startedAt : null) : race.activeStartedAt;
  const shownQueue = pending ? waitingRunners.filter((runner) => runner.id !== pending.runnerId) : waitingRunners;
  const shownNext = shownQueue[0] ?? null;
  const upcomingRunners = shownQueue.slice(0, 5);
  const previousLapText = shownRunner?.lastLapMs ? formatDurationMs(shownRunner.lastLapMs) : '—';
  const bestLapText = shownRunner?.bestLapMs ? formatDurationMs(shownRunner.bestLapMs) : '—';
  const activeKey = shownRunner?.id ?? 'none';
  const startKey = shownStartedAt ?? 0;

  // What changed after this screen opened moves briefly.
  const changed = useArrivals([
    `active:${activeKey}`,
    `start:${startKey}`,
    `prev:${previousLapText}`,
    `best:${bestLapText}`,
  ]);
  const newLapIds = useArrivals(
    recentLaps.map((lap) => lap.id),
    !historyLoading
  );
  const newUpcomingIds = useArrivals(upcomingRunners.map((runner) => runner.id));

  const waitingCount = shownQueue.length;
  const handoffLabel = timingBlocked
    ? 'Timing geblokkeerd'
    : race.raceFinishedAt && !pending && nextRunner
      ? `Race hervatten met ${shortRunnerName(nextRunner)}`
      : shownRunner
        ? shownNext
          ? `Klok ${shortRunnerName(shownRunner)} af, start ${shortRunnerName(shownNext)}`
          : `Klok ${shortRunnerName(shownRunner)} af`
        : shownNext
          ? `Start ${shortRunnerName(shownNext)}`
          : 'Geen loper klaar';
  const finished = Boolean(race.raceFinishedAt) && !pending;

  return (
    <>
      <PageHeader title="Timing" meta={<span>Spatie of Enter klokt de huidige loper af en start de volgende.</span>} />

      <div className="timing-workspace">
        <section className={`timing-station${shownRunner ? ' is-running' : ''}`} aria-label="Timing bedienen">
          <span className="timing-station__label">
            {shownRunner && <LiveDot />}
            {finished ? 'Race afgesloten' : shownRunner ? 'Nu op de piste' : 'Nog niemand op de piste'}
          </span>
          <div key={activeKey} className={`timing-now${changed.has(`active:${activeKey}`) ? ' rise-in' : ''}`}>
            {shownRunner ? (
              <>
                <RunnerName runner={shownRunner} size="lg" />
                {shownRunner.labels.length > 0 && (
                  <div className="label-list">
                    {shownRunner.labels.map((label) => (
                      <LabelBadge key={label.id} label={label} />
                    ))}
                  </div>
                )}
              </>
            ) : (
              <span className="timing-now__empty">
                {finished ? 'Niemand actief' : shownNext ? 'Klaar om te starten' : 'Wacht op de eerste loper'}
              </span>
            )}
          </div>

          <div className="timing-clock-row">
            {shownRunner && shownStartedAt ? (
              <TimingClock
                key={startKey}
                startedAt={shownStartedAt}
                stoppedAt={finishPress?.pressedAt ?? null}
                arrived={changed.has(`start:${startKey}`)}
              />
            ) : (
              <span className="timing-clock timing-clock--idle" aria-hidden="true">
                0:00<small>.0</small>
              </span>
            )}
            <div className="timing-clock-stats">
              <div className="stat-panel">
                <span className="muted-label">Vorige ronde</span>
                <strong
                  key={previousLapText}
                  className={changed.has(`prev:${previousLapText}`) ? 'value-tick' : undefined}
                >
                  {previousLapText}
                </strong>
              </div>
              <div className="stat-panel">
                <span className="muted-label">Snelste ronde</span>
                <strong key={bestLapText} className={changed.has(`best:${bestLapText}`) ? 'value-tick' : undefined}>
                  {bestLapText}
                </strong>
              </div>
            </div>
          </div>

          <div className="timing-actions">
            <button
              className={`btn btn--primary btn--xl${pressed ? ' is-pressed' : ''}`}
              onClick={(event) => {
                if (handoffBusyRef.current) return;
                flashPress();
                void runHandoff(event.timeStamp);
              }}
              disabled={handoffDisabled}
              aria-busy={handoffBusy}
            >
              <span>{handoffLabel}</span>
              {!finished && !handoffDisabled && <kbd>Spatie / Enter</kbd>}
            </button>
          </div>

          <div className="timing-feedback">
            {timingBlocked && (
              <div className="warning-banner warning-banner--blocking">
                <span>
                  <strong>Timing staat stil.</strong> Klokken lukt weer zodra een tweede laptop terug is. Zijn de andere
                  laptops echt kapot, ga dan alleen verder in <Link to="/admin">Beheer</Link>.
                </span>
              </div>
            )}

            {actionError && (
              <div className="warning-banner warning-banner--blocking" role="alert">
                {actionError}
              </div>
            )}
            {pending ? (
              // Only shows when the laptops take a moment to answer; a normal press is confirmed before it fades in.
              <p className="timing-feedback__hint timing-feedback__saving" role="status">
                Wissel wordt opgeslagen…
              </p>
            ) : (
              lastAction && (
                <div key={startKey} className="success-banner" role="status">
                  {lastAction}
                </div>
              )
            )}
            {!shownRunner && !shownNext && !finished && !timingBlocked && (
              <p className="timing-feedback__hint">Zet in Wachtrij een opgewarmde loper klaar om te starten.</p>
            )}
            {shownRunner && !shownNext && !finished && !timingBlocked && (
              <p className="timing-feedback__hint timing-feedback__hint--warn">
                Niemand klaar in de wachtrij. Na afklokken loopt er niemand op de piste.
              </p>
            )}
            {finished && (
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
            <button className="btn timing-undo" onClick={undo} disabled={timingBlocked || Boolean(race.raceFinishedAt)}>
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
                  <li key={runner.id} className={newUpcomingIds.has(runner.id) ? 'is-new' : undefined}>
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
                      <tr key={lap.id} className={newLapIds.has(lap.id) ? 'is-new' : undefined}>
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
              onClick={(event) => startFinish(event.timeStamp)}
              disabled={timingBlocked}
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
            if (!handoffBusy) cancelFinish();
          }}
        >
          <div className="confirm-modal confirm-modal--danger">
            {finishConfirmStep === 1 ? (
              <>
                <h3>Race beëindigen?</h3>
                <p>
                  {activeRunner && race.activeStartedAt && finishPress
                    ? `De klok van ${shortRunnerName(activeRunner)} staat stil op ${formatDurationMs(Math.max(0, finishPress.pressedAt - race.activeStartedAt))}. `
                    : ''}
                  De actieve loper stopt zonder extra ronde. Bij annuleren loopt de klok gewoon verder. Daarna vraagt de
                  app nog één keer om bevestiging.
                </p>
                <div className="modal-actions">
                  <button className="btn" onClick={cancelFinish} disabled={handoffBusy}>
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
                  <button className="btn" onClick={cancelFinish} disabled={handoffBusy}>
                    Annuleer
                  </button>
                  <button className="btn btn--danger" onClick={() => void finish()} disabled={handoffBusy}>
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

function TimingClock({
  startedAt,
  stoppedAt,
  arrived,
}: {
  startedAt: number;
  stoppedAt: number | null;
  arrived: boolean;
}) {
  const now = useClockTick(LIVE_MILLISECOND_INTERVAL_MS, stoppedAt === null);
  const [main, fraction = '0'] = formatDurationMs(Math.max(0, (stoppedAt ?? now) - startedAt)).split('.');
  return (
    <span
      className={`timing-clock live-time${arrived ? ' value-tick' : ''}`}
      role="timer"
      aria-label="Lopende rondetijd"
    >
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
