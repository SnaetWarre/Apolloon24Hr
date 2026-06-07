import React from 'react';
import { useAppStore } from '../store';
import type { Label, Runner } from '../types';
import { LabelBadge, labelKindOrder, labelKindTitle } from './LabelBadge';

export function RunnerActivationModal({
  onClose,
  onOpenProfile,
}: {
  onClose: () => void;
  onOpenProfile?: (runnerId: string) => void;
}) {
  const runners = useAppStore((state) => state.runners);
  const setStatus = useAppStore((state) => state.setStatus);
  const [query, setQuery] = React.useState('');
  const [activatingId, setActivatingId] = React.useState<string | null>(null);

  const availableRunners = React.useMemo(() => {
    return runners.filter(isAvailableForActivation).sort(sortRunnerByNumberThenName);
  }, [runners]);

  const filteredMatches = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return availableRunners;
    return availableRunners.filter((runner) => runnerMatchesQuery(runner, q));
  }, [availableRunners, query]);

  const visibleMatches = filteredMatches.slice(0, 40);
  const hasQuery = Boolean(query.trim());

  async function activate(runnerId: string) {
    setActivatingId(runnerId);
    try {
      await setStatus(runnerId, 'warming_up');
      onClose();
    } finally {
      setActivatingId(null);
    }
  }

  function openProfile(runnerId: string) {
    onOpenProfile?.(runnerId);
    onClose();
  }

  function handleSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Enter') return;
    const firstMatch = visibleMatches[0];
    if (!firstMatch || activatingId) return;
    event.preventDefault();
    void activate(firstMatch.id);
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <ModalHeader title="Loper zoeken" onClose={onClose} />
        <input
          autoFocus
          className="input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleSearchKeyDown}
          placeholder="Zoek op nummer, naam of label..."
        />

        <div className="runner-search-list">
          <div className="runner-search-summary">
            {hasQuery
              ? `${filteredMatches.length} resultaat${filteredMatches.length === 1 ? '' : 'en'}`
              : `${availableRunners.length} lopers buiten Telsysteem 1`}
            {filteredMatches.length > visibleMatches.length ? ` · eerste ${visibleMatches.length} getoond` : ''}
          </div>
          {filteredMatches.length === 0 && (
            <div className="empty-inline">
              {hasQuery ? 'Geen loper buiten Telsysteem 1 gevonden.' : 'Geen beschikbare lopers buiten Telsysteem 1.'}
            </div>
          )}
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
                <button className="btn btn--ghost btn--fixed" onClick={() => openProfile(runner.id)}>
                  Profiel
                </button>
                <button
                  className="btn btn--primary btn--fixed"
                  onClick={() => activate(runner.id)}
                  disabled={activatingId === runner.id}
                >
                  {activatingId === runner.id ? 'Bezig...' : 'Opwarmen'}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function RunnerAddModal({ onClose }: { onClose: () => void }) {
  const labels = useAppStore((state) => state.labels);
  const addRunner = useAppStore((state) => state.addRunner);
  const [runnerNumber, setRunnerNumber] = React.useState('');
  const [name, setName] = React.useState('');
  const [targetLaps, setTargetLaps] = React.useState('');
  const [historicalAvgMinutes, setHistoricalAvgMinutes] = React.useState('');
  const [historicalAvgSeconds, setHistoricalAvgSeconds] = React.useState('');
  const [historicalBestMinutes, setHistoricalBestMinutes] = React.useState('');
  const [historicalBestSeconds, setHistoricalBestSeconds] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [selectedLabels, setSelectedLabels] = React.useState<string[]>([]);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function save() {
    if (saving) return;
    const cleanName = name.trim();
    if (!cleanName) {
      setError('Naam is verplicht');
      return;
    }

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
        labels: selectedLabels,
        status: 'warming_up',
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Loper toevoegen mislukt');
    } finally {
      setSaving(false);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'Enter' && event.ctrlKey) {
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
      return [...current.filter((id) => exclusiveLabelGroup(labels.find((item) => item.id === id)?.kind) !== group), labelId];
    });
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal" onKeyDown={handleKeyDown}>
        <ModalHeader title="Nieuwe loper" onClose={onClose} />

        <div className="form-grid">
          <label>
            Lopersnummer
            <input
              autoFocus
              className="input"
              value={runnerNumber}
              onChange={(event) => setRunnerNumber(event.target.value)}
            />
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

        <div className="label-picker-groups">
          {groupLabels(labels).map(([kind, groupedLabels]) => (
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

        <label className="stacked-label">
          Notities
          <textarea className="input textarea" value={notes} onChange={(event) => setNotes(event.target.value)} />
        </label>

        {error && <div className="warning-banner">{error}</div>}

        <div className="modal-actions">
          <button className="btn btn--ghost" onClick={onClose}>
            Annuleer
          </button>
          <button className="btn btn--primary" onClick={save} disabled={saving}>
            {saving ? 'Opslaan...' : 'Toevoegen aan opwarmen'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ModalHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="modal-header">
      <h2>{title}</h2>
      <button className="icon-btn" onClick={onClose} aria-label="Sluiten">
        x
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
  return (
    <span className="label-row">
      {labels.map((label) => (
        <LabelBadge key={label.id} label={label} compact />
      ))}
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
    default:
      return runner.status;
  }
}

function runnerMatchesQuery(runner: Runner, query: string) {
  const labelText = runner.labels.map((label) => label.name).join(' ').toLowerCase();
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
