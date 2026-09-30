import crypto from 'node:crypto';
import type { ActivityCursor, ActivityEntry } from '../../shared/schemas.js';
import { all, run } from './connection.js';

const MAX_PAGE = 500;

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

/** The newest entries first; `before` continues below the last entry of the previous page. */
export function getActivity(limit: number, before: ActivityCursor | null = null): ActivityEntry[] {
  const size = Math.min(Math.max(1, Math.trunc(limit) || 1), MAX_PAGE);
  return all<ActivityEntry>(
    `SELECT id, occurred_at AS occurredAt, action, summary, origin
     FROM activity_log
     WHERE (occurred_at, id) < (?, ?)
     ORDER BY occurred_at DESC, id DESC
     LIMIT ?`,
    [before?.occurredAt ?? Number.MAX_SAFE_INTEGER, before?.id ?? '', size]
  );
}
