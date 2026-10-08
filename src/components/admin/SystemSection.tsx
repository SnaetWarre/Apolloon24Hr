import React from 'react';
import { useAppActions } from '../../app/index';
import { describeAutoLinks, describeGroup } from '../../lib/systemStatus';
import { formatClockTimeMs } from '../../lib/time';
import { useConfirm } from '../ConfirmDialog';
import { NetworkSetupPanel } from '../NetworkSetupPanel';
import type { BackupStatus, ClusterStatus, NearbyGroup, Runner } from '../../types';
import { AboutPanel } from './AboutPanel';
import { AdminNoticeBanner, useAdminAction } from './AdminNotice';
import { RestorePanel } from './RestorePanel';
import { formatFileSize, formatRelativeAge } from './adminFormat';
import { countLabel, laptopLabel, shortUrl, useJoinGroup } from './useJoinGroup';

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
      {cluster?.enabled && <ClusterPanel cluster={cluster} hostUrl={hostUrl} runnerCount={runners.length} />}
      <section className="panel">
        <NetworkSetupPanel />
      </section>
      {cluster && <BackupPanel backup={cluster.backup} />}
      <RestorePanel runnerCount={runners.length} />
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
      <AboutPanel cluster={cluster} />
    </>
  );
}

function ClusterPanel({
  cluster,
  hostUrl,
  runnerCount,
}: {
  cluster: ClusterStatus;
  hostUrl: string;
  runnerCount: number;
}) {
  const confirm = useConfirm();
  const { continueAlone } = useAppActions();
  const { pending: alonePending, notice: aloneNotice, run } = useAdminAction();
  const { join: joinGroup, pending: joinPending, notice: joinNotice } = useJoinGroup(runnerCount, cluster.changed);
  const [otherUrl, setOtherUrl] = React.useState('');
  const group = describeGroup(cluster);
  const pending = alonePending || joinPending;
  const busy = pending || Boolean(cluster.busy);

  async function join(url: string, found?: NearbyGroup) {
    if (await joinGroup(url, found)) setOtherUrl('');
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
        {cluster.members.length === 1
          ? 'Koppel deze laptop met de andere: dan heeft elke laptop alle gegevens, kan je op elke laptop werken, en werken de andere vanzelf verder als er één uitvalt.'
          : `Gekoppelde laptops hebben elk alle gegevens, en op elke laptop kan je werken. Een wijziging is pas bewaard als minstens ${cluster.majority} laptops ze hebben. Valt een laptop uit, dan werken de andere vanzelf verder.`}
        {cluster.autoLink.enabled &&
          runnerCount === 0 &&
          ' Zolang hier geen lopers staan, koppelt deze laptop vanzelf met de laptops die ze op het netwerk vindt.'}
      </p>
      <div className={`host-hint cluster-state cluster-state--${group.tone}`} role="status">
        <strong>{group.title}</strong> · {group.detail}
      </div>
      {describeAutoLinks(cluster).map((link) => (
        <div className="host-hint cluster-auto-link" key={link.hostId}>
          {link.text}
        </div>
      ))}
      {cluster.autoLink.waiting && (
        <div className="host-hint cluster-auto-link" role="status">
          {cluster.autoLink.waiting}
        </div>
      )}
      {cluster.members.length > 1 &&
        cluster.members.map((member) => (
          <div className="host-hint cluster-peer-row" key={member.hostId}>
            <strong>
              {laptopLabel(member)}
              {member.self && ' (deze laptop)'}
            </strong>
            {member.name && <small className="cluster-peer-row__address">{shortUrl(member.url)}</small>}
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
          <p className="panel-copy">Laptops op dit netwerk waarmee deze laptop kan samenwerken:</p>
          {cluster.nearby.length ? (
            cluster.nearby.map((found) => (
              <NearbyRow key={found.url} found={found} canJoin busy={busy} onJoin={() => void join(found.url, found)} />
            ))
          ) : (
            <div className="host-hint">
              Nog geen andere laptops gevonden. Staat Apolloon aan op de andere laptops, en hangen ze aan hetzelfde
              netwerk?
            </div>
          )}
          <details className="host-hint cluster-manual-join">
            <summary className="disclosure">Laptop niet in de lijst? Vul het adres in</summary>
            <p className="panel-copy">
              Het adres staat onderaan de zijbalk van die laptop. Deze laptop
              {cluster.hostName && (
                <>
                  {' '}
                  heet <strong>{cluster.hostName}</strong> en
                </>
              )}{' '}
              heeft adres <strong>{hostUrl}</strong>.
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
                onClick={() => void join(otherUrl.trim())}
                disabled={!otherUrl.trim() || busy}
              >
                {busy ? 'Bezig...' : 'Koppelen'}
              </button>
            </div>
          </details>
        </>
      ) : (
        <>
          {cluster.nearby.length > 0 && <p className="panel-copy">Andere laptops op dit netwerk:</p>}
          {cluster.nearby.map((found) => (
            <NearbyRow
              key={found.url}
              found={found}
              canJoin={false}
              busy={busy}
              onJoin={() => void join(found.url, found)}
            />
          ))}
          <p className="panel-copy">
            {cluster.autoLink.enabled ? (
              <>
                Nog een laptop toevoegen? Start Apolloon op een lege laptop aan hetzelfde netwerk: die koppelt vanzelf.
                Lukt dat niet, open dan op die laptop Beheer › Systeem & herstel en klik op Koppelen naast deze groep
                (adres <strong>{hostUrl}</strong>).
              </>
            ) : (
              <>
                Nog een laptop toevoegen? Open op die laptop Beheer › Systeem & herstel en klik op Koppelen naast deze
                groep (adres <strong>{hostUrl}</strong>).
              </>
            )}
          </p>
        </>
      )}
      <AdminNoticeBanner notice={joinNotice} />
      <AdminNoticeBanner notice={aloneNotice} />
    </section>
  );
}

/**
 * A laptop or group heard on the network, with Koppelen when pressing it here goes the right way:
 * the side with fewer runners takes the other's data. A laptop in a group only takes in empty
 * laptops (`canJoin` false); it never leaves its group from this list.
 */
function NearbyRow({
  found,
  canJoin,
  busy,
  onJoin,
}: {
  found: NearbyGroup;
  canJoin: boolean;
  busy: boolean;
  onJoin: () => void;
}) {
  return (
    <div className="host-hint cluster-peer-row">
      <strong>{laptopLabel(found)}</strong>
      <span>
        {countLabel(found.laptops, 'laptop', 'laptops')} · {countLabel(found.runners, 'loper', 'lopers')}
        {found.name && <small className="cluster-peer-row__address"> · {shortUrl(found.url)}</small>}
      </span>
      {!found.compatible ? (
        <span>andere versie ({found.appVersion}): installeer overal dezelfde versie</span>
      ) : found.link === 'invite' || (found.link === 'join' && canJoin) ? (
        <button className="btn btn--primary" onClick={onJoin} disabled={busy}>
          {busy ? 'Bezig...' : 'Koppelen'}
        </button>
      ) : (
        <span>Druk op Koppelen op die laptop.</span>
      )}
    </div>
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
