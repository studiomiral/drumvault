import { describe, expect, it, vi } from 'vitest'

// The exporter talks to the app through `window.drumvault`; naming needs none of it.
vi.hoisted(() => {
  ;(globalThis as { window?: unknown }).window = { drumvault: {} }
})

import { exportDir, exportFolderName, exportTargets, hasVocals, midiParts, vocalTakes } from '../src/arrange/exporter'
import { newProject } from '../src/lib/project'
import type { AudioClip, Project } from '../src/types/project'

function track(): Project {
  const p = newProject('Generated 08', 124)
  const lane = (name: string) => ({ ...p.lanes[0], id: name.toLowerCase().replace(/\s/g, '-'), name, mute: false })
  p.lanes = [lane('Kick'), lane('Clap 2'), lane('Bass'), lane('Stab'), { ...lane('Hats'), mute: true }]
  const part = (laneId: string, role: 'bass' | 'stab'): AudioClip => ({
    id: `${laneId}-1`, type: 'audio', laneId, start: 0, length: 16, gainDb: 0, trimBeats: 0,
    sample: { relPath: `.drumvault/${role}/x.wav`, id: -1, name: 'x', kind: 'loop', category: 'melodic', bars: 1, durationS: 2, bpm: 124 },
    bass: { role, preset: '/p.SerumPreset', presetName: 'p', midiId: 1, midiName: 'm', transpose: 0 },
  })
  p.clips = [part('bass', 'bass'), part('stab', 'stab')]
  return p
}

describe('export layout', () => {
  it('names the project folder after the project, its tempo and its key', () => {
    const p = track()
    expect(exportFolderName(p)).toBe('Generated 08 - 124 BPM')
    expect(exportFolderName({ ...p, generation: { key: 'Em' } as Project['generation'] })).toBe('Generated 08 - 124 BPM - E minor')
    expect(exportFolderName({ ...p, bpm: 122.5, generation: { key: 'F#' } as Project['generation'] })).toBe('Generated 08 - 122.50 BPM - F# major')
    expect(exportDir({ dir: '/out', folder: 'Generated 08 - 124 BPM' }, 'stems')).toBe('/out/Generated 08 - 124 BPM/stems')
  })

  it('names stems as their lanes and the mixdown in masters, skipping muted lanes', () => {
    const p = track()
    const t = exportTargets(p, { laneIds: p.lanes.map((l) => l.id), master: true })
    expect(t.map((x) => `${x.sub}/${x.file}`)).toEqual(['stems/Kick.wav', 'stems/Clap 2.wav', 'stems/Bass.wav', 'stems/Stab.wav', 'masters/mixdown.wav'])
  })

  it('writes MIDI for the bass and keys parts only, named as their stems', () => {
    expect(midiParts(track())).toEqual([{ role: 'bass', file: 'Bass.mid' }])
  })

  it('adds the instrumental masters when the track sings, and knows the takes it sings', () => {
    const p = track()
    expect(hasVocals(p)).toBe(false)
    const vocal = { ...p.lanes[0], id: 'vocal', name: 'Vocal', mute: false }
    p.lanes.push(vocal)
    p.clips.push({ id: 'v1', type: 'pattern', laneId: 'vocal', start: 0, length: 4, gainDb: 0, steps: [3],
      sample: { relPath: 'Vocals/2026-11-02_10-00-00/chops/chop-01.wav', id: -1, name: 'chop', kind: 'oneshot', category: 'melodic', bars: null, durationS: 0.3 } } as never)
    expect(hasVocals(p)).toBe(true)
    expect(vocalTakes(p)).toEqual(['2026-11-02_10-00-00'])
    const t = exportTargets(p, { laneIds: p.lanes.map((l) => l.id), master: true })
    expect(t.filter((x) => x.sub === 'masters').map((x) => x.file)).toEqual(['mixdown.wav', 'mixdown instrumental.wav'])
  })
})
