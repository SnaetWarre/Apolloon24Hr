import { SectionNavigation } from './SectionNavigation';
import React from 'react';
import { useAppActions, useAppData, useClusterStatus } from '../app/index';
import { labelKindTitle } from './LabelBadge';
import { RunnerProfileModal } from './RunnerProfileModal';
import { formatClockTimeMs } from '../lib/time';
import { buildEventReadiness, readinessSummary } from '../lib/readiness';
import { AdminRunnerTable } from './admin/AdminRunnerTable';
import { LabelAdminRow } from './admin/LabelAdminRow';
import { TemporaryTeamAdminCard } from './admin/TemporaryTeamAdminCard';
import { TemporaryTeamCreateForm } from './admin/TemporaryTeamCreateForm';
import { NetworkSetupPanel } from './NetworkSetupPanel';
import {
  formatConflictTime,
  formatFileSize,
  formatRelativeAge,
  groupLabels,
  publicRecordModeLabel,
  statusLabel,
  statusOrder,
} from './admin/adminFormat';
import type { LiveAppSnapshot, PublicRecordMode, Runner } from '../types';

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
    createTemporaryTeam,
    setTemporaryTeamSchedule,
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
  const [runnerHour, setRunnerHour] = React.useState('');
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
  const openReadinessCount = readinessChecks.filter((check) => check.level !== 'ready').length;

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

  const availableHours = React.useMemo(
    () => [...new Set(runners.flatMap((runner) => runner.registration?.availableHours ?? []))]
      .sort((a, b) => {
        const day = (hour: string) => hour.toLowerCase().includes('dinsdag') ? 0 : hour.toLowerCase().includes('woensdag') ? 1 : 2;
        return day(a) - day(b) || a.localeCompare(b, 'nl-BE', { numeric: true });
      }),
    [runners]
  );

  const matchingAdminRunners = React.useMemo(() => {
    const q = runnerQuery.trim().toLowerCase();
    return runners
      .filter((runner) => !runnerHour || runner.registration?.availableHours.includes(runnerHour))
      .filter((runner) => {
        if (!q) return true;
        const labelText = runner.labels
          .map((label) => label.name)
          .join(' ')
          .toLowerCase();
        return (
          runner.name.toLowerCase().includes(q) ||
          (runner.runnerNumber || '').toLowerCase().includes(q) ||
          runner.status.toLowerCase().includes(q) ||
          runner.registrationSource.toLowerCase().includes(q) ||
          labelText.includes(q) ||
          runner.registration?.availableHours.some((hour) => hour.toLowerCase().includes(q))
        );
      })
      .sort(
        (a, b) =>
          statusOrder(a.status) - statusOrder(b.status) ||
          (a.runnerNumber || '').localeCompare(b.runnerNumber || '', undefined, { numeric: true }) ||
          a.name.localeCompare(b.name)
      );
  }, [runnerHour, runnerQuery, runners]);
  const adminRunners = matchingAdminRunners.slice(0, 150);
  const runnerStatusCounts = React.useMemo(() => {
    const counts = new Map<Runner['status'], number>();
    for (const runner of matchingAdminRunners) {
      counts.set(runner.status, (counts.get(runner.status) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort(([a], [b]) => statusOrder(a) - statusOrder(b))
      .map(([status, count]) => `${statusLabel(status)}: ${count}`)
      .join(' · ');
  }, [matchingAdminRunners]);

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
          <h1 className="app-title">Beheer</h1>
          <p className="tagline">Lopers, ploegen en instellingen voor de wedstrijd.</p>
        </div>
      </div>

      <div className="management-workspace">
        <aside className="management-navigation">
          <SectionNavigation
            label="Beheeronderdelen"
            sections={ADMIN_SECTIONS}
            activeSectionId={activeSection}
            onSectionChange={setActiveSection}
            attentionIds={readiness === 'ready' ? [] : (['system'] as AdminSection[])}
          />
          {readiness !== 'ready' && (
            <button className="management-health" onClick={() => setActiveSection('system')}>
              Systeem vraagt aandacht <span>Bekijk verbinding en herstel →</span>
            </button>
          )}
        </aside>
        <div className="management-content">
          <section hidden={activeSection !== 'labels'} className="panel">
            <h2>Tijdelijke nachtploegen</h2>
            <p className="panel-copy">
              Plan wanneer de lopers tijdelijk van hun gewone speedteam naar deze ploeg gaan. Na het einduur keren ze automatisch terug.
            </p>
            <TemporaryTeamCreateForm runners={runners} allTeams={temporaryTeams} onCreate={createTemporaryTeam} />
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
                      onSetSchedule={setTemporaryTeamSchedule}
                    />
                  ) : null;
                })}
              </div>
            ) : (
              <div className="empty-inline">
                Nog geen tijdelijke nachtploegen. Maak hierboven de eerste aan.
              </div>
            )}
          </section>

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
                      ? `Aandacht nodig · ${openReadinessCount} open`
                      : `Niet klaar · ${openReadinessCount} open`}
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
                      {check.id === 'timing-controller' && check.level !== 'ready' && (
                        <button
                          className="btn btn--ghost btn--sm readiness-check-action"
                          onClick={() => setActiveSection('system')}
                        >
                          Naar Systeem &amp; herstel →
                        </button>
                      )}
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
                {(cluster.deadLetterCount ?? 0) > 0 && (
                  <div className="warning-banner" role="alert">
                    {cluster.deadLetterCount} synchronisatie-actie{(cluster.deadLetterCount ?? 0) === 1 ? ' is' : 's zijn'} in
                    quarantaine gezet omdat de data fout was. De sync loopt door, maar controleer welke
                    wijziging mist en voer die indien nodig opnieuw in.
                  </div>
                )}
              </section>
            )}

            <section hidden={activeSection !== 'system'} className="panel">
              <NetworkSetupPanel />
            </section>

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
                Een formulierexport met E-mailadres en Voornaam + naam neemt het spreadsheetrijnummer als lopersnummer en bewaart alle inschrijvingsantwoorden in het profiel.
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

          <section hidden={activeSection !== 'runners'} className="panel">
            <h2>Lopers beheren</h2>
            <p className="panel-copy">
              Definitief verwijderen kan alleen voor lopers zonder rondes. Gelopen data blijft bewaard voor
              analyse.
            </p>
            <div className="form-row form-row--plain">
              <input
                className="input input--stretch"
                aria-label="Lopers zoeken"
                value={runnerQuery}
                onChange={(event) => setRunnerQuery(event.target.value)}
                placeholder="Zoek op nummer, naam, label, status, bron of uur..."
              />
              <select
                className="input"
                aria-label="Beschikbaar tijdens"
                value={runnerHour}
                onChange={(event) => setRunnerHour(event.target.value)}
              >
                <option value="">Alle beschikbare uren</option>
                {availableHours.map((hour) => <option key={hour} value={hour}>{hour}</option>)}
              </select>
            </div>
            <p className="panel-copy" role="status">
              {matchingAdminRunners.length} {matchingAdminRunners.length === 1 ? 'loper' : 'lopers'} gevonden
              {runnerHour ? ` voor ${runnerHour}` : ''}
              {matchingAdminRunners.length > 150 ? ' · eerste 150 getoond' : ''}
              {runnerStatusCounts ? ` · ${runnerStatusCounts}` : ''}
            </p>
            {runnerHour && <p className="panel-copy">Beschikbaarheid komt uit de inschrijving. De status toont de huidige stap in de app, niet de fysieke locatie.</p>}
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
