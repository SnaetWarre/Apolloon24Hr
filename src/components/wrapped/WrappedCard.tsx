import { LabelBadge } from '../LabelBadge';
import { formatLapTime, formatPlace, type WrappedRunner } from '../../lib/wrapped';

/**
 * One runner's story image, 1080×1920, to share on Instagram. A placeholder layout with
 * everything Apolloon asked for, until the real design lands; only this file and
 * wrapped.css change then.
 */
export function WrappedCard({ runner, year }: { runner: WrappedRunner; year: number }) {
  const overall = formatPlace(runner.pointsRank);
  return (
    <article className="wrapped-card" aria-label={`Wrapped van ${runner.name}`}>
      <header className="wrapped-card__head">
        <span className="brand-mark wrapped-card__logo" role="img" aria-label="Apolloon" />
        <span className="wrapped-card__event">24 Urenloop {year}</span>
      </header>

      <section className="wrapped-card__profile" aria-label="Lopersprofiel">
        {runner.runnerNumber && <span className="wrapped-card__number">#{runner.runnerNumber}</span>}
        <h1 className="wrapped-card__name">{runner.name}</h1>
        {runner.labels.length > 0 && (
          <div className="wrapped-card__labels">
            {runner.labels.map((label) => (
              <LabelBadge key={label.id} label={label} />
            ))}
          </div>
        )}
        <div className="wrapped-card__type">
          <span>Lopersprofiel</span>
          <strong>{runner.runnerType.title}</strong>
          <p>{runner.runnerType.text}</p>
        </div>
      </section>

      <dl className="wrapped-card__stats">
        <div>
          <dt>Rondjes</dt>
          <dd>{runner.laps}</dd>
        </div>
        <div>
          <dt>Snelste ronde</dt>
          <dd>{runner.fastestLapMs != null ? formatLapTime(runner.fastestLapMs) : '–'}</dd>
        </div>
        <div>
          <dt>Gemiddelde rondetijd</dt>
          <dd>{runner.averageLapMs != null ? formatLapTime(runner.averageLapMs) : '–'}</dd>
        </div>
        {runner.burgies > 0 && (
          <div>
            <dt>Burgies gepakt</dt>
            <dd>{runner.burgies}</dd>
          </div>
        )}
      </dl>

      <section className="wrapped-card__places" aria-label="Coëfficiëntenplaats">
        <span className="wrapped-card__kicker">Coëfficiëntenplaats</span>
        <p className="wrapped-card__place">
          <strong>{overall.headline}</strong> {overall.detail}
        </p>
        {runner.labelPointsRanks.length > 0 && (
          <ul>
            {runner.labelPointsRanks.map((rank) => (
              <li key={rank.label.id}>
                <strong>{rank.place}e</strong> van {rank.of} in {rank.label.name}
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}
