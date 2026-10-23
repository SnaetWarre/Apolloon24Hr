import { useNavigate } from '@tanstack/react-router';
import { buildKpis } from '../../lib/analysis';
import { useArrivals } from '../../lib/motion';
import { formatElapsedSeconds } from '../../lib/time';
import type { LapRecord, LiveAppSnapshot } from '../../types';
import { LiveElapsed } from '../LiveTime';
import type { DisplayPresentation } from './displaySettings';

export const selectInsideDisplayData = ({ runners, labels, race }: LiveAppSnapshot) => ({ runners, labels, race });

export function DisplayBrand() {
  const navigate = useNavigate();
  return (
    <div className="display-brand">
      <button
        type="button"
        className="display-brand__home"
        onClick={() => void navigate({ to: '/' })}
        aria-label="Apolloon, terug naar start"
        title="Terug naar start"
      >
        <span className="brand-mark" aria-hidden="true" />
      </button>
      <span>you&apos;ll never walk alone</span>
    </div>
  );
}

export function DisplayTotals({ race, laps }: { race: LiveAppSnapshot['race']; laps: LapRecord[] }) {
  // Same definition as Analyse, so the public and operator screens agree.
  const lapsPerHour = buildKpis(laps, race).lapsPerHour;
  const changed = useArrivals([`laps:${laps.length}`]);
  return (
    <dl className="inside-totals">
      <div>
        <dt>Racetijd</dt>
        <dd>
          {race.raceStartedAt ? (
            race.raceFinishedAt ? (
              formatElapsedSeconds(race.raceFinishedAt - race.raceStartedAt)
            ) : (
              <LiveElapsed startedAt={race.raceStartedAt} />
            )
          ) : (
            '0:00'
          )}
        </dd>
      </div>
      <div>
        <dt>Rondes</dt>
        <dd key={laps.length} className={changed.has(`laps:${laps.length}`) ? 'value-tick' : undefined}>
          {laps.length.toLocaleString('nl-BE')}
        </dd>
      </div>
      <div>
        <dt>Per uur</dt>
        <dd>
          {lapsPerHour == null
            ? '—'
            : lapsPerHour.toLocaleString('nl-BE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
        </dd>
      </div>
    </dl>
  );
}

export function PresentationSwitch({
  presentation,
  onChange,
}: {
  presentation: DisplayPresentation;
  onChange: (next: DisplayPresentation) => void;
}) {
  return (
    <div className="inside-presentation" role="group" aria-label="Weergave van dit scherm">
      <button
        className={`inside-control-button${presentation === 'light' ? ' is-active' : ''}`}
        aria-pressed={presentation === 'light'}
        onClick={() => onChange('light')}
      >
        Licht
      </button>
      <button
        className={`inside-control-button${presentation === 'dark' ? ' is-active' : ''}`}
        aria-pressed={presentation === 'dark'}
        onClick={() => onChange('dark')}
      >
        Donker
      </button>
    </div>
  );
}
