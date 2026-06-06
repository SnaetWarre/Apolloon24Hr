import { create } from 'zustand';
import { io } from 'socket.io-client';
import type { AppSnapshot, HostInfo, Label, LapRecord, RaceState, Runner, RunnerStatus, ViewMode } from './types';
import { fetchState } from './api';

export interface RunnerInput {
  name: string;
  runnerNumber?: string | null;
  targetLaps?: number | null;
  historicalAvgMs?: number | null;
  historicalBestMs?: number | null;
  notes?: string;
  labels?: string[];
}

interface AppState {
  view: ViewMode;
  runners: Runner[];
  labels: Label[];
  laps: LapRecord[];
  race: RaceState;
  host: HostInfo | null;
  search: string;
  selectedRunnerId: string | null;
  initialized: boolean;
  lastError: string | null;
  initialize: () => Promise<void>;
  refresh: () => Promise<void>;
  applySnapshot: (snapshot: AppSnapshot) => void;
  setView: (v: ViewMode) => void;
  setSearch: (q: string) => void;
  selectRunner: (id: string | null) => void;
  selectNext: () => void;
  selectPrev: () => void;
  addRunner: (input: string | RunnerInput) => Promise<void>;
  updateRunner: (id: string, input: Partial<RunnerInput>) => Promise<void>;
  setStatus: (id: string, status: RunnerStatus) => Promise<void>;
  moveInQueue: (id: string, newIndex: number) => Promise<void>;
  deleteRunner: (id: string) => Promise<void>;
  createLabel: (input: Pick<Label, 'name' | 'color' | 'icon' | 'kind'> & { imageUrl?: string | null }) => Promise<void>;
  updateLabel: (
    id: string,
    input: Partial<Pick<Label, 'name' | 'color' | 'icon' | 'kind' | 'imageUrl'>>
  ) => Promise<void>;
  deleteLabel: (id: string) => Promise<void>;
  importRunnersCsv: (csvText: string) => Promise<string>;
  handoff: () => Promise<void>;
  startNext: () => Promise<void>;
  undoLastHandoff: () => Promise<void>;
  finishRace: () => Promise<void>;
}

const emptyRace: RaceState = {
  id: 1,
  activeRunnerId: null,
  activeStartedAt: null,
  raceStartedAt: null,
  raceFinishedAt: null,
};

let socket: any | null = null;

async function apiRequest<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers || {}),
    },
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload?.error || 'Request failed');
  }
  return payload as T;
}

function snapshotFromPayload(payload: any): AppSnapshot | null {
  if (payload?.state) return payload.state as AppSnapshot;
  if (payload?.runners && payload?.labels && payload?.race && payload?.laps) {
    return payload as AppSnapshot;
  }
  return null;
}

function sortedSearchableRunners(runners: Runner[], search: string) {
  const q = search.trim().toLowerCase();
  const filtered = q
    ? runners.filter((runner) => {
        const labelText = runner.labels.map((label) => label.name).join(' ').toLowerCase();
        return (
          runner.name.toLowerCase().includes(q) ||
          (runner.runnerNumber || '').toLowerCase().includes(q) ||
          labelText.includes(q)
        );
      })
    : runners;
  return [...filtered].sort((a, b) => {
    const numberA = a.runnerNumber || '';
    const numberB = b.runnerNumber || '';
    return numberA.localeCompare(numberB, undefined, { numeric: true }) || a.name.localeCompare(b.name);
  });
}

export const useAppStore = create<AppState>((set, get) => ({
  view: 'kanban',
  runners: [],
  labels: [],
  laps: [],
  race: emptyRace,
  host: null,
  search: '',
  selectedRunnerId: null,
  initialized: false,
  lastError: null,
  async initialize() {
    if (get().initialized) return;
    const state = await fetchState<AppSnapshot>();
    get().applySnapshot(state);
    set({ initialized: true });
    if (!socket) {
      socket = io('/');
      socket.on('state:init', (snapshot: AppSnapshot) => get().applySnapshot(snapshot));
      socket.on('state:changed', (snapshot: AppSnapshot) => get().applySnapshot(snapshot));
    }
  },
  async refresh() {
    const state = await fetchState<AppSnapshot>();
    get().applySnapshot(state);
  },
  applySnapshot(snapshot) {
    set({
      runners: snapshot.runners || [],
      labels: snapshot.labels || [],
      laps: snapshot.laps || [],
      race: snapshot.race || emptyRace,
      host: snapshot.host || null,
      lastError: null,
    });
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
    const sorted = sortedSearchableRunners(get().runners, get().search);
    if (sorted.length === 0) return;
    const currentId = get().selectedRunnerId;
    if (!currentId) {
      set({ selectedRunnerId: sorted[0].id });
      return;
    }
    const idx = sorted.findIndex((runner) => runner.id === currentId);
    const nextIdx = Math.min(sorted.length - 1, idx + 1);
    set({ selectedRunnerId: sorted[nextIdx]?.id ?? currentId });
  },
  selectPrev() {
    const sorted = sortedSearchableRunners(get().runners, get().search);
    if (sorted.length === 0) return;
    const currentId = get().selectedRunnerId;
    if (!currentId) {
      set({ selectedRunnerId: sorted[0].id });
      return;
    }
    const idx = sorted.findIndex((runner) => runner.id === currentId);
    const prevIdx = Math.max(0, idx - 1);
    set({ selectedRunnerId: sorted[prevIdx]?.id ?? currentId });
  },
  async addRunner(input) {
    const body = typeof input === 'string' ? { name: input } : input;
    const payload = await apiRequest('/api/runners', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const snapshot = snapshotFromPayload(payload);
    if (snapshot) get().applySnapshot(snapshot);
  },
  async updateRunner(id, input) {
    const payload = await apiRequest(`/api/runners/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
    const snapshot = snapshotFromPayload(payload);
    if (snapshot) get().applySnapshot(snapshot);
  },
  async setStatus(id, status) {
    const payload = await apiRequest('/api/queue/status', {
      method: 'POST',
      body: JSON.stringify({ id, status }),
    });
    const snapshot = snapshotFromPayload(payload);
    if (snapshot) get().applySnapshot(snapshot);
  },
  async moveInQueue(id, newIndex) {
    const waiting = get()
      .runners.filter((runner) => runner.status === 'waiting')
      .sort((a, b) => (a.queueIndex ?? 0) - (b.queueIndex ?? 0));
    const oldIndex = waiting.findIndex((runner) => runner.id === id);
    if (oldIndex === -1) return;
    const [moved] = waiting.splice(oldIndex, 1);
    waiting.splice(newIndex, 0, moved);
    const payload = await apiRequest('/api/queue/reorder', {
      method: 'POST',
      body: JSON.stringify({ ids: waiting.map((runner) => runner.id) }),
    });
    const snapshot = snapshotFromPayload(payload);
    if (snapshot) get().applySnapshot(snapshot);
  },
  async deleteRunner(id) {
    const payload = await apiRequest(`/api/runners/${id}`, { method: 'DELETE' });
    const snapshot = snapshotFromPayload(payload);
    if (snapshot) get().applySnapshot(snapshot);
    if (get().selectedRunnerId === id) set({ selectedRunnerId: null });
  },
  async createLabel(input) {
    const payload = await apiRequest('/api/labels', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    const snapshot = snapshotFromPayload(payload);
    if (snapshot) get().applySnapshot(snapshot);
  },
  async updateLabel(id, input) {
    const payload = await apiRequest(`/api/labels/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
    const snapshot = snapshotFromPayload(payload);
    if (snapshot) get().applySnapshot(snapshot);
  },
  async deleteLabel(id) {
    const payload = await apiRequest(`/api/labels/${id}`, { method: 'DELETE' });
    const snapshot = snapshotFromPayload(payload);
    if (snapshot) get().applySnapshot(snapshot);
  },
  async importRunnersCsv(csvText) {
    const payload = await apiRequest('/api/import/runners-csv', {
      method: 'POST',
      body: JSON.stringify({ csvText }),
    });
    const snapshot = snapshotFromPayload(payload);
    if (snapshot) get().applySnapshot(snapshot);
    const summary = payload.summary;
    return `${summary.created} aangemaakt, ${summary.updated} bijgewerkt, ${summary.skipped} overgeslagen`;
  },
  async handoff() {
    const payload = await apiRequest('/api/race/handoff', { method: 'POST' });
    const snapshot = snapshotFromPayload(payload);
    if (snapshot) get().applySnapshot(snapshot);
  },
  async startNext() {
    const payload = await apiRequest('/api/race/start-next', { method: 'POST' });
    const snapshot = snapshotFromPayload(payload);
    if (snapshot) get().applySnapshot(snapshot);
  },
  async undoLastHandoff() {
    const payload = await apiRequest('/api/race/undo-last-handoff', { method: 'POST' });
    const snapshot = snapshotFromPayload(payload);
    if (snapshot) get().applySnapshot(snapshot);
  },
  async finishRace() {
    const payload = await apiRequest('/api/race/finish', { method: 'POST' });
    const snapshot = snapshotFromPayload(payload);
    if (snapshot) get().applySnapshot(snapshot);
  },
}));
