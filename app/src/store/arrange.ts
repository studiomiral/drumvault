// Create's timeline state that is not part of the project (and not undoable).

import { create } from 'zustand'
import { laneRole } from '../generate/generator'
import type { ProjectFileInfo } from '../types/project'

/** What Create's side panel shows: the track (its key, structure, choices), a module, or a lane (by name). */
export type Panel = { module: 'track' | 'bass' | 'chords' | 'vocals' | 'vocalloops' | 'strings' | 'pads' | 'ambience' | 'disco' | 'verb' } | { lane: string }

/** The panel a lane opens: its module (Bass, Chords, Strings, Disco Hits), else the lane itself. */
export function panelOf(laneName: string): Panel {
  const role = laneRole(laneName)
  return role === 'bass' ? { module: 'bass' } : role === 'stab' || role === 'stab2' || role === 'stab3' ? { module: 'chords' }
    : role === 'vocal' || role === 'vchop' ? { module: 'vocals' } : role === 'strings' ? { module: 'strings' } : role === 'pad' ? { module: 'pads' } : role === 'bed' ? { module: 'ambience' } : role === 'disco' || role === 'disco2' ? { module: 'disco' } : { lane: laneName }
}

export const MIN_PX_PER_BEAT = 0.5  // 192 bars fit in ~400 px
export const MAX_PX_PER_BEAT = 160
export const DEFAULT_PX_PER_BEAT = 12

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
  /** The side panel beside the timeline (the track, a module or a lane), or closed. */
  lanePanel: Panel | null
  /** Bumped when a track is put on screen: the timeline zooms to fit it. */
  fit: number
  fitToTrack(): void
  setView(patch: Partial<Pick<ArrangeState, 'pxPerBeat' | 'scrollX' | 'scrollY' | 'libraryOpen'>>): void
  set(patch: Partial<ArrangeState>): void
}

export const useArrange = create<ArrangeState>((set) => ({
  pxPerBeat: DEFAULT_PX_PER_BEAT,
  scrollX: 0,
  scrollY: 0,
  libraryOpen: false,
  projects: [],
  missing: new Set(),
  saving: false,
  lastSaved: null,
  lanePanel: savedPanel(),
  fit: 0,
  fitToTrack: () => set((s) => ({ fit: s.fit + 1 })),
  setView: (patch) => set(patch),
  set: (patch) => {
    if ('lanePanel' in patch) savePanel(patch.lanePanel ?? null)
    set(patch)
  },
}))

const PANEL_KEY = 'drumvault.create.panel'

function savedPanel(): Panel | null {
  try {
    const v = localStorage.getItem(PANEL_KEY)
    return v == null ? { module: 'track' } : (JSON.parse(v) as Panel | null)
  } catch {
    return { module: 'track' }
  }
}

function savePanel(p: Panel | null): void {
  try {
    localStorage.setItem(PANEL_KEY, JSON.stringify(p))
  } catch {
    // not remembered
  }
}
