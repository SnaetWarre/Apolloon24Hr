import crypto from 'node:crypto';
import type { ActivityCursor, ActivityEntry } from '../../shared/schemas.js';
import { foldSearchText } from '../../shared/search.js';
import { iterate, run } from './connection.js';

const MAX_PAGE = 500;

/** Moving runners through warm-up and the queue happens all the time; Activiteit shows it on request. */
const QUEUE_ACTIONS = ['runners.setStatus', 'runners.reorder'];

/**
 * Records who changed what, inside the write it describes: the entry travels to the
 * other laptops with the change itself, and disappears with it when the write fails.
 */
export function logActivity(entry: Omit<ActivityEntry, 'id'>): void {
  run('INSERT INTO activity_log (id, occurred_at, action, summary, origin) VALUES (?, ?, ?, ?, ?)', [
    crypto.randomUUID(),
    entry.occurredAt,
    entry.action,
    entry.summary.slice(0, 500),
    entry.origin.slice(0, 200),
  ]);
}

/**
 * The newest entries first; `before` continues below the last entry of the previous page.
 * The filters apply before the page is cut, so a full page means there may be more.
 */
export function getActivity(
  limit: number,
  before: ActivityCursor | null = null,
  { queueMoves = true, search = '' }: { queueMoves?: boolean; search?: string } = {}
): ActivityEntry[] {
  const size = Math.min(Math.max(1, Math.trunc(limit) || 1), MAX_PAGE);
  // SQLite cannot drop accents, so the search runs here, row by row, until the page is full.
  const needle = foldSearchText(search.trim());
  const rows = iterate<ActivityEntry>(
    `SELECT id, occurred_at AS occurredAt, action, summary, origin
     FROM activity_log
     WHERE (occurred_at, id) < (?, ?)${queueMoves ? '' : ` AND action NOT IN (${QUEUE_ACTIONS.map(() => '?').join(', ')})`}
     ORDER BY occurred_at DESC, id DESC`,
    [before?.occurredAt ?? Number.MAX_SAFE_INTEGER, before?.id ?? '', ...(queueMoves ? [] : QUEUE_ACTIONS)]
  );
  const page: ActivityEntry[] = [];
  for (const entry of rows) {
    if (needle && !foldSearchText(entry.summary).includes(needle) && !foldSearchText(entry.origin).includes(needle)) {
      continue;
    }
    page.push(entry);
    if (page.length === size) break;
  }
  return page;
}
