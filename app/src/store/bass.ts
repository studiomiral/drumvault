// Bass material (SCOPE.md §6.7): imported basslines and the Serum 2 patch pool (the preset
// folders chosen in Settings), shared by Generate, Arrange and Settings.

import { create } from 'zustand'
import { api } from '../api'
import { BASS_DEFAULTS } from '../lib/defaults'
import type { AppSettings, BassSettings, HitItem, MidiItem, SerumPool, SerumPreset } from '../types/api'
import { DEFAULT_GENRE, type Genre } from '../types/engine'
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
  /** Organic's arps and plucks (SCOPE.md §5.18): the patches in the Plucks folders, and those left out. */
  pluckPresets: SerumPreset[]
  pluckSkipped: number
  /** The Piano tab's patches (the Piano folders; not played yet), and those left out. */
  pianoPresets: SerumPreset[]
  pianoSkipped: number
  loaded: boolean
  error: string | null
}

export const useBass = create<BassState>(() => ({ basslines: [], presets: [], skipped: 0, padPresets: [], padSkipped: 0, pluckPresets: [], pluckSkipped: 0, pianoPresets: [], pianoSkipped: 0, loaded: false, error: null }))

export { samplePatch, type BassSource } from '../generate/basspatch'

/** The patches a bass can play through, by `source` (basspatch.ts), from the stores' lists unless given. */
export function bassPatches(source: BassSource = 'both', presets: SerumPreset[] = useBass.getState().presets,
                            hits: HitItem[] = useHits.getState().hits): SerumPreset[] {
  return patchPool(source, presets, hits)
}

const genre = (): Genre => useApp.getState().settings?.genre ?? DEFAULT_GENRE

/** The active genre's folders of a pool: house's bass and pads as before genres (`bass`, `pads`), every other its own. */
function genreFolders(pool: SerumPool): string[] | null {
  const g = genre()
  return g === DEFAULT_GENRE && (pool === 'bass' || pool === 'pads') ? null : useApp.getState().settings?.genreFolders?.[g]?.[pool] ?? []
}

async function saveGenreFolders(pool: SerumPool, folders: string[]): Promise<void> {
  const all = useApp.getState().settings?.genreFolders ?? {}
  const g = genre()
  await useApp.getState().saveSettings({ genreFolders: { ...all, [g]: { ...all[g], [pool]: folders } } })
}

/**
 * The octaves saved for bass patches in the settings' genre: each genre its own (house's as before
 * genres), since a genre's lines sit in a register of their own (organic's far under house's).
 */
export function octavesOf(settings: AppSettings | null | undefined): Record<string, number> {
  const g = settings?.genre ?? DEFAULT_GENRE
  return (g === DEFAULT_GENRE ? settings?.bass?.octaves : settings?.genreOctaves?.[g]) ?? {}
}

export function bassSettings(): BassSettings {
  const settings = useApp.getState().settings
  const s = { ...BASS_DEFAULTS, ...settings?.bass, presetRoot: serumPresetRoot() }
  return { ...s, folders: genreFolders('bass') ?? s.folders, octaves: octavesOf(settings) }
}

/** The load running, and what it loads (the genre's folders): a call for the same waits for it, any other loads after it. */
let loading: { what: string; p: Promise<void> } | null = null

/** (Re)load basslines and presets; call after imports or when the chosen folders (or the genre) change. */
export function loadBass(): Promise<void> {
  const what = JSON.stringify([genre(), bassSettings().folders, padsSettings().folders, plucksSettings().folders, pianoSettings().folders])
  if (loading?.what === what) return loading.p
  const before = loading?.p ?? Promise.resolve()
  const p: Promise<void> = before.catch(() => {}).then(async () => {
    try {
      const s = bassSettings()
      const pf = padsSettings().folders
      const kf = plucksSettings().folders
      const nf = pianoSettings().folders
      const none = Promise.resolve({ folders: [], presets: [] as SerumPreset[] })
      const [midis, pool, pads, plucks, piano] = await Promise.all([
        api.listMidi(),
        s.folders.length ? api.serumPresets(s.presetRoot, s.folders) : none,
        pf.length ? api.serumPresets(s.presetRoot, pf) : none,
        kf.length ? api.serumPresets(s.presetRoot, kf) : none,
        nf.length ? api.serumPresets(s.presetRoot, nf) : none,
      ])
      useBass.setState({
        basslines: midis.filter((m) => m.role === 'bass'), presets: playable(pool.presets), skipped: pool.presets.length - playable(pool.presets).length,
        padPresets: playable(pads.presets), padSkipped: pads.presets.length - playable(pads.presets).length,
        pluckPresets: playable(plucks.presets), pluckSkipped: plucks.presets.length - playable(plucks.presets).length,
        pianoPresets: playable(piano.presets), pianoSkipped: piano.presets.length - playable(piano.presets).length, loaded: true, error: null,
      })
    } catch (e) {
      useBass.setState({ loaded: true, error: (e as Error).message })
    } finally {
      if (loading?.p === p) loading = null
    }
  })
  loading = { what, p }
  return p
}

/** The Pads module's folders under the Serum 2 presets folder. */
export function padsSettings(): { folders: string[] } {
  return { folders: genreFolders('pads') ?? useApp.getState().settings?.pads?.folders ?? [] }
}

export async function savePadsSettings(patch: { folders?: string[] }): Promise<void> {
  if (patch.folders && genreFolders('pads')) return saveGenreFolders('pads', patch.folders)
  await useApp.getState().saveSettings({ pads: { ...useApp.getState().settings?.pads, folders: patch.folders ?? padsSettings().folders } })
}

/** The Plucks folders (organic's arps and plucks; the active genre's). */
export function plucksSettings(): { folders: string[] } {
  return { folders: genreFolders('plucks') ?? [] }
}

export async function savePlucksSettings(patch: { folders?: string[] }): Promise<void> {
  if (patch.folders) await saveGenreFolders('plucks', patch.folders)
}

/** The Piano folders (the Piano tab's patches; the active genre's). */
export function pianoSettings(): { folders: string[] } {
  return { folders: genreFolders('piano') ?? [] }
}

export async function savePianoSettings(patch: { folders?: string[] }): Promise<void> {
  if (patch.folders) await saveGenreFolders('piano', patch.folders)
}

export async function saveBassSettings(patch: Partial<BassSettings>): Promise<void> {
  // (A genre other than house keeps its folders in `genreFolders` and its octaves in `genreOctaves`; the
  // favourites are shared, by path.)
  const { folders, octaves, ...rest } = patch
  const ownFolders = genreFolders('bass') != null
  if (folders && ownFolders) await saveGenreFolders('bass', folders)
  if (octaves && genre() !== DEFAULT_GENRE) {
    const all = useApp.getState().settings?.genreOctaves ?? {}
    await useApp.getState().saveSettings({ genreOctaves: { ...all, [genre()]: octaves } })
  }
  const shared = { ...(ownFolders ? rest : { ...rest, ...(folders ? { folders } : {}) }), ...(octaves && genre() === DEFAULT_GENRE ? { octaves } : {}) }
  if (Object.keys(shared).length) {
    await useApp.getState().saveSettings({ bass: { ...BASS_DEFAULTS, ...useApp.getState().settings?.bass, presetRoot: serumPresetRoot(), ...shared } })
  }
}

export function toggleFavoritePreset(path: string): void {
  const fav = bassSettings().favorites
  void saveBassSettings({ favorites: fav.includes(path) ? fav.filter((p) => p !== path) : [...fav, path] })
}
