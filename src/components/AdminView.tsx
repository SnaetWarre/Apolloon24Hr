import React from 'react';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { useAppActions, useAppData } from '../app/index';
import { LabelBadge, labelKindOrder, labelKindTitle } from './LabelBadge';
import { SourceBadge } from './RunnerEntryModals';
import { RunnerProfileModal } from './RunnerProfileModal';
import { formatClockTimeMs } from '../lib/time';
import type { AppSnapshot, Label, PublicRecordMode, Runner, RunnerStatus, TemporaryTeam } from '../types';

const selectAdminData = ({ labels, runners, settings, temporaryTeams }: AppSnapshot) => ({
  labels,
  runners,
  settings,
  temporaryTeams,
});

export function AdminView() {
  const { labels, runners, settings, temporaryTeams } = useAppData(selectAdminData);
  const {
    importRunnersCsv,
    createLabel,
    updateLabel,
    deleteLabel,
    deleteRunner,
    unhideRunner,
    burgieGepakt,
    updatePublicRecordMode,
    setTemporaryTeamMembers,
    setTemporaryTeamActive,
  } = useAppActions();
  const [csvText, setCsvText] = React.useState('');
  const [csvFileName, setCsvFileName] = React.useState('');
  const [message, setMessage] = React.useState<string | null>(null);
  const [importing, setImporting] = React.useState(false);
  const [eventMessage, setEventMessage] = React.useState<string | null>(null);
  const [eventSaving, setEventSaving] = React.useState(false);
  const [recordModeSaving, setRecordModeSaving] = React.useState(false);
  const [runnerMessage, setRunnerMessage] = React.useState<string | null>(null);
  const [runnerQuery, setRunnerQuery] = React.useState('');
  const [labelName, setLabelName] = React.useState('');
  const [labelColor, setLabelColor] = React.useState('#3b82f6');
  const [labelKind, setLabelKind] = React.useState('andere');
  const [labelImageUrl, setLabelImageUrl] = React.useState('');
  const [labelTargetLaps, setLabelTargetLaps] = React.useState('');
  const [labelSortOrder, setLabelSortOrder] = React.useState('');
  const [labelMessage, setLabelMessage] = React.useState<string | null>(null);
  const [addingLabel, setAddingLabel] = React.useState(false);
  const [profileRunnerId, setProfileRunnerId] = React.useState<string | null>(null);

  async function importCsv() {
    if (!csvText.trim() || importing) return;
    setMessage(null);
    setImporting(true);
    try {
      const summary = await importRunnersCsv(csvText);
      setMessage(summary);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Import mislukt');
    } finally {
      setImporting(false);
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
    if (!name || addingLabel) return;
    setAddingLabel(true);
    setLabelMessage(null);
    try {
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
    } catch (err) {
      setLabelMessage(err instanceof Error ? err.message : 'Label toevoegen mislukt');
    } finally {
      setAddingLabel(false);
    }
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

  async function changePublicRecordMode(publicRecordMode: PublicRecordMode) {
    setEventMessage(null);
    setRecordModeSaving(true);
    try {
      const nextSettings = await updatePublicRecordMode(publicRecordMode);
      setEventMessage(`Recordflits staat op ${publicRecordModeLabel(nextSettings.publicRecordMode)}.`);
    } catch (err) {
      setEventMessage(err instanceof Error ? err.message : 'Recordflits aanpassen mislukt');
    } finally {
      setRecordModeSaving(false);
    }
  }

  async function removeLabel(id: string, name: string) {
    if (!window.confirm(`Label ${name} verwijderen? Dit verwijdert het label ook van lopers.`)) return;
    setLabelMessage(null);
    try {
      await deleteLabel(id);
      setLabelMessage(`${name} is verwijderd.`);
    } catch (err) {
      setLabelMessage(err instanceof Error ? err.message : 'Label verwijderen mislukt');
    }
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
          <div className="form-row form-row--plain public-record-mode-row">
            <label htmlFor="public-record-mode">
              <strong>Recordflits</strong>
            </label>
            <select
              id="public-record-mode"
              className="input"
              value={settings.publicRecordMode}
              onChange={(event) => void changePublicRecordMode(event.target.value as PublicRecordMode)}
              disabled={recordModeSaving}
            >
              <option value="off">Uit</option>
              <option value="day">Dagrecord</option>
              <option value="two_hour">Per 2 uur</option>
              <option value="hour">Per uur</option>
            </select>
          </div>
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
            <button
              className="btn btn--primary btn--fixed"
              onClick={importCsv}
              disabled={!csvText.trim() || importing}
            >
              {importing ? 'Importeren...' : 'Importeren'}
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
              <option value="temporary_team">Tijdelijke nachtploeg</option>
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
            <button className="btn btn--primary" onClick={addLabel} disabled={!labelName.trim() || addingLabel}>
              {addingLabel ? 'Toevoegen...' : 'Label toevoegen'}
            </button>
          </div>

          {labelMessage && <div className="host-hint">{labelMessage}</div>}

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
        <h2>Tijdelijke nachtploegen</h2>
        <p className="panel-copy">
          Stel de leden vooraf in. Activeren vervangt hun gewone speedteam tijdelijk; deactiveren zet die automatisch terug.
        </p>
        {temporaryTeams.length ? (
          <div className="temporary-team-list">
            {temporaryTeams.map((team) => {
              const label = labels.find((item) => item.id === team.labelId);
              return label ? (
                <TemporaryTeamAdminCard
                  key={team.labelId}
                  label={label}
                  team={team}
                  allTeams={temporaryTeams}
                  runners={runners}
                  onSaveMembers={setTemporaryTeamMembers}
                  onSetActive={setTemporaryTeamActive}
                />
              ) : null;
            })}
          </div>
        ) : (
          <div className="empty-inline">Maak hierboven eerst een label van het type Tijdelijke nachtploeg.</div>
        )}
      </section>

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

function publicRecordModeLabel(mode: PublicRecordMode) {
  if (mode === 'off') return 'uit';
  if (mode === 'hour') return 'per uur';
  if (mode === 'two_hour') return 'per 2 uur';
  return 'dagrecord';
}

function TemporaryTeamAdminCard({
  label,
  team,
  allTeams,
  runners,
  onSaveMembers,
  onSetActive,
}: {
  label: Label;
  team: TemporaryTeam;
  allTeams: TemporaryTeam[];
  runners: Runner[];
  onSaveMembers: (labelId: string, runnerIds: string[]) => Promise<TemporaryTeam>;
  onSetActive: (labelId: string, active: boolean) => Promise<TemporaryTeam>;
}) {
  const [selectedIds, setSelectedIds] = React.useState<string[]>(team.memberRunnerIds);
  const [query, setQuery] = React.useState('');
  const [membersOpen, setMembersOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [feedback, setFeedback] = React.useState<string | null>(null);

  React.useEffect(() => {
    setSelectedIds(team.memberRunnerIds);
  }, [team.memberRunnerIds.join('|')]);

  const otherMemberIds = new Set(
    allTeams.filter((item) => item.labelId !== team.labelId).flatMap((item) => item.memberRunnerIds)
  );
  const selectedRunners = selectedIds
    .map((id) => runners.find((runner) => runner.id === id))
    .filter((runner): runner is Runner => Boolean(runner))
    .sort(compareRunnerIdentity);
  const normalizedQuery = query.trim().toLowerCase();
  const availableRunners = runners
    .filter((runner) => !selectedIds.includes(runner.id))
    .filter((runner) => {
      if (!normalizedQuery) return true;
      return (
        runner.name.toLowerCase().includes(normalizedQuery) ||
        (runner.runnerNumber || '').toLowerCase().includes(normalizedQuery) ||
        runner.labels.some((item) => item.name.toLowerCase().includes(normalizedQuery))
      );
    })
    .sort(compareRunnerIdentity);
  const dirty = [...selectedIds].sort().join('|') !== [...team.memberRunnerIds].sort().join('|');

  function openMembers() {
    setSelectedIds(team.memberRunnerIds);
    setQuery('');
    setFeedback(null);
    setMembersOpen(true);
  }

  function closeMembers() {
    if (dirty && !window.confirm('Niet-opgeslagen wijzigingen aan de ledenlijst weggooien?')) return;
    setMembersOpen(false);
  }

  async function saveMembers() {
    if (busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      await onSaveMembers(team.labelId, selectedIds);
      setFeedback(`${selectedIds.length} leden opgeslagen.`);
      setMembersOpen(false);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Ledenlijst opslaan mislukt');
    } finally {
      setBusy(false);
    }
  }

  React.useEffect(() => {
    if (!membersOpen) return undefined;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeMembers();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [membersOpen, dirty]);

  async function changeActive() {
    if (busy) return;
    const action = team.active ? 'deactiveren' : 'activeren';
    if (!window.confirm(`${label.name} ${action} voor ${team.memberRunnerIds.length} lopers?`)) return;
    setBusy(true);
    setFeedback(null);
    try {
      await onSetActive(team.labelId, !team.active);
      setFeedback(team.active ? 'Gewone speedteams zijn hersteld.' : `${label.name} is actief.`);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : `${label.name} ${action} mislukt`);
    } finally {
      setBusy(false);
    }
  }

  const memberNames = team.memberRunnerIds
    .map((id) => runners.find((runner) => runner.id === id))
    .filter((runner): runner is Runner => Boolean(runner));

  return (
    <>
      <article className={`temporary-team-card${team.active ? ' is-active' : ''}`}>
      <div className="panel-heading-row">
        <div>
          <LabelBadge label={label} />
          <p className="panel-copy">
            {team.active
              ? `Actief sinds ${team.activatedAt ? formatClockTimeMs(team.activatedAt) : 'onbekend'}`
              : `${team.memberRunnerIds.length} leden ingesteld`}
          </p>
        </div>
        <span className={`status-badge${team.active ? ' status-badge--running' : ''}`}>
          {team.active ? 'Actief' : 'Niet actief'}
        </span>
      </div>

      <div className="temporary-team-summary">
        <span className="muted-label">Huidige leden</span>
        {memberNames.length ? (
          <div className="temporary-team-member-preview">
            {memberNames.slice(0, 5).map((runner) => (
              <span key={runner.id}>{runner.runnerNumber ? `${runner.runnerNumber} · ` : ''}{runner.name}</span>
            ))}
            {memberNames.length > 5 && <em>+{memberNames.length - 5} andere</em>}
          </div>
        ) : (
          <div className="empty-inline">Nog geen leden geselecteerd.</div>
        )}
      </div>
      <div className="form-row form-row--plain">
        <button className="btn btn--ghost" onClick={openMembers} disabled={busy}>
          {team.active ? 'Ledenlijst bekijken' : 'Ledenlijst beheren'}
        </button>
        <button
          className={`btn ${team.active ? 'btn--danger' : 'btn--primary'}`}
          onClick={changeActive}
          disabled={busy || (!team.active && team.memberRunnerIds.length === 0)}
        >
          {busy ? 'Bezig...' : team.active ? 'Deactiveren' : 'Activeren'}
        </button>
      </div>
      {feedback && <div className="host-hint">{feedback}</div>}
      </article>

      {membersOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={`Ledenlijst ${label.name}`}>
          <div className="modal temporary-team-modal">
            <div className="modal-header">
              <div>
                <span className="muted-label">Tijdelijke nachtploeg</span>
                <h2>Ledenlijst beheren</h2>
                <p><LabelBadge label={label} /> · {selectedIds.length} geselecteerd</p>
              </div>
              <button className="icon-btn" onClick={closeMembers} aria-label="Sluiten">x</button>
            </div>

            {team.active && (
              <div className="warning-banner">De ploeg is actief. Deactiveer ze eerst om de ledenlijst te wijzigen.</div>
            )}

            <div className="temporary-team-member-manager">
              <section className="temporary-team-member-column temporary-team-member-column--selected">
                <div className="temporary-team-column-heading">
                  <div>
                    <span className="muted-label">Geselecteerd</span>
                    <h3>Huidige leden</h3>
                  </div>
                  <strong>{selectedRunners.length}</strong>
                </div>
                <div className="temporary-team-member-list">
                  {selectedRunners.length ? selectedRunners.map((runner) => (
                    <div key={runner.id} className="temporary-team-member-row">
                      <RunnerIdentity runner={runner} />
                      {!team.active && (
                        <button
                          className="btn btn--danger btn--sm"
                          onClick={() => setSelectedIds((current) => current.filter((id) => id !== runner.id))}
                        >
                          Verwijder
                        </button>
                      )}
                    </div>
                  )) : <div className="empty-inline">Nog niemand geselecteerd.</div>}
                </div>
              </section>

              <section className="temporary-team-member-column">
                <div className="temporary-team-column-heading">
                  <div>
                    <span className="muted-label">Beschikbaar</span>
                    <h3>Lopers toevoegen</h3>
                  </div>
                  <strong>{availableRunners.length}</strong>
                </div>
                <input
                  autoFocus
                  className="input input--search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Zoek op nummer, naam of speedteam..."
                />
                <div className="temporary-team-member-list">
                  {availableRunners.length ? availableRunners.map((runner) => {
                    const assignedElsewhere = otherMemberIds.has(runner.id);
                    const baseTeams = runner.labels.filter((item) => item.kind === 'speedteam');
                    const invalidBaseTeam = baseTeams.length !== 1;
                    return (
                      <div key={runner.id} className={`temporary-team-member-row${assignedElsewhere || invalidBaseTeam ? ' is-disabled' : ''}`}>
                        <RunnerIdentity
                          runner={runner}
                          detail={assignedElsewhere
                            ? 'Zit al in een andere nachtploeg'
                            : invalidBaseTeam
                              ? 'Heeft niet exact één speedteam'
                              : baseTeams[0].name}
                        />
                        <button
                          className="btn btn--primary btn--sm"
                          disabled={team.active || assignedElsewhere || invalidBaseTeam}
                          onClick={() =>
                            setSelectedIds((current) =>
                              current.includes(runner.id) ? current : [...current, runner.id]
                            )
                          }
                        >
                          Voeg toe
                        </button>
                      </div>
                    );
                  }) : <div className="empty-inline">Geen lopers gevonden.</div>}
                </div>
              </section>
            </div>

            <div className="temporary-team-modal-actions">
              <button className="btn btn--ghost" onClick={closeMembers}>Annuleren</button>
              {!team.active && (
                <button className="btn btn--primary" onClick={saveMembers} disabled={busy || !dirty}>
                  {busy ? 'Opslaan...' : `Ledenlijst opslaan (${selectedIds.length})`}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function RunnerIdentity({ runner, detail }: { runner: Runner; detail?: string }) {
  const baseTeam = runner.labels.find((label) => label.kind === 'speedteam');
  return (
    <div className="temporary-team-runner-identity">
      <strong>{runner.runnerNumber ? `${runner.runnerNumber} - ` : ''}{runner.name}</strong>
      <span>{detail || baseTeam?.name || 'Geen speedteam'}</span>
    </div>
  );
}

function compareRunnerIdentity(a: Runner, b: Runner) {
  return (
    (a.runnerNumber || '').localeCompare(b.runnerNumber || '', undefined, { numeric: true }) ||
    a.name.localeCompare(b.name)
  );
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
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setTarget(label.targetLaps?.toString() || '');
    setSortOrder(label.sortOrder?.toString() || '');
  }, [label.targetLaps, label.sortOrder]);

  async function saveLabelSettings() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        targetLaps: target ? Number(target) : null,
        sortOrder: sortOrder ? Number(sortOrder) : null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Label opslaan mislukt');
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
      {error && <span className="warning-inline">{error}</span>}
    </div>
  );
}
