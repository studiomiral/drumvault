// Arrange view state that is not part of the project (and not undoable).

import { create } from 'zustand'
import type { ProjectFileInfo } from '../types/project'

export const MIN_PX_PER_BEAT = 0.5  // 192 bars fit in ~400 px
export const MAX_PX_PER_BEAT = 160

interface ArrangeState {
  pxPerBeat: number
  scrollX: number          // px
  scrollY: number          // px
  libraryOpen: boolean
  projects: ProjectFileInfo[]
  /** Sample paths used by the project that are not in the library (any more). */
  missing: Set<string>
  saving: boolean
  lastSaved: number | null
  setView(patch: Partial<Pick<ArrangeState, 'pxPerBeat' | 'scrollX' | 'scrollY' | 'libraryOpen'>>): void
  set(patch: Partial<ArrangeState>): void
}

export const useArrange = create<ArrangeState>((set) => ({
  pxPerBeat: 12,
  scrollX: 0,
  scrollY: 0,
  libraryOpen: true,
  projects: [],
  missing: new Set(),
  saving: false,
  lastSaved: null,
  setView: (patch) => set(patch),
  set: (patch) => set(patch),
}))
