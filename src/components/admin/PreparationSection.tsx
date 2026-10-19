import React from 'react';
import { useAppActions } from '../../app/index';
import { buildEventReadiness, readinessSummary, type ReadinessCheck } from '../../lib/readiness';
import { REGISTRATION_FILE_TYPES, readRegistrationFile, type RegistrationFile } from '../../lib/registrationFile';
import type { ClusterStatus } from '../../types';
import { useAdminAction } from './useAdminAction';

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
          <p className="panel-copy">Eén overzicht van backups, opslagruimte en de gekoppelde laptops.</p>
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
  const { importRunners } = useAppActions();
  const [registrationFile, setRegistrationFile] = React.useState<RegistrationFile | null>(null);
  const [fileName, setFileName] = React.useState('');
  const { pending, run } = useAdminAction();
  // Rows the import skipped or doubted stay on the panel, as a list to fix in the file.
  const [problems, setProblems] = React.useState<string[]>([]);

  async function onFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Clear the input so picking the same file again after editing it fires `change` and is read fresh.
    event.target.value = '';
    if (!file) return;
    setProblems([]);
    setFileName(file.name);
    setRegistrationFile(await readRegistrationFile(file));
  }

  async function importFile(file: RegistrationFile) {
    setProblems([]);
    const summary = await run(
      () => importRunners(file),
      ({ created, updated, skipped }) => `${created} aangemaakt, ${updated} bijgewerkt, ${skipped} overgeslagen`,
      'Import mislukt'
    );
    if (summary) setProblems(summary.errors);
  }

  return (
    <section className="panel">
      <h2>Inschrijvingen importeren</h2>
      <p className="panel-copy">
        Kies het Excel-bestand of de CSV-export van het inschrijvingsformulier. Nieuwe lopers komen in de databank en
        verschijnen op het bord zodra je ze aanmeldt in Wachtrij. Het rijnummer wordt het lopersnummer en alle
        antwoorden komen in het profiel.
      </p>
      <div className="file-import-row">
        <label className="file-picker">
          <input type="file" accept={REGISTRATION_FILE_TYPES} onChange={onFileChange} />
          <span>Bestand kiezen</span>
        </label>
        <span className="file-name">{fileName || 'Geen bestand gekozen'}</span>
        <button
          className="btn btn--primary btn--fixed"
          onClick={() => {
            if (registrationFile) void importFile(registrationFile);
          }}
          disabled={!registrationFile || pending}
        >
          {pending ? 'Importeren...' : 'Importeren'}
        </button>
      </div>
      {problems.length > 0 && (
        <div className="warning-banner import-problems">
          <strong>Nakijken in het bestand</strong>
          <ul>
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
