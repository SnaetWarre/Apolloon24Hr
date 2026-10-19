import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { trpc } from '../../api';
import { useAppActions } from '../../app/index';
import { backupsKey } from '../../app/snapshot';
import { useConfirm } from '../ConfirmDialog';
import type { BackupRecord } from '../../types';
import { useToast } from '../Toaster';
import { useAdminAction } from './useAdminAction';
import { formatFileSize, formatRelativeAge } from './adminFormat';
import { laptopWithAddress } from './useJoinGroup';

const SHOWN_AT_FIRST = 8;

/**
 * Puts every linked laptop back to one of this laptop's backups, for a wrong change that
 * was copied to all of them. The current data is kept in a backup first, so a restore can
 * itself be undone by restoring that one.
 */
export function RestorePanel({ runnerCount }: { runnerCount: number }) {
  const confirm = useConfirm();
  const { restoreBackup } = useAppActions();
  const toast = useToast();
  const { pending, run } = useAdminAction();
  const [showAll, setShowAll] = React.useState(false);
  const backups = useQuery({ queryKey: backupsKey, queryFn: () => trpc.backups.list.query(), refetchInterval: 60_000 });
  const records = backups.data ?? [];
  const shown = showAll ? records : records.slice(0, SHOWN_AT_FIRST);

  async function restore(record: BackupRecord) {
    if (pending) return;
    let preview;
    try {
      preview = await trpc.backups.preview.query({ fileName: record.fileName });
    } catch (error) {
      toast({
        tone: 'error',
        text: 'De backup kon niet gelezen worden',
        detail: error instanceof Error ? error.message : undefined,
      });
      return;
    }
    const confirmed = await confirm({
      title: `Terug naar ${formatMoment(record.createdAt)}?`,
      message: (
        <>
          <p>
            Alle gekoppelde laptops gaan terug naar deze backup: {preview.runners} lopers en {preview.laps} rondes
            {preview.lastLapAt ? `, laatste ronde om ${formatMoment(preview.lastLapAt)}` : ''}. Nu zijn er {runnerCount}{' '}
            lopers.
          </p>
          <p>
            Alles wat na {formatMoment(record.createdAt)} gebeurde, verdwijnt. De huidige toestand wordt eerst als
            backup bewaard, dus ook dit terugzetten kan je nog ongedaan maken.
          </p>
          {preview.raceStartedAt !== null && preview.raceFinishedAt === null && (
            <p>
              <strong>De wedstrijd liep toen.</strong> De loper die toen op de piste stond, staat er weer, met de
              starttijd van toen. Controleer de timing meteen na het terugzetten.
            </p>
          )}
        </>
      ),
      confirmLabel: 'Terugzetten',
      tone: 'danger',
    });
    if (!confirmed) return;
    await run(
      () => restoreBackup(record.fileName),
      (result) => ({
        text: `Teruggezet naar ${formatMoment(record.createdAt)}: ${result.runners} lopers, ${result.laps} rondes.`,
        detail: `Ongedaan maken kan met de backup "Vóór terugzetten" op ${laptopWithAddress({ name: result.safetyHostName, url: result.safetyHostUrl })}.`,
      }),
      'Terugzetten mislukt'
    );
  }

  return (
    <section className="panel">
      <h2>Backup terugzetten</h2>
      <p className="panel-copy">
        Voor een fout die al op alle laptops staat, zoals een verwijderde loper of een verkeerde import. Alle gekoppelde
        laptops gaan samen terug; niemand hoeft iets af te sluiten.
      </p>
      {backups.error ? (
        <div className="warning-banner" role="alert">
          De lijst met backups kon niet geladen worden.
        </div>
      ) : records.length === 0 ? (
        <div className="host-hint">
          {backups.isLoading ? 'Backups laden…' : 'Er is op deze laptop nog geen backup.'}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="backup-table">
            <thead>
              <tr>
                <th>Tijdstip</th>
                <th>Soort</th>
                <th>Grootte</th>
                <th>
                  <span className="visually-hidden">Actie</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((record) => (
                <tr key={record.fileName}>
                  <td>
                    {formatMoment(record.createdAt)}{' '}
                    <span className="muted-label">{formatRelativeAge(record.createdAt)}</span>
                  </td>
                  <td>{backupKind(record)}</td>
                  <td>{formatFileSize(record.sizeBytes)}</td>
                  <td className="backup-table__action">
                    <button className="btn btn--secondary" onClick={() => void restore(record)} disabled={pending}>
                      Terugzetten
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {records.length > SHOWN_AT_FIRST && (
        <button className="btn btn--ghost" onClick={() => setShowAll((value) => !value)}>
          {showAll ? 'Minder tonen' : `Alle ${records.length} backups tonen`}
        </button>
      )}
    </section>
  );
}

function backupKind(record: BackupRecord): string {
  if (record.scheduled) return 'Automatisch';
  if (record.fileName.includes('-pre-restore-')) return 'Vóór terugzetten';
  if (record.fileName.includes('-pre-clear-')) return 'Vóór race wissen';
  if (record.fileName.includes('-pre-join-')) return 'Vóór koppelen';
  if (record.fileName.includes('-pre-resync-')) return 'Vóór bijwerken';
  return 'Handmatig';
}

function formatMoment(ms: number): string {
  return new Date(ms).toLocaleString('nl-BE', {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Brussels',
  });
}
