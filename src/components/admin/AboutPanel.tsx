import React from 'react';
import { useAppData } from '../../app/index';
import { copyText } from '../../lib/clipboard';
import { getDesktop, useDesktopUpdate, type DesktopUpdateStatus } from '../../lib/desktop';
import { buildDiagnosticsText } from '../../lib/diagnostics';
import { formatClockTimeMs } from '../../lib/time';
import type { ClusterStatus, LiveAppSnapshot } from '../../types';
import { Icon } from '../Icon';

const selectHost = ({ host }: LiveAppSnapshot) => ({ host });

/** Version, updates, and the way to the log files, for whoever keeps these laptops running. */
export function AboutPanel({ cluster }: { cluster: ClusterStatus | null }) {
  const { host } = useAppData(selectHost);
  const desktop = getDesktop();
  const [dataPath, setDataPath] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [folderError, setFolderError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!desktop) return;
    let active = true;
    void desktop.getDiagnostics().then((diagnostics) => {
      if (active) setDataPath(diagnostics.dataPath);
    });
    return () => {
      active = false;
    };
  }, [desktop]);

  async function copyDiagnostics() {
    const text = buildDiagnosticsText({
      cluster,
      host,
      desktop: desktop ? await desktop.getDiagnostics() : null,
      userAgent: navigator.userAgent,
    });
    if ((await copyText(text)) !== 'copied') return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  async function openDataFolder() {
    setFolderError(await desktop!.openDataFolder());
  }

  return (
    <section className="panel">
      <h2>Over deze installatie</h2>
      <div className="backup-metrics about-facts">
        <span>
          <strong>Versie</strong>
          Apolloon {cluster?.appVersion ?? '…'}
        </span>
        <span>
          <strong>Databankschema</strong>
          {cluster?.schemaVersion ?? '…'}
        </span>
        {dataPath && (
          <span className="about-facts__wide">
            <strong>Gegevensmap (databank, backups en server.log)</strong>
            <code>{dataPath}</code>
          </span>
        )}
      </div>
      {desktop ? (
        <UpdateStatusRow />
      ) : (
        <p className="panel-copy about-browser-note">
          Dit scherm is een browser. Installeren, updaten en de logbestanden openen gebeurt op de laptop zelf, in de
          Apolloon-app.
        </p>
      )}
      <div className="form-row form-row--plain">
        {desktop && (
          <button type="button" className="btn btn--secondary" onClick={() => void openDataFolder()}>
            <Icon name="folder" size={14} />
            Logmap openen
          </button>
        )}
        <button type="button" className="btn btn--secondary" onClick={() => void copyDiagnostics()}>
          <Icon name={copied ? 'check' : 'copy'} size={14} className={copied ? 'icon--pop' : undefined} />
          {copied ? 'Gekopieerd' : 'Diagnose kopiëren'}
        </button>
      </div>
      {folderError && (
        <div className="warning-banner" role="alert">
          De map kon niet worden geopend: {folderError}
        </div>
      )}
      <p className="panel-copy about-help">
        Vraag je hulp op afstand? Plak de diagnose in je bericht: ze bevat de versie, de status van de laptops en de
        backups{desktop ? ', en de laatste regels van het logbestand' : ''}.
      </p>
    </section>
  );
}

function UpdateStatusRow() {
  const { status, check, open } = useDesktopUpdate();
  if (!status) return null;
  if (status.state === 'available') {
    const { update } = status;
    return (
      <div className="update-notice" role="status">
        <div>
          <strong>Versie {update.version} is beschikbaar.</strong>
          <span>
            Installeer dezelfde versie op alle laptops, en nooit tijdens de race: laptops met een andere versie koppelen
            niet met elkaar. Zet eerst een backup op een USB-stick.
          </span>
        </div>
        <div className="update-notice__actions">
          <button type="button" className="btn btn--primary" onClick={() => open(update.downloadUrl ?? update.pageUrl)}>
            <Icon name="download" size={14} />
            Installatiebestand downloaden
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => open(update.pageUrl)}>
            Wat is er nieuw?
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="host-hint update-status" role="status" aria-live="polite">
      <span>{describeUpdateStatus(status)}</span>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={check}
        disabled={status.state === 'checking'}
        aria-busy={status.state === 'checking'}
      >
        {status.state === 'checking' ? 'Bezig…' : 'Nu controleren'}
      </button>
    </div>
  );
}

function describeUpdateStatus(status: Exclude<DesktopUpdateStatus, { state: 'available' }>): string {
  switch (status.state) {
    case 'checking':
      return 'Controleren op een nieuwere versie…';
    case 'current':
      return `Dit is de nieuwste versie. Gecontroleerd om ${formatClockTimeMs(status.checkedAt).slice(0, 5)}.`;
    case 'unreachable':
      return `Kon niet controleren op een nieuwere versie (geen internet). Op het evenement is dat normaal.`;
  }
}
