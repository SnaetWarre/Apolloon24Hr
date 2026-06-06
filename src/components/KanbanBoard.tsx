import React from 'react';
import { DndContext, closestCenter, useDraggable, useDroppable, DragEndEvent } from '@dnd-kit/core';
import { useAppStore } from '../store';
import { formatDurationMs, formatElapsedSeconds, nowMs } from '../lib/time';
import type { Runner, RunnerStatus } from '../types';
import { LabelBadge } from './LabelBadge';
import { SourceBadge } from './RunnerEntryModals';

const COLUMNS: { key: RunnerStatus; title: string }[] = [
  { key: 'warming_up', title: 'Aan het opwarmen' },
  { key: 'waiting', title: 'In de wachtrij' },
  { key: 'ran', title: 'Heeft gelopen' },
];

function TimerBadge({ runner }: { runner: Runner }) {
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    const id = window.setInterval(() => setTick((tick) => (tick + 1) % 1_000_000), 1000);
    return () => window.clearInterval(id);
  }, []);
  if (!runner.statusSince || runner.status === 'ran') return null;
  return <span className="timer-badge">{formatElapsedSeconds(nowMs() - runner.statusSince)}</span>;
}

export const KanbanBoard: React.FC = () => {
  const runners = useAppStore((state) => state.runners);
  const search = useAppStore((state) => state.search);
  const setStatus = useAppStore((state) => state.setStatus);
  const moveInQueue = useAppStore((state) => state.moveInQueue);
  const selectedRunnerId = useAppStore((state) => state.selectedRunnerId);
  const selectRunner = useAppStore((state) => state.selectRunner);
  const hideRunner = useAppStore((state) => state.hideRunner);
  const unhideRunner = useAppStore((state) => state.unhideRunner);
  const [showHiddenRan, setShowHiddenRan] = React.useState(false);

  const filteredRunners = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    const visible = runners.filter((runner) => {
      if (runner.status === 'registered' || runner.status === 'running') return false;
      if (runner.hiddenFromQueue && !(showHiddenRan && runner.status === 'ran')) return false;
      return true;
    });
    if (!q) return visible;
    return visible.filter((runner) => {
      const labelText = runner.labels.map((label) => label.name).join(' ').toLowerCase();
      return (
        runner.name.toLowerCase().includes(q) ||
        (runner.runnerNumber || '').toLowerCase().includes(q) ||
        labelText.includes(q)
      );
    });
  }, [runners, search, showHiddenRan]);

  const waitingSorted = React.useMemo(() => {
    return filteredRunners
      .filter((runner) => runner.status === 'waiting')
      .sort((a, b) => (a.queueIndex ?? 0) - (b.queueIndex ?? 0));
  }, [filteredRunners]);

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;

    const activeId = String(active.id);
    const overId = String(over.id);

    if (overId.startsWith('column-')) {
      const targetStatus = overId.replace('column-', '') as RunnerStatus;
      const runner = filteredRunners.find((item) => item.id === activeId);
      if (runner && runner.status !== targetStatus) {
        setStatus(activeId, targetStatus);
      }
      return;
    }

    const activeRunner = filteredRunners.find((runner) => runner.id === activeId);
    const overRunner = filteredRunners.find((runner) => runner.id === overId);

    if (activeRunner?.status === 'waiting' && overRunner?.status === 'waiting') {
      const oldIndex = waitingSorted.findIndex((runner) => runner.id === activeId);
      const newIndex = waitingSorted.findIndex((runner) => runner.id === overId);
      if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
        moveInQueue(activeId, newIndex);
      }
      return;
    }

    if (overRunner && activeRunner && activeRunner.status !== overRunner.status) {
      setStatus(activeId, overRunner.status);
    }
  }

  return (
    <DndContext collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <div className="board-toolbar">
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={showHiddenRan}
            onChange={(event) => setShowHiddenRan(event.target.checked)}
          />
          Verborgen gelopen tonen
        </label>
      </div>
      <div className="kanban">
        {COLUMNS.map((column) => {
          const items =
            column.key === 'waiting'
              ? waitingSorted
              : filteredRunners.filter((runner) => runner.status === column.key);
          return (
            <DroppableColumn key={column.key} id={`column-${column.key}`} title={column.title}>
              {items.map((runner, index) => (
                <DroppableCard key={runner.id} id={runner.id}>
                  <DraggableCard
                    id={runner.id}
                    runner={runner}
                    selected={selectedRunnerId === runner.id}
                    onSelect={() => selectRunner(runner.id)}
                    columnKey={column.key}
                    queueIndex={column.key === 'waiting' ? index : undefined}
                    onSetStatus={setStatus}
                    onHide={hideRunner}
                    onUnhide={unhideRunner}
                  />
                </DroppableCard>
              ))}
              {items.length === 0 && <div className="column-empty">Geen lopers</div>}
            </DroppableColumn>
          );
        })}
      </div>
    </DndContext>
  );
};

function DroppableColumn({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div ref={setNodeRef} className={`column${isOver ? ' column--over' : ''}`}>
      <div className="column-title">{title}</div>
      <div className="column-body">{children}</div>
    </div>
  );
}

function DraggableCard({
  id,
  runner,
  selected,
  onSelect,
  columnKey,
  queueIndex,
  onSetStatus,
  onHide,
  onUnhide,
}: {
  id: string;
  runner: Runner;
  selected: boolean;
  onSelect: () => void;
  columnKey: RunnerStatus;
  queueIndex?: number;
  onSetStatus: (id: string, status: RunnerStatus) => Promise<void>;
  onHide: (id: string) => Promise<void>;
  onUnhide: (id: string) => Promise<void>;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id });
  const style: React.CSSProperties = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    opacity: isDragging ? 0.5 : 1,
  };

  async function handleHide(event: React.MouseEvent) {
    event.stopPropagation();
    await onHide(id);
  }

  async function handleUnhide(event: React.MouseEvent) {
    event.stopPropagation();
    await onUnhide(id);
  }

  return (
    <div
      ref={setNodeRef}
      className={`card${selected ? ' card--selected' : ''}${runner.hiddenFromQueue ? ' card--muted' : ''}`}
      style={style}
    >
      <div className="card-row">
        <button
          type="button"
          {...listeners}
          {...attributes}
          onClick={onSelect}
          className="card-main"
        >
          <span className="runner-title">
            {runner.runnerNumber && <span className="runner-number">{runner.runnerNumber}</span>}
            <span>{runner.name}</span>
          </span>
          <LabelPills labels={runner.labels} />
          <span className="card-meta">
            <span>
              {runner.lapCount} toeren
              {runner.bestLapMs ? ` · snelste ${formatDurationMs(runner.bestLapMs)}` : ''}
            </span>
            <SourceBadge source={runner.registrationSource} />
          </span>
        </button>
        <div className="card-actions">
          <TimerBadge runner={runner} />
          {columnKey === 'waiting' && queueIndex !== undefined && (
            <span className="queue-badge">{queueIndex === 0 ? 'Volgende' : `#${queueIndex + 1}`}</span>
          )}
          {columnKey !== 'warming_up' && (
            <button onClick={(event) => { event.stopPropagation(); onSetStatus(id, 'warming_up'); }} className="btn btn--sm btn--fixed">
              Opwarmen
            </button>
          )}
          {columnKey !== 'waiting' && (
            <button onClick={(event) => { event.stopPropagation(); onSetStatus(id, 'waiting'); }} className="btn btn--sm btn--fixed">
              Wachtrij
            </button>
          )}
          {columnKey !== 'ran' && (
            <button onClick={(event) => { event.stopPropagation(); onSetStatus(id, 'ran'); }} className="btn btn--sm btn--fixed">
              Gelopen
            </button>
          )}
          {columnKey === 'ran' && !runner.hiddenFromQueue && (
            <button className="btn btn--sm btn--fixed" onClick={handleHide}>
              Verberg
            </button>
          )}
          {columnKey === 'ran' && runner.hiddenFromQueue && (
            <button className="btn btn--sm btn--fixed" onClick={handleUnhide}>
              Terug tonen
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function LabelPills({ labels }: { labels: Runner['labels'] }) {
  if (!labels.length) return null;
  return (
    <span className="label-row">
      {labels.map((label) => (
        <LabelBadge key={label.id} label={label} compact />
      ))}
    </span>
  );
}

function DroppableCard({ id, children }: { id: string; children: React.ReactNode }) {
  const { setNodeRef } = useDroppable({ id });
  return <div ref={setNodeRef}>{children}</div>;
}
