import React from 'react';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { trpc } from '../../api';
import { activityKey } from '../../app/snapshot';
import type { ActivityCursor, ActivityEntry } from '../../types';

const PAGE_SIZE = 200;

/**
 * Every change to the event data, newest first, with the screen and address it came from.
 * The list is the same on every linked laptop: each entry is saved with the change itself.
 */
export function ActivitySection({ active }: { active: boolean }) {
  const [search, setSearch] = React.useState('');
  const [showQueue, setShowQueue] = React.useState(false);
  // The server filters, so every page holds PAGE_SIZE matching entries however many queue moves sit between them.
  const filters = { queueMoves: showQueue, search: search.trim() };
  const query = useInfiniteQuery({
    queryKey: [...activityKey, filters],
    queryFn: ({ pageParam }) => trpc.activity.list.query({ limit: PAGE_SIZE, before: pageParam, ...filters }),
    initialPageParam: null as ActivityCursor | null,
    getNextPageParam: (lastPage) => {
      if (lastPage.length < PAGE_SIZE) return undefined;
      const last = lastPage[lastPage.length - 1];
      return { occurredAt: last.occurredAt, id: last.id };
    },
    // Only while the section is open: every change refreshes it.
    enabled: active,
    // Typing a search keeps the old list on screen until the new one arrives.
    placeholderData: keepPreviousData,
  });

  const entries = query.data?.pages.flat() ?? [];
  const emptyText = query.isLoading
    ? 'Activiteit laden…'
    : filters.search
      ? 'Geen activiteit gevonden.'
      : 'Nog geen activiteit.';

  return (
    <section className="panel">
      <h2>Activiteit</h2>
      <p className="panel-copy">
        Wie wat veranderde, van welk scherm en welk adres. Elke laptop toont dezelfde lijst. Gelopen rondes staan niet
        hier maar bij Analyse.
      </p>
      <div className="activity-toolbar">
        <input
          className="input"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Zoek op loper, label of adres"
          aria-label="Activiteit doorzoeken"
        />
        <label className="toggle-row">
          <input type="checkbox" checked={showQueue} onChange={(event) => setShowQueue(event.target.checked)} />
          Wachtrij-bewegingen tonen
        </label>
      </div>
      {query.error ? (
        <div className="warning-banner" role="alert">
          De activiteit kon niet geladen worden.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="activity-table">
            <thead>
              <tr>
                <th>Tijd</th>
                <th>Wat</th>
                <th>Waar</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <ActivityRow key={entry.id} entry={entry} />
              ))}
              {entries.length === 0 && (
                <tr>
                  <td colSpan={3}>{emptyText}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {query.hasNextPage && (
        <button
          className="btn btn--ghost"
          onClick={() => void query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
        >
          {query.isFetchingNextPage ? 'Laden…' : 'Oudere activiteit laden'}
        </button>
      )}
    </section>
  );
}

function ActivityRow({ entry }: { entry: ActivityEntry }) {
  return (
    <tr>
      <td className="activity-table__time">{formatMoment(entry.occurredAt)}</td>
      <td>{entry.summary}</td>
      <td className="activity-table__origin">{entry.origin}</td>
    </tr>
  );
}

function formatMoment(ms: number): string {
  return new Date(ms).toLocaleString('nl-BE', {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'Europe/Brussels',
  });
}
