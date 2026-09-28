import React from 'react';
import { ModalDialog } from './ModalDialog';
import { useConfirm } from './ConfirmDialog';
import { runnerFormError } from '../lib/runnerForm';
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
  const confirm = useConfirm();
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
    const validationError = runnerFormError(name, targetLaps);
    if (validationError) {
      setSaveError(validationError);
      return;
    }
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
    if (saving) return;
    if (dirty) {
      setClosePromptOpen(true);
      return;
    }
    onClose();
  }

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
    if (!(await confirm({
      title: 'Uit de wachtrij halen?',
      message: `${runner.name} verdwijnt uit de wachtrij en opwarming.`,
      confirmLabel: 'Uit wachtrij halen',
    }))) return;

    const runnerName = runner.name;
    setQueueActionBusy(true);
    setQueueActionMessage(null);
    setQueueActionError(null);
    try {
      await setStatus(runner.id, 'registered');
      setQueueActionMessage(`${runnerName} staat niet meer in de wachtrij of opwarming.`);
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
    <ModalDialog label="Lopersprofiel" onRequestClose={requestClose} closeOnBackdrop>
      <div className="modal modal--runner-profile">
        <div className="modal-header">
          <div>
            <span className="modal-kicker">Lopersprofiel</span>
            <h2>{runnerTitle(runner)}</h2>
          </div>
          <button className="icon-btn" onClick={requestClose} aria-label="Sluiten">
            ✕
          </button>
        </div>

        <section className="profile-essentials" aria-label="Contact en beschikbaarheid">
          <h3>Contact en beschikbaarheid</h3>
          <div className="profile-essentials__grid">
            <div className="profile-essential-field">
              <span className="muted-label">Telefoon</span>
              {runner.registration?.phone ? (
                <a href={`tel:${runner.registration.phone.replace(/\s+/g, '')}`}>{runner.registration.phone}</a>
              ) : <span className="profile-essential-field__empty">Niet opgegeven</span>}
            </div>
            <div className="profile-essential-field">
              <span className="muted-label">E-mail</span>
              {runner.registration?.email ? (
                <a href={`mailto:${runner.registration.email}`}>{runner.registration.email}</a>
              ) : <span className="profile-essential-field__empty">Niet opgegeven</span>}
            </div>
            <div className="profile-essential-field profile-essential-field--hours">
              <span className="muted-label">Beschikbare uren</span>
              {runner.registration?.availableHours.length ? (
                <div className="profile-hours">
                  {runner.registration.availableHours.map((hour) => <span key={hour}>{hour}</span>)}
                </div>
              ) : <span className="profile-essential-field__empty">Niet opgegeven</span>}
            </div>
          </div>
          {!runner.registration && (
            <p className="profile-essentials__note">
              {runner.registrationSource === 'manual' ? 'Manueel toegevoegd, geen inschrijving.' : 'Geen inschrijvingsgegevens.'}
            </p>
          )}
        </section>

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
            <span className="muted-label">Rondes</span>
            <strong>{runner.lapCount}</strong>
          </div>
          <div className="profile-stat">
            <span className="muted-label">Laatste ronde</span>
            <strong>{latestLap ? formatDurationMs(latestLap.durationMs) : '—'}</strong>
          </div>
          <div className="profile-stat">
            <span className="muted-label">Snelste ronde</span>
            <strong>{runner.bestLapMs ? formatDurationMs(runner.bestLapMs) : '—'}</strong>
          </div>
        </div>

        {runner.registration && (
          <section className="profile-registration" aria-label="Inschrijvingsgegevens">
            <h3>Inschrijvingsgegevens</h3>
            <div className="profile-registration__grid">
              <RegistrationField label="Studiefase" value={runner.registration.studyPhase} />
              <RegistrationField label="Geschat totaal rondjes" value={runner.registration.estimatedLaps} />
              <RegistrationField label="Geschat gemiddeld tempo op 515 m" value={runner.registration.estimatedPace} />
              <RegistrationField label="Maximum rondjes per blok van 2 uur" value={runner.registration.maxLapsPerBlock} />
              <RegistrationField label="Flexibiliteit" value={runner.registration.flexibility} />
              <RegistrationField label="Categorieën" value={runner.registration.categories.join(', ')} />
              <RegistrationField label="Toestemming voor hergebruik" value={runner.registration.reuseConsent} />
              <RegistrationField label="Opmerking bij inschrijving" value={runner.registration.remarks} />
              <RegistrationField label="Ingeschreven op" value={runner.registration.submittedAt} />
            </div>
          </section>
        )}

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

        <h3 className="profile-edit-title">Profiel aanpassen</h3>
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
            Doel (rondes)
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
              <h3>Wachtrij</h3>
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
            <button className="btn btn--ghost" onClick={async () => {
              if (await confirm({
                title: 'Nieuwste profiel laden?',
                message: 'Je niet-opgeslagen aanpassingen worden vervangen.',
                confirmLabel: 'Nieuwste laden',
                tone: 'danger',
              })) {
                loadLatestProfile();
                setClosePromptOpen(false);
              }
            }}>Nieuwste profiel laden</button>
          </div>
        )}
        {saveError && <div className="warning-banner" role="alert">{saveError}</div>}

        <div className="modal-actions">
          <button className="btn btn--ghost" onClick={requestClose}>
            Annuleer
          </button>
          <button className="btn btn--primary" onClick={saveAndClose} disabled={saving || profileChangedElsewhere}>
            {saving ? 'Opslaan...' : 'Opslaan'}
          </button>
        </div>

        {closePromptOpen && (
          <ModalDialog label="Wijzigingen opslaan?" onRequestClose={() => { if (!saving) setClosePromptOpen(false); }}>
            <div className="confirm-modal">
              <h3>Wijzigingen opslaan?</h3>
              <p>Er zijn aanpassingen aan dit lopersprofiel.</p>
              {saveError && <div className="warning-banner" role="alert">{saveError}</div>}
              {profileChangedElsewhere && <p role="alert">Dit profiel is elders gewijzigd. Kies Verder bewerken om je invoer te bekijken.</p>}
              <div className="modal-actions">
                <button className="btn btn--ghost" onClick={() => setClosePromptOpen(false)} disabled={saving}>
                  Verder bewerken
                </button>
                <button className="btn btn--ghost" onClick={onClose} disabled={saving}>
                  Niet opslaan
                </button>
                <button className="btn btn--primary" onClick={saveAndClose} disabled={saving || profileChangedElsewhere}>
                  {saving ? 'Opslaan...' : 'Opslaan'}
                </button>
              </div>
            </div>
          </ModalDialog>
        )}
      </div>
    </ModalDialog>
  );
}

/** Empty answers are left out so the filled-in ones stand out. */
function RegistrationField({ label, value }: { label: string; value: string }) {
  if (!value.trim()) return null;
  return <div className="profile-registration__field"><span className="muted-label">{label}</span><span>{value}</span></div>;
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
  return runner.runnerNumber ? `${runner.runnerNumber} ${runner.name}` : runner.name;
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
    JSON.stringify(runner.registration),
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
