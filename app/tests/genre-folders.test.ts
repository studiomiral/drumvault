import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../src/types/api'

// The app's settings as the main process keeps them: a patch merged in.
let saved: AppSettings
vi.mock('../src/api', () => ({
  api: {
    saveSettings: async (patch: Partial<AppSettings>) => (saved = { ...saved, ...patch }),
    onLibraryChanged: () => {},
  },
}))

const { useApp } = await import('../src/store/app')
const { bassSettings, padsSettings, plucksSettings, saveBassSettings, savePadsSettings, savePlucksSettings } = await import('../src/store/bass')

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

  it('shares the starred patches between the genres', async () => {
    use({ ...saved, genre: 'organic' })
    await saveBassSettings({ favorites: ['/serum/Saw Bass/b.SerumPreset'] })
    expect(saved.bass?.folders).toEqual(['House Bass'])
    use({ ...saved, genre: 'house' })
    expect(bassSettings().favorites).toEqual(['/serum/Saw Bass/b.SerumPreset'])
  })
})
