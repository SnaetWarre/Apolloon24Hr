import React from 'react';
import { useAppActions, useAppData, useRaceHistory } from '../app/index';
import { formatClockTimeMs, formatDurationMs } from '../lib/time';
import { labelKindOrder, labelKindTitle } from './LabelBadge';
import type { Label, LiveAppSnapshot, Runner, RunnerStatus } from '../types';
import { LiveElapsed } from './LiveTime';

const selectRunnerProfileData = ({ runners, labels, temporaryTeams }: LiveAppSnapshot) => ({
  runners,
  labels,
  temporaryTeams,
});

export function RunnerProfileModal({ runnerId, onClose }: { runnerId: string; onClose: () => void }) {
  const { runners, labels, temporaryTeams } = useAppData(selectRunnerProfileData);
  const { laps: allLaps } = useRaceHistory({ scope: 'runner', runnerId });
  const { setStatus, updateRunner } = useAppActions();
  const runner = runners.find((item) => item.id === runnerId);
  const [runnerNumber, setRunnerNumber] = React.useState('');
  const [name, setName] = React.useState('');
  const [targetLaps, setTargetLaps] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [selectedLabels, setSelectedLabels] = React.useState<string[]>([]);
  const [closePromptOpen, setClosePromptOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [queueActionBusy, setQueueActionBusy] = React.useState(false);
  const [queueActionMessage, setQueueActionMessage] = React.useState<string | null>(null);
  const [queueActionError, setQueueActionError] = React.useState<string | null>(null);
  const [draftBaseline, setDraftBaseline] = React.useState(runner);
  const editableRunnerKey = runner ? getEditableRunnerKey(runner) : '';
  const dirty = draftBaseline
    ? isDirty({ runner: draftBaseline, runnerNumber, name, targetLaps, notes, selectedLabels })
    : false;
  const profileChangedElsewhere = Boolean(
    runner && draftBaseline && runner.id === draftBaseline.id &&
    editableRunnerKey !== getEditableRunnerKey(draftBaseline)
  );
  const initializedRunnerId = React.useRef<string | null>(null);
  const activeTemporaryTeam = temporaryTeams.find(
    (team) => team.active && team.memberRunnerIds.includes(runnerId)
  );

  function loadLatestProfile() {
    if (!runner) return;
    initializedRunnerId.current = runner.id;
    setDraftBaseline(runner);
    setRunnerNumber(runner.runnerNumber || '');
    setName(runner.name);
    setTargetLaps(runner.targetLaps?.toString() || '');
    setNotes(runner.notes || '');
    setSelectedLabels(runner.labels.map((label) => label.id));
  }

  React.useEffect(() => {
    // Refresh untouched profiles, but never replace an operator's unsaved draft.
    if (initializedRunnerId.current !== runnerId || !dirty) loadLatestProfile();
  }, [editableRunnerKey]);

  React.useEffect(() => {
    setQueueActionMessage(null);
    setQueueActionError(null);
    setQueueActionBusy(false);
    setSaveError(null);
  }, [runnerId]);

  const laps = React.useMemo(() => allLaps.filter((lap) => lap.runnerId === runnerId), [allLaps, runnerId]);

  async function saveAndClose() {
    if (saving || profileChangedElsewhere) return;
    setSaving(true);
    setSaveError(null);
    try {
      await updateRunner(runnerId, {
        runnerNumber,
        name,
        targetLaps: targetLaps ? Number(targetLaps) : null,
        notes,
        labels: selectedLabels,
      });
      onClose();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Profiel opslaan mislukt');
    } finally {
      setSaving(false);
    }
  }

  function requestClose() {
    if (dirty) {
      setClosePromptOpen(true);
      return;
    }
    onClose();
  }

  React.useEffect(() => {
    if (!runner) return undefined;

    function handleDocumentKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (closePromptOpen) {
        setClosePromptOpen(false);
        return;
      }
      requestClose();
    }

    document.addEventListener('keydown', handleDocumentKeyDown);
    return () => document.removeEventListener('keydown', handleDocumentKeyDown);
  }, [closePromptOpen, dirty, runner]);

  function toggleLabel(labelId: string) {
    const label = labels.find((item) => item.id === labelId);
    if (!label || label.kind === 'temporary_team') return;
    setSelectedLabels((current) => {
      if (current.includes(labelId)) return current.filter((id) => id !== labelId);
      if (label.kind === 'speedteam') {
        return [...current.filter((id) => labels.find((item) => item.id === id)?.kind !== 'speedteam'), labelId];
      }
      return [...current, labelId];
    });
  }

  async function removeFromQueueFlow() {
    if (!runner || !isQueueRemovalStatus(runner.status)) return;
    if (!window.confirm('Loper terug buiten Telsysteem 1 zetten?')) return;

    const runnerName = runner.name;
    setQueueActionBusy(true);
    setQueueActionMessage(null);
    setQueueActionError(null);
    try {
      await setStatus(runner.id, 'registered');
      setQueueActionMessage(`${runnerName} staat terug buiten Telsysteem 1.`);
    } catch (err) {
      setQueueActionError(err instanceof Error ? err.message : 'Loper terugzetten mislukt');
    } finally {
      setQueueActionBusy(false);
    }
  }

  if (!runner) return null;

  const latestLap = laps[0] || null;
  const statusSummary = runnerStatusSummary(runner.status);
  const recentLaps = laps.slice(0, 10);
  const queueRemovalLabel = queueRemovalButtonLabel(runner.status);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modal-header">
          <div>
            <span className="modal-kicker">Lopersprofiel</span>
            <h2>{runnerTitle(runner)}</h2>
            <p>
              {runner.lapCount} toeren
              {runner.bestLapMs ? ` · snelste ${formatDurationMs(runner.bestLapMs)}` : ''}
              {runner.averageLapMs ? ` · gemiddeld ${formatDurationMs(runner.averageLapMs)}` : ''}
            </p>
          </div>
          <button className="icon-btn" onClick={requestClose} aria-label="Sluiten">
            x
          </button>
        </div>

        <div className="profile-stats">
          <div className="profile-stat">
            <span className="muted-label">{statusSummary.title}</span>
            <strong>
              {statusSummary.showsElapsed && runner.statusSince
                ? <LiveElapsed startedAt={runner.statusSince} prefix="voor " />
                : '—'}
            </strong>
          </div>
          <div className="profile-stat">
            <span className="muted-label">Totaal toeren</span>
            <strong>{runner.lapCount}</strong>
          </div>
          <div className="profile-stat">
            <span className="muted-label">Laatste ronde</span>
            <strong>{latestLap ? formatDurationMs(latestLap.durationMs) : 'Nog geen ronde'}</strong>
          </div>
        </div>

        <section className="profile-laps">
          <h3>Laatste rondes</h3>
          {recentLaps.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Ronde</th>
                    <th>Tijd</th>
                    <th>Rondetijd</th>
                  </tr>
                </thead>
                <tbody>
                  {recentLaps.map((lap) => (
                    <tr key={lap.id}>
                      <td>{lap.lapNumber}</td>
                      <td>{formatClockTimeMs(lap.finishedAt)}</td>
                      <td>{formatDurationMs(lap.durationMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-inline">Nog geen rondes geregistreerd.</div>
          )}
        </section>

        <div className="form-grid">
          <label>
            Lopersnummer
            <input className="input" value={runnerNumber} onChange={(event) => setRunnerNumber(event.target.value)} />
          </label>
          <label>
            Naam
            <input className="input" value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            Doelstelling toeren
            <input
              className="input"
              type="number"
              min="0"
              value={targetLaps}
              onChange={(event) => setTargetLaps(event.target.value)}
            />
          </label>
        </div>

        <div className="label-picker-groups">
          {activeTemporaryTeam && (
            <div className="host-hint">
              De speedteamploeg wordt beheerd door de actieve tijdelijke nachtploeg en kan hier niet gewijzigd worden.
            </div>
          )}
          {groupLabels(labels).map(([kind, groupedLabels]) => (
            <section key={kind} className="label-picker-group">
              <h3>{labelKindTitle(kind)}</h3>
              <div className="label-picker">
                {groupedLabels.map((label) => (
                  <label key={label.id} className="check-pill">
                    <input
                      type="checkbox"
                      checked={selectedLabels.includes(label.id)}
                      disabled={label.kind === 'temporary_team' || (Boolean(activeTemporaryTeam) && label.kind === 'speedteam')}
                      onChange={() => toggleLabel(label.id)}
                    />
                    <span style={{ borderColor: label.color }}>
                      {label.imageUrl ? (
                        <img src={label.imageUrl} alt="" className="label-image" />
                      ) : (
                        <i className="label-dot" style={{ background: label.color }} />
                      )}
                      {label.name}
                    </span>
                  </label>
                ))}
              </div>
            </section>
          ))}
        </div>

        <label className="stacked-label">
          Notities
          <textarea className="input textarea" value={notes} onChange={(event) => setNotes(event.target.value)} />
        </label>

        {queueRemovalLabel && (
          <section className="profile-queue-action">
            <div>
              <h3>Telsysteem 1</h3>
              <p>Haal deze loper uit de actieve lijst zonder profiel of rondedata te verwijderen.</p>
            </div>
            <button className="btn btn--ghost" onClick={removeFromQueueFlow} disabled={queueActionBusy}>
              {queueActionBusy ? 'Bezig...' : queueRemovalLabel}
            </button>
          </section>
        )}

        {queueActionMessage && <div className="success-banner">{queueActionMessage}</div>}
        {queueActionError && <div className="warning-banner">{queueActionError}</div>}
        {profileChangedElsewhere && (
          <div className="warning-banner" role="alert">
            Dit profiel is intussen elders gewijzigd. Je invoer is bewaard. Kopieer je aanpassingen voordat je de nieuwste versie laadt en opnieuw bewerkt.
            <button className="btn btn--ghost" onClick={() => {
              if (window.confirm('Nieuwste profiel laden? Je niet-opgeslagen aanpassingen worden vervangen.')) {
                loadLatestProfile();
                setClosePromptOpen(false);
              }
            }}>Nieuwste profiel laden</button>
          </div>
        )}
        {saveError && <div className="warning-banner">{saveError}</div>}

        <div className="modal-actions">
          <button className="btn btn--ghost" onClick={requestClose}>
            Annuleer
          </button>
          <button className="btn btn--primary" onClick={saveAndClose} disabled={saving || profileChangedElsewhere}>
            {saving ? 'Opslaan...' : 'Opslaan'}
          </button>
        </div>

        {closePromptOpen && (
          <div className="nested-modal-backdrop" role="dialog" aria-modal="true">
            <div className="confirm-modal">
              <h3>Wijzigingen opslaan?</h3>
              <p>Er zijn aanpassingen aan dit lopersprofiel.</p>
              <div className="modal-actions">
                <button className="btn btn--ghost" onClick={() => setClosePromptOpen(false)}>
                  Verder bewerken
                </button>
                <button className="btn btn--ghost" onClick={onClose}>
                  Niet opslaan
                </button>
                <button className="btn btn--primary" onClick={saveAndClose} disabled={saving || profileChangedElsewhere}>
                  {saving ? 'Opslaan...' : 'Opslaan'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function isQueueRemovalStatus(status: RunnerStatus) {
  return status === 'warming_up' || status === 'waiting';
}

function queueRemovalButtonLabel(status: RunnerStatus) {
  if (status === 'warming_up') return 'Uit opwarmen halen';
  if (status === 'waiting') return 'Uit wachtrij halen';
  return null;
}

function runnerTitle(runner: Pick<Runner, 'runnerNumber' | 'name'>) {
  return runner.runnerNumber ? `${runner.runnerNumber} - ${runner.name}` : runner.name;
}

function isDirty({
  runner,
  runnerNumber,
  name,
  targetLaps,
  notes,
  selectedLabels,
}: {
  runner: Runner;
  runnerNumber: string;
  name: string;
  targetLaps: string;
  notes: string;
  selectedLabels: string[];
}) {
  const currentLabels = runner.labels.map((label) => label.id).sort().join('|');
  const nextLabels = [...selectedLabels].sort().join('|');
  return (
    runnerNumber.trim() !== (runner.runnerNumber || '') ||
    name.trim() !== runner.name ||
    targetLaps.trim() !== (runner.targetLaps?.toString() || '') ||
    notes !== (runner.notes || '') ||
    currentLabels !== nextLabels
  );
}

function getEditableRunnerKey(runner: Runner) {
  return [
    runner.id,
    runner.runnerNumber || '',
    runner.name,
    runner.targetLaps ?? '',
    runner.notes || '',
    runner.labels.map((label) => label.id).sort().join('|'),
  ].join('\u0001');
}

function runnerStatusSummary(status: RunnerStatus) {
  const showsElapsed = !['registered', 'ran'].includes(status);
  switch (status) {
    case 'registered':
      return { title: 'Ingeschreven', showsElapsed };
    case 'warming_up':
      return { title: 'Aan het opwarmen', showsElapsed };
    case 'waiting':
      return { title: 'In de wachtrij', showsElapsed };
    case 'running':
      return { title: 'Loopt nu', showsElapsed };
    case 'ran':
      return { title: 'Heeft gelopen', showsElapsed };
    default:
      return { title: status, showsElapsed };
  }
}

function groupLabels(labels: Label[]) {
  const grouped = new Map<string, typeof labels>();
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
