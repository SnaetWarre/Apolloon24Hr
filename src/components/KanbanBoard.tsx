import React from 'react';
import { useAppStore } from '../store';
import { formatDurationMs, nowMs } from '../lib/time';
import type { Runner, RunnerStatus } from '../types';
import { DndContext, closestCenter, useDraggable, useDroppable, DragEndEvent } from '@dnd-kit/core';

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
    if (!over || active.id === over.id) return;
    const oldIndex = waitingSorted.findIndex((r) => r.id === String(active.id));
    const newIndex = waitingSorted.findIndex((r) => r.id === String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    moveInQueue(String(active.id), newIndex);
  }

  return (
    <div className="kanban">
      {COLUMNS.map((col) => {
        const items = col.key === 'waiting'
          ? waitingSorted
          : filteredRunners.filter((r) => r.status === col.key);
        return (
          <div key={col.key} className="column">
            <div className="column-title">{col.title}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {col.key === 'waiting' ? (
                <DndContext collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                  {items.map((r, idx) => (
                    <DroppableCard key={r.id} id={r.id}>
                      <DraggableWaitingCard
                        id={r.id}
                        runner={r}
                        idx={idx}
                        selected={selectedRunnerId === r.id}
                        onSelect={() => selectRunner(r.id)}
                        onSetStatus={setStatus}
                      />
                    </DroppableCard>
                  ))}
                </DndContext>
              ) : (
                items.map((r) => (
                  <div
                    key={r.id}
                    onClick={() => selectRunner(r.id)}
                    className={`card${selectedRunnerId === r.id ? ' card--selected' : ''}`}
                    style={{ cursor: 'pointer' }}
                  >
                    <div className="card-row">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                        <div className="name-wrap">{r.name}</div>
                        <TimerBadge runner={r} />
                      </div>
                      <div style={{ display: 'flex', gap: 4 }}>
                        {col.key !== 'warming_up' && (
                          <button 
                            onClick={(e) => { e.stopPropagation(); setStatus(r.id, 'warming_up'); }}
                            className="btn btn--sm"
                          >Opwarmen</button>
                        )}
                        {col.key !== 'waiting' && (
                          <button 
                            onClick={(e) => { e.stopPropagation(); setStatus(r.id, 'waiting'); }}
                            className="btn btn--sm"
                          >Wachtrij</button>
                        )}
                        {col.key !== 'ran' && (
                          <button 
                            onClick={(e) => { e.stopPropagation(); setStatus(r.id, 'ran'); }}
                            className="btn btn--sm"
                          >Gelopen</button>
                        )}
                        {col.key === 'ran' && (
                          <button 
                            className="btn btn--danger"
                            onClick={(e) => { e.stopPropagation(); deleteRunner(r.id); }}
                          >×</button>
                        )}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};

function DraggableWaitingCard({ id, runner, idx, selected, onSelect, onSetStatus }: { 
  id: string; 
  runner: Runner; 
  idx: number; 
  selected: boolean; 
  onSelect: () => void; 
  onSetStatus: (id: string, status: RunnerStatus) => Promise<void>; 
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id });
  const style: React.CSSProperties = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    opacity: isDragging ? 0.8 : 1
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
          <span style={{ 
            fontSize: 12, 
            color: '#93c5fd',
            fontWeight: 600,
            background: 'rgba(0, 0, 0, 0.3)',
            padding: '2px 8px',
            borderRadius: '4px'
          }}>{idx === 0 ? '🎯 Next up' : `#${idx + 1}`}</span>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button 
            onClick={(e) => { e.stopPropagation(); onSetStatus(id, 'ran'); }}
            className="btn btn--sm"
          >Markeer gelopen</button>
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


