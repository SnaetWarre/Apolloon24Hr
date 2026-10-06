import { compareWaitingOrder } from '../lib/runners';
import type { LiveAppSnapshot, RunnerStatus } from '../types';

/**
 * Queue changes show on this screen the moment they are clicked, before the server confirms them.
 * Each pending change is a patch over the server's snapshot. It is applied again to every snapshot
 * that arrives while it is in flight, so a refetch in between never flips a runner back. Patches
 * must be idempotent: the snapshot they land on may already contain the change.
 */
type Patch = (snapshot: LiveAppSnapshot) => LiveAppSnapshot;

const pending = new Set<Patch>();
let confirmed: LiveAppSnapshot | null = null;

/** Called with every snapshot the server sends; returns it with this screen's unconfirmed changes on top. */
export function withPendingChanges(serverSnapshot: LiveAppSnapshot): LiveAppSnapshot {
  confirmed = serverSnapshot;
  let snapshot = serverSnapshot;
  for (const patch of pending) snapshot = patch(snapshot);
  return snapshot;
}

/** The last snapshot as the server sent it, without changes still in flight. */
export function confirmedSnapshot(): LiveAppSnapshot | null {
  return confirmed;
}

/** Registers a patch; calling the returned function removes it and rebuilds the snapshot from the server state. */
export function addPendingChange(patch: Patch): () => LiveAppSnapshot | null {
  pending.add(patch);
  return () => {
    pending.delete(patch);
    return confirmed ? withPendingChanges(confirmed) : null;
  };
}

/** Queue positions of the waiting runners, first in line first. */
export function waitingOrder(snapshot: LiveAppSnapshot): string[] {
  return snapshot.runners
    .filter((runner) => runner.status === 'waiting')
    .sort(compareWaitingOrder)
    .map((runner) => runner.id);
}

/** Moves a runner to a lane the way the server does: waiting goes to the back, other lanes have no position. */
export function statusPatch(id: string, status: RunnerStatus, statusSince: number): Patch {
  return (snapshot) => {
    const runner = snapshot.runners.find((candidate) => candidate.id === id);
    if (!runner || runner.status === status) return snapshot;
    const lastIndex = Math.max(
      -1,
      ...snapshot.runners.filter((other) => other.status === 'waiting').map((other) => other.queueIndex ?? -1)
    );
    return {
      ...snapshot,
      runners: snapshot.runners.map((other) =>
        other.id === id
          ? {
              ...other,
              status,
              statusSince,
              queueIndex: status === 'waiting' ? lastIndex + 1 : null,
              hiddenFromQueue: false,
              queueHiddenAt: null,
            }
          : other
      ),
    };
  };
}

/** Puts the waiting runners in `ids` order; anyone waiting who is not listed keeps their turn after them. */
export function orderPatch(ids: string[]): Patch {
  return (snapshot) => {
    const listed = new Map(ids.map((id, index) => [id, index]));
    const unlisted = waitingOrder(snapshot).filter((id) => !listed.has(id));
    const position = new Map([...listed, ...unlisted.map((id, index) => [id, ids.length + index] as const)]);
    return {
      ...snapshot,
      runners: snapshot.runners.map((runner) =>
        runner.status === 'waiting' ? { ...runner, queueIndex: position.get(runner.id) ?? runner.queueIndex } : runner
      ),
    };
  };
}
