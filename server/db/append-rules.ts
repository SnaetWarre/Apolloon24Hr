import type { ReplicationLogEntry } from './types.js';

/*
 * How a follower's log takes a leader's entries. Pure, so the SQLite log and
 * the in-memory log of the consensus simulation decide exactly alike.
 */

export type LogView = {
  headSeq: number;
  /** Id of the entry at `seq`, or null when this log does not hold it (never written, or pruned). */
  idAt(seq: number): string | null;
  /** The oldest entry still held, or null for an empty log. */
  oldestSeq(): number | null;
};

export type AppendOutcome = { ok: true } | { ok: false; reason: 'behind' | 'diverged' };

/**
 * Decides whether entries that follow (`prevSeq`, `prevId`) fit this log.
 * Entries this log already holds with the same id are skipped. A different id
 * at the same position, or entries here the leader did not send, mean the
 * histories diverged, and this laptop must re-sync from a full copy.
 */
export function planAppend(
  log: LogView,
  prevSeq: number,
  prevId: string | null,
  entries: ReplicationLogEntry[]
): { ok: true; fresh: ReplicationLogEntry[] } | { ok: false; reason: 'behind' | 'diverged' } {
  if (prevSeq > log.headSeq) return { ok: false, reason: 'behind' };
  if (prevSeq > 0 && log.idAt(prevSeq) !== prevId) return { ok: false, reason: 'diverged' };
  const coveredSeq = entries.length ? entries[entries.length - 1].seq : prevSeq;
  if (log.headSeq > coveredSeq) return { ok: false, reason: 'diverged' };
  for (const entry of entries) {
    if (entry.seq <= log.headSeq && log.idAt(entry.seq) !== entry.id) return { ok: false, reason: 'diverged' };
  }
  return { ok: true, fresh: entries.filter((entry) => entry.seq > log.headSeq) };
}

/** True when a follower at (`after`, `afterId`) holds a prefix of this log that is still retained. */
export function canContinueFrom(log: LogView, after: number, afterId: string | null): boolean {
  if (after > log.headSeq) return false;
  if (after === 0) {
    const oldest = log.oldestSeq();
    return oldest === null || oldest <= 1;
  }
  return log.idAt(after) === afterId;
}
