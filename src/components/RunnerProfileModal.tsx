import React from 'react';
import { ModalDialog } from './ModalDialog';
import { useConfirm } from './ConfirmDialog';
import { AvailableHoursPicker } from './AvailableHoursPicker';
import { groupLabels, toggleRunnerLabel } from '../lib/labels';
import { runnerLabel, statusLabel } from '../lib/runners';
import { runnerFormError } from '../lib/runnerForm';
import { mailHref, phoneHref } from '../lib/contact';
import { useAppActions, useAppData, useRaceHistory, useRegistrations } from '../app/index';
import { formatClockTimeMs, formatDurationMs } from '../lib/time';
import { labelKindTitle } from './LabelBadge';
import type { LiveAppSnapshot, Runner, RunnerRegistration, RunnerStatus } from '../types';
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
  const registration = useRegistrations()[runnerId] ?? null;
  const [runnerNumber, setRunnerNumber] = React.useState('');
  const [name, setName] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [phone, setPhone] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [availableHours, setAvailableHours] = React.useState<string[]>([]);
  const [selectedLabels, setSelectedLabels] = React.useState<string[]>([]);
  const [closePromptOpen, setClosePromptOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [queueActionBusy, setQueueActionBusy] = React.useState(false);
  const [queueActionMessage, setQueueActionMessage] = React.useState<string | null>(null);
  const [queueActionError, setQueueActionError] = React.useState<string | null>(null);
  const [draftBaseline, setDraftBaseline] = React.useState(runner);
  const [registrationBaseline, setRegistrationBaseline] = React.useState(registration);
  const editableRunnerKey = runner ? getEditableRunnerKey(runner, registration) : '';
  const dirty = draftBaseline
    ? isDirty({
        runner: draftBaseline,
        registration: registrationBaseline,
        runnerNumber,
        name,
        notes,
        phone,
        email,
        availableHours,
        selectedLabels,
      })
    : false;
  const profileChangedElsewhere = Boolean(
    runner &&
    draftBaseline &&
    runner.id === draftBaseline.id &&
    editableRunnerKey !== getEditableRunnerKey(draftBaseline, registrationBaseline)
  );
  const initializedRunnerId = React.useRef<string | null>(null);
  const activeTemporaryTeam = temporaryTeams.find((team) => team.active && team.memberRunnerIds.includes(runnerId));

  function loadLatestProfile() {
    if (!runner) return;
    initializedRunnerId.current = runner.id;
    setDraftBaseline(runner);
    setRegistrationBaseline(registration);
    setRunnerNumber(runner.runnerNumber || '');
    setName(runner.name);
    setNotes(runner.notes || '');
    setPhone(registration?.phone || '');
    setEmail(registration?.email || '');
    setAvailableHours(registration?.availableHours ?? []);
    setSelectedLabels(runner.labels.map((label) => label.id));
  }

  React.useEffect(() => {
    // Refresh untouched profiles, but never replace an operator's unsaved draft.
    if (initializedRunnerId.current !== runnerId || !dirty) loadLatestProfile();
    // Only a change to the stored profile should reload the form, not every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    const validationError = runnerFormError(name);
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
        notes,
        registrationDetails: { phone, email, availableHours },
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
    setSelectedLabels((current) => toggleRunnerLabel(current, labelId, labels));
  }

  async function removeFromQueueFlow() {
    if (!runner || !isQueueRemovalStatus(runner.status)) return;
    if (
      !(await confirm({
        title: 'Uit de wachtrij halen?',
        message: `${runner.name} verdwijnt uit de wachtrij en opwarming.`,
        confirmLabel: 'Uit wachtrij halen',
      }))
    )
      return;

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
  const phoneLink = phoneHref(phone);
  const mailLink = mailHref(email);

  return (
    <ModalDialog label="Lopersprofiel" onRequestClose={requestClose} closeOnBackdrop>
      <div className="modal modal--runner-profile">
        <div className="modal-header">
          <div>
            <span className="modal-kicker">Lopersprofiel</span>
            <h2>{runnerLabel(runner)}</h2>
          </div>
          <button className="icon-btn" onClick={requestClose} aria-label="Sluiten">
            ✕
          </button>
        </div>

        <div className="form-grid">
          <label>
            Lopersnummer
            <input className="input" value={runnerNumber} onChange={(event) => setRunnerNumber(event.target.value)} />
          </label>
          <label>
            Naam
            <input className="input" value={name} onChange={(event) => setName(event.target.value)} />
          </label>
        </div>

        <div className="profile-stats">
          <div className="profile-stat">
            <span className="muted-label">{statusSummary.title}</span>
            <strong>
              {statusSummary.showsElapsed && runner.statusSince ? (
                <LiveElapsed startedAt={runner.statusSince} prefix="voor " />
              ) : (
                '—'
              )}
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

        <section className="profile-essentials" aria-label="Contact en beschikbaarheid">
          <h3>Contact en beschikbaarheid</h3>
          <div className="form-grid">
            <label>
              Telefoon
              <div className="input-with-action">
                <input
                  className="input"
                  type="tel"
                  autoComplete="off"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                />
                {phoneLink && (
                  <a className="btn btn--ghost" href={phoneLink}>
                    Bellen
                  </a>
                )}
              </div>
            </label>
            <label>
              E-mail
              <div className="input-with-action">
                <input
                  className="input"
                  type="email"
                  autoComplete="off"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
                {mailLink && (
                  <a className="btn btn--ghost" href={mailLink}>
                    Mailen
                  </a>
                )}
              </div>
            </label>
          </div>
          <AvailableHoursPicker value={availableHours} onChange={setAvailableHours} />
          {!registration && (
            <p className="profile-essentials__note">
              {runner.registrationSource === 'manual'
                ? 'Manueel toegevoegd, geen inschrijving.'
                : 'Geen inschrijvingsgegevens.'}
            </p>
          )}
        </section>

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
                      disabled={
                        label.kind === 'temporary_team' || (Boolean(activeTemporaryTeam) && label.kind === 'speedteam')
                      }
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

        {registration && hasRegistrationAnswers(registration) && (
          <section className="profile-registration" aria-label="Inschrijvingsgegevens">
            <h3>Inschrijvingsgegevens</h3>
            <div className="profile-registration__grid">
              <RegistrationField label="Studiefase" value={registration.studyPhase} />
              <RegistrationField label="Geschat totaal rondjes" value={registration.estimatedLaps} />
              <RegistrationField label="Geschat gemiddeld tempo op 515 m" value={registration.estimatedPace} />
              <RegistrationField label="Maximum rondjes per blok van 2 uur" value={registration.maxLapsPerBlock} />
              <RegistrationField label="Snelste (test)ronde" value={registration.fastestLap} />
              <RegistrationField label="Flexibiliteit" value={registration.flexibility} />
              <RegistrationField label="Categorieën" value={registration.categories.join(', ')} />
              <RegistrationField label="Toestemming voor hergebruik" value={registration.reuseConsent} />
              <RegistrationField label="Opmerking bij inschrijving" value={registration.remarks} />
              <RegistrationField label="Ingeschreven op" value={registration.submittedAt} />
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
            Dit profiel is intussen elders gewijzigd. Je invoer is bewaard. Kopieer je aanpassingen voordat je de
            nieuwste versie laadt en opnieuw bewerkt.
            <button
              className="btn btn--ghost"
              onClick={async () => {
                if (
                  await confirm({
                    title: 'Nieuwste profiel laden?',
                    message: 'Je niet-opgeslagen aanpassingen worden vervangen.',
                    confirmLabel: 'Nieuwste laden',
                    tone: 'danger',
                  })
                ) {
                  loadLatestProfile();
                  setClosePromptOpen(false);
                }
              }}
            >
              Nieuwste profiel laden
            </button>
          </div>
        )}
        {saveError && (
          <div className="warning-banner" role="alert">
            {saveError}
          </div>
        )}

        <div className="modal-actions">
          <button className="btn btn--ghost" onClick={requestClose}>
            Annuleer
          </button>
          <button className="btn btn--primary" onClick={saveAndClose} disabled={saving || profileChangedElsewhere}>
            {saving ? 'Opslaan...' : 'Opslaan'}
          </button>
        </div>

        {closePromptOpen && (
          <ModalDialog
            label="Wijzigingen opslaan?"
            onRequestClose={() => {
              if (!saving) setClosePromptOpen(false);
            }}
          >
            <div className="confirm-modal">
              <h3>Wijzigingen opslaan?</h3>
              <p>Er zijn aanpassingen aan dit lopersprofiel.</p>
              {saveError && (
                <div className="warning-banner" role="alert">
                  {saveError}
                </div>
              )}
              {profileChangedElsewhere && (
                <p role="alert">Dit profiel is elders gewijzigd. Kies Verder bewerken om je invoer te bekijken.</p>
              )}
              <div className="modal-actions">
                <button className="btn btn--ghost" onClick={() => setClosePromptOpen(false)} disabled={saving}>
                  Verder bewerken
                </button>
                <button className="btn btn--ghost" onClick={onClose} disabled={saving}>
                  Niet opslaan
                </button>
                <button
                  className="btn btn--primary"
                  onClick={saveAndClose}
                  disabled={saving || profileChangedElsewhere}
                >
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

/** The form's own answers; contact details and hours already show at the top. */
function hasRegistrationAnswers(registration: RunnerRegistration) {
  return (
    registration.categories.length > 0 ||
    [
      registration.studyPhase,
      registration.estimatedLaps,
      registration.estimatedPace,
      registration.maxLapsPerBlock,
      registration.fastestLap,
      registration.flexibility,
      registration.reuseConsent,
      registration.remarks,
      registration.submittedAt,
    ].some((value) => value.trim())
  );
}

/** Empty answers are left out so the filled-in ones stand out. */
function RegistrationField({ label, value }: { label: string; value: string }) {
  if (!value.trim()) return null;
  return (
    <div className="profile-registration__field">
      <span className="muted-label">{label}</span>
      <span>{value}</span>
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

function isDirty({
  runner,
  registration,
  runnerNumber,
  name,
  notes,
  phone,
  email,
  availableHours,
  selectedLabels,
}: {
  runner: Runner;
  registration: RunnerRegistration | null;
  runnerNumber: string;
  name: string;
  notes: string;
  phone: string;
  email: string;
  availableHours: string[];
  selectedLabels: string[];
}) {
  const currentLabels = runner.labels
    .map((label) => label.id)
    .sort()
    .join('|');
  const nextLabels = [...selectedLabels].sort().join('|');
  return (
    runnerNumber.trim() !== (runner.runnerNumber || '') ||
    name.trim() !== runner.name ||
    notes !== (runner.notes || '') ||
    phone.trim() !== (registration?.phone || '') ||
    email.trim() !== (registration?.email || '') ||
    availableHours.join('|') !== (registration?.availableHours ?? []).join('|') ||
    currentLabels !== nextLabels
  );
}

function getEditableRunnerKey(runner: Runner, registration: RunnerRegistration | null) {
  return [
    runner.id,
    runner.runnerNumber || '',
    runner.name,
    runner.notes || '',
    runner.labels
      .map((label) => label.id)
      .sort()
      .join('|'),
    registration?.phone || '',
    registration?.email || '',
    (registration?.availableHours ?? []).join('|'),
  ].join('\u0001');
}

function runnerStatusSummary(status: RunnerStatus) {
  return { title: statusLabel(status), showsElapsed: !['registered', 'ran'].includes(status) };
}
