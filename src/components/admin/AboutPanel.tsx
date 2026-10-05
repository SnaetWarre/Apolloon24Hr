import React from 'react';
import { useAppData } from '../../app/index';
import { copyText } from '../../lib/clipboard';
import { getDesktop, useDesktopUpdate, type DesktopUpdateStatus } from '../../lib/desktop';
import { buildDiagnosticsText } from '../../lib/diagnostics';
import { formatClockTimeMs } from '../../lib/time';
import type { ClusterStatus, LiveAppSnapshot } from '../../types';
import { useConfirm } from '../ConfirmDialog';
import { Icon } from '../Icon';

const selectHost = ({ host }: LiveAppSnapshot) => ({ host });
const selectRace = ({ race }: LiveAppSnapshot) => ({ race });

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
        <UpdateStatusRow cluster={cluster} />
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

const SAME_VERSION =
  'Installeer dezelfde versie op alle laptops, en nooit tijdens de race: laptops met een andere versie koppelen niet met elkaar.';

function UpdateStatusRow({ cluster }: { cluster: ClusterStatus | null }) {
  const { status, check, open } = useDesktopUpdate();
  const { race } = useAppData(selectRace);
  const confirm = useConfirm();
  const [problem, setProblem] = React.useState<string | null>(null);
  const [lastInstall, setLastInstall] = React.useState<{ version: string; ok: boolean } | null>(null);

  React.useEffect(() => {
    let active = true;
    void getDesktop()
      ?.update.lastInstall()
      .then((outcome) => {
        if (active) setLastInstall(outcome);
      });
    return () => {
      active = false;
    };
  }, []);

  const raceRunning = Boolean(race.raceStartedAt && !race.raceFinishedAt);
  const otherLaptops = (cluster?.members.length ?? 1) - 1;

  async function install(version: string) {
    setProblem(null);
    const confirmed = await confirm({
      title: `Bijwerken naar ${version}?`,
      message:
        'Apolloon maakt eerst een backup, sluit, installeert de nieuwe versie en start daarna vanzelf opnieuw. Dat duurt ongeveer een minuut.' +
        (otherLaptops > 0
          ? ` Deze laptop werkt daarna pas weer samen met de ${otherLaptops === 1 ? 'andere laptop' : `${otherLaptops} andere laptops`} als die ook bijgewerkt ${otherLaptops === 1 ? 'is' : 'zijn'}: werk ze meteen na elkaar bij.`
          : ''),
      confirmLabel: 'Installeren en herstarten',
    });
    if (!confirmed) return;
    setProblem((await getDesktop()?.update.install()) ?? null);
  }

  const outcome = lastInstall && (
    <div className={lastInstall.ok ? 'success-banner' : 'warning-banner'} role="status">
      {lastInstall.ok
        ? `Apolloon is bijgewerkt naar ${lastInstall.version}.`
        : `De installatie van versie ${lastInstall.version} is niet gelukt. Probeer opnieuw, of download het installatiebestand zelf.`}
    </div>
  );

  if (!status) return outcome || null;

  if (
    status.state === 'available' ||
    status.state === 'downloading' ||
    status.state === 'ready' ||
    status.state === 'installing'
  ) {
    const { update } = status;
    return (
      <>
        {outcome}
        <div className="update-notice" role="status" aria-live="polite">
          <div>
            <strong>
              {status.state === 'downloading'
                ? `Versie ${update.version} wordt gedownload… ${status.percent}%`
                : status.state === 'ready'
                  ? `Versie ${update.version} is klaar om te installeren.`
                  : status.state === 'installing'
                    ? `Backup maken en versie ${update.version} installeren…`
                    : `Versie ${update.version} is beschikbaar.`}
            </strong>
            {status.state === 'downloading' && (
              <span
                className="update-progress"
                role="progressbar"
                aria-label="Download"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={status.percent}
              >
                <span style={{ width: `${status.percent}%` }} />
              </span>
            )}
            <span>
              {status.state === 'installing'
                ? 'Apolloon sluit zo en start vanzelf opnieuw met de nieuwe versie.'
                : status.state === 'ready' && raceRunning
                  ? 'De wedstrijd loopt: installeer pas na de wedstrijd.'
                  : SAME_VERSION}
            </span>
            {status.state === 'available' && status.problem && <span>{status.problem}</span>}
          </div>
          <div className="update-notice__actions">
            {status.state === 'ready' || status.state === 'installing' ? (
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void install(update.version)}
                disabled={raceRunning || status.state === 'installing'}
                aria-busy={status.state === 'installing'}
              >
                <Icon name="download" size={14} />
                {status.state === 'installing' ? 'Bezig…' : 'Nu installeren en herstarten'}
              </button>
            ) : status.state === 'available' ? (
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => open(update.downloadUrl ?? update.pageUrl)}
              >
                <Icon name="download" size={14} />
                Installatiebestand downloaden
              </button>
            ) : null}
            <button type="button" className="btn btn--ghost" onClick={() => open(update.pageUrl)}>
              Wat is er nieuw?
            </button>
          </div>
        </div>
        {problem && (
          <div className="warning-banner" role="alert">
            {problem}
          </div>
        )}
      </>
    );
  }
  return (
    <>
      {outcome}
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
    </>
  );
}

function describeUpdateStatus(
  status: Extract<DesktopUpdateStatus, { state: 'checking' | 'current' | 'unreachable' }>
): string {
  switch (status.state) {
    case 'checking':
      return 'Controleren op een nieuwere versie…';
    case 'current':
      return `Dit is de nieuwste versie. Gecontroleerd om ${formatClockTimeMs(status.checkedAt).slice(0, 5)}.`;
    case 'unreachable':
      return `Kon niet controleren op een nieuwere versie (geen internet). Op het evenement is dat normaal.`;
  }
}
