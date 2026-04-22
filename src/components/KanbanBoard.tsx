import React from 'react';
import { useAppStore } from '../store';
import { formatDurationMs, nowMs } from '../lib/time';
import type { Runner, RunnerStatus } from '../types';
import { DndContext, closestCenter, useDraggable, useDroppable, DragEndEvent, DragOverlay } from '@dnd-kit/core';

const COLUMNS: { key: RunnerStatus; title: string }[] = [
  { key: 'warming_up', title: 'Aan het opwarmen' },
  { key: 'waiting', title: 'In de wachtrij' },
  { key: 'ran', title: 'Heeft gelopen' },
];

function TimerBadge({ runner }: { runner: Runner }) {
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    const id = setInterval(() => setTick((n) => (n + 1) % 1_000_000), 1000);
    return () => clearInterval(id);
  }, []);
  if (!runner.statusSince) return null;
  const ms = nowMs() - runner.statusSince;
  return (
    <span className="timer-badge">⏱ {formatDurationMs(ms)}</span>
  );
}

export const KanbanBoard: React.FC = () => {
  const runners = useAppStore((s) => s.runners);
  const search = useAppStore((s) => s.search);
  const setStatus = useAppStore((s) => s.setStatus);
  const moveInQueue = useAppStore((s) => s.moveInQueue);
  const selectedRunnerId = useAppStore((s) => s.selectedRunnerId);
  const selectRunner = useAppStore((s) => s.selectRunner);
  const deleteRunner = useAppStore((s) => s.deleteRunner);

  const filteredRunners = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return runners;
    return runners.filter((r) => r.name.toLowerCase().includes(q));
  }, [runners, search]);

  const waitingSorted = React.useMemo(() => {
    return filteredRunners
      .filter((r) => r.status === 'waiting')
      .sort((a, b) => (a.queueIndex ?? 0) - (b.queueIndex ?? 0));
  }, [filteredRunners]);

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;
    
    const activeId = String(active.id);
    const overId = String(over.id);
    
    // Check if dropping on a column
    if (overId.startsWith('column-')) {
      const targetStatus = overId.replace('column-', '') as RunnerStatus;
      const runner = filteredRunners.find((r) => r.id === activeId);
      if (runner && runner.status !== targetStatus) {
        setStatus(activeId, targetStatus);
      }
      return;
    }
    
    // Check if reordering within waiting queue
    const activeRunner = filteredRunners.find((r) => r.id === activeId);
    const overRunner = filteredRunners.find((r) => r.id === overId);
    
    if (activeRunner?.status === 'waiting' && overRunner?.status === 'waiting') {
      const oldIndex = waitingSorted.findIndex((r) => r.id === activeId);
      const newIndex = waitingSorted.findIndex((r) => r.id === overId);
      if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
        moveInQueue(activeId, newIndex);
      }
      return;
    }
    
    // Dropping on a card in a different column - move to that column
    if (overRunner && activeRunner && activeRunner.status !== overRunner.status) {
      setStatus(activeId, overRunner.status);
    }
  }

  return (
    <DndContext collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <div className="kanban">
        {COLUMNS.map((col) => {
          const items = col.key === 'waiting'
            ? waitingSorted
            : filteredRunners.filter((r) => r.status === col.key);
          return (
            <DroppableColumn key={col.key} id={`column-${col.key}`} title={col.title}>
              {col.key === 'waiting' ? (
                items.map((r, idx) => (
                  <DroppableCard key={r.id} id={r.id}>
                    <DraggableCard
                      id={r.id}
                      runner={r}
                      selected={selectedRunnerId === r.id}
                      onSelect={() => selectRunner(r.id)}
                      columnKey={col.key}
                      queueIndex={idx}
                      onSetStatus={setStatus}
                      onDelete={deleteRunner}
                    />
                  </DroppableCard>
                ))
              ) : (
                items.map((r) => (
                  <DraggableCard
                    key={r.id}
                    id={r.id}
                    runner={r}
                    selected={selectedRunnerId === r.id}
                    onSelect={() => selectRunner(r.id)}
                    columnKey={col.key}
                    onSetStatus={setStatus}
                    onDelete={deleteRunner}
                  />
                ))
              )}
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
    <div 
      ref={setNodeRef} 
      className="column"
      style={{
        borderColor: isOver ? '#3b82f6' : 'rgba(59,130,246,.3)',
        background: isOver ? 'rgba(59,130,246,.15)' : 'rgba(0,0,0,.4)',
        transition: 'border-color 0.2s ease, background 0.2s ease'
      }}
    >
      <div className="column-title">{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minHeight: 100 }}>
        {children}
      </div>
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
  onDelete 
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
    cursor: isDragging ? 'grabbing' : 'grab'
  };
  const className = `card${selected ? ' card--selected' : ''}`;
  
  return (
    <div ref={setNodeRef} className={className} style={style}>
      <div className="card-row">
        <div 
          {...listeners} 
          {...attributes} 
          onClick={onSelect}
          style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'grab', flex: 1, minWidth: 0 }}
        >
          <div className="name-wrap">{runner.name}</div>
          <TimerBadge runner={runner} />
          {columnKey === 'waiting' && queueIndex !== undefined && (
            <span style={{ 
              fontSize: 12, 
              color: '#93c5fd',
              fontWeight: 600,
              background: 'rgba(0, 0, 0, 0.3)',
              padding: '2px 8px',
              borderRadius: '4px'
            }}>{queueIndex === 0 ? '🎯 Next up' : `#${queueIndex + 1}`}</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {columnKey === 'waiting' && (
            <button 
              onClick={(e) => { e.stopPropagation(); onSetStatus(id, 'ran'); }}
              className="btn btn--sm"
            >Markeer gelopen</button>
          )}
          {columnKey !== 'warming_up' && columnKey !== 'waiting' && (
            <button 
              onClick={(e) => { e.stopPropagation(); onSetStatus(id, 'warming_up'); }}
              className="btn btn--sm"
            >Opwarmen</button>
          )}
          {columnKey !== 'waiting' && columnKey !== 'ran' && (
            <button 
              onClick={(e) => { e.stopPropagation(); onSetStatus(id, 'waiting'); }}
              className="btn btn--sm"
            >Wachtrij</button>
          )}
          {columnKey !== 'ran' && columnKey !== 'waiting' && (
            <button 
              onClick={(e) => { e.stopPropagation(); onSetStatus(id, 'ran'); }}
              className="btn btn--sm"
            >Gelopen</button>
          )}
          {columnKey === 'ran' && (
            <button 
              className="btn btn--danger"
              onClick={(e) => { e.stopPropagation(); onDelete(id); }}
            >×</button>
          )}
        </div>
      </div>
    </div>
  );
}

function DroppableCard({ id, children }: { id: string; children: React.ReactNode }) {
  const { setNodeRef } = useDroppable({ id });
  return (
    <div ref={setNodeRef}>
      {children}
    </div>
  );
}


