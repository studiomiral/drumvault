import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/api', () => ({ api: {} }))
vi.mock('../src/audio/engine', () => ({ playback: { reloadClips: vi.fn().mockResolvedValue(undefined), preload: vi.fn().mockResolvedValue(undefined), syncLanes: vi.fn() } }))
import { changeBass, editBassNotes, switchBassline } from '../src/arrange/commands'
import { useProject } from '../src/store/project'
import { makeLane, newProject } from '../src/lib/project'
import type { AudioClip } from '../src/types/project'

function clip(role: 'bass' | 'keys'): AudioClip {
  return { id: role, type: 'audio', laneId: role, start: 0, length: 8, trimBeats: 0, gainDb: 0,
    sample: { id: null, relPath: '', name: role, kind: 'loop', category: 'melodic', bars: 1, durationS: 2 },
    bass: { role: role === 'bass' ? undefined : role, midiId: -123, midiName: role, preset: '/patch', presetName: 'Patch',
      transpose: 0, notes: [[0, 1, role === 'bass' ? 36 : 60, 100]], bars: 1 } }
}
beforeEach(() => {
  const p = newProject('Editing', 124); p.lanes = [makeLane('Bass', 0), makeLane('Keys', 1)]; p.clips = [clip('bass'), clip('keys')]
  useProject.getState().load(p, null)
})
describe('Keys editing isolation even when generated MIDI ids collide', () => {
  it('edits only Keys, and undo restores the chord part', () => {
    const notes: [number, number, number, number][] = [[0, 2, 64, 95], [0, 2, 67, 90]]
    editBassNotes(-123, notes, 2, 'keys')
    const [bass, keys] = useProject.getState().project.clips as AudioClip[]
    expect(bass.bass!.notes).toEqual([[0, 1, 36, 100]])
    expect(keys.bass!.notes).toEqual(notes); expect(keys.sample.bars).toBe(2)
    expect(keys.sample.relPath).toMatch(/^\.drumvault\/keys\//)
    useProject.getState().undo()
    expect((useProject.getState().project.clips[1] as AudioClip).bass!.notes).toEqual([[0, 1, 60, 100]])
  })
  it('switches a saved Keys edit without switching Bass', () => {
    switchBassline(-123, { id: 123, name: 'Saved Keys' }, 'keys')
    const [bass, keys] = useProject.getState().project.clips as AudioClip[]
    expect(bass.bass!.midiId).toBe(-123); expect(keys.bass!.midiId).toBe(123)
  })
  it('uses only the selected role when transposing a mixed selection', async () => {
    useProject.getState().select(['bass', 'keys'])
    await changeBass('Transpose Keys', (b) => ({ ...b, transpose: 12 }), 'keys')
    const [bass, keys] = useProject.getState().project.clips as AudioClip[]
    expect(bass.bass!.transpose).toBe(0); expect(keys.bass!.transpose).toBe(12)
  })
})
