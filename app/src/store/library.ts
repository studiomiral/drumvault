import { create } from 'zustand'
import type { SampleFilter } from '../types/api'

interface LibraryState {
  filter: SampleFilter
  selectedId: number | null
  setFilter(patch: Partial<SampleFilter>): void
  resetFilter(): void
  select(id: number | null): void
}

const EMPTY: SampleFilter = {
  kind: null, categories: [], keys: [], compatible: false, bars: [], zipIds: [], favoritesOnly: false,
  search: '', sort: 'name',
}

export const useLibrary = create<LibraryState>((set) => ({
  filter: EMPTY,
  selectedId: null,
  setFilter: (patch) => set((s) => ({ filter: { ...s.filter, ...patch } })),
  resetFilter: () => set((s) => ({ filter: { ...EMPTY, sort: s.filter.sort } })),
  select: (selectedId) => set({ selectedId }),
}))
