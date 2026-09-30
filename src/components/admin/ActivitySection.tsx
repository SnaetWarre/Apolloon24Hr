import React from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { trpc } from '../../api';
import { activityKey } from '../../app/snapshot';
import type { ActivityEntry } from '../../types';

const PAGE_SIZE = 200;

/** Moving runners through warm-up and the queue happens all the time; shown on request. */
const QUEUE_ACTIONS = new Set(['runners.setStatus', 'runners.reorder']);

/**
 * Every change to the event data, newest first, with the screen and address it came from.
 * The list is the same on every linked laptop: each entry is saved with the change itself.
 */
export function ActivitySection({ active }: { active: boolean }) {
  const [search, setSearch] = React.useState('');
  const [showQueue, setShowQueue] = React.useState(false);
  const query = useInfiniteQuery({
    queryKey: activityKey,
    queryFn: ({ pageParam }) => trpc.activity.list.query({ limit: PAGE_SIZE, before: pageParam }),
    initialPageParam: null as number | null,
    getNextPageParam: (lastPage) =>
      lastPage.length < PAGE_SIZE ? undefined : lastPage[lastPage.length - 1].occurredAt,
    // Only while the section is open: every change refreshes it.
    enabled: active,
  });

  const needle = search.trim().toLowerCase();
  const entries = (query.data?.pages.flat() ?? []).filter(
    (entry) =>
      (showQueue || !QUEUE_ACTIONS.has(entry.action)) &&
      (!needle || entry.summary.toLowerCase().includes(needle) || entry.origin.toLowerCase().includes(needle))
  );

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
                  <td colSpan={3}>{query.isLoading ? 'Activiteit laden…' : 'Nog geen activiteit.'}</td>
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
  });
}
