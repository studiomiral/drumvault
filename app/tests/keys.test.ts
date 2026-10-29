import { describe, expect, it } from 'vitest'
import { learnKeys, generateKeys, generatedKeysMidi } from '../src/generate/keys'
import { Rng } from '../src/generate/rng'
import { bassNotes } from '../src/lib/midi'
import { bassPath } from '../src/audio/schedule'
import { makeLane, newProject } from '../src/lib/project'
import type { MidiItem } from '../src/types/api'
import type { AudioClip, BassRender } from '../src/types/project'
function part(id: number, notes: MidiItem['notes'], key = 'Cm', bars = 2): MidiItem {
  return { id, notes, key_label: key, bars, role: 'keys', name: `Piano ${id}`, file_name: '', rel_path: '', key_camelot: null, favorite: 0, source: null, source_code: null }
}
const chords = part(1, [[0.5, 0.75, 60, 110], [0.5, 0.5, 63, 90], [0.5, 0.6, 67, 95], [0.5, 0.7, 70, 85], [4, 2, 56, 95], [4, 1.8, 60, 90], [4, 1.9, 63, 88]])
const organ = part(2, [[0, 1.5, 60, 98], [0, 1.5, 63, 92], [0, 1.5, 67, 88], [2.75, 0.5, 62, 104], [2.75, 0.5, 65, 99], [2.75, 0.5, 69, 90]], 'Cm', 1)
describe('polyphonic Keys learning', () => {
  it('preserves voicings and per-voice articulation, excludes bass and leaves source MIDI intact', () => {
    const before = structuredClone(chords)
    const model = learnKeys([chords, { ...organ, role: 'bass' }])!
    expect(model.parts).toBe(1)
    expect(model.polyphony).toBe(4)
    expect(model.phrases[0].events[0].voices).toHaveLength(4)
    expect(generateKeys(model, new Rng(1), { key: 'Cm', bars: 2 }).notes).toEqual(chords.notes)
    expect(chords).toEqual(before)
    expect(learnKeys([{ ...chords, role: 'bass' }])).toBeNull()
    expect(learnKeys([{ ...chords, notes: [] }])).toBeNull()
  })
  it('transposes whole voicings into the track key and adapts major/minor harmony', () => {
    const model = learnKeys([chords])!
    expect(generateKeys(model, new Rng(1), { key: 'Dm', bars: 2 }).notes.slice(0, 4).map((n) => n[2])).toEqual([62, 65, 69, 72])
    expect(generateKeys(model, new Rng(1), { key: 'D', bars: 2 }).notes.slice(0, 4).map((n) => n[2])).toEqual([62, 66, 69, 73])
  })
  it('makes deterministic bounded 1/2/4-bar parts using learned rhythms and harmonies', () => {
    const model = learnKeys([chords, organ])!
    const variations = new Set<string>()
    for (let seed = 1; seed <= 30; seed++) for (const bars of [1, 2, 4] as const) {
      const line = generateKeys(model, new Rng(seed), { key: 'F#m', bars })
      expect(line).toEqual(generateKeys(model, new Rng(seed), { key: 'F#m', bars }))
      expect(line.bars).toBe(bars)
      expect(line.notes.length).toBeGreaterThan(1)
      for (const [s, l, p, v] of line.notes) {
        expect(s).toBeGreaterThanOrEqual(0); expect(s + l).toBeLessThanOrEqual(bars * 4)
        expect(l).toBeGreaterThan(0); expect(p).toBeGreaterThanOrEqual(0); expect(p).toBeLessThanOrEqual(127); expect(v).toBeGreaterThan(0)
      }
      expect(generatedKeysMidi(line, 'F#m')).toMatchObject({ role: 'keys', key_label: 'F#m', source: 'generated' })
      variations.add(JSON.stringify(line.notes))
    }
    expect(variations.size).toBeGreaterThan(3)
  })
  it('learns saved Keys files alongside imported files', () => {
    const saved = { ...chords, id: 3, source: null, name: 'Saved edit', notes: [[0, 3, 72, 100], [0, 3, 75, 90]] as MidiItem['notes'] }
    const model = learnKeys([chords, saved])!
    expect(model.parts).toBe(2)
    expect(model.phrases[1].events[0].voices).toHaveLength(2)
  })
})
describe('separate Keys render and export', () => {
  const render: BassRender = { preset: '/Piano.SerumPreset', presetName: 'Piano', midiId: -1, midiName: 'Keys', transpose: 2, role: 'keys', notes: chords.notes, bars: 2 }
  it('uses separate caches even for identical bass and Keys notes', () => {
    expect(bassPath(render, 124)).toMatch(/^\.drumvault\/keys\//)
    expect(bassPath({ ...render, role: undefined }, 124)).toMatch(/^\.drumvault\/bass\//)
    expect(bassPath(render, 124)).not.toBe(bassPath({ ...render, role: 'bass' }, 124))
  })
  it('exports looped/transposed Keys chords with no bass notes leaking between parts', () => {
    const project = newProject('Test', 124)
    const lane = makeLane('Keys', 0); project.lanes = [lane]
    const clip: AudioClip = { id: 'keys', laneId: lane.id, type: 'audio', start: 8, length: 16, trimBeats: 0, gainDb: 0,
      sample: { id: null, relPath: '', name: '', kind: 'loop', category: 'melodic', bars: 2, durationS: 4 }, bass: render }
    project.clips = [clip, { ...clip, id: 'bass', bass: { ...render, role: undefined, notes: [[0, 1, 36, 100]] } }]
    const keys = bassNotes(project, [], 'keys'); const bass = bassNotes(project, [])
    expect(keys).toHaveLength(14)
    expect(keys.slice(0, 4).map((n) => n.pitch)).toEqual([62, 65, 69, 72])
    expect(bass).toHaveLength(2); expect(bass.every((n) => n.pitch === 38)).toBe(true)
  })
})
