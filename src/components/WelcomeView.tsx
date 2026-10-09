import { useAppData, useClusterStatus } from '../app/index';
import { useCopyText } from '../lib/clipboard';
import type { ClusterStatus, LiveAppSnapshot } from '../types';
import { AdminNoticeBanner } from './admin/AdminNotice';
import { countLabel, laptopLabel, shortUrl, useJoinGroup } from './admin/useJoinGroup';
import { describeAutoLinks } from '../lib/systemStatus';
import { Icon } from './Icon';
import { PageHeader } from './PageHeader';

const selectHost = ({ host }: LiveAppSnapshot) => ({ host });

/**
 * What Overzicht shows while this laptop has no runners and the race has not started:
 * the two ways to begin (import the registrations here, or link to a laptop that has
 * them) and what comes after. It goes away by itself once there are runners.
 */
export function WelcomeView({
  onSkip,
  onOpenAdmin,
}: {
  onSkip: () => void;
  /** Opens Beheer on a tab. Passed in: a router import here would split the first download. */
  onOpenAdmin: (section: 'preparation' | 'system') => void;
}) {
  const { host } = useAppData(selectHost);
  const { cluster } = useClusterStatus();
  const [copied, copyHostUrl] = useCopyText(host?.url ?? null);
  const linking = cluster?.enabled ?? false;
  const autoLink = cluster?.autoLink.enabled ?? false;

  return (
    <>
      <PageHeader title="Overzicht" meta={<span>Nog niet ingesteld</span>} />
      <div className="welcome">
        <header className="welcome__intro">
          <h2>Welkom bij Apolloon</h2>
          <p>Op deze laptop staan nog geen lopers. Kies hoe ze begint.</p>
        </header>

        <div className={`welcome__choices${linking ? '' : ' welcome__choices--single'}`}>
          <section className="panel welcome-choice">
            <span className="welcome-choice__icon" aria-hidden="true">
              <Icon name="upload" size={18} />
            </span>
            <h3>Dit is de eerste laptop</h3>
            <p>
              Importeer hier de inschrijvingen: het Excel-bestand of de CSV-export van het inschrijvingsformulier. De
              andere laptops {autoLink ? 'koppelen daarna vanzelf met deze.' : 'koppel je daarna aan deze.'}
            </p>
            <div className="welcome-choice__actions">
              <button type="button" className="btn btn--primary" onClick={() => onOpenAdmin('preparation')}>
                Inschrijvingen importeren
                <Icon name="arrowRight" size={14} />
              </button>
            </div>
          </section>

          {linking && cluster && (
            <section className="panel welcome-choice">
              <span className="welcome-choice__icon" aria-hidden="true">
                <Icon name="link" size={18} />
              </span>
              <h3>Een andere laptop is al ingesteld</h3>
              <p>
                {autoLink
                  ? 'Deze laptop koppelt vanzelf met die groep zodra ze die vindt.'
                  : 'Koppel deze laptop aan die groep.'}{' '}
                Ze neemt alle gegevens over en werkt mee; valt er later een laptop uit, dan werken de andere gewoon
                verder.
              </p>
              <JoinChoice cluster={cluster} onOpenAdmin={onOpenAdmin} />
            </section>
          )}
        </div>

        <section className="welcome-next" aria-labelledby="welcome-next-title">
          <h3 id="welcome-next-title">Daarna</h3>
          <ol>
            {linking && (
              <li>
                {autoLink ? (
                  'Start Apolloon op de andere laptops, aan dezelfde switch. Ze koppelen vanzelf met deze laptop.'
                ) : (
                  <>
                    Start Apolloon op de andere laptops, aan dezelfde switch, en kies daar{' '}
                    <strong>Een andere laptop is al ingesteld</strong>.
                  </>
                )}
                {cluster?.hostName && (
                  <>
                    {' '}
                    Deze laptop staat daar als <strong>{cluster.hostName}</strong>.
                  </>
                )}
              </li>
            )}
            <li>
              Kijk <strong>Beheer › Voorbereiding</strong> na: de wedstrijdgereedheid moet op <strong>Klaar</strong>{' '}
              staan.
            </li>
            {host && (
              <li>
                Open het adres{' '}
                <button type="button" className="welcome-address" onClick={copyHostUrl} title="Adres kopiëren">
                  {shortUrl(host.url)}
                  <Icon name={copied ? 'check' : 'copy'} size={13} className={copied ? 'icon--pop' : undefined} />
                </button>{' '}
                in de browser van de tv&apos;s en kies Binnenscherm of Buitenscherm.
              </li>
            )}
          </ol>
        </section>

        <button type="button" className="btn btn--quiet btn--sm welcome__skip" onClick={onSkip}>
          Overslaan en het lege overzicht tonen
        </button>
      </div>
    </>
  );
}

function JoinChoice({ cluster, onOpenAdmin }: { cluster: ClusterStatus; onOpenAdmin: (section: 'system') => void }) {
  const { join, pending, notice } = useJoinGroup(0, cluster.changed, { raceStarted: false, raceRunning: false });
  const busy = pending || Boolean(cluster.busy);
  // Only laptops that hold runners are "already set up"; an empty one is pulled in from the laptop with the runners.
  const setUp = cluster.nearby.filter((found) => found.runners > 0);

  if (cluster.members.length > 1) {
    const autoLinked = describeAutoLinks(cluster).find((link) => link.hostId === cluster.hostId);
    return (
      <div className="success-banner" role="status">
        {autoLinked ? `${autoLinked.text}.` : 'Gekoppeld.'} Deze laptop werkt samen met{' '}
        {countLabel(cluster.members.length - 1, 'andere laptop', 'andere laptops')}. Importeer de inschrijvingen op één
        van de laptops; ze verschijnen dan overal.
      </div>
    );
  }

  return (
    <>
      {setUp.length > 0 && (
        <ul className="welcome-nearby">
          {setUp.map((found) => (
            <li className="host-hint cluster-peer-row" key={found.url}>
              <span>
                <strong>{laptopLabel(found)}</strong>
                <small>
                  {countLabel(found.laptops, 'laptop', 'laptops')} · {countLabel(found.runners, 'loper', 'lopers')}
                  {found.name && ` · ${shortUrl(found.url)}`}
                </small>
              </span>
              {found.compatible ? (
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  onClick={() => void join(found.url, found)}
                  disabled={busy}
                >
                  {busy ? 'Bezig…' : 'Koppelen'}
                </button>
              ) : (
                <small className="welcome-nearby__mismatch">
                  Andere versie ({found.appVersion}). Installeer overal dezelfde versie.
                </small>
              )}
            </li>
          ))}
        </ul>
      )}
      {cluster.autoLink.waiting && (
        <div className="host-hint cluster-auto-link" role="status">
          {cluster.autoLink.waiting}
        </div>
      )}
      {setUp.length === 0 && (
        <div className="welcome-searching" role="status">
          <span className="welcome-searching__dot" aria-hidden="true" />
          <span>
            <strong>Zoeken naar laptops op dit netwerk…</strong>
            <small>Staat Apolloon aan op de andere laptop, en hangen beide aan dezelfde switch?</small>
          </span>
        </div>
      )}
      <AdminNoticeBanner notice={notice} />
      <div className="welcome-choice__actions">
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => onOpenAdmin('system')}>
          Adres zelf invullen
        </button>
      </div>
    </>
  );
}
