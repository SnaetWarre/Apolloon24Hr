import React from 'react';
import { useAppStore } from '../store';
import type { Label, Runner } from '../types';
import { LabelBadge, labelKindOrder, labelKindTitle } from './LabelBadge';

export function RunnerActivationModal({ onClose }: { onClose: () => void }) {
  const runners = useAppStore((state) => state.runners);
  const setStatus = useAppStore((state) => state.setStatus);
  const selectRunner = useAppStore((state) => state.selectRunner);
  const [query, setQuery] = React.useState('');
  const [activatingId, setActivatingId] = React.useState<string | null>(null);

  const matches = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return runners
      .filter((runner) => runner.status === 'registered')
      .filter((runner) => runnerMatchesQuery(runner, q))
      .sort(sortRunnerByNumberThenName)
      .slice(0, 60);
  }, [query, runners]);

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
    selectRunner(runnerId);
    onClose();
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <ModalHeader title="Ingeschrevene zoeken" onClose={onClose} />
        <input
          autoFocus
          className="input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Zoek op nummer, naam of label..."
        />

        <div className="runner-search-list">
          {!query.trim() && <div className="empty-inline">Typ een naam, nummer of label om te zoeken.</div>}
          {query.trim() && matches.length === 0 && <div className="empty-inline">Geen ingeschreven loper gevonden.</div>}
          {matches.map((runner) => (
            <div key={runner.id} className="runner-search-row">
              <div>
                <RunnerTitle runner={runner} />
                <div className="runner-search-meta">
                  <SourceBadge source={runner.registrationSource} />
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
  const [historicalAvg, setHistoricalAvg] = React.useState('');
  const [historicalBest, setHistoricalBest] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [selectedLabels, setSelectedLabels] = React.useState<string[]>([]);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function save() {
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
        historicalAvgMs: secondsInputToMs(historicalAvg),
        historicalBestMs: secondsInputToMs(historicalBest),
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

  function toggleLabel(labelId: string) {
    setSelectedLabels((current) =>
      current.includes(labelId) ? current.filter((id) => id !== labelId) : [...current, labelId]
    );
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
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
            Historisch gemiddelde in seconden
            <input className="input" value={historicalAvg} onChange={(event) => setHistoricalAvg(event.target.value)} />
          </label>
          <label>
            Historisch snelste in seconden
            <input className="input" value={historicalBest} onChange={(event) => setHistoricalBest(event.target.value)} />
          </label>
        </div>

        <div className="label-picker-groups">
          {groupLabels(labels).map(([kind, groupedLabels]) => (
            <section key={kind} className="label-picker-group">
              <h3>{labelKindTitle(kind)}</h3>
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

function secondsInputToMs(value: string) {
  const text = value.trim();
  if (!text) return null;
  const seconds = Number(text.replace(',', '.'));
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
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
