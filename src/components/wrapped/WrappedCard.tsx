import { LabelBadge } from '../LabelBadge';
import { formatLapTime, WRAPPED_FACTS_PER_CARD, type WrappedFactKind, type WrappedRunner } from '../../lib/wrapped';

/** These have their own place on the card, so they never fill a fact line too. */
const SHOWN_ELSEWHERE = new Set<WrappedFactKind>(['distance', 'laps', 'fastest_lap']);
const KM = new Intl.NumberFormat('nl-BE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/**
 * One runner's story image, 1080×1920, to share on Instagram. A placeholder layout that
 * shows every number until the real design lands; only this file and wrapped.css change then.
 */
export function WrappedCard({ runner }: { runner: WrappedRunner }) {
  const facts = runner.facts.filter((fact) => !SHOWN_ELSEWHERE.has(fact.kind)).slice(0, WRAPPED_FACTS_PER_CARD);
  const year = new Date(runner.firstLapAt).getFullYear();
  return (
    <article className="wrapped-card" aria-label={`Wrapped van ${runner.name}`}>
      <header className="wrapped-card__head">
        <span className="brand-mark wrapped-card__logo" role="img" aria-label="Apolloon" />
        <span className="wrapped-card__event">24 Urenloop {year}</span>
      </header>

      <div className="wrapped-card__who">
        {runner.runnerNumber && <span className="wrapped-card__number">#{runner.runnerNumber}</span>}
        <h1 className="wrapped-card__name">{runner.name}</h1>
      </div>

      <div className="wrapped-card__hero">
        <strong className="wrapped-card__km">
          {KM.format(runner.distanceKm)}
          <small>km</small>
        </strong>
        <span className="wrapped-card__laps">
          {runner.laps} {runner.laps === 1 ? 'ronde' : 'rondes'}
        </span>
      </div>

      <dl className="wrapped-card__stats">
        <div>
          <dt>Snelste ronde</dt>
          <dd>{runner.fastestLapMs != null ? formatLapTime(runner.fastestLapMs) : '–'}</dd>
        </div>
        <div>
          <dt>Gemiddeld</dt>
          <dd>{runner.averageLapMs != null ? formatLapTime(runner.averageLapMs) : '–'}</dd>
        </div>
        <div>
          <dt>Plaats in rondes</dt>
          <dd>
            {runner.teamRank.laps.place}
            <small>/{runner.teamRank.laps.of}</small>
          </dd>
        </div>
      </dl>

      <ol className="wrapped-card__facts">
        {facts.map((fact) => (
          <li key={fact.kind}>{fact.text}</li>
        ))}
      </ol>

      {runner.labels.length > 0 && (
        <div className="wrapped-card__labels">
          {runner.labels.map((label) => (
            <LabelBadge key={label.id} label={label} />
          ))}
        </div>
      )}
    </article>
  );
}
