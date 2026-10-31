// Arrange view state that is not part of the project (and not undoable).

import { create } from 'zustand'
import { laneRole } from '../generate/generator'
import type { ProjectFileInfo } from '../types/project'

/** What the lane panel shows (Generate's, and Arrange's beside the timeline): a module, or a lane (by name). */
export type Panel = { module: 'bass' | 'chords' | 'disco' | 'verb' } | { lane: string }

/** The panel a lane opens: its module (Bass, Chords, Disco Hits), else the lane itself. */
export function panelOf(laneName: string): Panel {
  const role = laneRole(laneName)
  return role === 'bass' ? { module: 'bass' } : role === 'keys' || role === 'stab' ? { module: 'chords' }
    : role === 'disco' || role === 'disco2' ? { module: 'disco' } : { lane: laneName }
}

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
  /** The lane panel beside the timeline (a generated project's lane or module), or closed. */
  lanePanel: Panel | null
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
  lanePanel: null,
  setView: (patch) => set(patch),
  set: (patch) => set(patch),
}))
