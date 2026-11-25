// Music loops (SCOPE.md §6.11b): the loops in <Library>/Music Loops (the active genre's), dropped on
// the Music Loops page; Generate plays one in some new house tracks in place of the stabs.

import { create } from 'zustand'
import { api } from '../api'
import type { MusicLoopMeta } from '../types/api'

interface MusicLoopsState {
  loops: MusicLoopMeta[]
  loaded: boolean
}

export const useMusicLoops = create<MusicLoopsState>(() => ({ loops: [], loaded: false }))

/** (Re)load the loops. */
export async function loadMusicLoops(): Promise<void> {
  try {
    useMusicLoops.setState({ loops: await api.listMusicLoops(), loaded: true })
  } catch {
    useMusicLoops.setState({ loaded: true })
  }
}
