import React from 'react';
import { useAppActions, useAppData, useClusterStatus, useRaceHistory } from '../app/index';
import { formatClockTimeMs, formatDurationMs } from '../lib/time';
import { getNextWaitingRunner, runnerLabel } from '../lib/runners';
import type { LiveAppSnapshot, Runner } from '../types';
import { LabelBadge } from './LabelBadge';
import { LiveDuration } from './LiveTime';

const selectTimingData = ({ runners, race }: LiveAppSnapshot) => ({ runners, race });

export function TimingView() {
  const { runners, race } = useAppData(selectTimingData);
  const { laps } = useRaceHistory({ scope: 'recent', limit: 250 });
  const { cluster } = useClusterStatus();
  const { handoff, startNext, undoLastHandoff, finishRace, claimTimingControl } = useAppActions();
  const [message, setMessage] = React.useState<string | null>(null);
  const [handoffBusy, setHandoffBusy] = React.useState(false);
  const [lastAction, setLastAction] = React.useState<string | null>(null);
  const [finishConfirmStep, setFinishConfirmStep] = React.useState<0 | 1 | 2>(0);
  const handoffBusyRef = React.useRef(false);
  const controlledElsewhere = Boolean(
    cluster?.timingControllerHostId &&
      cluster.timingControllerHostId !== cluster.hostId
  );
  const timingControl = cluster?.timingControl ?? null;
  const hasSyncConflict = Boolean(cluster?.conflictCount);
  const timingBlocked = controlledElsewhere || hasSyncConflict;

  const activeRunner = runners.find((runner) => runner.id === race.activeRunnerId) || null;
  const nextRunner = getNextWaitingRunner(runners);
  const recentLaps = laps.slice(0, 10);
  const activePreviousLap = activeRunner ? laps.find((lap) => lap.runnerId === activeRunner.id) || null : null;
  const handoffPreview = buildHandoffPreview(activeRunner, nextRunner);

  const runExclusiveRaceAction = React.useCallback(
    async (action: () => Promise<unknown>, successMessage: string | null): Promise<boolean> => {
      if (handoffBusyRef.current) return false;
      handoffBusyRef.current = true;
      setHandoffBusy(true);
      setMessage(null);
      setLastAction(null);
      try {
        await action();
        if (successMessage) setLastAction(successMessage);
        return true;
      } catch (err) {
        setMessage(err instanceof Error ? err.message : 'Timing actie mislukt');
        return false;
      } finally {
        handoffBusyRef.current = false;
        setHandoffBusy(false);
      }
    },
    []
  );

  const runHandoff = React.useCallback(async () => {
      if (timingBlocked) return;
    const hadActiveRunner = Boolean(activeRunner);
    await runExclusiveRaceAction(
      () => (activeRunner ? handoff() : startNext()),
      hadActiveRunner ? 'Ronde opgeslagen. Volgende loper gestart.' : 'Race gestart. Eerste loper loopt.'
    );
  }, [activeRunner, handoff, runExclusiveRaceAction, startNext, timingBlocked]);

  React.useEffect(() => {
    // Navigation buttons can stay focused when this route opens. In that case,
    // the browser consumes Space as a button press instead of a timing action.
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) activeElement.blur();
  }, []);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key === 'Escape' && finishConfirmStep > 0) {
        event.preventDefault();
        setFinishConfirmStep(0);
        return;
      }
      if (
        !isHandoffKey(event) ||
        isTextEntryTarget(target) ||
        finishConfirmStep > 0 ||
        timingBlocked
      ) return;
      // Space is the dedicated timing control on this screen, even if a button
      // still has focus. Keep Enter's normal button/link behaviour intact.
      if (event.key === 'Enter' && isInteractiveTarget(target)) return;
      event.preventDefault();
      if (event.repeat || handoffBusy) return;
      void runHandoff();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [finishConfirmStep, handoffBusy, runHandoff, timingBlocked]);

  async function undo() {
    if (handoffBusyRef.current) return;
    if (!window.confirm('Laatste handoff ongedaan maken?')) return;
    await runExclusiveRaceAction(undoLastHandoff, null);
  }

  async function finish() {
    const succeeded = await runExclusiveRaceAction(finishRace, 'Race beeindigd.');
    if (succeeded) {
      setFinishConfirmStep(0);
    }
  }

  async function emergencyTakeover() {
    if (
      !timingControl ||
      !controlledElsewhere ||
      (!timingControl.takeoverAllowed && !timingControl.forcedTakeoverAllowed)
    ) return;
    const force = !timingControl.localReplicaCaughtUp;
    if (
      !window.confirm(
        force
          ? 'GEFORCEERDE noodovername: deze laptop is mogelijk niet volledig gesynchroniseerd. Bevestig dat de vorige timinglaptop gestopt is en aanvaard dat de laatste timingacties kunnen ontbreken. Doorgaan?'
          : 'Noodovername timing: bevestig dat de vorige timinglaptop gestopt of definitief losgekoppeld is. Als die laptop verder klokt, ontstaan twee timinggeschiedenissen. Doorgaan?'
      )
    ) {
      return;
    }
    await runExclusiveRaceAction(
      () => claimTimingControl(timingControl.controllerHostId, force),
      force
        ? 'Deze laptop heeft de timing geforceerd overgenomen; controleer de laatste timingacties.'
        : 'Deze laptop heeft de timing overgenomen.'
    );
  }

  return (
    <>
      <div className="hero hero--compact">
        <div>
          <img className="hero-logo" src="/brand/apolloon-logo.png" alt="Apolloon" width={560} height={169} fetchPriority="high" />
          <h1 className="app-title">Telsysteem 2 - Timing</h1>
        </div>
      </div>

      <div className="timing-grid">
        <TimingCard
          title="Huidige loper"
          runner={activeRunner}
          empty="Nog niemand actief"
          accent
          extra={
            activeRunner && race.activeStartedAt ? (
              <LiveDuration startedAt={race.activeStartedAt} className="live-time" />
            ) : null
          }
        />
        <TimingCard title="Volgende loper" runner={nextRunner} empty="Geen loper in wachtrij" />
      </div>

      <div className="handoff-preview">
        <span className="muted-label">Bij volgende spatie/enter</span>
        <strong>{handoffPreview}</strong>
      </div>

      {controlledElsewhere && (
        <div className="warning-banner">
          {timingControl?.state === 'remote-reachable' ? (
            <span>
              De timing wordt bediend op{' '}
              <strong>{timingControl.controllerUrl || 'een andere bereikbare laptop'}</strong>.
              Gebruik die laptop of draag de timing daar gecontroleerd over.
            </span>
          ) : (
            <>
              <span>
                De timinglaptop is niet bereikbaar. Controleer eerst fysiek dat die app gestopt is.
                {timingControl?.takeoverAllowed ? (
                  ' De lokale replica bevat alles tot de laatste geslaagde synchronisatie; een noodovername is nu mogelijk.'
                ) : timingControl?.forcedTakeoverAllowed ? (
                  ' De lokale replica is mogelijk onvolledig. Alleen een geforceerde noodovername is beschikbaar.'
                ) : timingControl?.localReplicaCaughtUp ? (
                  ` Noodovername wordt beschikbaar om ${formatClockTimeMs(
                    timingControl.takeoverAvailableAt || Date.now()
                  )}.`
                ) : (
                  ` De lokale replica is mogelijk onvolledig. Herstel bij voorkeur de verbinding; geforceerde noodovername wordt beschikbaar om ${formatClockTimeMs(
                    timingControl?.forcedTakeoverAvailableAt || Date.now()
                  )}.`
                )}
              </span>
              <button
                className="btn btn--ghost"
                onClick={() => void emergencyTakeover()}
                disabled={
                  handoffBusy ||
                  (!timingControl?.takeoverAllowed && !timingControl?.forcedTakeoverAllowed)
                }
              >
                {timingControl?.forcedTakeoverAllowed
                  ? 'Geforceerde noodovername'
                  : 'Noodovername starten'}
              </button>
            </>
          )}
        </div>
      )}

      {hasSyncConflict && (
        <div className="warning-banner">
          Er zijn twee verschillende timinggeschiedenissen gevonden. Timing is veilig gepauzeerd.
          Kies in Admin welke laptop de correcte geschiedenis bevat.
        </div>
      )}

      <div className="timing-actions">
        <button
          className="btn btn--primary btn--xl"
          onClick={runHandoff}
          disabled={handoffBusy || timingBlocked}
        >
          {handoffBusy ? 'Bezig...' : activeRunner ? 'Spatie/Enter: handoff' : 'Start eerste loper'}
        </button>
        <button
          className="btn btn--ghost"
          onClick={undo}
          disabled={handoffBusy || timingBlocked}
        >
          Undo laatste handoff
        </button>
      </div>

      {message && <div className="warning-banner">{message}</div>}
      {lastAction && <div className="success-banner">{lastAction}</div>}

      <div className="stats-grid">
        <div className="stat-panel">
          <span className="muted-label">Race start</span>
          <strong>{race.raceStartedAt ? formatClockTimeMs(race.raceStartedAt) : 'Nog niet gestart'}</strong>
        </div>
        <div className="stat-panel">
          <span className="muted-label">Vorige ronde huidige loper</span>
          <strong>{activePreviousLap ? formatDurationMs(activePreviousLap.durationMs) : 'Geen vorige ronde'}</strong>
        </div>
        <div className="stat-panel">
          <span className="muted-label">Wachtrij</span>
          <strong>{runners.filter((runner) => runner.status === 'waiting').length} lopers klaar</strong>
        </div>
      </div>

      <section className="panel">
        <h2>Laatste 10 rondes</h2>
        {recentLaps.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tijd</th>
                  <th>Nr.</th>
                  <th>Naam</th>
                  <th>Ronde</th>
                  <th>Rondetijd</th>
                </tr>
              </thead>
              <tbody>
                {recentLaps.map((lap) => (
                  <tr key={lap.id}>
                    <td>{formatClockTimeMs(lap.finishedAt)}</td>
                    <td>{lap.runnerNumber || '-'}</td>
                    <td>{lap.runnerName}</td>
                    <td>{lap.lapNumber}</td>
                    <td>{formatDurationMs(lap.durationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-inline">Nog geen rondes geregistreerd</div>
        )}
      </section>

      <section className="danger-zone">
        <h2>Race afsluiten</h2>
        <button
          className="btn btn--danger"
          onClick={() => setFinishConfirmStep(1)}
          disabled={handoffBusy || timingBlocked}
        >
          Race beeindigen
        </button>
      </section>

      {finishConfirmStep > 0 && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="confirm-modal finish-confirm">
            {finishConfirmStep === 1 ? (
              <>
                <h3>Race beeindigen?</h3>
                <p>Dit stopt de actieve loper zonder extra ronde.</p>
                <div className="modal-actions">
                  <button className="btn btn--ghost" onClick={() => setFinishConfirmStep(0)}>
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
                <p>Bevestig alleen als de race echt afgerond is.</p>
                <div className="modal-actions">
                  <button className="btn btn--ghost" onClick={() => setFinishConfirmStep(0)}>
                    Annuleer
                  </button>
                  <button className="btn btn--danger" onClick={finish} disabled={handoffBusy}>
                    Race definitief beeindigen
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
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

function TimingCard({
  title,
  runner,
  empty,
  accent,
  extra,
}: {
  title: string;
  runner: Runner | null;
  empty: string;
  accent?: boolean;
  extra?: React.ReactNode;
}) {
  return (
    <section className={`timing-card${accent ? ' timing-card--accent' : ''}`}>
      <span className="muted-label">{title}</span>
      {runner ? (
        <>
          <strong>
            {runner.runnerNumber && <span>{runner.runnerNumber} - </span>}
            {runner.name}
          </strong>
          <div className="display-labels">
            {runner.labels.map((label) => (
              <LabelBadge key={label.id} label={label} />
            ))}
          </div>
          {extra}
        </>
      ) : (
        <strong>{empty}</strong>
      )}
    </section>
  );
}

function buildHandoffPreview(activeRunner: Runner | null, nextRunner: Runner | null) {
  if (activeRunner && nextRunner) {
    return `${runnerLabel(activeRunner)} wordt afgeklokt -> ${runnerLabel(nextRunner)} start`;
  }
  if (!activeRunner && nextRunner) {
    return `${runnerLabel(nextRunner)} start`;
  }
  if (activeRunner && !nextRunner) {
    return 'Huidige loper wordt afgeklokt; geen volgende loper klaar';
  }
  return 'Geen loper klaar in de wachtrij';
}
