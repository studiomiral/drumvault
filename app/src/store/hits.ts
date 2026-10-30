// Disco hits (SCOPE.md §6.8): the Disco Hits page's samples, shared by that page and Generate.

import { create } from 'zustand'
import { api } from '../api'
import type { HitItem } from '../types/api'

interface HitsState {
  hits: HitItem[]
  loaded: boolean
  error: string | null
}

export const useHits = create<HitsState>(() => ({ hits: [], loaded: false, error: null }))

let loading: Promise<void> | null = null

/** (Re)load the hits; call after imports and corrections. */
export function loadHits(): Promise<void> {
  loading ??= (async () => {
    try {
      useHits.setState({ hits: await api.listHits(), loaded: true, error: null })
    } catch (e) {
      useHits.setState({ loaded: true, error: (e as Error).message })
    } finally {
      loading = null
    }
  })()
  return loading
}
