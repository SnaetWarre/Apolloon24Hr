import React from 'react';
import { useAppStore } from '../store';
import { LabelBadge, labelKindOrder, labelKindTitle } from './LabelBadge';
import type { Label } from '../types';

export function AdminView() {
  const labels = useAppStore((state) => state.labels);
  const runners = useAppStore((state) => state.runners);
  const importRunnersCsv = useAppStore((state) => state.importRunnersCsv);
  const createLabel = useAppStore((state) => state.createLabel);
  const deleteLabel = useAppStore((state) => state.deleteLabel);
  const [csvText, setCsvText] = React.useState('');
  const [message, setMessage] = React.useState<string | null>(null);
  const [labelName, setLabelName] = React.useState('');
  const [labelColor, setLabelColor] = React.useState('#3b82f6');
  const [labelKind, setLabelKind] = React.useState('andere');
  const [labelImageUrl, setLabelImageUrl] = React.useState('');

  async function importCsv() {
    if (!csvText.trim()) return;
    setMessage(null);
    try {
      const summary = await importRunnersCsv(csvText);
      setMessage(summary);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Import mislukt');
    }
  }

  async function onFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setCsvText(await file.text());
  }

  async function addLabel() {
    const name = labelName.trim();
    if (!name) return;
    await createLabel({
      name,
      color: labelColor,
      icon: name.slice(0, 2).toUpperCase(),
      kind: labelKind.trim() || 'custom',
      imageUrl: labelImageUrl.trim() || null,
    });
    setLabelName('');
    setLabelImageUrl('');
  }

  async function removeLabel(id: string, name: string) {
    if (!window.confirm(`Label ${name} verwijderen? Dit verwijdert het label ook van lopers.`)) return;
    await deleteLabel(id);
  }

  return (
    <>
      <div className="hero hero--compact">
        <h1 className="app-title">Admin / Import / Labels</h1>
        <p className="tagline">Voorbereiding voor de lokale wedstrijddatabase.</p>
      </div>

      <div className="analysis-grid">
        <section className="panel">
          <h2>Google Sheets CSV import</h2>
          <p className="panel-copy">
            Verwachte kolommen: runner_number, name, labels, target_laps, historical_avg, historical_best.
          </p>
          <input className="input" type="file" accept=".csv,text/csv" onChange={onFileChange} />
          <textarea
            className="input textarea textarea--large"
            value={csvText}
            onChange={(event) => setCsvText(event.target.value)}
            placeholder="Plak hier CSV data..."
          />
          <button className="btn btn--primary" onClick={importCsv}>
            Importeren
          </button>
          {message && <div className="host-hint">{message}</div>}
        </section>

        <section className="panel">
          <h2>Labels</h2>
          <div className="form-row">
            <input
              className="input"
              value={labelName}
              onChange={(event) => setLabelName(event.target.value)}
              placeholder="Nieuw label"
            />
            <input
              className="input input--color"
              type="color"
              value={labelColor}
              onChange={(event) => setLabelColor(event.target.value)}
            />
            <select className="input" value={labelKind} onChange={(event) => setLabelKind(event.target.value)}>
              <option value="speedteam">Speedteam</option>
              <option value="zustervereniging">Zustervereniging</option>
              <option value="andere">Andere</option>
              <option value="custom">Custom</option>
            </select>
            <input
              className="input"
              value={labelImageUrl}
              onChange={(event) => setLabelImageUrl(event.target.value)}
              placeholder="/labels/logo.png optioneel"
            />
            <button className="btn btn--primary" onClick={addLabel}>
              Label toevoegen
            </button>
          </div>

          <div className="label-admin-list">
            {groupLabels(labels).map(([kind, groupedLabels]) => (
              <section key={kind} className="label-admin-group">
                <h3>{labelKindTitle(kind)}</h3>
                {groupedLabels.map((label) => (
                  <div key={label.id} className="label-admin-row">
                    <LabelBadge label={label} />
                    <em>{label.kind}</em>
                    <button className="btn btn--danger" onClick={() => removeLabel(label.id, label.name)}>
                      Verwijder
                    </button>
                  </div>
                ))}
              </section>
            ))}
          </div>
        </section>
      </div>

      <section className="panel">
        <h2>Database status</h2>
        <div className="stats-grid">
          <div className="stat-panel">
            <span className="muted-label">Lopers</span>
            <strong>{runners.length}</strong>
          </div>
          <div className="stat-panel">
            <span className="muted-label">Labels</span>
            <strong>{labels.length}</strong>
          </div>
          <div className="stat-panel">
            <span className="muted-label">In wachtrij</span>
            <strong>{runners.filter((runner) => runner.status === 'waiting').length}</strong>
          </div>
        </div>
      </section>
    </>
  );
}

function groupLabels(labels: Label[]) {
  const grouped = new Map<string, typeof labels>();
  [...labels]
    .sort((a, b) => labelKindOrder(a.kind) - labelKindOrder(b.kind) || a.name.localeCompare(b.name))
    .forEach((label) => {
      if (!grouped.has(label.kind)) grouped.set(label.kind, []);
      grouped.get(label.kind)?.push(label);
    });
  return [...grouped.entries()];
}
