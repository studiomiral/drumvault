import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../src/types/api'

// The app's settings as the main process keeps them: a patch merged in.
let saved: AppSettings
vi.mock('../src/api', () => ({
  api: {
    saveSettings: async (patch: Partial<AppSettings>) => (saved = { ...saved, ...patch }),
    onLibraryChanged: () => {},
    listMidi: async () => [],
    // Each folder's one patch, the house ones slow (a load still running when the genre switches).
    serumPresets: async (_root: string, folders: string[]) => {
      if (folders.includes('House Bass')) await new Promise((ok) => setTimeout(ok, 50))
      return { folders: [], presets: folders.map((f) => ({ path: `/serum/${f}/p.SerumPreset`, name: f, folder: f, tags: [], samples: [] })) }
    },
  },
}))

const { tabsOf, useApp } = await import('../src/store/app')
const { bassSettings, loadBass, padsSettings, pianoSettings, plucksSettings, saveBassSettings, savePadsSettings, savePianoSettings, savePlucksSettings, useBass } = await import('../src/store/bass')

const use = (s: AppSettings) => {
  saved = s
  useApp.setState({ settings: s })
}

describe('Serum 2 folders per genre (SCOPE.md §5.18)', () => {
  beforeEach(() => use({
    libraryPath: '/lib', engine: {}, enginePath: null, uvPath: null, lastProject: null,
    bass: { presetRoot: '/serum', folders: ['House Bass'], favorites: ['/serum/House Bass/a.SerumPreset'] }, pads: { folders: ['House Pads'] },
  }))

  it('keeps house on the folders from before genres, and gives organic its own', async () => {
    expect([bassSettings().folders, padsSettings().folders, plucksSettings().folders]).toEqual([['House Bass'], ['House Pads'], []])
    use({ ...saved, genre: 'organic' })
    expect([bassSettings().folders, padsSettings().folders, plucksSettings().folders]).toEqual([[], [], []])
    await saveBassSettings({ folders: ['Saw Bass'] })
    await savePadsSettings({ folders: ['Warm Pads'] })
    await savePlucksSettings({ folders: ['Plucks', 'Arps'] })
    expect([bassSettings().folders, padsSettings().folders, plucksSettings().folders]).toEqual([['Saw Bass'], ['Warm Pads'], ['Plucks', 'Arps']])
    // House's are as they were.
    expect([saved.bass?.folders, saved.pads?.folders]).toEqual([['House Bass'], ['House Pads']])
    use({ ...saved, genre: 'house' })
    expect([bassSettings().folders, padsSettings().folders]).toEqual([['House Bass'], ['House Pads']])
  })

  it("loads the genre's own patches, also when it switches while the other genre's are still loading", async () => {
    const house = loadBass()
    use({ ...saved, genre: 'organic', genreFolders: { organic: { bass: ['Saw Bass'] } } })
    await Promise.all([house, loadBass()])
    expect(useBass.getState().presets.map((p) => p.folder)).toEqual(['Saw Bass'])
  })

  it('keeps each genre its own patch octaves (a patch can sit in another octave in organic)', async () => {
    use({ ...saved, bass: { ...saved.bass!, octaves: { '/serum/House Bass/a.SerumPreset': 12 } } })
    use({ ...saved, genre: 'organic' })
    expect(bassSettings().octaves).toEqual({})
    await saveBassSettings({ octaves: { '/serum/House Bass/a.SerumPreset': -12 } })
    expect(bassSettings().octaves).toEqual({ '/serum/House Bass/a.SerumPreset': -12 })
    expect(saved.bass?.octaves).toEqual({ '/serum/House Bass/a.SerumPreset': 12 })
    use({ ...saved, genre: 'house' })
    expect(bassSettings().octaves).toEqual({ '/serum/House Bass/a.SerumPreset': 12 })
  })

  it('gives the Piano tab its own folders in every genre, house included', async () => {
    expect(pianoSettings().folders).toEqual([])
    await savePianoSettings({ folders: ['House Keys'] })
    expect(pianoSettings().folders).toEqual(['House Keys'])
    expect(saved.genreFolders?.house?.piano).toEqual(['House Keys'])
    use({ ...saved, genre: 'organic' })
    expect(pianoSettings().folders).toEqual([])
    await savePianoSettings({ folders: ['Felt Piano'] })
    await loadBass()
    expect(useBass.getState().pianoPresets.map((p) => p.folder)).toEqual(['Felt Piano'])
    use({ ...saved, genre: 'house' })
    expect(pianoSettings().folders).toEqual(['House Keys'])
  })

  it('shows the Sounds tabs without MIDI, and Plucks only for organic', () => {
    const labels = (g: string) => tabsOf('sounds', g).map((t) => t.label)
    expect(labels('house')).toEqual(['Chord Stabs', 'Drop Hits', 'Strings', 'Bass', 'Pads', 'Piano', 'Ambience', 'Vocal Loops'])
    expect(labels('organic')).toEqual(['Chord Stabs', 'Drop Hits', 'Strings', 'Bass', 'Pads', 'Piano', 'Plucks', 'Ambience', 'Vocal Loops'])
  })

  it('shares the starred patches between the genres', async () => {
    use({ ...saved, genre: 'organic' })
    await saveBassSettings({ favorites: ['/serum/Saw Bass/b.SerumPreset'] })
    expect(saved.bass?.folders).toEqual(['House Bass'])
    use({ ...saved, genre: 'house' })
    expect(bassSettings().favorites).toEqual(['/serum/Saw Bass/b.SerumPreset'])
  })
})
