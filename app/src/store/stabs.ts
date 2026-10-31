// Chord stab patches (SCOPE.md §6.9): the Serum 2 presets chosen for Stabs under the shared Serum 2
// presets folder in Settings; Generate draws stabs from them and the Chord Stabs page's samples.

import { create } from 'zustand'
import { api } from '../api'
import { STABS_DEFAULTS } from '../lib/defaults'
import type { BassSettings, SerumPreset } from '../types/api'
import { serumPresetRoot, useApp } from './app'

interface StabPresetsState {
  presets: SerumPreset[]
  /** What the engine measured: does a patch play a chord from one key (by path)? */
  measured: Record<string, boolean>
  /** What the engine read: the chord a patch's clip player plays (semitones from the root; null: none). */
  voicings: Record<string, number[] | null>
  loaded: boolean
  error: string | null
}

export const useStabPresets = create<StabPresetsState>(() => ({ presets: [], measured: {}, voicings: {}, loaded: false, error: null }))

export function stabsSettings(): BassSettings {
  return { ...STABS_DEFAULTS, ...useApp.getState().settings?.stabs, presetRoot: serumPresetRoot() }
}

let loading: Promise<void> | null = null

/** (Re)load the patch pool; call when the chosen folders change. */
export function loadStabPresets(): Promise<void> {
  loading ??= (async () => {
    try {
      const s = stabsSettings()
      const pool = s.folders.length ? await api.serumPresets(s.presetRoot, s.folders) : { folders: [], presets: [] }
      // Each patch's own chord and whether it stacks one, before Generate uses it (so a patch plays
      // the same chord in every track): read from the cache, a new patch rendered once.
      const todo = pool.presets.map((p) => p.path).filter((p) => !(p in useStabPresets.getState().measured))
      const m = todo.length ? await api.stabChords(todo).catch(() => null) : null
      useStabPresets.setState((st) => ({
        presets: pool.presets, loaded: true, error: null,
        ...(m ? { measured: { ...st.measured, ...m.chords }, voicings: { ...st.voicings, ...m.voicings } } : {}),
      }))
    } catch (e) {
      useStabPresets.setState({ loaded: true, error: (e as Error).message })
    } finally {
      loading = null
    }
  })()
  return loading
}

// Read when the engine is up (it may not be yet when Generate first loads them).
useApp.subscribe((s, prev) => {
  if (s.engine.state === 'ready' && prev.engine.state !== 'ready' && useStabPresets.getState().presets.length) void loadStabPresets()
})

export async function saveStabsSettings(patch: Partial<BassSettings>): Promise<void> {
  await useApp.getState().saveSettings({ stabs: { ...stabsSettings(), ...patch } })
}

/**
 * Whether a stab patch plays a chord from one key, with its arp and clip player off (then it gets
 * the root alone, else the key's seventh chord): as set by hand, else as measured (a patch whose
 * oscillators stack a chord), else not.
 */
export function playsChord(p: Pick<SerumPreset, 'path' | 'name'>): boolean {
  const set = stabsSettings().chords?.[p.path]
  if (set != null) return set
  // A patch with its own clip chord plays that (its notes); else as measured.
  return !useStabPresets.getState().voicings[p.path] && (useStabPresets.getState().measured[p.path] ?? false)
}

/** The chord a stab patch's clip player plays (semitones from the root), if it has one and isn't set to the root alone. */
export function presetVoicing(p: Pick<SerumPreset, 'path'>): number[] | null {
  return stabsSettings().chords?.[p.path] ? null : useStabPresets.getState().voicings[p.path] ?? null
}

/** The stab patches with their own chord or chord flag, for Generate. */
export function stabPresetPool(): SerumPreset[] {
  return useStabPresets.getState().presets.map((p) => ({ ...p, chord: playsChord(p), voicing: presetVoicing(p) }))
}
