// Bass material (SCOPE.md §6.7): imported basslines and the Serum 2 patch pool (the preset
// folders chosen in Settings), shared by Generate, Arrange and Settings.

import { create } from 'zustand'
import { api } from '../api'
import { BASS_DEFAULTS } from '../lib/defaults'
import type { BassSettings, MidiItem, SerumPreset } from '../types/api'
import { serumPresetRoot, useApp } from './app'

interface BassState {
  basslines: MidiItem[]
  presets: SerumPreset[]
  loaded: boolean
  error: string | null
}

export const useBass = create<BassState>(() => ({ basslines: [], presets: [], loaded: false, error: null }))

export function bassSettings(): BassSettings {
  return { ...BASS_DEFAULTS, ...useApp.getState().settings?.bass, presetRoot: serumPresetRoot() }
}

let loading: Promise<void> | null = null

/** (Re)load basslines and presets; call after imports or when the chosen folders change. */
export function loadBass(): Promise<void> {
  loading ??= (async () => {
    try {
      const s = bassSettings()
      const [midis, pool] = await Promise.all([
        api.listMidi(),
        s.folders.length ? api.serumPresets(s.presetRoot, s.folders) : Promise.resolve({ folders: [], presets: [] }),
      ])
      useBass.setState({ basslines: midis.filter((m) => m.role === 'bass'), presets: pool.presets, loaded: true, error: null })
    } catch (e) {
      useBass.setState({ loaded: true, error: (e as Error).message })
    } finally {
      loading = null
    }
  })()
  return loading
}

export async function saveBassSettings(patch: Partial<BassSettings>): Promise<void> {
  await useApp.getState().saveSettings({ bass: { ...bassSettings(), ...patch } })
}

export function toggleFavoritePreset(path: string): void {
  const fav = bassSettings().favorites
  void saveBassSettings({ favorites: fav.includes(path) ? fav.filter((p) => p !== path) : [...fav, path] })
}
