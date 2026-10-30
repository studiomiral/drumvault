// Keys material: imported and saved piano/organ parts and the Serum 2 patch pool (the folders
// chosen for Keys under the shared Serum 2 presets folder in Settings), shared by Generate, Arrange and Settings.

import { create } from 'zustand'
import { api } from '../api'
import { KEYS_DEFAULTS } from '../lib/defaults'
import type { BassSettings, MidiItem, SerumPreset } from '../types/api'
import { serumPresetRoot, useApp } from './app'

interface KeysState {
  parts: MidiItem[]
  presets: SerumPreset[]
  loaded: boolean
  error: string | null
}

export const useKeys = create<KeysState>(() => ({ parts: [], presets: [], loaded: false, error: null }))

export function keysSettings(): BassSettings {
  return { ...KEYS_DEFAULTS, ...useApp.getState().settings?.keys, presetRoot: serumPresetRoot() }
}

let loading: Promise<void> | null = null

/** (Re)load parts and presets; call after imports or when the chosen folders change. */
export function loadKeys(): Promise<void> {
  loading ??= (async () => {
    try {
      const s = keysSettings()
      const [midis, pool] = await Promise.all([
        api.listMidi(),
        s.folders.length ? api.serumPresets(s.presetRoot, s.folders) : Promise.resolve({ folders: [], presets: [] }),
      ])
      useKeys.setState({ parts: midis.filter((m) => m.role === 'keys'), presets: pool.presets, loaded: true, error: null })
    } catch (e) {
      useKeys.setState({ loaded: true, error: (e as Error).message })
    } finally {
      loading = null
    }
  })()
  return loading
}

export async function saveKeysSettings(patch: Partial<BassSettings>): Promise<void> {
  await useApp.getState().saveSettings({ keys: { ...keysSettings(), ...patch } })
}

export function toggleFavoriteKeysPreset(path: string): void {
  const fav = keysSettings().favorites
  void saveKeysSettings({ favorites: fav.includes(path) ? fav.filter((p) => p !== path) : [...fav, path] })
}
