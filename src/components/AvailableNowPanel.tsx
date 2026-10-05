import React from 'react';
import { useRegistrations } from '../app/index';
import { brusselsMoment, findAvailableUncalledRunners, formatMomentBlock } from '../lib/availability';
import { phoneHref } from '../lib/contact';
import { useClockTick } from '../lib/useClockTick';
import type { Runner } from '../types';
import { Icon } from './Icon';
import { LabelBadge } from './LabelBadge';
import { RunnerName } from './RunnerName';

const HOUR_MS = 3_600_000;

/**
 * Under the board: who could run this hour according to their registration,
 * but is not warming up or waiting. The list rolls over on the hour, so the
 * crew never calls last hour's people.
 */
export function AvailableNowPanel({
  runners,
  onOpenProfile,
}: {
  runners: Runner[];
  onOpenProfile: (runnerId: string) => void;
}) {
  const registrations = useRegistrations();
  const [search, setSearch] = React.useState('');
  // Ticks exactly on the hour boundary; Brussels hours line up with UTC hours.
  const now = useClockTick(HOUR_MS);
  const { hour, weekday } = brusselsMoment(now);
  const moment = { hour, weekday };
  const available = findAvailableUncalledRunners(runners, registrations, moment);
  const query = search.trim().toLowerCase();
  const shown = query
    ? available.filter(
        ({ runner, phone }) =>
          runner.name.toLowerCase().includes(query) ||
          (runner.runnerNumber ?? '').toLowerCase().includes(query) ||
          phone.replace(/\s+/g, '').includes(query.replace(/\s+/g, ''))
      )
    : available;
  const hasRegistrations = Object.keys(registrations).length > 0;

  return (
    <details className="available-now" open>
      <summary className="disclosure">
        Nu beschikbaar, nog niet opgeroepen <span>{available.length}</span>
        <small>{formatMomentBlock(moment)}</small>
      </summary>
      <div className="available-now__toolbar">
        <p className="available-now__copy">
          Volgens hun inschrijving kunnen deze lopers dit uur lopen, maar ze staan niet aan het opwarmen of in de
          wachtrij. Klik op een naam voor het profiel.
        </p>
        <label className="board-search">
          <Icon name="search" size={14} />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Naam, nummer of telefoon"
            aria-label="Beschikbare lopers filteren"
          />
        </label>
      </div>
      <div className="available-now__rows">
        {shown.map(({ runner, phone, flexibility }) => (
          <AvailableRunnerRow
            key={runner.id}
            runner={runner}
            phone={phone}
            flexibility={flexibility}
            onOpenProfile={onOpenProfile}
          />
        ))}
        {!shown.length && (
          <p className="empty-inline">
            {!hasRegistrations
              ? 'Geen inschrijvingsuren bekend. Importeer de inschrijvingen in Beheer.'
              : query
                ? 'Geen beschikbare lopers voor dit filter.'
                : 'Iedereen die dit uur beschikbaar is, staat al klaar of heeft al gelopen.'}
          </p>
        )}
      </div>
    </details>
  );
}

function AvailableRunnerRow({
  runner,
  phone,
  flexibility,
  onOpenProfile,
}: {
  runner: Runner;
  phone: string;
  flexibility: string;
  onOpenProfile: (runnerId: string) => void;
}) {
  const phoneLink = phoneHref(phone);
  return (
    <div className="available-now__row">
      <button type="button" className="queue-identity" onClick={() => onOpenProfile(runner.id)}>
        <span className="runner-title">
          <RunnerName runner={runner} />
        </span>
        <span className="queue-runner__details">
          {runner.labels.map((label) => (
            <LabelBadge key={label.id} label={label} compact />
          ))}
          <span>{runner.status === 'ran' ? `${runner.lapCount} gelopen` : 'nog niet gelopen'}</span>
          {flexibility && <span>{flexibility}</span>}
        </span>
      </button>
      {phoneLink ? (
        <a className="btn btn--sm available-now__phone" href={phoneLink}>
          <Icon name="phone" size={14} />
          {phone}
        </a>
      ) : (
        <span className="available-now__phone available-now__phone--none">{phone || 'Geen nummer'}</span>
      )}
    </div>
  );
}
