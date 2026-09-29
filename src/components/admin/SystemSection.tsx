import React from 'react';
import { useAppActions } from '../../app/index';
import { describeGroup } from '../../lib/systemStatus';
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
  const { joinGroup, continueAlone } = useAppActions();
  const { pending, notice, run } = useAdminAction();
  const [otherUrl, setOtherUrl] = React.useState('');
  const group = describeGroup(cluster);

  async function join() {
    const url = otherUrl.trim();
    if (!url || pending) return;
    const confirmed = await confirm({
      title: 'Deze laptop koppelen?',
      message:
        'Deze laptop neemt alle gegevens van de andere laptops over en werkt daarna mee. Wat nu op deze laptop staat, wordt eerst als backup bewaard.',
      confirmLabel: 'Koppelen',
      tone: 'danger',
    });
    if (!confirmed) return;
    const result = await run(
      () => joinGroup(url),
      ({ backupFile }) =>
        backupFile ? `Gekoppeld. De vorige gegevens staan in de backup ${backupFile}.` : 'Gekoppeld.',
      'Koppelen mislukt'
    );
    if (result) setOtherUrl('');
  }

  async function goOnAlone() {
    if (pending) return;
    const confirmed = await confirm({
      title: 'Alleen verder werken?',
      message:
        'Doe dit alleen als de andere laptops echt kapot of weg zijn. Staan ze nog aan, controleer dan de netwerkkabel: dan werkt alles vanzelf weer. Wijzigingen van de laatste seconden op de andere laptops kunnen ontbreken. Komen ze later terug, dan nemen ze de gegevens van deze laptop over en bewaren ze hun eigen gegevens in een backup.',
      confirmLabel: 'Alleen verder werken',
      tone: 'danger',
    });
    if (!confirmed) return;
    await run(
      continueAlone,
      'Deze laptop werkt alleen verder. Koppel de andere laptops opnieuw zodra dat kan.',
      'Mislukt'
    );
  }

  return (
    <section className="panel">
      <h2>Laptops koppelen</h2>
      <p className="panel-copy">
        Gekoppelde laptops hebben elk alle gegevens, en op elke laptop kan je werken. Een wijziging is pas bewaard als
        minstens {cluster.majority === 1 ? 'deze laptop' : `${cluster.majority} laptops`} ze hebben. Valt een laptop
        uit, dan werken de andere vanzelf verder.
      </p>
      <div className={`host-hint cluster-state cluster-state--${group.tone}`} role="status">
        <strong>{group.title}</strong> · {group.detail}
      </div>
      {cluster.members.length > 1 &&
        cluster.members.map((member) => (
          <div className="host-hint cluster-peer-row" key={member.hostId}>
            <strong>
              {member.url.replace(/^https?:\/\//, '')}
              {member.self && ' (deze laptop)'}
            </strong>
            <span>
              {!member.reachable
                ? 'niet bereikbaar'
                : member.self && !cluster.writable
                  ? 'wacht op de andere laptops'
                  : member.leader
                    ? 'ordent de wijzigingen'
                    : member.caughtUp
                      ? 'heeft alles'
                      : 'haalt wijzigingen op'}
            </span>
          </div>
        ))}
      {cluster.state === 'no-majority' && (
        <div className="warning-banner" role="alert">
          <span>
            Er zijn te weinig laptops bereikbaar om iets te bewaren. Zet de andere laptops aan of controleer de kabel.
            Zijn ze echt kapot?{' '}
            <button className="btn btn--secondary" onClick={() => void goOnAlone()} disabled={pending}>
              Alleen verder werken
            </button>
          </span>
        </div>
      )}
      {cluster.lastError && (
        <div className="warning-banner" role="alert">
          {cluster.lastError}
        </div>
      )}
      {cluster.members.length === 1 ? (
        <>
          <p className="panel-copy">
            Adres van deze laptop: <strong>{hostUrl}</strong>. Koppel een andere laptop door daar dit adres in te
            vullen, of vul hier het adres van een laptop in die al gekoppeld is:
          </p>
          <div className="form-row">
            <input
              className="input"
              value={otherUrl}
              onChange={(event) => setOtherUrl(event.target.value)}
              placeholder="http://192.168.1.20:5173"
              inputMode="url"
              aria-label="Adres van een andere laptop"
            />
            <button
              className="btn btn--primary btn--fixed"
              onClick={() => void join()}
              disabled={!otherUrl.trim() || pending || Boolean(cluster.busy)}
            >
              {pending || cluster.busy ? 'Bezig...' : 'Koppelen'}
            </button>
          </div>
        </>
      ) : (
        <p className="panel-copy">
          Nog een laptop koppelen? Vul op die laptop dit adres in: <strong>{hostUrl}</strong>.
        </p>
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
        Download regelmatig een kopie naar een USB-stick. De gekoppelde laptops beschermen tegen een defect toestel;
        deze versies beschermen ook tegen een fout die naar alle laptops gekopieerd is.
      </p>
      <AdminNoticeBanner notice={notice} />
    </section>
  );
}
