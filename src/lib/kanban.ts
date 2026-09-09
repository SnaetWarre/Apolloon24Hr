import { closestCenter, pointerWithin, type Collision, type CollisionDetection } from '@dnd-kit/core';
import type { Runner, RunnerStatus } from '../types';

export type KanbanDropAction =
  | { type: 'set-status'; runnerId: string; status: RunnerStatus }
  | { type: 'move-in-queue'; runnerId: string; targetRunnerId: string };

function isColumnId(id: string): boolean {
  return id.startsWith('column-');
}

function withoutActive(collisions: Collision[], activeId: string): Collision[] {
  return collisions.filter((collision) => String(collision.id) !== activeId);
}

function preferRunnerTarget(collisions: Collision[]): Collision[] {
  const runnerTarget = collisions.find((collision) => !isColumnId(String(collision.id)));
  return runnerTarget ? [runnerTarget] : collisions.slice(0, 1);
}

/**
 * Pointer drops should follow the element actually under the pointer. Using
 * closestCenter alone is unreliable when a column has few or no cards because
 * the large, nested column and card drop zones compete with nearby targets.
 */
export const kanbanCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = withoutActive(pointerWithin(args), String(args.active.id));
  if (args.pointerCoordinates) return preferRunnerTarget(pointerCollisions);

  return preferRunnerTarget(withoutActive(closestCenter(args), String(args.active.id)));
};

export function resolveKanbanDrop(
  activeId: string,
  overId: string,
  runners: Pick<Runner, 'id' | 'status'>[]
): KanbanDropAction | null {
  const activeRunner = runners.find((runner) => runner.id === activeId);
  if (!activeRunner) return null;

  if (isColumnId(overId)) {
    const targetStatus = overId.slice('column-'.length) as RunnerStatus;
    if (targetStatus === 'ran' || activeRunner.status === targetStatus) return null;
    return { type: 'set-status', runnerId: activeId, status: targetStatus };
  }

  const overRunner = runners.find((runner) => runner.id === overId);
  if (!overRunner) return null;

  if (activeRunner.status === 'waiting' && overRunner.status === 'waiting') {
    if (activeId === overId) return null;
    return { type: 'move-in-queue', runnerId: activeId, targetRunnerId: overId };
  }

  if (activeRunner.status !== overRunner.status && overRunner.status !== 'ran') {
    return { type: 'set-status', runnerId: activeId, status: overRunner.status };
  }

  return null;
}
