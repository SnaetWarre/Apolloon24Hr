import React from 'react';
import { DndContext, useDraggable, useDroppable, DragEndEvent } from '@dnd-kit/core';
import { useAppActions, useAppData } from '../app/index';
import { useAppStore } from '../store';
import { formatDurationMs, formatElapsedSeconds, nowMs } from '../lib/time';
import { useSecondTick } from '../lib/useAnimationFrameTick';
import { kanbanCollisionDetection, resolveKanbanDrop } from '../lib/kanban';
import type { LiveAppSnapshot, Runner, RunnerStatus } from '../types';
import { LabelBadge } from './LabelBadge';

const selectKanbanData = ({ runners }: LiveAppSnapshot) => ({ runners });

const COLUMNS: { key: RunnerStatus; title: string }[] = [
  { key: 'warming_up', title: 'Opwarming' },
  { key: 'waiting', title: 'Klaar om te lopen' },
];

function TimerBadge({ runner }: { runner: Runner }) {
  const running = Boolean(runner.statusSince && runner.status !== 'ran');
  useSecondTick(running);
  if (!runner.statusSince || runner.status === 'ran') return null;
  return <span className="timer-badge">{formatElapsedSeconds(nowMs() - runner.statusSince)}</span>;
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
  const search = useAppStore((state) => state.search);
  const { setStatus, moveInQueue, hideRunner, unhideRunner } = useAppActions();
  const [showHiddenRan, setShowHiddenRan] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [actionBusy, setActionBusy] = React.useState(false);
  const actionBusyRef = React.useRef(false);

  const runQueueAction = React.useCallback(async (action: () => Promise<unknown>) => {
    if (actionBusyRef.current) return;
    actionBusyRef.current = true;
    setActionBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Wachtrijactie mislukt');
    } finally {
      actionBusyRef.current = false;
      setActionBusy(false);
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
    return visible.filter((runner) => {
      const labelText = runner.labels
        .map((label) => label.name)
        .join(' ')
        .toLowerCase();
      return (
        runner.name.toLowerCase().includes(q) ||
        (runner.runnerNumber || '').toLowerCase().includes(q) ||
        labelText.includes(q)
      );
    });
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

  function renderRunnerRow(runner: Runner) {
    const queuePosition = queuePositionByRunnerId.get(runner.id) ?? -1;
    const previousRunner = queuePosition > 0 ? completeWaitingQueue[queuePosition - 1] : null;
    return (
      <QueueRunnerRow
        key={runner.id}
        runner={runner}
        queuePosition={queuePosition}
        actionBusy={actionBusy}
        onOpenProfile={onOpenProfile}
        onAdvance={() =>
          void runQueueAction(() =>
            setStatus(runner.id, runner.status === 'warming_up' ? 'waiting' : 'warming_up')
          )
        }
        onMoveEarlier={
          previousRunner
            ? () => void runQueueAction(() => moveInQueue(runner.id, previousRunner.id))
            : undefined
        }
        onToggleHidden={() => void (runner.hiddenFromQueue ? handleUnhide(runner.id) : handleHide(runner.id))}
      />
    );
  }

  return (
    <DndContext collisionDetection={kanbanCollisionDetection} onDragEnd={onDragEnd}>
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
              >
                {columnRunners.map(renderRunnerRow)}
                {!columnRunners.length && (
                  <p className="empty-inline">
                    {search ? 'Geen lopers voor dit filter.' : 'Nog geen lopers.'}
                  </p>
                )}
              </QueueLane>
            );
          })}
        </div>
        <details className="queue-completed">
          <summary>
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
    </DndContext>
  );
};

function QueueLane({
  id,
  title,
  count,
  children,
}: {
  id: string;
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <section ref={setNodeRef} className={`queue-lane${isOver ? ' queue-lane--over' : ''}`} aria-label={title}>
      <header>
        <h2>{title}</h2>
        <span>{count} lopers</span>
      </header>
      <div className="queue-lane__rows">{children}</div>
    </section>
  );
}

function QueueRunnerRow({
  runner,
  queuePosition,
  actionBusy,
  onOpenProfile,
  onAdvance,
  onMoveEarlier,
  onToggleHidden,
}: {
  runner: Runner;
  queuePosition: number;
  actionBusy: boolean;
  onOpenProfile: (runnerId: string) => void;
  onAdvance: () => void;
  onMoveEarlier?: () => void;
  onToggleHidden: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    transform,
    isDragging,
  } = useDraggable({ id: runner.id, disabled: actionBusy });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: runner.id });
  const rowStyle: React.CSSProperties = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
  };
  const isCompleted = runner.status === 'ran';
  return (
    <div ref={setDropRef} className={isOver ? 'queue-drop-target' : undefined}>
      <div
        ref={setDragRef}
        style={rowStyle}
        className={`queue-runner${isDragging ? ' queue-runner--dragging' : ''}${queuePosition === 0 ? ' queue-runner--next' : ''}`}
      >
        <button
          {...listeners}
          {...attributes}
          className="queue-drag"
          aria-label={`Verplaats ${runner.name}`}
          title="Sleep om te verplaatsen"
        >
          ⠿
        </button>
        {queuePosition >= 0 && (
          <span
            className="queue-position"
            title={queuePosition === 0 ? 'Volgende loper' : 'Positie in wachtrij'}
          >
            {queuePosition + 1}
          </span>
        )}
        <button className="queue-identity" onClick={() => onOpenProfile(runner.id)} title="Profiel openen">
          <span className="runner-title">
            <span className="runner-number">{runner.runnerNumber || '-'}</span>
            {runner.name}
          </span>
          <span className="queue-runner__details">
            {runner.labels.map((label) => (
              <LabelBadge key={label.id} label={label} compact />
            ))}
            <span
              title={runner.bestLapMs ? `Snelste ronde ${formatDurationMs(runner.bestLapMs)}` : undefined}
            >
              {runner.lapCount} toeren
            </span>
          </span>
        </button>
        <TimerBadge runner={runner} />
        <div className="queue-row-actions">
          {queuePosition >= 0 && (
            <button
              className="btn btn--sm"
              disabled={actionBusy || !onMoveEarlier}
              onClick={onMoveEarlier}
              aria-label={`${runner.name} één plaats naar voren`}
            >
              ↑
            </button>
          )}
          <button className="btn btn--sm" disabled={actionBusy} onClick={onAdvance}>
            {runner.status === 'warming_up' ? 'Naar wachtrij →' : 'Opwarmen'}
          </button>
          {isCompleted && (
            <button className="btn btn--secondary btn--sm" disabled={actionBusy} onClick={onToggleHidden}>
              {runner.hiddenFromQueue ? 'Terug tonen' : 'Verberg'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
