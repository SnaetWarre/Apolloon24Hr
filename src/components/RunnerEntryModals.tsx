import React from 'react';
import { ModalDialog } from './ModalDialog';
import { useConfirm } from './ConfirmDialog';
import { AvailableHoursPicker } from './AvailableHoursPicker';
import { runnerFormError } from '../lib/runnerForm';
import { useAppActions, useAppData } from '../app/index';
import type { Label, LiveAppSnapshot, Runner } from '../types';
import { compareLabels, LabelBadge, labelKindTitle } from './LabelBadge';

const selectRunners = ({ runners }: LiveAppSnapshot) => ({ runners });
const selectLabels = ({ labels }: LiveAppSnapshot) => ({ labels });

export function RunnerActivationModal({
  onClose,
  onOpenProfile,
  onActivated,
}: {
  onClose: () => void;
  onOpenProfile?: (runnerId: string) => void;
  onActivated?: () => void;
}) {
  const { runners } = useAppData(selectRunners);
  const { setStatus } = useAppActions();
  const [query, setQuery] = React.useState('');
  const [showAllMatches, setShowAllMatches] = React.useState(false);
  const [keepSearchOpen, setKeepSearchOpen] = React.useState(false);
  const [activationNotice, setActivationNotice] = React.useState<string | null>(null);
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const [activatingId, setActivatingId] = React.useState<string | null>(null);
  const [activationError, setActivationError] = React.useState<string | null>(null);
  const activationBusyRef = React.useRef(false);

  const searchableRunners = React.useMemo(() => {
    return [...runners].sort(sortRunnerByNumberThenName);
  }, [runners]);

  const filteredMatches = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return searchableRunners;
    const exactNumberMatches = searchableRunners.filter((runner) => runner.runnerNumber?.trim().toLowerCase() === q);
    return exactNumberMatches.length
      ? exactNumberMatches
      : searchableRunners.filter((runner) => runnerMatchesQuery(runner, q));
  }, [searchableRunners, query]);

  const visibleMatches = showAllMatches ? filteredMatches : filteredMatches.slice(0, 40);
  const hasQuery = Boolean(query.trim());

  async function activate(runnerId: string) {
    if (activationBusyRef.current) return;
    activationBusyRef.current = true;
    setActivatingId(runnerId);
    setActivationError(null);
    setActivationNotice(null);
    try {
      await setStatus(runnerId, 'warming_up');
      onActivated?.();
      if (keepSearchOpen) {
        const activatedRunner = runners.find((runner) => runner.id === runnerId);
        setActivationNotice(`${activatedRunner?.name || 'Loper'} staat bij opwarming.`);
        setQuery('');
        searchInputRef.current?.focus();
      } else {
        onClose();
      }
    } catch (err) {
      setActivationError(err instanceof Error ? err.message : 'Loper activeren mislukt');
    } finally {
      activationBusyRef.current = false;
      setActivatingId(null);
    }
  }

  function openProfile(runnerId: string) {
    onOpenProfile?.(runnerId);
    onClose();
  }

  function handleSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter' || event.repeat || event.nativeEvent.isComposing) return;
    const firstMatch = visibleMatches[0];
    if (
      !query.trim() ||
      filteredMatches.length !== 1 ||
      !firstMatch ||
      !isAvailableForActivation(firstMatch) ||
      activatingId
    )
      return;
    event.preventDefault();
    void activate(firstMatch.id);
  }

  return (
    <ModalDialog
      label="Loper zoeken"
      onRequestClose={() => {
        if (!activationBusyRef.current) onClose();
      }}
      initialFocusRef={searchInputRef}
    >
      <div className="modal">
        <ModalHeader
          title="Loper zoeken"
          onClose={() => {
            if (!activationBusyRef.current) onClose();
          }}
        />
        <input
          ref={searchInputRef}
          aria-label="Zoek op nummer, naam of label"
          className="input"
          value={query}
          readOnly={Boolean(activatingId)}
          onChange={(event) => {
            setQuery(event.target.value);
            setShowAllMatches(false);
          }}
          onKeyDown={handleSearchKeyDown}
          placeholder="Zoek op nummer, naam of label..."
        />

        <label className="toggle-row">
          <input
            type="checkbox"
            checked={keepSearchOpen}
            disabled={Boolean(activatingId)}
            onChange={(event) => setKeepSearchOpen(event.target.checked)}
          />
          Meerdere lopers aanmelden
        </label>
        <p className="label-picker-help">Aan: dit venster blijft open na elke aanmelding.</p>
        {activationNotice && (
          <div className="success-banner" role="status">
            {activationNotice}
          </div>
        )}
        {hasQuery && filteredMatches.length === 1 && isAvailableForActivation(filteredMatches[0]) && (
          <p className="label-picker-help">Enter: deze loper naar opwarming.</p>
        )}
        <div className="runner-search-list">
          <div className="runner-search-summary">
            {hasQuery
              ? `${filteredMatches.length} resultaat${filteredMatches.length === 1 ? '' : 'en'}`
              : `${searchableRunners.length} lopers in de databank`}
            {filteredMatches.length > visibleMatches.length ? ` · eerste ${visibleMatches.length} getoond` : ''}
          </div>
          {filteredMatches.length === 0 && (
            <div className="empty-inline">
              {hasQuery ? 'Geen loper gevonden.' : 'Geen beschikbare lopers in de databank.'}
            </div>
          )}
          {activationError && <div className="warning-banner">{activationError}</div>}
          {visibleMatches.map((runner) => (
            <div key={runner.id} className="runner-search-row">
              <div>
                <RunnerTitle runner={runner} />
                <div className="runner-search-meta">
                  <StatusBadge runner={runner} />
                  <LabelPills labels={runner.labels} />
                </div>
              </div>
              <div className="runner-search-actions">
                <button
                  className="btn btn--ghost btn--fixed"
                  onClick={() => openProfile(runner.id)}
                  disabled={Boolean(activatingId)}
                >
                  Profiel
                </button>
                {isAvailableForActivation(runner) ? (
                  <button
                    className="btn btn--primary btn--fixed"
                    onClick={() => activate(runner.id)}
                    disabled={Boolean(activatingId)}
                  >
                    {activatingId === runner.id ? 'Bezig...' : 'Opwarmen'}
                  </button>
                ) : (
                  <button
                    className="btn btn--ghost btn--fixed"
                    disabled
                    title="Deze loper staat al in het traject en kan niet opnieuw worden aangemeld."
                  >
                    {runnerStatusLabel(runner)}
                  </button>
                )}
              </div>
            </div>
          ))}
          {filteredMatches.length > visibleMatches.length && (
            <button className="btn btn--ghost" onClick={() => setShowAllMatches(true)}>
              Toon alle {filteredMatches.length} lopers
            </button>
          )}
        </div>
      </div>
    </ModalDialog>
  );
}

/** Queue screens add a runner straight to warming up; management only registers them. */
export function RunnerAddModal({
  onClose,
  onAdded,
  destination = 'warming_up',
}: {
  onClose: () => void;
  onAdded?: () => void;
  destination?: 'warming_up' | 'registered';
}) {
  const { labels } = useAppData(selectLabels);
  const { addRunner } = useAppActions();
  const [runnerNumber, setRunnerNumber] = React.useState('');
  const [name, setName] = React.useState('');
  const [targetLaps, setTargetLaps] = React.useState('');
  const [historicalAvgMinutes, setHistoricalAvgMinutes] = React.useState('');
  const [historicalAvgSeconds, setHistoricalAvgSeconds] = React.useState('');
  const [historicalBestMinutes, setHistoricalBestMinutes] = React.useState('');
  const [historicalBestSeconds, setHistoricalBestSeconds] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [phone, setPhone] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [availableHours, setAvailableHours] = React.useState<string[]>([]);
  const [selectedLabels, setSelectedLabels] = React.useState<string[]>([]);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const saveBusyRef = React.useRef(false);
  const runnerNumberInputRef = React.useRef<HTMLInputElement>(null);
  const confirm = useConfirm();

  async function requestClose() {
    if (saveBusyRef.current) return;
    const hasDraft =
      selectedLabels.length > 0 ||
      availableHours.length > 0 ||
      [
        runnerNumber,
        name,
        targetLaps,
        notes,
        phone,
        email,
        historicalAvgMinutes,
        historicalAvgSeconds,
        historicalBestMinutes,
        historicalBestSeconds,
      ].some((input) => input.trim());
    if (
      hasDraft &&
      !(await confirm({
        title: 'Nieuwe loper sluiten?',
        message: 'Je invoer is nog niet opgeslagen en gaat verloren.',
        confirmLabel: 'Sluiten zonder opslaan',
        cancelLabel: 'Verder invullen',
        tone: 'danger',
      }))
    )
      return;
    if (saveBusyRef.current) return;
    onClose();
  }

  async function save() {
    if (saveBusyRef.current) return;
    const cleanName = name.trim();
    const validationError = runnerFormError(name, targetLaps);
    if (validationError) {
      setError(validationError);
      return;
    }

    saveBusyRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await addRunner({
        runnerNumber: runnerNumber.trim() || null,
        name: cleanName,
        targetLaps: targetLaps ? Number(targetLaps) : null,
        historicalAvgMs: minuteSecondInputToMs(historicalAvgMinutes, historicalAvgSeconds),
        historicalBestMs: minuteSecondInputToMs(historicalBestMinutes, historicalBestSeconds),
        registrationSource: 'manual',
        notes,
        registrationDetails: { phone, email, availableHours },
        labels: selectedLabels,
        status: destination,
      });
      onAdded?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Loper toevoegen mislukt');
    } finally {
      saveBusyRef.current = false;
      setSaving(false);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Enter' && event.ctrlKey && !event.repeat && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void save();
    }
  }

  function toggleLabel(labelId: string) {
    const label = labels.find((item) => item.id === labelId);
    if (!label) return;
    const group = exclusiveLabelGroup(label.kind);

    setSelectedLabels((current) => {
      if (current.includes(labelId)) return current.filter((id) => id !== labelId);
      return [
        ...current.filter((id) => exclusiveLabelGroup(labels.find((item) => item.id === id)?.kind) !== group),
        labelId,
      ];
    });
  }

  return (
    <ModalDialog label="Nieuwe loper" onRequestClose={requestClose} initialFocusRef={runnerNumberInputRef}>
      <div className="modal" onKeyDown={handleKeyDown}>
        <ModalHeader title="Nieuwe loper" onClose={requestClose} />

        <div className="form-grid">
          <label>
            Lopersnummer
            <input
              ref={runnerNumberInputRef}
              className="input"
              value={runnerNumber}
              onChange={(event) => setRunnerNumber(event.target.value)}
            />
          </label>
          <label>
            Naam
            <input className="input" value={name} onChange={(event) => setName(event.target.value)} />
          </label>
        </div>

        <div className="label-picker-groups">
          {groupLabels(labels.filter((label) => label.kind !== 'temporary_team')).map(([kind, groupedLabels]) => (
            <section key={kind} className="label-picker-group">
              <h3>{labelKindTitle(kind)}</h3>
              <p className="label-picker-help">Kies maximaal 1 optie.</p>
              <div className="label-picker">
                {groupedLabels.map((label) => (
                  <label key={label.id} className="check-pill">
                    <input
                      type="checkbox"
                      checked={selectedLabels.includes(label.id)}
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

        <details className="runner-extra-details">
          <summary className="disclosure">
            Contact en beschikbaarheid <span>Telefoon, e-mail en beschikbare uren</span>
          </summary>
          <div className="form-grid">
            <label>
              Telefoon
              <input
                className="input"
                type="tel"
                autoComplete="off"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
              />
            </label>
            <label>
              E-mail
              <input
                className="input"
                type="email"
                autoComplete="off"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
          </div>
          <AvailableHoursPicker value={availableHours} onChange={setAvailableHours} />
        </details>

        <details className="runner-extra-details">
          <summary className="disclosure">
            Extra gegevens <span>Doel, historische tijden en notities</span>
          </summary>
          <div className="form-grid">
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
            <label>
              Historisch gemiddelde
              <div className="duration-input">
                <input
                  className="input"
                  type="number"
                  min="0"
                  value={historicalAvgMinutes}
                  onChange={(event) => setHistoricalAvgMinutes(event.target.value)}
                  placeholder="min"
                />
                <input
                  className="input"
                  type="number"
                  min="0"
                  max="59"
                  value={historicalAvgSeconds}
                  onBlur={() => setHistoricalAvgSeconds(normalizeSecondsInput(historicalAvgSeconds))}
                  onChange={(event) => setHistoricalAvgSeconds(event.target.value)}
                  placeholder="sec"
                />
              </div>
            </label>
            <label>
              Historisch snelste
              <div className="duration-input">
                <input
                  className="input"
                  type="number"
                  min="0"
                  value={historicalBestMinutes}
                  onChange={(event) => setHistoricalBestMinutes(event.target.value)}
                  placeholder="min"
                />
                <input
                  className="input"
                  type="number"
                  min="0"
                  max="59"
                  value={historicalBestSeconds}
                  onBlur={() => setHistoricalBestSeconds(normalizeSecondsInput(historicalBestSeconds))}
                  onChange={(event) => setHistoricalBestSeconds(event.target.value)}
                  placeholder="sec"
                />
              </div>
            </label>
          </div>
          <label className="stacked-label">
            Notities
            <textarea className="input textarea" value={notes} onChange={(event) => setNotes(event.target.value)} />
          </label>
        </details>

        {error && (
          <div className="warning-banner" role="alert">
            {error}
          </div>
        )}

        <div className="modal-actions">
          <button className="btn btn--ghost" onClick={requestClose} disabled={saving}>
            Annuleer
          </button>
          <button className="btn btn--primary" onClick={save} disabled={saving}>
            {saving ? 'Opslaan...' : destination === 'warming_up' ? 'Toevoegen aan opwarmen' : 'Loper toevoegen'}
          </button>
        </div>
      </div>
    </ModalDialog>
  );
}

function ModalHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="modal-header">
      <h2>{title}</h2>
      <button className="icon-btn modal-close-btn" onClick={onClose} aria-label="Sluiten">
        ✕
      </button>
    </div>
  );
}

function RunnerTitle({ runner }: { runner: Runner }) {
  return (
    <span className="runner-title">
      {runner.runnerNumber && <span className="runner-number">{runner.runnerNumber}</span>}
      <span>{runner.name}</span>
    </span>
  );
}

function LabelPills({ labels }: { labels: Runner['labels'] }) {
  if (!labels.length) return null;
  const visible = labels.slice(0, 2);
  const hiddenCount = labels.length - visible.length;
  return (
    <span className="label-row" title={labels.map((label) => label.name).join(', ')}>
      {visible.map((label) => (
        <LabelBadge key={label.id} label={label} compact />
      ))}
      {hiddenCount > 0 && <span className="label-pill label-pill--compact">+{hiddenCount}</span>}
    </span>
  );
}

export function SourceBadge({ source }: { source: Runner['registrationSource'] }) {
  return <span className="source-badge">{source === 'import' ? 'Import' : 'Manueel'}</span>;
}

function StatusBadge({ runner }: { runner: Runner }) {
  return <span className="status-badge">{runnerStatusLabel(runner)}</span>;
}

function isAvailableForActivation(runner: Runner) {
  return runner.status !== 'warming_up' && runner.status !== 'waiting' && runner.status !== 'running';
}

function runnerStatusLabel(runner: Runner) {
  if (runner.hiddenFromQueue) return 'Verborgen';
  switch (runner.status) {
    case 'registered':
      return 'Ingeschreven';
    case 'ran':
      return 'Heeft gelopen';
    case 'warming_up':
      return 'Aan het opwarmen';
    case 'waiting':
      return 'In de wachtrij';
    case 'running':
      return 'Op de piste';
    default:
      return runner.status;
  }
}

function runnerMatchesQuery(runner: Runner, query: string) {
  const labelText = runner.labels
    .map((label) => label.name)
    .join(' ')
    .toLowerCase();
  return (
    runner.name.toLowerCase().includes(query) ||
    (runner.runnerNumber || '').toLowerCase().includes(query) ||
    labelText.includes(query)
  );
}

function sortRunnerByNumberThenName(a: Runner, b: Runner) {
  return (
    (a.runnerNumber || '').localeCompare(b.runnerNumber || '', undefined, { numeric: true }) ||
    a.name.localeCompare(b.name)
  );
}

function minuteSecondInputToMs(minutes: string, seconds: string) {
  const cleanMinutes = minutes.trim();
  const cleanSeconds = seconds.trim();
  if (!cleanMinutes && !cleanSeconds) return null;
  const minuteValue = Number(cleanMinutes || 0);
  const secondValue = Number(normalizeSecondsInput(cleanSeconds || '0'));
  if (!Number.isFinite(minuteValue) || !Number.isFinite(secondValue)) return null;
  return (Math.max(0, Math.round(minuteValue)) * 60 + secondValue) * 1000;
}

function normalizeSecondsInput(value: string) {
  const seconds = Number(value.trim() || 0);
  if (!Number.isFinite(seconds)) return '';
  return String(Math.min(59, Math.max(0, Math.round(seconds))));
}

function exclusiveLabelGroup(kind: string | undefined) {
  if (kind === 'speedteam') return 'speedteam';
  if (kind === 'zustervereniging' || kind === 'association') return 'zustervereniging';
  return 'andere';
}

function groupLabels(labels: Label[]) {
  const grouped = new Map<string, typeof labels>();
  [...labels].sort(compareLabels).forEach((label) => {
    if (!grouped.has(label.kind)) grouped.set(label.kind, []);
    grouped.get(label.kind)?.push(label);
  });
  return [...grouped.entries()];
}
