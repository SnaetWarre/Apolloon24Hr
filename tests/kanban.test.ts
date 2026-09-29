import assert from 'node:assert/strict';
import test from 'node:test';
import type { Active, CollisionDetection, DroppableContainer } from '@dnd-kit/core';
import { kanbanCollisionDetection, resolveKanbanDrop } from '../src/lib/kanban.ts';

type ClientRect = Parameters<CollisionDetection>[0]['collisionRect'];

test('dragging a warming-up runner into an empty or populated waiting column sets waiting status', () => {
  const warmingRunner = { id: 'warming-runner', status: 'warming_up' as const };
  const waitingRunner = { id: 'waiting-runner', status: 'waiting' as const };

  assert.deepEqual(resolveKanbanDrop(warmingRunner.id, 'column-waiting', [warmingRunner]), {
    type: 'set-status',
    runnerId: warmingRunner.id,
    status: 'waiting',
  });
  assert.deepEqual(resolveKanbanDrop(warmingRunner.id, waitingRunner.id, [warmingRunner, waitingRunner]), {
    type: 'set-status',
    runnerId: warmingRunner.id,
    status: 'waiting',
  });
});

test('kanban collision detection targets the exact empty column or runner under the pointer', () => {
  const active = {
    id: 'warming-runner',
    data: { current: undefined },
    rect: { current: { initial: null, translated: null } },
  } satisfies Active;
  const rect = (left: number, top: number, width: number, height: number): ClientRect => ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  });
  const container = (id: string, bounds: ClientRect): DroppableContainer => ({
    id,
    key: id,
    disabled: false,
    data: { current: undefined },
    node: { current: null },
    rect: { current: bounds },
  });
  const warmingColumnRect = rect(0, 0, 300, 800);
  const waitingColumnRect = rect(320, 0, 300, 800);
  const waitingRunnerRect = rect(330, 100, 280, 100);
  const warmingColumn = container('column-warming_up', warmingColumnRect);
  const waitingColumn = container('column-waiting', waitingColumnRect);

  const emptyColumnCollision = kanbanCollisionDetection({
    active,
    collisionRect: rect(350, 500, 280, 100),
    droppableContainers: [warmingColumn, waitingColumn],
    droppableRects: new Map([
      [warmingColumn.id, warmingColumnRect],
      [waitingColumn.id, waitingColumnRect],
    ]),
    pointerCoordinates: { x: 450, y: 550 },
  });
  assert.equal(emptyColumnCollision[0]?.id, 'column-waiting');

  const waitingRunner = container('waiting-runner', waitingRunnerRect);
  const populatedColumnCollision = kanbanCollisionDetection({
    active,
    collisionRect: rect(330, 100, 280, 100),
    droppableContainers: [warmingColumn, waitingColumn, waitingRunner],
    droppableRects: new Map([
      [warmingColumn.id, warmingColumnRect],
      [waitingColumn.id, waitingColumnRect],
      [waitingRunner.id, waitingRunnerRect],
    ]),
    pointerCoordinates: { x: 450, y: 150 },
  });
  assert.equal(populatedColumnCollision[0]?.id, 'waiting-runner');

  const outsideBoardCollisions = kanbanCollisionDetection({
    active,
    collisionRect: rect(700, 100, 280, 100),
    droppableContainers: [warmingColumn, waitingColumn, waitingRunner],
    droppableRects: new Map([
      [warmingColumn.id, warmingColumnRect],
      [waitingColumn.id, waitingColumnRect],
      [waitingRunner.id, waitingRunnerRect],
    ]),
    pointerCoordinates: { x: 800, y: 150 },
  });
  assert.deepEqual(outsideBoardCollisions, []);
});
