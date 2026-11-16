// Bass material (SCOPE.md §6.7): imported basslines and the Serum 2 patch pool (the preset
// folders chosen in Settings), shared by Generate, Arrange and Settings.

import { create } from 'zustand'
import { api } from '../api'
import { BASS_DEFAULTS } from '../lib/defaults'
import type { BassSettings, HitItem, MidiItem, SerumPreset } from '../types/api'
import { playable, serumPresetRoot, useApp } from './app'
import { patchPool, type BassSource } from '../generate/basspatch'
import { useHits } from './hits'

interface BassState {
  basslines: MidiItem[]
  presets: SerumPreset[]
  /** Patches in the chosen folders left out: their samples aren't on this Mac. */
  skipped: number
  /** The breakdown layer's patches (SCOPE.md §6.7b): pads and reeses from the Pads folders, and those left out. */
  padPresets: SerumPreset[]
  padSkipped: number
  loaded: boolean
  error: string | null
}

export const useBass = create<BassState>(() => ({ basslines: [], presets: [], skipped: 0, padPresets: [], padSkipped: 0, loaded: false, error: null }))

export { samplePatch, type BassSource } from '../generate/basspatch'

/** The patches a bass can play through, by `source` (basspatch.ts), from the stores' lists unless given. */
export function bassPatches(source: BassSource = 'both', presets: SerumPreset[] = useBass.getState().presets,
                            hits: HitItem[] = useHits.getState().hits): SerumPreset[] {
  return patchPool(source, presets, hits)
}

export function bassSettings(): BassSettings {
  return { ...BASS_DEFAULTS, ...useApp.getState().settings?.bass, presetRoot: serumPresetRoot() }
}

let loading: Promise<void> | null = null

/** (Re)load basslines and presets; call after imports or when the chosen folders change. */
export function loadBass(): Promise<void> {
  loading ??= (async () => {
    try {
      const s = bassSettings()
      const pf = padsSettings().folders
      const [midis, pool, pads] = await Promise.all([
        api.listMidi(),
        s.folders.length ? api.serumPresets(s.presetRoot, s.folders) : Promise.resolve({ folders: [], presets: [] }),
        pf.length ? api.serumPresets(s.presetRoot, pf) : Promise.resolve({ folders: [], presets: [] }),
      ])
      useBass.setState({
        basslines: midis.filter((m) => m.role === 'bass'), presets: playable(pool.presets), skipped: pool.presets.length - playable(pool.presets).length,
        padPresets: playable(pads.presets), padSkipped: pads.presets.length - playable(pads.presets).length, loaded: true, error: null,
      })
    } catch (e) {
      useBass.setState({ loaded: true, error: (e as Error).message })
    } finally {
      loading = null
    }
  })()
  return loading
}

/** The Pads module's folders under the Serum 2 presets folder. */
export function padsSettings(): { folders: string[] } {
  return { folders: [], ...useApp.getState().settings?.pads }
}

export async function savePadsSettings(patch: { folders?: string[] }): Promise<void> {
  await useApp.getState().saveSettings({ pads: { ...padsSettings(), ...patch } })
}

export async function saveBassSettings(patch: Partial<BassSettings>): Promise<void> {
  await useApp.getState().saveSettings({ bass: { ...bassSettings(), ...patch } })
}

export function toggleFavoritePreset(path: string): void {
  const fav = bassSettings().favorites
  void saveBassSettings({ favorites: fav.includes(path) ? fav.filter((p) => p !== path) : [...fav, path] })
}
