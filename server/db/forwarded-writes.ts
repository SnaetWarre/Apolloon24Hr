import { one, run } from './connection.js';

/**
 * Results of writes another laptop passed on, by request id. When the main
 * laptop fails while a write is on its way, the sender repeats it at the next
 * main laptop; this makes sure the repeat is not applied twice. Replicated, so
 * whichever laptop leads next knows what already happened.
 */
const KEEP_MS = 10 * 60_000;

export function findForwardedWrite(requestId: string): { result: unknown } | null {
  const row = one<{ resultJson: string }>(
    'SELECT result_json AS resultJson FROM forwarded_writes WHERE request_id = ?',
    [requestId]
  );
  return row ? { result: JSON.parse(row.resultJson) as unknown } : null;
}

export function saveForwardedWrite(requestId: string, result: unknown, now: number): void {
  run('DELETE FROM forwarded_writes WHERE created_at < ?', [now - KEEP_MS]);
  run('INSERT INTO forwarded_writes (request_id, result_json, created_at) VALUES (?, ?, ?)', [
    requestId,
    JSON.stringify(result ?? null),
    now,
  ]);
}

/** Rewrites the entry for a repeat, so confirming the repeat also confirms the original. */
export function touchForwardedWrite(requestId: string, now: number): void {
  run('UPDATE forwarded_writes SET created_at = ? WHERE request_id = ?', [now, requestId]);
}
