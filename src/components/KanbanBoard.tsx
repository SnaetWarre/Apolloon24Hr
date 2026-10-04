import React from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent,
} from '@dnd-kit/core';
import { useAppActions, useAppData } from '../app/index';
import { useBoardSearch } from '../app/boardSearch';
import { useArrivals } from '../lib/motion';
import { runnerMatchesSearch } from '../lib/runners';
import { formatDurationMs, formatElapsedSeconds } from '../lib/time';
import { useSecondTick } from '../lib/useClockTick';
import { kanbanCollisionDetection, resolveKanbanDrop } from '../lib/kanban';
import type { LiveAppSnapshot, Runner, RunnerStatus } from '../types';
import { LabelBadge } from './LabelBadge';
import { RunnerName } from './RunnerName';
import { Icon } from './Icon';

const selectKanbanData = ({ runners }: LiveAppSnapshot) => ({ runners });

const COLUMNS: { key: RunnerStatus; title: string }[] = [
  { key: 'warming_up', title: 'Opwarming' },
  { key: 'waiting', title: 'Klaar om te lopen' },
];

// Warming up this long is worth a glance; it never blocks anything.
const LONG_WARM_UP_MS = 10 * 60_000;

function TimerBadge({ runner }: { runner: Runner }) {
  const running = Boolean(runner.statusSince && runner.status !== 'ran');
  const now = useSecondTick(running);
  if (!runner.statusSince || runner.status === 'ran') return <span className="timer-badge" />;
  const elapsedMs = now - runner.statusSince;
  const long = runner.status === 'warming_up' && elapsedMs >= LONG_WARM_UP_MS;
  return (
    <span
      className={`timer-badge${long ? ' timer-badge--long' : ''}`}
      title={long ? 'Al meer dan 10 minuten aan het opwarmen (mm:ss)' : 'Tijd in deze status (mm:ss)'}
    >
      <Icon name="timing" size={12} />
      {formatElapsedSeconds(elapsedMs)}
    </span>
  );
}

const LAST_IN_ORDER = Number.MAX_SAFE_INTEGER;

function runnerNumberValue(runner: Runner) {
  const parsed = Number.parseInt(runner.runnerNumber ?? '', 10);
  return Number.isFinite(parsed) ? parsed : LAST_IN_ORDER;
}

function compareByStatusSinceAsc(a: Runner, b: Runner) {
  return (a.statusSince ?? LAST_IN_ORDER) - (b.statusSince ?? LAST_IN_ORDER);
}

function compareByStatusSinceDesc(a: Runner, b: Runner) {
  return (b.statusSince ?? 0) - (a.statusSince ?? 0);
}

export const KanbanBoard: React.FC<{ onOpenProfile: (runnerId: string) => void }> = ({ onOpenProfile }) => {
  const { runners } = useAppData(selectKanbanData);
  const search = useBoardSearch();
  const { setStatus, moveInQueue, hideRunner, unhideRunner } = useAppActions();
  const [showHiddenRan, setShowHiddenRan] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [draggedRunnerId, setDraggedRunnerId] = React.useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = React.useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor)
  );

  // Changes show at once and reach the server in click order, so the board never locks between clicks.
  const runQueueAction = React.useCallback(async (action: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Wachtrijactie mislukt');
    }
  }, []);
  const handleHide = React.useCallback(
    (id: string) => runQueueAction(() => hideRunner(id)),
    [hideRunner, runQueueAction]
  );
  const handleUnhide = React.useCallback(
    (id: string) => runQueueAction(() => unhideRunner(id)),
    [runQueueAction, unhideRunner]
  );

  const filteredRunners = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    const visible = runners.filter((runner) => {
      if (runner.status === 'registered' || runner.status === 'running') return false;
      if (runner.hiddenFromQueue && !(showHiddenRan && runner.status === 'ran')) return false;
      return true;
    });
    if (!q) return visible;
    return visible.filter((runner) => runnerMatchesSearch(runner, q));
  }, [runners, search, showHiddenRan]);
  const warmingUpSorted = React.useMemo(() => {
    return filteredRunners
      .filter((runner) => runner.status === 'warming_up')
      .sort((a, b) => compareByStatusSinceAsc(a, b) || runnerNumberValue(a) - runnerNumberValue(b));
  }, [filteredRunners]);

  const completeWaitingQueue = React.useMemo(() => {
    return runners
      .filter((runner) => runner.status === 'waiting')
      .sort(
        (a, b) =>
          (a.queueIndex ?? LAST_IN_ORDER) - (b.queueIndex ?? LAST_IN_ORDER) ||
          compareByStatusSinceAsc(a, b) ||
          runnerNumberValue(a) - runnerNumberValue(b)
      );
  }, [runners]);
  const visibleRunnerIds = new Set(filteredRunners.map((runner) => runner.id));
  const waitingSorted = completeWaitingQueue.filter((runner) => visibleRunnerIds.has(runner.id));
  const queuePositionByRunnerId = React.useMemo(
    () => new Map(completeWaitingQueue.map((runner, index) => [runner.id, index])),
    [completeWaitingQueue]
  );

  const ranSorted = React.useMemo(() => {
    return filteredRunners
      .filter((runner) => runner.status === 'ran')
      .sort(
        (a, b) =>
          compareByStatusSinceDesc(a, b) ||
          (b.createdAt ?? 0) - (a.createdAt ?? 0) ||
          runnerNumberValue(b) - runnerNumberValue(a)
      );
  }, [filteredRunners]);

  function onDragEnd(event: DragEndEvent) {
    setDraggedRunnerId(null);
    setDropTargetId(null);
    const { active, over } = event;
    if (!over) return;

    const activeId = String(active.id);
    const overId = String(over.id);
    const action = resolveKanbanDrop(activeId, overId, filteredRunners);
    if (action?.type === 'set-status') {
      void runQueueAction(() => setStatus(action.runnerId, action.status));
    } else if (action?.type === 'move-in-queue') {
      void runQueueAction(() => moveInQueue(action.runnerId, action.targetRunnerId));
    }
  }

  const draggedRunner = runners.find((runner) => runner.id === draggedRunnerId);
  const dropAction =
    draggedRunnerId && dropTargetId ? resolveKanbanDrop(draggedRunnerId, dropTargetId, filteredRunners) : null;

  // A runner counts as arrived in a lane when the pair (lane, runner) is new, whatever the filter shows.
  const arrivedIds = useArrivals(
    runners
      .filter((runner) => runner.status === 'warming_up' || runner.status === 'waiting' || runner.status === 'ran')
      .map((runner) => `${runner.status}:${runner.id}`)
  );

  function renderRunnerRow(runner: Runner) {
    const queuePosition = queuePositionByRunnerId.get(runner.id) ?? -1;
    const insertionEdge =
      dropAction?.type === 'move-in-queue' && dropAction.targetRunnerId === runner.id
        ? (queuePositionByRunnerId.get(dropAction.runnerId) ?? -1) < queuePosition
          ? 'after'
          : 'before'
        : undefined;
    return (
      <QueueRunnerRow
        key={runner.id}
        runner={runner}
        queuePosition={queuePosition}
        arrived={arrivedIds.has(`${runner.status}:${runner.id}`)}
        insertionEdge={insertionEdge}
        onOpenProfile={onOpenProfile}
        onAdvance={() =>
          void runQueueAction(() => setStatus(runner.id, runner.status === 'warming_up' ? 'waiting' : 'warming_up'))
        }
        onToggleHidden={() => void (runner.hiddenFromQueue ? handleUnhide(runner.id) : handleHide(runner.id))}
      />
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={kanbanCollisionDetection}
      onDragStart={({ active }) => setDraggedRunnerId(String(active.id))}
      onDragOver={({ over }) => setDropTargetId(over ? String(over.id) : null)}
      onDragCancel={() => {
        setDraggedRunnerId(null);
        setDropTargetId(null);
      }}
      onDragEnd={onDragEnd}
    >
      {actionError && (
        <div className="warning-banner" role="alert">
          {actionError}
        </div>
      )}
      <div className="queue-workspace">
        <div className="queue-lanes">
          {COLUMNS.map((column) => {
            const columnRunners = column.key === 'warming_up' ? warmingUpSorted : waitingSorted;
            return (
              <QueueLane
                key={column.key}
                id={`column-${column.key}`}
                title={column.title}
                count={columnRunners.length}
                totalCount={
                  search.trim()
                    ? runners.filter((runner) => runner.status === column.key && !runner.hiddenFromQueue).length
                    : undefined
                }
                dropHint={
                  dropAction?.type === 'set-status' && dropAction.status === column.key
                    ? column.key === 'waiting'
                      ? 'Loslaten: achteraan in de wachtrij'
                      : 'Loslaten: naar opwarming'
                    : undefined
                }
              >
                {columnRunners.map(renderRunnerRow)}
                {!columnRunners.length && (
                  <p className="empty-inline">
                    {search.trim()
                      ? 'Geen lopers voor dit filter. Wis het filter om iedereen te zien.'
                      : column.key === 'warming_up'
                        ? 'Nog niemand aan het opwarmen. Zoek een loper op nummer of naam, of voeg een nieuwe loper toe.'
                        : 'De wachtrij is leeg. Sleep een opgewarmde loper hierheen of kies “Naar wachtrij”.'}
                  </p>
                )}
              </QueueLane>
            );
          })}
        </div>
        <details className="queue-completed">
          <summary className="disclosure">
            Heeft gelopen <span>{ranSorted.length}</span>
            <small>Terug laten opwarmen of verbergen</small>
          </summary>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={showHiddenRan}
              onChange={(event) => setShowHiddenRan(event.target.checked)}
            />
            Verborgen gelopen tonen
          </label>
          <div className="queue-completed__rows">
            {ranSorted.map(renderRunnerRow)}
            {!ranSorted.length && <p className="empty-inline">Geen gelopen lopers voor deze selectie.</p>}
          </div>
        </details>
      </div>
      <DragOverlay dropAnimation={null} zIndex={2}>
        {draggedRunner && (
          <div className="queue-runner queue-runner--overlay">
            <span className="queue-drag" aria-hidden="true">
              ⠿
            </span>
            <div className="queue-identity">
              <span className="runner-title">
                <RunnerName runner={draggedRunner} />
              </span>
              <span className="queue-runner__details">Loslaten om te verplaatsen</span>
            </div>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
};

function QueueLane({
  id,
  title,
  count,
  totalCount,
  dropHint,
  children,
}: {
  id: string;
  title: string;
  count: number;
  totalCount?: number;
  dropHint?: string;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const changed = useArrivals([`count:${count}`]);
  return (
    <section
      ref={setNodeRef}
      className={`queue-lane${isOver || dropHint ? ' queue-lane--over' : ''}`}
      aria-label={title}
    >
      <header>
        <h2>{title}</h2>
        {dropHint ? (
          <span className="queue-drop-hint" role="status">
            {dropHint}
          </span>
        ) : (
          <span key={count} className={changed.has(`count:${count}`) ? 'value-tick' : undefined}>
            {count}
            {totalCount !== undefined ? ` van ${totalCount}` : ''}{' '}
            {count === 1 && totalCount === undefined ? 'loper' : 'lopers'}
          </span>
        )}
      </header>
      <div className="queue-lane__rows">{children}</div>
    </section>
  );
}

function QueueRunnerRow({
  runner,
  queuePosition,
  arrived,
  onOpenProfile,
  onAdvance,
  insertionEdge,
  onToggleHidden,
}: {
  runner: Runner;
  queuePosition: number;
  arrived: boolean;
  onOpenProfile: (runnerId: string) => void;
  onAdvance: () => void;
  insertionEdge?: 'before' | 'after';
  onToggleHidden: () => void;
}) {
  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({ id: runner.id });
  const { setNodeRef: setDropRef } = useDroppable({ id: runner.id, disabled: isDragging });
  const isCompleted = runner.status === 'ran';
  return (
    <div
      ref={setDropRef}
      className={insertionEdge ? `queue-drop-target queue-drop-target--${insertionEdge}` : undefined}
    >
      {insertionEdge && <span className="queue-insertion-label">Hier invoegen</span>}
      <div
        ref={setDragRef}
        {...listeners}
        {...attributes}
        aria-label={`Verplaats ${runner.name}`}
        onKeyDown={(event) => {
          if (event.target === event.currentTarget) listeners?.onKeyDown?.(event);
        }}
        className={`queue-runner${isDragging ? ' queue-runner--dragging' : ''}${queuePosition === 0 ? ' queue-runner--next' : ''}${arrived ? ' queue-runner--arrived' : ''}`}
      >
        <span className="queue-drag" aria-hidden="true">
          ⠿
        </span>
        {queuePosition >= 0 && (
          <span className="queue-position" title={queuePosition === 0 ? 'Volgende loper' : 'Positie in wachtrij'}>
            {queuePosition + 1}
          </span>
        )}
        <button
          className="queue-identity"
          onClick={() => onOpenProfile(runner.id)}
          title={`${runner.name}: profiel openen`}
        >
          <span className="runner-title">
            <RunnerName runner={runner} />
            {queuePosition === 0 && <span className="queue-next-tag">Volgende</span>}
          </span>
          <span className="queue-runner__details">
            {runner.labels.map((label) => (
              <LabelBadge key={label.id} label={label} compact />
            ))}
            {runner.lapCount > 0 && (
              <span title={runner.bestLapMs ? `Snelste ronde ${formatDurationMs(runner.bestLapMs)}` : undefined}>
                {runner.lapCount} {runner.lapCount === 1 ? 'ronde' : 'rondes'}
              </span>
            )}
            {runner.estimatedPace && <span title="Geschat tempo uit de inschrijving">~{runner.estimatedPace}</span>}
          </span>
        </button>
        <TimerBadge runner={runner} />
        <div className="queue-row-actions" onPointerDown={(event) => event.stopPropagation()}>
          <button className={`btn btn--sm${runner.status === 'warming_up' ? ' btn--advance' : ''}`} onClick={onAdvance}>
            {runner.status === 'warming_up' ? 'Naar wachtrij' : 'Opwarmen'}
          </button>
          {isCompleted && (
            <button className="btn btn--quiet btn--sm" onClick={onToggleHidden}>
              {runner.hiddenFromQueue ? 'Terug tonen' : 'Verberg'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
