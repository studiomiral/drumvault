import { create } from 'zustand'
import type { SampleFilter } from '../types/api'

interface LibraryState {
  filter: SampleFilter
  /** "Find similar" mode: show the nearest neighbours of this sample instead of the filter. */
  similarTo: { id: number; name: string } | null
  selectedId: number | null
  setFilter(patch: Partial<SampleFilter>): void
  resetFilter(): void
  select(id: number | null): void
  findSimilar(s: { id: number; name: string } | null): void
}

const EMPTY: SampleFilter = {
  kind: null, categories: [], keys: [], compatible: false, bars: [], zipIds: [], favoritesOnly: false,
  search: '', sort: 'name',
}

export const useLibrary = create<LibraryState>((set) => ({
  filter: EMPTY,
  similarTo: null,
  selectedId: null,
  // Changing the filter leaves "find similar" mode.
  setFilter: (patch) => set((s) => ({ filter: { ...s.filter, ...patch }, similarTo: null })),
  resetFilter: () => set((s) => ({ filter: { ...EMPTY, sort: s.filter.sort }, similarTo: null })),
  select: (selectedId) => set({ selectedId }),
  findSimilar: (similarTo) => set({ similarTo }),
}))
