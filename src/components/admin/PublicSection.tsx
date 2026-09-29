import { Link } from '@tanstack/react-router';
import { useAppActions } from '../../app/index';
import { formatClockTimeMs } from '../../lib/time';
import { Icon } from '../Icon';
import type { PublicRecordMode } from '../../types';
import { AdminNoticeBanner, useAdminAction } from './AdminNotice';
import { publicRecordModeLabel } from './adminFormat';

const RECORD_MODES: ReadonlyArray<[PublicRecordMode, string]> = [
  ['off', 'Uit'],
  ['day', 'Dagrecord'],
  ['two_hour', 'Per 2 uur'],
  ['hour', 'Per uur'],
];

export function PublicSection({ publicRecordMode }: { publicRecordMode: PublicRecordMode }) {
  const { burgieGepakt, updatePublicRecordMode } = useAppActions();
  const { pending, notice, run } = useAdminAction();

  return (
    <section className="panel">
      <h2>Publieke momenten</h2>
      <p className="panel-copy">Wat het publiek op het Buitenscherm ziet, bovenop de huidige en volgende loper.</p>
      <div className="public-moments">
        <div className="public-moment">
          <h3>Burgie gepakt</h3>
          <p>
            Toont 8 seconden “Burgie gepakt, ZINGEN” met de loper die nu op de piste is, en bewaart het moment in de
            analyse.
          </p>
          <button
            className="btn btn--primary"
            disabled={pending}
            onClick={() =>
              void run(
                burgieGepakt,
                (event) =>
                  `Burgie gepakt opgeslagen om ${formatClockTimeMs(event.occurredAt)}${
                    event.runnerName
                      ? ` voor ${event.runnerNumber ? `${event.runnerNumber} ` : ''}${event.runnerName}`
                      : ''
                  }.`,
                'Burgie gepakt opslaan mislukt'
              )
            }
          >
            {pending ? 'Opslaan...' : 'Burgie gepakt'}
          </button>
        </div>
        <div className="public-moment">
          <h3 id="public-record-mode">Recordflits</h3>
          <p>Een nieuwe snelste ronde verschijnt 8 seconden groot op het Buitenscherm.</p>
          <div className="segmented-control" role="group" aria-labelledby="public-record-mode">
            {RECORD_MODES.map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                className={publicRecordMode === mode ? 'is-active' : ''}
                aria-pressed={publicRecordMode === mode}
                disabled={pending}
                onClick={() => {
                  if (publicRecordMode === mode) return;
                  void run(
                    () => updatePublicRecordMode(mode),
                    (settings) => `Recordflits staat op ${publicRecordModeLabel(settings.publicRecordMode)}.`,
                    'Recordflits aanpassen mislukt'
                  );
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="public-links">
        <Link className="btn btn--sm" to="/display/outside">
          <Icon name="displayOutside" size={14} />
          Buitenscherm openen
        </Link>
        <Link className="btn btn--sm" to="/display/inside">
          <Icon name="displayInside" size={14} />
          Binnenscherm openen
        </Link>
      </div>
      <AdminNoticeBanner notice={notice} />
    </section>
  );
}
