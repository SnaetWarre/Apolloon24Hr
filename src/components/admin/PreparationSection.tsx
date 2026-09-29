import React from 'react';
import { useAppActions } from '../../app/index';
import { buildEventReadiness, readinessSummary, type ReadinessCheck } from '../../lib/readiness';
import type { ClusterStatus } from '../../types';
import { AdminNoticeBanner, useAdminAction } from './AdminNotice';

const READINESS_ORDER = { blocked: 0, warning: 1, ready: 2 } as const;

export function PreparationSection({
  cluster,
  clusterError,
  onOpenSystem,
}: {
  cluster: ClusterStatus | null;
  clusterError: Error | null;
  onOpenSystem: () => void;
}) {
  return (
    <>
      <ReadinessPanel cluster={cluster} clusterError={clusterError} onOpenSystem={onOpenSystem} />
      <ImportPanel />
    </>
  );
}

function ReadinessPanel({
  cluster,
  clusterError,
  onOpenSystem,
}: {
  cluster: ClusterStatus | null;
  clusterError: Error | null;
  onOpenSystem: () => void;
}) {
  const checks = sortByLevel(buildEventReadiness(cluster));
  const readiness = readinessSummary(checks);
  const openCount = checks.filter((check) => check.level !== 'ready').length;
  return (
    <section className={`panel readiness-panel readiness-panel--${readiness}`}>
      <div className="readiness-heading">
        <div>
          <h2>Wedstrijdgereedheid</h2>
          <p className="panel-copy">Eén overzicht van backups, de tweede laptop en de klokken.</p>
        </div>
        <strong className={`readiness-summary readiness-summary--${readiness}`}>
          {readiness === 'ready'
            ? 'Klaar'
            : readiness === 'warning'
              ? `Aandacht nodig · ${openCount} open`
              : `Niet klaar · ${openCount} open`}
        </strong>
      </div>
      {clusterError && (
        <div className="warning-banner" role="alert">
          De actuele systeemstatus kon niet worden vernieuwd: {clusterError.message}
        </div>
      )}
      <ul className="readiness-list">
        {checks.map((check) => (
          <li className={`readiness-check readiness-check--${check.level}`} key={check.id}>
            <span className="readiness-check__marker" aria-hidden="true">
              {check.level === 'ready' ? '✓' : check.level === 'warning' ? '!' : '×'}
            </span>
            <span>
              <strong>{check.label}</strong>
              <small>{check.detail}</small>
              {check.id === 'replica' && check.level !== 'ready' && (
                <button className="btn btn--ghost btn--sm readiness-check-action" onClick={onOpenSystem}>
                  Naar Systeem &amp; herstel
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Blocking problems first; within a level the order from readiness.ts stays. */
function sortByLevel(checks: ReadinessCheck[]): ReadinessCheck[] {
  return checks
    .map((check, index) => ({ check, index }))
    .sort((a, b) => READINESS_ORDER[a.check.level] - READINESS_ORDER[b.check.level] || a.index - b.index)
    .map(({ check }) => check);
}

function ImportPanel() {
  const { importRunnersCsv } = useAppActions();
  const [csvText, setCsvText] = React.useState('');
  const [fileName, setFileName] = React.useState('');
  const { pending, notice, setNotice, run } = useAdminAction();

  async function onFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setNotice(null);
    setFileName(file.name);
    setCsvText(await file.text());
  }

  return (
    <section className="panel">
      <h2>Inschrijvingen importeren</h2>
      <p className="panel-copy">
        Kies de CSV-export van het inschrijvingsformulier. Nieuwe lopers komen in de databank en verschijnen op het bord
        zodra je ze aanmeldt in Wachtrij. Het rijnummer wordt het lopersnummer en alle antwoorden komen in het profiel.
      </p>
      <div className="file-import-row">
        <label className="file-picker">
          <input type="file" accept=".csv,text/csv" onChange={onFileChange} />
          <span>CSV-bestand kiezen</span>
        </label>
        <span className="file-name">{fileName || 'Geen bestand gekozen'}</span>
        <button
          className="btn btn--primary btn--fixed"
          onClick={() =>
            void run(
              () => importRunnersCsv(csvText),
              (summary) => summary,
              'Import mislukt'
            )
          }
          disabled={!csvText.trim() || pending}
        >
          {pending ? 'Importeren...' : 'Importeren'}
        </button>
      </div>
      <AdminNoticeBanner notice={notice} />
    </section>
  );
}
