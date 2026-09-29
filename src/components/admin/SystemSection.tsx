import React from 'react';
import { useAppActions } from '../../app/index';
import { formatClockTimeMs } from '../../lib/time';
import { useConfirm } from '../ConfirmDialog';
import { NetworkSetupPanel } from '../NetworkSetupPanel';
import type { BackupStatus, ClusterStatus, Runner } from '../../types';
import { AdminNoticeBanner, useAdminAction } from './AdminNotice';
import { formatFileSize, formatRelativeAge } from './adminFormat';

export function SystemSection({
  cluster,
  hostUrl,
  runners,
  labelCount,
}: {
  cluster: ClusterStatus | null;
  hostUrl: string;
  runners: Runner[];
  labelCount: number;
}) {
  return (
    <>
      {cluster?.enabled && <ClusterPanel cluster={cluster} hostUrl={hostUrl} />}
      <section className="panel">
        <NetworkSetupPanel />
      </section>
      {cluster && <BackupPanel backup={cluster.backup} />}
      <section className="panel">
        <h2>Database status</h2>
        <div className="stats-grid">
          <div className="stat-panel">
            <span className="muted-label">Lopers</span>
            <strong>{runners.length}</strong>
          </div>
          <div className="stat-panel">
            <span className="muted-label">Labels</span>
            <strong>{labelCount}</strong>
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

function ClusterPanel({ cluster, hostUrl }: { cluster: ClusterStatus; hostUrl: string }) {
  const confirm = useConfirm();
  const { joinPrimary, promoteToPrimary } = useAppActions();
  const { pending, notice, run } = useAdminAction();
  const [primaryUrl, setPrimaryUrl] = React.useState('');

  async function join() {
    const url = primaryUrl.trim();
    if (!url || pending) return;
    const confirmed = await confirm({
      title: 'Standby worden van deze laptop?',
      message:
        'Deze laptop neemt de volledige database van de primaire laptop over en geeft voortaan elke wijziging aan die laptop door. De huidige database wordt eerst als backup bewaard.',
      confirmLabel: 'Koppelen en overnemen',
      tone: 'danger',
    });
    if (!confirmed) return;
    const result = await run(
      () => joinPrimary(url),
      ({ backupFile }) => `Gekoppeld als standby. De vorige database staat in de backup ${backupFile}.`,
      'Koppelen mislukt'
    );
    if (result) setPrimaryUrl('');
  }

  async function promote() {
    if (pending) return;
    const planned = await confirm({
      title: 'Deze laptop primair maken?',
      message:
        'De huidige primaire laptop geeft alles door en wordt standby. Werk daarna op deze laptop en open op browserlaptops en schermen het adres van deze laptop.',
      confirmLabel: 'Primair maken',
    });
    if (!planned) return;
    const outcome = await run(
      () => promoteToPrimary(false),
      ({ result }) =>
        result === 'primary-unreachable'
          ? 'De primaire laptop is niet bereikbaar.'
          : 'Deze laptop is nu primair. De vorige primaire laptop volgt als standby.',
      'Overnemen mislukt'
    );
    if (outcome?.result !== 'primary-unreachable') return;

    const emergency = await confirm({
      title: 'Noodovername: primaire laptop onbereikbaar',
      message:
        'Neem alleen over als de primaire laptop echt gestopt of losgekoppeld is. Wijzigingen van de laatste seconden die nog niet gekopieerd waren, kunnen ontbreken. Komt die laptop later terug, dan volgt hij automatisch deze laptop en bewaart hij zijn eigen data in een backup.',
      confirmLabel: 'Noodovername',
      tone: 'danger',
    });
    if (emergency) {
      await run(
        () => promoteToPrimary(true),
        'Noodovername gelukt. Controleer de laatste rondes.',
        'Noodovername mislukt'
      );
    }
  }

  const primary = cluster.primary;
  return (
    <section className="panel">
      <h2>Laptops koppelen</h2>
      {cluster.role === 'primary' ? (
        <>
          <p className="panel-copy">
            Deze laptop is <strong>primair</strong>: alle wijzigingen gebeuren hier. Adres voor andere laptops:{' '}
            <strong>{hostUrl}</strong>.
          </p>
          {cluster.standbys.length ? (
            cluster.standbys.map((standby) => (
              <div className="host-hint cluster-peer-row" key={standby.hostId}>
                <strong>{standby.url}</strong>
                <span>
                  {!standby.reachable
                    ? `niet bereikbaar; laatst gezien om ${formatClockTimeMs(standby.lastSeenAt)}`
                    : standby.caughtUp
                      ? 'standby, volledig bij'
                      : 'standby, werkt bij'}
                </span>
              </div>
            ))
          ) : (
            <div className="host-hint">
              Nog geen standby. Open Beheer op een tweede laptop en koppel die met het adres hierboven.
            </div>
          )}
        </>
      ) : (
        <>
          <p className="panel-copy">
            Deze laptop is <strong>standby</strong>: ze houdt een volledige kopie bij en geeft wijzigingen door aan{' '}
            <strong>{primary?.url ?? 'onbekend'}</strong>
            {primary?.reachable
              ? primary.lagEntries
                ? ` en haalt nog ${primary.lagEntries} wijzigingen op.`
                : ' en is volledig bij.'
              : primary?.lastContactAt
                ? `, maar die is niet bereikbaar sinds ${formatClockTimeMs(primary.lastContactAt)}.`
                : ', maar die is nog niet bereikt.'}
          </p>
          <div className="form-row form-row--plain">
            <button
              className="btn btn--primary"
              onClick={() => void promote()}
              disabled={pending || Boolean(cluster.busy)}
            >
              {pending ? 'Bezig...' : 'Deze laptop primair maken'}
            </button>
          </div>
        </>
      )}
      {cluster.competingPrimaryUrl && (
        <div className="warning-banner" role="alert">
          Ook {cluster.competingPrimaryUrl} is primair. Koppel één van beide opnieuw als standby.
        </div>
      )}
      {cluster.lastError && (
        <div className="warning-banner" role="alert">
          {cluster.lastError}
        </div>
      )}
      {cluster.role === 'primary' && (
        <>
          <p className="panel-copy">Of maak deze laptop standby van een andere, primaire laptop:</p>
          <div className="form-row">
            <input
              className="input"
              value={primaryUrl}
              onChange={(event) => setPrimaryUrl(event.target.value)}
              placeholder="http://192.168.1.20:5173"
              inputMode="url"
              aria-label="Adres van de primaire laptop"
            />
            <button
              className="btn btn--primary btn--fixed"
              onClick={() => void join()}
              disabled={!primaryUrl.trim() || pending}
            >
              {pending ? 'Bezig...' : 'Standby worden'}
            </button>
          </div>
        </>
      )}
      <div className="host-hint">
        <strong>Deze versie:</strong> Apolloon {cluster.appVersion} · schema {cluster.schemaVersion}
      </div>
      <AdminNoticeBanner notice={notice} />
    </section>
  );
}

function BackupPanel({ backup }: { backup: BackupStatus }) {
  const { createBackup } = useAppActions();
  const { pending, notice, run } = useAdminAction();
  const busy = pending || backup.inProgress;

  return (
    <section className="panel">
      <h2>Herstelbackups</h2>
      <p className="panel-copy">
        {backup.enabled
          ? 'Apolloon maakt tijdens gebruik automatisch gecontroleerde kopieën van de database en bewaart de recentste.'
          : 'Automatische backups zijn op deze installatie uitgeschakeld. Handmatige backups blijven beschikbaar.'}
      </p>
      {!backup.enabled && (
        <div className="warning-banner" role="alert">
          Automatische backups zijn uitgeschakeld.
        </div>
      )}
      {backup.latest ? (
        <div className="backup-summary">
          <strong>Laatste backup:</strong> {new Date(backup.latest.createdAt).toLocaleString('nl-BE')} ·{' '}
          {formatRelativeAge(backup.latest.createdAt)} · {formatFileSize(backup.latest.sizeBytes)} · gecontroleerd ·{' '}
          {backup.retainedCount} bewaard
        </div>
      ) : (
        <div className="warning-banner" role="alert">
          Er is op deze laptop nog geen herstelbackup.
        </div>
      )}
      {backup.lastError && (
        <div className="warning-banner" role="alert">
          Laatste backup mislukt: {backup.lastError}
        </div>
      )}
      {backup.diskLow && (
        <div className="warning-banner" role="alert">
          Weinig opslagruimte: nog {backup.diskFreeBytes === null ? 'onbekend' : formatFileSize(backup.diskFreeBytes)}{' '}
          vrij; de veiligheidsgrens is {formatFileSize(backup.minimumFreeBytes)}.
        </div>
      )}
      <div className="backup-metrics">
        <span>
          <strong>Volgende automatische backup</strong>
          {backup.enabled && backup.nextScheduledAt
            ? new Date(backup.nextScheduledAt).toLocaleTimeString('nl-BE')
            : 'niet gepland'}
        </span>
        <span>
          <strong>Vrije opslag</strong>
          {backup.diskFreeBytes === null ? 'onbekend' : formatFileSize(backup.diskFreeBytes)}
        </span>
        <span>
          <strong>Database</strong>
          {formatFileSize(backup.databaseBytes)}
        </span>
      </div>
      <div className="form-row form-row--plain backup-actions">
        <button
          className="btn btn--primary"
          onClick={() =>
            void run(
              createBackup,
              (record) => `Backup gecontroleerd en opgeslagen om ${formatClockTimeMs(record.createdAt)}.`,
              'Backup maken mislukt'
            )
          }
          disabled={busy}
          aria-busy={busy}
        >
          {busy ? 'Backup bezig...' : 'Nu backup maken'}
        </button>
        {backup.latest && (
          <a className="btn btn--secondary" href="/api/backups/latest" download>
            Laatste backup downloaden
          </a>
        )}
      </div>
      <p className="panel-copy">
        Download regelmatig een kopie naar een andere laptop of USB-stick. De standby beschermt tegen een defect
        toestel; deze versies beschermen ook tegen een fout die naar de standby gekopieerd is.
      </p>
      <AdminNoticeBanner notice={notice} />
    </section>
  );
}
