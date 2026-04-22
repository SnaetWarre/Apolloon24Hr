import { create } from 'zustand';
import { io } from 'socket.io-client';
import type { Runner, RunnerStatus, ViewMode } from './types';
import { fetchState } from './auth';

interface AppState {
  view: ViewMode;
  runners: Runner[];
  search: string;
  selectedRunnerId: string | null;
  initialize: () => Promise<void>;
  setView: (v: ViewMode) => void;
  setSearch: (q: string) => void;
  selectRunner: (id: string | null) => void;
  selectNext: () => void;
  selectPrev: () => void;
  addRunner: (name: string) => Promise<void>;
  setStatus: (id: string, status: RunnerStatus) => Promise<void>;
  moveInQueue: (id: string, newIndex: number) => Promise<void>;
  deleteRunner: (id: string) => Promise<void>;
}

// client no longer fabricates runners locally

let socket: any | null = null;

export const useAppStore = create<AppState>((set, get) => ({
  view: 'kanban',
  runners: [],
  search: '',
  selectedRunnerId: null,
  async initialize() {
    // Fetch initial state (requires being logged in)
    const state = await fetchState<{ runners: Runner[] }>();
    set({ runners: state.runners });
    // Connect socket
    if (!socket) {
      socket = io('/', { withCredentials: true });
      socket.on('state:init', (payload: { runners: Runner[] }) => {
        set({ runners: payload.runners });
      });
      socket.on('runner:added', (runner: Runner) => {
        set({ runners: [...get().runners, runner] });
      });
      socket.on('runner:updated', (updated: Runner) => {
        set({ runners: get().runners.map((r) => (r.id === updated.id ? updated : r)) });
      });
      socket.on('runner:deleted', (id: string) => {
        set({ runners: get().runners.filter((r) => r.id !== id) });
      });
      socket.on('waiting:reordered', (ids: string[]) => {
        const map = new Map(ids.map((id, idx) => [id, idx] as const));
        const next = get().runners.map((r) => (r.status === 'waiting' ? { ...r, queueIndex: map.get(r.id) ?? r.queueIndex } : r));
        set({ runners: next });
      });
    }
  },
  setView(v) {
    set({ view: v });
  },
  setSearch(q) {
    set({ search: q });
  },
  selectRunner(id) {
    set({ selectedRunnerId: id });
  },
  selectNext() {
    const q = get().search.trim().toLowerCase();
    const filtered = q ? get().runners.filter((r) => r.name.toLowerCase().includes(q)) : get().runners;
    const sorted = [...filtered].sort((a, b) => a.name.localeCompare(b.name));
    if (sorted.length === 0) return;
    const currentId = get().selectedRunnerId;
      if (!currentId) {
      set({ selectedRunnerId: sorted[0].id });
      return;
    }
    const idx = sorted.findIndex((r) => r.id === currentId);
    const nextIdx = Math.min(sorted.length - 1, idx + 1);
    set({ selectedRunnerId: sorted[nextIdx]?.id ?? currentId });
  },
  selectPrev() {
    const q = get().search.trim().toLowerCase();
    const filtered = q ? get().runners.filter((r) => r.name.toLowerCase().includes(q)) : get().runners;
    const sorted = [...filtered].sort((a, b) => a.name.localeCompare(b.name));
    if (sorted.length === 0) return;
    const currentId = get().selectedRunnerId;
      if (!currentId) {
      set({ selectedRunnerId: sorted[0].id });
      return;
    }
    const idx = sorted.findIndex((r) => r.id === currentId);
    const prevIdx = Math.max(0, idx - 1);
    set({ selectedRunnerId: sorted[prevIdx]?.id ?? currentId });
  },
  async addRunner(name) {
    const res = await fetch('/api/runners', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
      credentials: 'include',
    });
    if (!res.ok) throw new Error('failed to add');
  },
  async setStatus(id, status) {
    // Optimistic update: instant UI
    const now = Date.now();
    const prev = get().runners.find((r) => r.id === id);
    if (!prev) return;
    
    let queueIndex = prev.queueIndex;
    if (status === 'waiting') {
      const maxIdx = get().runners
        .filter((r) => r.status === 'waiting' && r.id !== id)
        .reduce((m, r) => Math.max(m, r.queueIndex ?? -1), -1);
      queueIndex = maxIdx + 1;
    } else {
      queueIndex = null;
    }
    
    set({
      runners: get().runners.map((r) =>
        r.id === id ? { ...r, status, statusSince: now, queueIndex } : r
      ),
    });

    // Background sync
    fetch(`/api/runners/${id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
      credentials: 'include',
    }).catch(() => {
      // rollback on error (optional)
    });
  },
  async moveInQueue(id, newIndex) {
    // Optimistic reorder: instant UI
    const waiting = get().runners
      .filter((r) => r.status === 'waiting')
      .sort((a, b) => (a.queueIndex ?? 0) - (b.queueIndex ?? 0));
    const others = get().runners.filter((r) => r.status !== 'waiting');
    const targetIdx = waiting.findIndex((r) => r.id === id);
    if (targetIdx === -1) return;
    
    const [moved] = waiting.splice(targetIdx, 1);
    waiting.splice(newIndex, 0, moved);
    const reindexed = waiting.map((r, i) => ({ ...r, queueIndex: i }));
    set({ runners: [...others, ...reindexed] });

    // Background sync
    const ids = waiting.map((r) => r.id);
    fetch('/api/waiting/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
      credentials: 'include',
    }).catch(() => {
      // ignore or rollback
    });
  },
  async deleteRunner(id) {
    // Optimistic: remove instantly
    set({ runners: get().runners.filter((r) => r.id !== id) });
    
    // Background sync
    fetch(`/api/runners/${id}`, { method: 'DELETE', credentials: 'include' }).catch(() => {
      // ignore or rollback
    });
  },
}));


