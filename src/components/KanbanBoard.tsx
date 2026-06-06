import React from 'react';
import { DndContext, closestCenter, useDraggable, useDroppable, DragEndEvent } from '@dnd-kit/core';
import { useAppStore } from '../store';
import { formatDurationMs, nowMs } from '../lib/time';
import type { Runner, RunnerStatus } from '../types';
import { LabelBadge } from './LabelBadge';

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
  return <span className="timer-badge">{formatDurationMs(nowMs() - runner.statusSince)}</span>;
}

export const KanbanBoard: React.FC = () => {
  const runners = useAppStore((state) => state.runners);
  const search = useAppStore((state) => state.search);
  const setStatus = useAppStore((state) => state.setStatus);
  const moveInQueue = useAppStore((state) => state.moveInQueue);
  const selectedRunnerId = useAppStore((state) => state.selectedRunnerId);
  const selectRunner = useAppStore((state) => state.selectRunner);
  const deleteRunner = useAppStore((state) => state.deleteRunner);

  const filteredRunners = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    const visible = runners.filter((runner) => runner.status !== 'running');
    if (!q) return visible;
    return visible.filter((runner) => {
      const labelText = runner.labels.map((label) => label.name).join(' ').toLowerCase();
      return (
        runner.name.toLowerCase().includes(q) ||
        (runner.runnerNumber || '').toLowerCase().includes(q) ||
        labelText.includes(q)
      );
    });
  }, [runners, search]);

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
                    onDelete={deleteRunner}
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
  onDelete,
}: {
  id: string;
  runner: Runner;
  selected: boolean;
  onSelect: () => void;
  columnKey: RunnerStatus;
  queueIndex?: number;
  onSetStatus: (id: string, status: RunnerStatus) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id });
  const style: React.CSSProperties = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    opacity: isDragging ? 0.5 : 1,
  };

  async function handleDelete(event: React.MouseEvent) {
    event.stopPropagation();
    if (!window.confirm(`Loper ${runner.name} verwijderen?`)) return;
    await onDelete(id);
  }

  return (
    <div ref={setNodeRef} className={`card${selected ? ' card--selected' : ''}`} style={style}>
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
            {runner.lapCount} toeren
            {runner.bestLapMs ? ` · snelste ${formatDurationMs(runner.bestLapMs)}` : ''}
          </span>
        </button>
        <div className="card-actions">
          <TimerBadge runner={runner} />
          {columnKey === 'waiting' && queueIndex !== undefined && (
            <span className="queue-badge">{queueIndex === 0 ? 'Volgende' : `#${queueIndex + 1}`}</span>
          )}
          {columnKey !== 'warming_up' && (
            <button onClick={(event) => { event.stopPropagation(); onSetStatus(id, 'warming_up'); }} className="btn btn--sm">
              Opwarmen
            </button>
          )}
          {columnKey !== 'waiting' && (
            <button onClick={(event) => { event.stopPropagation(); onSetStatus(id, 'waiting'); }} className="btn btn--sm">
              Wachtrij
            </button>
          )}
          {columnKey !== 'ran' && (
            <button onClick={(event) => { event.stopPropagation(); onSetStatus(id, 'ran'); }} className="btn btn--sm">
              Gelopen
            </button>
          )}
          {columnKey === 'ran' && (
            <button className="btn btn--danger" onClick={handleDelete}>
              Verwijder
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
