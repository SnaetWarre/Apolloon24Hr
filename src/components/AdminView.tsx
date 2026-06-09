import React from 'react';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { useAppActions, useAppData } from '../app/index';
import { LabelBadge, labelKindOrder, labelKindTitle } from './LabelBadge';
import { SourceBadge } from './RunnerEntryModals';
import { RunnerProfileModal } from './RunnerProfileModal';
import { formatClockTimeMs } from '../lib/time';
import type { Label, Runner, RunnerStatus } from '../types';

export function AdminView() {
  const { labels, runners } = useAppData();
  const {
    importRunnersCsv,
    createLabel,
    updateLabel,
    deleteLabel,
    deleteRunner,
    unhideRunner,
    burgieGepakt,
  } = useAppActions();
  const [csvText, setCsvText] = React.useState('');
  const [csvFileName, setCsvFileName] = React.useState('');
  const [message, setMessage] = React.useState<string | null>(null);
  const [eventMessage, setEventMessage] = React.useState<string | null>(null);
  const [eventSaving, setEventSaving] = React.useState(false);
  const [runnerMessage, setRunnerMessage] = React.useState<string | null>(null);
  const [runnerQuery, setRunnerQuery] = React.useState('');
  const [labelName, setLabelName] = React.useState('');
  const [labelColor, setLabelColor] = React.useState('#3b82f6');
  const [labelKind, setLabelKind] = React.useState('andere');
  const [labelImageUrl, setLabelImageUrl] = React.useState('');
  const [labelTargetLaps, setLabelTargetLaps] = React.useState('');
  const [labelSortOrder, setLabelSortOrder] = React.useState('');
  const [profileRunnerId, setProfileRunnerId] = React.useState<string | null>(null);

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
    setMessage(null);
    setCsvFileName(file.name);
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
      targetLaps: labelTargetLaps ? Number(labelTargetLaps) : null,
      sortOrder: labelSortOrder ? Number(labelSortOrder) : null,
    });
    setLabelName('');
    setLabelImageUrl('');
    setLabelTargetLaps('');
    setLabelSortOrder('');
  }

  async function triggerBurgieGepakt() {
    setEventMessage(null);
    setEventSaving(true);
    try {
      const event = await burgieGepakt();
      const runnerText = event.runnerName
        ? ` voor ${event.runnerNumber ? `${event.runnerNumber} - ` : ''}${event.runnerName}`
        : '';
      setEventMessage(`Burgie gepakt opgeslagen om ${formatClockTimeMs(event.occurredAt)}${runnerText}.`);
    } catch (err) {
      setEventMessage(err instanceof Error ? err.message : 'Burgie gepakt opslaan mislukt');
    } finally {
      setEventSaving(false);
    }
  }

  async function removeLabel(id: string, name: string) {
    if (!window.confirm(`Label ${name} verwijderen? Dit verwijdert het label ook van lopers.`)) return;
    await deleteLabel(id);
  }

  const adminRunners = React.useMemo(() => {
    const q = runnerQuery.trim().toLowerCase();
    const filtered = q
      ? runners.filter((runner) => {
          const labelText = runner.labels.map((label) => label.name).join(' ').toLowerCase();
          return (
            runner.name.toLowerCase().includes(q) ||
            (runner.runnerNumber || '').toLowerCase().includes(q) ||
            runner.status.toLowerCase().includes(q) ||
            runner.registrationSource.toLowerCase().includes(q) ||
            labelText.includes(q)
          );
        })
      : runners;
    return [...filtered]
      .sort(
        (a, b) =>
          statusOrder(a.status) - statusOrder(b.status) ||
          (a.runnerNumber || '').localeCompare(b.runnerNumber || '', undefined, { numeric: true }) ||
          a.name.localeCompare(b.name)
      )
      .slice(0, 150);
  }, [runnerQuery, runners]);

  async function restoreRunner(runner: Runner) {
    setRunnerMessage(null);
    try {
      await unhideRunner(runner.id);
      setRunnerMessage(`${runner.name} is terug zichtbaar.`);
    } catch (err) {
      setRunnerMessage(err instanceof Error ? err.message : 'Loper terug tonen mislukt');
    }
  }

  async function removeRunner(runner: Runner) {
    if (runner.lapCount > 0 || runner.status === 'running') return;
    if (!window.confirm(`Loper ${runner.name} definitief verwijderen?`)) return;
    setRunnerMessage(null);
    try {
      await deleteRunner(runner.id);
      setRunnerMessage(`${runner.name} is definitief verwijderd.`);
    } catch (err) {
      setRunnerMessage(err instanceof Error ? err.message : 'Loper verwijderen mislukt');
    }
  }

  return (
    <>
      <div className="hero hero--compact">
        <div>
          <img className="hero-logo" src="/brand/apolloon-logo.png" alt="Apolloon" />
          <h1 className="app-title">Admin / Import / Labels</h1>
          <p className="tagline">Voorbereiding voor de lokale wedstrijddatabase.</p>
        </div>
      </div>

      <div className="analysis-grid">
        <section className="panel">
          <h2>Publiek moment</h2>
          <p className="panel-copy">
            Slaat het moment op en toont de flash alleen op het buitenscherm.
          </p>
          <button className="btn btn--primary btn--xl" onClick={triggerBurgieGepakt} disabled={eventSaving}>
            {eventSaving ? 'Opslaan...' : 'Burgie gepakt'}
          </button>
          {eventMessage && <div className="host-hint">{eventMessage}</div>}
        </section>

        <section className="panel">
          <h2>Google Sheets CSV import</h2>
          <p className="panel-copy">
            Import zet nieuwe lopers in de ingeschreven databank. Ze verschijnen pas op het bord wanneer je ze
            activeert in Telsysteem 1.
          </p>
          <div className="file-import-row">
            <label className="file-picker">
              <input type="file" accept=".csv,text/csv" onChange={onFileChange} />
              <span>CSV-bestand kiezen</span>
            </label>
            <span className="file-name">{csvFileName || 'Geen bestand gekozen'}</span>
            <button className="btn btn--primary btn--fixed" onClick={importCsv} disabled={!csvText.trim()}>
              Importeren
            </button>
          </div>
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
            <input
              className="input input--number"
              type="number"
              min="0"
              value={labelTargetLaps}
              onChange={(event) => setLabelTargetLaps(event.target.value)}
              placeholder="Doel"
            />
            <input
              className="input input--number"
              type="number"
              min="0"
              value={labelSortOrder}
              onChange={(event) => setLabelSortOrder(event.target.value)}
              placeholder="Positie"
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
                  <LabelAdminRow
                    key={label.id}
                    label={label}
                    onSave={(fields) => updateLabel(label.id, fields)}
                    onDelete={() => removeLabel(label.id, label.name)}
                  />
                ))}
              </section>
            ))}
          </div>
        </section>
      </div>

      <section className="panel">
        <h2>Lopers beheren</h2>
        <p className="panel-copy">
          Definitief verwijderen kan alleen voor lopers zonder rondes. Gelopen data blijft bewaard voor analyse.
        </p>
        <div className="form-row form-row--plain">
          <input
            className="input input--stretch"
            value={runnerQuery}
            onChange={(event) => setRunnerQuery(event.target.value)}
            placeholder="Zoek op nummer, naam, label, status of bron..."
          />
        </div>
        {runnerMessage && <div className="host-hint">{runnerMessage}</div>}
        <div className="table-wrap">
          <AdminRunnerTable
            runners={adminRunners}
            onOpenProfile={setProfileRunnerId}
            onRestore={restoreRunner}
            onRemove={removeRunner}
          />
        </div>
      </section>

      {profileRunnerId && (
        <RunnerProfileModal runnerId={profileRunnerId} onClose={() => setProfileRunnerId(null)} />
      )}

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

function AdminRunnerTable({
  runners,
  onOpenProfile,
  onRestore,
  onRemove,
}: {
  runners: Runner[];
  onOpenProfile: (runnerId: string) => void;
  onRestore: (runner: Runner) => Promise<void>;
  onRemove: (runner: Runner) => Promise<void>;
}) {
  const columns = React.useMemo<ColumnDef<Runner>[]>(
    () => [
      { header: 'Nr.', accessorFn: (runner) => runner.runnerNumber || '-' },
      { header: 'Naam', accessorKey: 'name' },
      {
        header: 'Status',
        cell: ({ row }) => (
          <>
            {statusLabel(row.original.status)}
            {row.original.hiddenFromQueue ? ' · verborgen' : ''}
          </>
        ),
      },
      {
        header: 'Bron',
        cell: ({ row }) => <SourceBadge source={row.original.registrationSource} />,
      },
      {
        header: 'Labels',
        cell: ({ row }) => (
          <div className="label-row">
            {row.original.labels.map((label) => (
              <LabelBadge key={label.id} label={label} compact />
            ))}
          </div>
        ),
      },
      { header: 'Toeren', accessorKey: 'lapCount' },
      {
        header: 'Acties',
        cell: ({ row }) => {
          const runner = row.original;
          return (
            <div className="runner-admin-actions">
              <button className="btn btn--sm btn--fixed" onClick={() => onOpenProfile(runner.id)}>
                Profiel
              </button>
              {runner.hiddenFromQueue && (
                <button className="btn btn--sm btn--fixed" onClick={() => void onRestore(runner)}>
                  Terug tonen
                </button>
              )}
              <button
                className="btn btn--danger btn--fixed"
                onClick={() => void onRemove(runner)}
                disabled={runner.lapCount > 0 || runner.status === 'running'}
              >
                Verwijder
              </button>
            </div>
          );
        },
      },
    ],
    [onOpenProfile, onRemove, onRestore]
  );

  const table = useReactTable({
    data: runners,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <table>
      <thead>
        {table.getHeaderGroups().map((headerGroup) => (
          <tr key={headerGroup.id}>
            {headerGroup.headers.map((header) => (
              <th key={header.id}>
                {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
              </th>
            ))}
          </tr>
        ))}
      </thead>
      <tbody>
        {table.getRowModel().rows.map((row) => (
          <tr key={row.original.id}>
            {row.getVisibleCells().map((cell) => (
              <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
            ))}
          </tr>
        ))}
        {table.getRowModel().rows.length === 0 && (
          <tr>
            <td colSpan={columns.length}>Geen lopers gevonden.</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function statusOrder(status: RunnerStatus) {
  switch (status) {
    case 'running':
      return 0;
    case 'waiting':
      return 1;
    case 'warming_up':
      return 2;
    case 'ran':
      return 3;
    case 'registered':
      return 4;
    default:
      return 5;
  }
}

function statusLabel(status: RunnerStatus) {
  switch (status) {
    case 'registered':
      return 'Ingeschreven';
    case 'warming_up':
      return 'Aan het opwarmen';
    case 'waiting':
      return 'In de wachtrij';
    case 'running':
      return 'Loopt';
    case 'ran':
      return 'Heeft gelopen';
    default:
      return status;
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

function LabelAdminRow({
  label,
  onSave,
  onDelete,
}: {
  label: Label;
  onSave: (fields: { targetLaps: number | null; sortOrder: number | null }) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [target, setTarget] = React.useState(label.targetLaps?.toString() || '');
  const [sortOrder, setSortOrder] = React.useState(label.sortOrder?.toString() || '');
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    setTarget(label.targetLaps?.toString() || '');
    setSortOrder(label.sortOrder?.toString() || '');
  }, [label.targetLaps, label.sortOrder]);

  async function saveLabelSettings() {
    setSaving(true);
    try {
      await onSave({
        targetLaps: target ? Number(target) : null,
        sortOrder: sortOrder ? Number(sortOrder) : null,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="label-admin-row">
      <LabelBadge label={label} />
      <em>{label.kind}</em>
      <label className="label-target-editor">
        Doel toeren
        <input
          className="input input--number"
          type="number"
          min="0"
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          placeholder="Auto"
        />
      </label>
      <label className="label-target-editor">
        Positie
        <input
          className="input input--number"
          type="number"
          min="0"
          value={sortOrder}
          onChange={(event) => setSortOrder(event.target.value)}
          placeholder="Auto"
        />
      </label>
      <button className="btn btn--sm" onClick={saveLabelSettings} disabled={saving}>
        {saving ? 'Opslaan...' : 'Opslaan'}
      </button>
      <button className="btn btn--danger" onClick={onDelete}>
        Verwijder
      </button>
    </div>
  );
}
