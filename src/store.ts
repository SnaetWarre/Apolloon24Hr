import { create } from 'zustand';

interface UiState {
  search: string;
  setSearch: (q: string) => void;
}

export const useAppStore = create<UiState>((set) => ({
  search: '',
  setSearch(q) {
    set({ search: q });
  },
}));
