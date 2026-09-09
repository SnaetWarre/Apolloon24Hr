import { SectionNavigation } from './SectionNavigation';
import React from 'react';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { useAppActions, useAppData, useClusterStatus } from '../app/index';
import { LabelBadge, labelKindOrder, labelKindTitle } from './LabelBadge';
import { SourceBadge } from './RunnerEntryModals';
import { RunnerProfileModal } from './RunnerProfileModal';
import { formatClockTimeMs } from '../lib/time';
import { buildEventReadiness, readinessSummary } from '../lib/readiness';
import type { Label, LiveAppSnapshot, PublicRecordMode, Runner, RunnerStatus, TemporaryTeam } from '../types';

const selectAdminData = ({ labels, runners, settings, temporaryTeams, host, race }: LiveAppSnapshot) => ({
  labels,
  runners,
  settings,
  temporaryTeams,
  host,
  race,
});

type AdminSection = 'preparation' | 'runners' | 'labels' | 'system' | 'public';
const ADMIN_SECTIONS: ReadonlyArray<{ id: AdminSection; label: string }> = [
  { id: 'preparation', label: 'Voorbereiding' },
  { id: 'runners', label: 'Lopers' },
  { id: 'labels', label: 'Ploegen & labels' },
  { id: 'public', label: 'Publiek' },
  { id: 'system', label: 'Systeem & herstel' },
];

export function AdminView() {
  const [activeSection, setActiveSection] = React.useState<AdminSection>('preparation');
  const { labels, runners, settings, temporaryTeams, host, race } = useAppData(selectAdminData);
  const { cluster, error: clusterError } = useClusterStatus();
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
    joinCluster,
    resolveConflict,
    transferTimingControl,
    createBackup,
    compactDatabase,
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
  const [remoteClusterUrl, setRemoteClusterUrl] = React.useState('');
  const [remotePairingCode, setRemotePairingCode] = React.useState('');
  const [clusterMessage, setClusterMessage] = React.useState<string | null>(null);
  const [clusterSaving, setClusterSaving] = React.useState(false);
  const [backupSaving, setBackupSaving] = React.useState(false);
  const [backupMessage, setBackupMessage] = React.useState<string | null>(null);
  const [compactionSaving, setCompactionSaving] = React.useState(false);
  const [clusterConflicts, setClusterConflicts] = React.useState<
    Array<{
      id: string;
      kind: 'timing' | 'data';
      operationIds: string[];
      createdAt: number;
      operations: Array<{
        id: string;
        originHostId: string;
        type: string;
        createdAt: number;
      }>;
    }>
  >([]);
  const readinessChecks = React.useMemo(() => buildEventReadiness(cluster, race), [cluster, race]);
  const readiness = readinessSummary(readinessChecks);

  React.useEffect(() => {
    if (!cluster?.enabled || cluster.conflictCount === 0) {
      setClusterConflicts([]);
      return;
    }
    let active = true;
    void fetch('/api/cluster/conflicts')
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((conflicts: typeof clusterConflicts) => {
        if (active) setClusterConflicts(conflicts);
      })
      .catch(() => {
        if (active) setClusterMessage('De lijst met syncconflicten kon niet geladen worden.');
      });
    return () => {
      active = false;
    };
  }, [cluster?.conflictCount, cluster?.enabled]);

  async function connectToCluster() {
    const remoteUrl = remoteClusterUrl.trim();
    const pairingCode = remotePairingCode.trim();
    if (!remoteUrl || !pairingCode || clusterSaving) return;
    if (
      !window.confirm(
        'Deze laptop neemt de volledige database van de andere laptop over. De huidige database wordt eerst als herstelkopie bewaard. Doorgaan?'
      )
    ) {
      return;
    }
    setClusterSaving(true);
    setClusterMessage(null);
    try {
      const result = await joinCluster(remoteUrl, pairingCode);
      setRemotePairingCode('');
      setClusterMessage(
        `Gekoppeld. De vorige lokale database staat veilig in ${result.backupFile || 'een herstelkopie'}.`
      );
    } catch (err) {
      setClusterMessage(err instanceof Error ? err.message : 'Koppelen mislukt');
    } finally {
      setClusterSaving(false);
    }
  }

  async function chooseConflictVersion(conflictId: string, selectedOperationId: string) {
    if (
      !window.confirm(
        'Deze timingversie wordt de gekozen geschiedenis voor alle laptops. Controleer het tijdstip zorgvuldig. Doorgaan?'
      )
    ) {
      return;
    }
    setClusterSaving(true);
    setClusterMessage(null);
    try {
      await resolveConflict(conflictId, selectedOperationId);
      setClusterConflicts((current) => current.filter((item) => item.id !== conflictId));
      setClusterMessage('Syncconflict opgelost; de gekozen timing wordt naar alle laptops gekopieerd.');
    } catch (err) {
      setClusterMessage(err instanceof Error ? err.message : 'Conflict oplossen mislukt');
    } finally {
      setClusterSaving(false);
    }
  }

  async function transferTiming(targetHostId: string, targetUrl: string) {
    if (
      !window.confirm(
        `Timing gecontroleerd overdragen naar ${targetUrl}? Deze laptop kan daarna niet meer klokken.`
      )
    ) {
      return;
    }
    setClusterSaving(true);
    setClusterMessage(null);
    try {
      await transferTimingControl(targetHostId);
      setClusterMessage(`Timing is overgedragen naar ${targetUrl}.`);
    } catch (err) {
      setClusterMessage(err instanceof Error ? err.message : 'Timing overdragen mislukt');
    } finally {
      setClusterSaving(false);
    }
  }

  async function makeBackup() {
    if (backupSaving) return;
    setBackupSaving(true);
    setBackupMessage(null);
    try {
      const backup = await createBackup();
      setBackupMessage(`Backup gecontroleerd en opgeslagen om ${formatClockTimeMs(backup.createdAt)}.`);
    } catch (err) {
      setBackupMessage(err instanceof Error ? err.message : 'Backup maken mislukt');
    } finally {
      setBackupSaving(false);
    }
  }

  async function compactStorage() {
    if (compactionSaving || !cluster?.backup.database.compactionRecommended) return;
    if (
      !window.confirm(
        'Apolloon maakt eerst een geverifieerde herstelbackup en verkleint daarna het SQLite-bestand. Dit kan alleen wanneer de race niet actief is. Doorgaan?'
      )
    )
      return;
    setCompactionSaving(true);
    setBackupMessage(null);
    try {
      const result = await compactDatabase();
      setBackupMessage(
        `Database veilig verkleind van ${formatFileSize(result.before.fileBytes)} naar ${formatFileSize(result.after.fileBytes)}.`
      );
    } catch (err) {
      setBackupMessage(err instanceof Error ? err.message : 'Database compactie mislukt');
    } finally {
      setCompactionSaving(false);
    }
  }

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
          const labelText = runner.labels
            .map((label) => label.name)
            .join(' ')
            .toLowerCase();
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
          <span className="page-kicker">Wedstrijdbeheer</span>
          <h1 className="app-title">Beheer</h1>
          <p className="tagline">Voorbereiding voor de lokale wedstrijddatabase.</p>
        </div>
      </div>

      <div className="management-workspace">
        <aside className="management-navigation">
          <SectionNavigation
            label="Beheeronderdelen"
            sections={ADMIN_SECTIONS}
            activeSectionId={activeSection}
            onSectionChange={setActiveSection}
          />
          {readiness !== 'ready' && (
            <button className="management-health" onClick={() => setActiveSection('system')}>
              Systeem vraagt aandacht <span>Bekijk verbinding en herstel →</span>
            </button>
          )}
        </aside>
        <div className="management-content">
          <div className="admin-dashboard">
            <section
              hidden={activeSection !== 'preparation'}
              className={`panel readiness-panel readiness-panel--${readiness} admin-dashboard__full-width`}
            >
              <div className="readiness-heading">
                <div>
                  <h2>Wedstrijdgereedheid</h2>
                  <p className="panel-copy">
                    Eén overzicht van de herstel-, synchronisatie- en timingvoorwaarden.
                  </p>
                </div>
                <strong className={`readiness-summary readiness-summary--${readiness}`}>
                  {readiness === 'ready'
                    ? 'Klaar'
                    : readiness === 'warning'
                      ? 'Aandacht nodig'
                      : 'Niet klaar'}
                </strong>
              </div>
              {clusterError && (
                <div className="warning-banner" role="alert">
                  De actuele systeemstatus kon niet worden vernieuwd: {clusterError.message}
                </div>
              )}
              <ul className="readiness-list">
                {readinessChecks.map((check) => (
                  <li className={`readiness-check readiness-check--${check.level}`} key={check.id}>
                    <span className="readiness-check__marker" aria-hidden="true">
                      {check.level === 'ready' ? '✓' : check.level === 'warning' ? '!' : '×'}
                    </span>
                    <span>
                      <strong>{check.label}</strong>
                      <small>{check.detail}</small>
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            {cluster?.enabled && (
              <section hidden={activeSection !== 'system'} className="panel admin-dashboard__full-width">
                <h2>Laptops koppelen</h2>
                <p className="panel-copy">
                  Op deze laptop: <strong>{host.url}</strong>. Koppelcode:{' '}
                  <strong>{cluster.pairingCode}</strong>. Geef beide aan de andere laptop.
                </p>
                <p className="panel-copy">
                  {cluster.connectedHosts === 1
                    ? 'Deze laptop werkt zelfstandig en blijft volledig schrijfbaar.'
                    : `${cluster.connectedHosts} laptops zijn nu bereikbaar. Iedere laptop bewaart een volledige replica.`}
                </p>
                <div className="host-hint">
                  <strong>Timing:</strong>{' '}
                  {cluster.timingControl.state === 'unassigned'
                    ? 'nog niet toegewezen; de eerste timingactie kiest deze laptop.'
                    : cluster.timingControl.state === 'local'
                      ? `deze laptop is controller (generatie ${cluster.timingControl.generation}).`
                      : cluster.timingControl.state === 'remote-reachable'
                        ? `${cluster.timingControl.controllerUrl || 'andere laptop'} is controller en bereikbaar.`
                        : 'de timingcontroller is niet bereikbaar; gebruik alleen na fysieke controle een noodovername.'}
                </div>
                <div className="host-hint">
                  <strong>Deze versie:</strong> app {cluster.compatibility.appVersion} · schema{' '}
                  {cluster.compatibility.schemaVersion} · replicatieformaat{' '}
                  {cluster.compatibility.replicationFormatVersion}
                  {cluster.compatibility.releaseId
                    ? ` · release ${cluster.compatibility.releaseId.slice(0, 12)}`
                    : ''}
                </div>
                {cluster.peers.map((peer) => (
                  <div
                    className={`host-hint cluster-peer-row${peer.compatibilityError ? ' warning-banner' : ''}`}
                    key={peer.url}
                    role={peer.compatibilityError ? 'alert' : undefined}
                  >
                    <span>
                      <strong>{peer.url}</strong>{' '}
                      {peer.compatibilityError
                        ? peer.compatibilityError
                        : peer.reachable
                          ? peer.synchronized
                            ? 'bereikbaar en gesynchroniseerd'
                            : 'bereikbaar; synchronisatie bezig'
                          : peer.lastSeenAt
                            ? `niet bereikbaar; laatst gezien om ${formatClockTimeMs(peer.lastSeenAt)}`
                            : 'nog niet bereikbaar geweest'}
                    </span>
                    {cluster.timingControl.state === 'local' &&
                      peer.id &&
                      peer.reachable &&
                      !peer.compatibilityError && (
                        <button
                          className="btn btn--secondary"
                          onClick={() => void transferTiming(peer.id!, peer.url)}
                          disabled={clusterSaving || !peer.synchronized}
                          title={
                            peer.synchronized
                              ? 'Draag timing gecontroleerd over'
                              : 'Wacht tot alle wijzigingen gesynchroniseerd zijn'
                          }
                        >
                          Timing hierheen overdragen
                        </button>
                      )}
                  </div>
                ))}
                <div className="form-row">
                  <input
                    className="input"
                    value={remoteClusterUrl}
                    onChange={(event) => setRemoteClusterUrl(event.target.value)}
                    placeholder="http://192.168.1.20:5173"
                    inputMode="url"
                  />
                  <input
                    className="input"
                    value={remotePairingCode}
                    onChange={(event) => setRemotePairingCode(event.target.value.toUpperCase())}
                    placeholder="Koppelcode"
                    maxLength={8}
                  />
                  <button
                    className="btn btn--primary btn--fixed"
                    onClick={() => void connectToCluster()}
                    disabled={!remoteClusterUrl.trim() || !remotePairingCode.trim() || clusterSaving}
                  >
                    {clusterSaving ? 'Bezig...' : 'Deze laptop koppelen'}
                  </button>
                </div>
                {clusterConflicts.map((conflict) => (
                  <div className="host-hint" key={conflict.id}>
                    <strong>{conflict.kind === 'timing' ? 'Timingconflict' : 'Dataconflict'}</strong> van{' '}
                    {new Date(conflict.createdAt).toLocaleTimeString('nl-BE')}. Kies welke actie werkelijk
                    gebeurd is.
                    {conflict.operations.map((operation, index) => (
                      <button
                        className="btn btn--secondary"
                        key={operation.id}
                        onClick={() => void chooseConflictVersion(conflict.id, operation.id)}
                        disabled={clusterSaving}
                      >
                        Versie {index + 1}: {formatConflictTime(operation.createdAt)} (
                        {operation.originHostId === cluster.hostId ? 'deze laptop' : 'andere laptop'})
                      </button>
                    ))}
                  </div>
                ))}
                {clusterMessage && <div className="host-hint">{clusterMessage}</div>}
              </section>
            )}

            {cluster?.backup && (
              <section hidden={activeSection !== 'system'} className="panel admin-dashboard__backup">
                <h2>Herstelbackups</h2>
                <p className="panel-copy">
                  {cluster.backup.enabled
                    ? 'Apolloon maakt tijdens gebruik automatisch gecontroleerde SQLite-snapshots. Recente backups blijven fijnmazig bewaard, daarna per uur en per dag.'
                    : 'Automatische backups zijn op deze installatie uitgeschakeld. Handmatige backups blijven beschikbaar.'}
                </p>
                {!cluster.backup.enabled && (
                  <div className="warning-banner" role="alert">
                    Automatische backups zijn uitgeschakeld.
                  </div>
                )}
                {cluster.backup.latest ? (
                  <div className="backup-summary">
                    <strong>Laatste backup:</strong>{' '}
                    {new Date(cluster.backup.latest.createdAt).toLocaleString('nl-BE')} ·{' '}
                    {formatRelativeAge(cluster.backup.latest.createdAt)} ·{' '}
                    {formatFileSize(cluster.backup.latest.sizeBytes)} · gecontroleerd ·{' '}
                    {cluster.backup.retainedCount} bewaard ({formatFileSize(cluster.backup.retainedBytes)})
                    <div className="backup-checksum">
                      <span>SHA-256</span>
                      <code>{cluster.backup.latest.sha256}</code>
                    </div>
                  </div>
                ) : (
                  <div className="warning-banner" role="alert">
                    Er is op deze laptop nog geen herstelbackup.
                  </div>
                )}
                {cluster.backup.lastError && (
                  <div className="warning-banner" role="alert">
                    Laatste automatische backup mislukt: {cluster.backup.lastError}
                  </div>
                )}
                {cluster.backup.diskLow && (
                  <div className="warning-banner" role="alert">
                    Weinig opslagruimte: nog{' '}
                    {cluster.backup.diskFreeBytes === null
                      ? 'onbekend'
                      : formatFileSize(cluster.backup.diskFreeBytes)}{' '}
                    vrij; de veiligheidsgrens is {formatFileSize(cluster.backup.minimumFreeBytes)}.
                  </div>
                )}
                <div className="backup-metrics">
                  <span>
                    <strong>Volgende automatische backup</strong>
                    {cluster.backup.enabled && cluster.backup.nextScheduledAt
                      ? new Date(cluster.backup.nextScheduledAt).toLocaleTimeString('nl-BE')
                      : 'niet gepland'}
                  </span>
                  <span>
                    <strong>Vrije opslag</strong>
                    {cluster.backup.diskFreeBytes === null
                      ? 'onbekend'
                      : formatFileSize(cluster.backup.diskFreeBytes)}
                  </span>
                  <span>
                    <strong>SQLite-database</strong>
                    {formatFileSize(cluster.backup.database.fileBytes)} ·{' '}
                    {formatFileSize(cluster.backup.database.usedBytes)} werkelijk in gebruik
                  </span>
                  <span>
                    <strong>Backupplafond</strong>
                    {formatFileSize(cluster.backup.retainedBytes)} van{' '}
                    {formatFileSize(cluster.backup.maximumRetainedBytes)}
                  </span>
                </div>
                {cluster.backup.database.compactionRecommended && (
                  <div className="database-storage-note" role="status">
                    <strong>Geen dataprobleem:</strong> de database bevat{' '}
                    {formatFileSize(cluster.backup.database.reclaimableBytes)} lege ruimte die SQLite later
                    opnieuw kan gebruiken. Het bestand is daarom{' '}
                    {formatFileSize(cluster.backup.database.fileBytes)}, terwijl{' '}
                    {formatFileSize(cluster.backup.database.usedBytes)} werkelijk in gebruik is.
                    {cluster.backup.database.raceActive
                      ? ' Verkleinen kan veilig zodra de race afgelopen is.'
                      : ' Je kunt het bestand nu veilig verkleinen.'}
                  </div>
                )}
                <div className="form-row form-row--plain backup-actions">
                  <button
                    className="btn btn--primary"
                    onClick={() => void makeBackup()}
                    disabled={backupSaving || cluster.backup.inProgress || cluster.backup.queued}
                    aria-busy={backupSaving || cluster.backup.inProgress}
                  >
                    {cluster.backup.queued
                      ? 'Backup wacht...'
                      : backupSaving || cluster.backup.inProgress
                        ? 'Backup bezig...'
                        : 'Nu backup maken'}
                  </button>
                  {cluster.backup.latest && (
                    <>
                      <a className="btn btn--secondary" href="/api/backups/latest" download>
                        Laatste backup downloaden
                      </a>
                      <a className="btn btn--secondary" href="/api/backups/latest/manifest" download>
                        Controlebestand downloaden
                      </a>
                    </>
                  )}
                  {cluster.backup.database.compactionRecommended && (
                    <button
                      className="btn btn--secondary"
                      onClick={() => void compactStorage()}
                      disabled={
                        compactionSaving ||
                        cluster.backup.database.raceActive ||
                        cluster.backup.inProgress ||
                        cluster.backup.maintenanceInProgress
                      }
                    >
                      {compactionSaving || cluster.backup.maintenanceInProgress
                        ? 'Database verkleinen...'
                        : 'Database veilig verkleinen'}
                    </button>
                  )}
                </div>
                <p className="panel-copy">
                  Download regelmatig een kopie naar een andere laptop of USB-stick. Gesynchroniseerde
                  replica's beschermen tegen een defect toestel; deze versies beschermen ook tegen een fout
                  die naar alle laptops wordt gesynchroniseerd.
                </p>
                {backupMessage && (
                  <div className="success-banner" role="status" aria-live="polite">
                    {backupMessage}
                  </div>
                )}
              </section>
            )}

            <section hidden={activeSection !== 'public'} className="panel admin-dashboard__public-event">
              <h2>Publiek moment</h2>
              <p className="panel-copy">Slaat het moment op en toont de flash alleen op het buitenscherm.</p>
              <button
                className="btn btn--primary btn--xl"
                onClick={triggerBurgieGepakt}
                disabled={eventSaving}
              >
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

            <section hidden={activeSection !== 'preparation'} className="panel admin-dashboard__import">
              <h2>Google Sheets CSV import</h2>
              <p className="panel-copy">
                Import zet nieuwe lopers in de ingeschreven databank. Ze verschijnen pas op het bord wanneer
                je ze activeert in Telsysteem 1.
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

            <section hidden={activeSection !== 'labels'} className="panel admin-dashboard__labels">
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
                <select
                  className="input"
                  value={labelKind}
                  onChange={(event) => setLabelKind(event.target.value)}
                >
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
                <button
                  className="btn btn--primary"
                  onClick={addLabel}
                  disabled={!labelName.trim() || addingLabel}
                >
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

          <section hidden={activeSection !== 'labels'} className="panel">
            <h2>Tijdelijke nachtploegen</h2>
            <p className="panel-copy">
              Stel de leden vooraf in. Activeren vervangt hun gewone speedteam tijdelijk; deactiveren zet die
              automatisch terug.
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
              <div className="empty-inline">
                Maak hierboven eerst een label van het type Tijdelijke nachtploeg.
              </div>
            )}
          </section>

          <section hidden={activeSection !== 'runners'} className="panel">
            <h2>Lopers beheren</h2>
            <p className="panel-copy">
              Definitief verwijderen kan alleen voor lopers zonder rondes. Gelopen data blijft bewaard voor
              analyse.
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

          <section hidden={activeSection !== 'system'} className="panel">
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
        </div>
      </div>
    </>
  );
}

function formatConflictTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.toLocaleTimeString('nl-BE', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 ** 2) return `${(bytes / 1_024).toFixed(1)} KiB`;
  if (bytes < 1_024 ** 3) return `${(bytes / 1_024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1_024 ** 3).toFixed(1)} GiB`;
}

function formatRelativeAge(timestamp: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return 'zonet';
  if (minutes === 1) return '1 minuut geleden';
  if (minutes < 60) return `${minutes} minuten geleden`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return '1 uur geleden';
  if (hours < 48) return `${hours} uur geleden`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 dag geleden' : `${days} dagen geleden`;
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
