// Vocals (SCOPE.md §6.11): the takes in <Library>/Vocals, made in Arrange one for each track; the
// Vocals module reads what the open track sings from here.

import { create } from 'zustand'
import { api } from '../api'
import type { VocalMeta } from '../vocals/plan'

interface VocalsState {
  vocals: VocalMeta[]
  loaded: boolean
  /** A take is being made (ElevenLabs, then its split and analysis: a minute or two). */
  making: boolean
}

export const useVocals = create<VocalsState>(() => ({ vocals: [], loaded: false, making: false }))

/** The takes a track can sing: analysed, with a phrase loop (chops are out). */
export const playableVocals = (vocals: VocalMeta[]) =>
  vocals.filter((v) => v.vocal && v.analysis && v.analysis.phrases.length)

/** (Re)load the takes. */
export async function loadVocals(): Promise<void> {
  try {
    useVocals.setState({ vocals: await api.listVocals(), loaded: true })
  } catch {
    useVocals.setState({ loaded: true })
  }
}
