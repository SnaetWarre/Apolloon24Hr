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
    <span style={{ 
      fontSize: 12, 
      color: '#fff', 
      background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)', 
      padding: '4px 10px', 
      borderRadius: 999,
      fontWeight: 600,
      boxShadow: '0 2px 8px rgba(59, 130, 246, 0.4)'
    }}>
      ⏱ {formatDurationMs(ms)}
    </span>
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
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
      {COLUMNS.map((col) => {
        const items = col.key === 'waiting'
          ? waitingSorted
          : filteredRunners.filter((r) => r.status === col.key);
        return (
          <div key={col.key} style={{ 
            border: '2px solid rgba(59, 130, 246, 0.3)', 
            borderRadius: 12, 
            padding: 16, 
            background: 'rgba(0, 0, 0, 0.4)',
            boxShadow: '0 4px 16px rgba(0, 0, 0, 0.3)'
          }}>
            <div style={{ 
              fontWeight: 700, 
              marginBottom: 12, 
              fontSize: '18px',
              color: '#93c5fd',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              borderBottom: '2px solid rgba(59, 130, 246, 0.3)',
              paddingBottom: '8px'
            }}>{col.title}</div>
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
                    style={{
                      border: selectedRunnerId === r.id ? '2px solid #3b82f6' : '2px solid rgba(59, 130, 246, 0.2)',
                      borderRadius: 8,
                      padding: 12,
                      background: selectedRunnerId === r.id ? 'rgba(59, 130, 246, 0.2)' : 'rgba(0, 0, 0, 0.3)',
                      cursor: 'pointer',
                      transition: 'all 0.2s ease',
                      boxShadow: selectedRunnerId === r.id ? '0 4px 12px rgba(59, 130, 246, 0.3)' : '0 2px 4px rgba(0, 0, 0, 0.2)'
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ fontWeight: 600, color: '#fff' }}>{r.name}</div>
                        <TimerBadge runner={r} />
                      </div>
                      <div style={{ display: 'flex', gap: 4 }}>
                        {col.key !== 'warming_up' && (
                          <button 
                            onClick={(e) => { e.stopPropagation(); setStatus(r.id, 'warming_up'); }}
                            style={{
                              padding: '6px 12px',
                              fontSize: '12px',
                              background: 'rgba(59, 130, 246, 0.8)',
                              color: 'white',
                              border: 'none',
                              borderRadius: '4px',
                              cursor: 'pointer',
                              fontWeight: 600
                            }}
                          >Opwarmen</button>
                        )}
                        {col.key !== 'waiting' && (
                          <button 
                            onClick={(e) => { e.stopPropagation(); setStatus(r.id, 'waiting'); }}
                            style={{
                              padding: '6px 12px',
                              fontSize: '12px',
                              background: 'rgba(59, 130, 246, 0.8)',
                              color: 'white',
                              border: 'none',
                              borderRadius: '4px',
                              cursor: 'pointer',
                              fontWeight: 600
                            }}
                          >Wachtrij</button>
                        )}
                        {col.key !== 'ran' && (
                          <button 
                            onClick={(e) => { e.stopPropagation(); setStatus(r.id, 'ran'); }}
                            style={{
                              padding: '6px 12px',
                              fontSize: '12px',
                              background: 'rgba(59, 130, 246, 0.8)',
                              color: 'white',
                              border: 'none',
                              borderRadius: '4px',
                              cursor: 'pointer',
                              fontWeight: 600
                            }}
                          >Gelopen</button>
                        )}
                        {col.key === 'ran' && (
                          <button 
                            style={{ 
                              padding: '6px 10px',
                              fontSize: '16px',
                              color: 'white', 
                              background: '#dc2626',
                              border: 'none',
                              borderRadius: '4px',
                              cursor: 'pointer',
                              fontWeight: 700
                            }} 
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
    border: selected ? '2px solid #3b82f6' : '2px solid rgba(59, 130, 246, 0.2)',
    borderRadius: 8,
    padding: 12,
    background: selected ? 'rgba(59, 130, 246, 0.2)' : 'rgba(0, 0, 0, 0.3)',
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    opacity: isDragging ? 0.8 : 1,
    transition: 'all 0.2s ease',
    boxShadow: selected ? '0 4px 12px rgba(59, 130, 246, 0.3)' : '0 2px 4px rgba(0, 0, 0, 0.2)'
  };
  return (
    <div ref={setNodeRef} style={style}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div 
          {...listeners} 
          {...attributes} 
          onClick={onSelect}
          style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'grab', flex: 1 }}
        >
          <div style={{ fontWeight: 600, color: '#fff' }}>{runner.name}</div>
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
            style={{
              padding: '6px 12px',
              fontSize: '12px',
              background: 'rgba(59, 130, 246, 0.8)',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontWeight: 600
            }}
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


