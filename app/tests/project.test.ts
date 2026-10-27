import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { listProjects, projectFileName, readProjectFile, writeProjectFile } from '../electron/fs'
import {
  clipsInRange, duplicateClips, formatPosition, makeClip, newProject, nextMarkerName, parseProject, presetSteps,
  resizePattern, serializeProject,
} from '../src/lib/project'
import { useProject } from '../src/store/project'
import type { SampleListItem } from '../src/types/api'
import type { PatternClip } from '../src/types/project'

const sample = (kind: SampleListItem['kind'], category: SampleListItem['category'], bars: number | null = null): SampleListItem => ({
  id: 1, rel_path: `x/${category}.wav`, name: category, kind, category, bpm: 124, bars, key_label: 'Am',
  key_camelot: '8A', duration_s: 1, channels: 2, favorite: 0, rating: null, tags: null, zip_id: 1, source_code: 'S0001',
})

describe('project model', () => {
  it('starts with the default lanes, 192 bars, at the given BPM', () => {
    const p = newProject('Song', 124)
    expect(p.lanes.map((l) => l.name)).toEqual(['Kick', 'Clap', 'Snare', 'Hats', 'Perc', 'Tops', 'Groove'])
    expect(p.lengthBars).toBe(192)
    expect(p.bpm).toBe(124)
  })

  it('makes loop clips one loop long and one-shot pattern clips with a category preset', () => {
    const loop = makeClip(sample('loop', 'top', 4), 'L', 8)
    expect(loop).toMatchObject({ type: 'audio', start: 8, length: 16, trimBeats: 0 })
    // A riser (event) is whole bars of audio on the grid, like a loop, never a pattern.
    const riser = makeClip(sample('event', 'fx_riser', 8), 'L', 32)
    expect(riser).toMatchObject({ type: 'audio', start: 32, length: 32, trimBeats: 0 })
    const kick = makeClip(sample('oneshot', 'kick'), 'L', 0) as PatternClip
    expect(kick.type).toBe('pattern')
    expect(kick.steps.map((v, i) => (v ? i : -1)).filter((i) => i >= 0)).toEqual([0, 4, 8, 12])
    const clap = makeClip(sample('oneshot', 'clap'), 'L', 0) as PatternClip
    expect(clap.steps.map((v, i) => (v ? i : -1)).filter((i) => i >= 0)).toEqual([4, 12])
  })

  it('duplicates a selection right after itself', () => {
    const a = makeClip(sample('loop', 'top', 2), 'L1', 16)
    const b = makeClip(sample('loop', 'hat', 1), 'L2', 20)  // span 16..24
    const copies = duplicateClips([a, b])
    expect(copies.map((c) => c.start)).toEqual([24, 28])
    expect(copies.map((c) => c.laneId)).toEqual(['L1', 'L2'])
    expect(new Set([...copies, a, b].map((c) => c.id)).size).toBe(4)
    // Duplicating a 16-beat section that the clips don't fill: the copy follows the section.
    expect(duplicateClips([a, b], 16).map((c) => c.start)).toEqual([32, 36])
  })

  it('selects clips overlapping a section', () => {
    const clips = [makeClip(sample('loop', 'top', 2), 'L', 0), makeClip(sample('loop', 'top', 2), 'L', 8), makeClip(sample('loop', 'top', 2), 'L', 16)]
    expect(clipsInRange(clips, 8, 16).map((c) => c.start)).toEqual([8])
    expect(clipsInRange(clips, 4, 17).map((c) => c.start)).toEqual([0, 8, 16])
  })

  it('resizes patterns by repeating them and builds presets per bar', () => {
    const one = presetSteps('offbeat', 1)
    const two = resizePattern(one, 2)
    expect(two).toHaveLength(32)
    expect(two.slice(16)).toEqual(one)
    expect(resizePattern(two, 1)).toEqual(one)
    expect(presetSteps('four', 2).filter(Boolean)).toHaveLength(8)
  })

  it('formats positions as bar.beat.16th and names markers', () => {
    expect(formatPosition(0)).toBe('1.1.1')
    expect(formatPosition(4.75)).toBe('2.1.4')
    expect(formatPosition(767)).toBe('192.4.1')
    expect(nextMarkerName([])).toBe('Intro')
  })

  it('round-trips through JSON unchanged (save → reopen gives an identical project)', () => {
    const p = newProject('Round trip', 124)
    p.clips.push(makeClip(sample('loop', 'top', 4), p.lanes[5].id, 32), makeClip(sample('oneshot', 'kick'), p.lanes[0].id, 0))
    p.markers.push({ id: 'm1', name: 'Drop', start: 64, end: 128, color: '#db2777' })
    p.loop = { start: 64, end: 96, enabled: true }
    const back = parseProject(serializeProject(p))
    expect({ ...back, updatedAt: '' }).toEqual({ ...p, updatedAt: '' })
    expect(() => parseProject('{"format":"other"}')).toThrow()
  })
})

describe('undo history', () => {
  beforeEach(() => useProject.getState().load(newProject('t', 124), null))

  it('undoes and redoes edits', () => {
    const { edit } = useProject.getState()
    edit('Add marker', (d) => {
      d.markers.push({ id: 'm', name: 'Intro', start: 0, end: 16, color: '#000' })
    })
    edit('Rename', (d) => {
      d.markers[0].name = 'Drop'
    })
    expect(useProject.getState().project.markers[0].name).toBe('Drop')
    useProject.getState().undo()
    expect(useProject.getState().project.markers[0].name).toBe('Intro')
    useProject.getState().undo()
    expect(useProject.getState().project.markers).toHaveLength(0)
    useProject.getState().redo()
    useProject.getState().redo()
    expect(useProject.getState().project.markers[0].name).toBe('Drop')
    expect(useProject.getState().dirty).toBe(true)
  })

  it('keeps at least 100 steps and drops redo after a new edit', () => {
    const { edit } = useProject.getState()
    for (let i = 0; i < 150; i++) {
      edit('len', (d) => {
        d.lengthBars = 100 + i
      })
    }
    for (let i = 0; i < 120; i++) useProject.getState().undo()
    expect(useProject.getState().project.lengthBars).toBe(129)
    useProject.getState().edit('other', (d) => {
      d.metronome = true
    })
    expect(useProject.getState().future).toHaveLength(0)
  })

  it('merges consecutive fader moves into one step', () => {
    const { edit } = useProject.getState()
    const id = useProject.getState().project.lanes[0].id
    for (const v of [-1, -2, -3, -6]) {
      edit('Lane volume', (d) => {
        d.lanes.find((l) => l.id === id)!.volumeDb = v
      }, { coalesce: `vol-${id}` })
    }
    expect(useProject.getState().past).toHaveLength(1)
    useProject.getState().undo()
    expect(useProject.getState().project.lanes[0].volumeDb).toBe(0)
  })

  it('drops selections of deleted clips', () => {
    const clip = makeClip(sample('loop', 'top', 2), useProject.getState().project.lanes[0].id, 0)
    useProject.getState().edit('add', (d) => {
      d.clips.push(clip)
    })
    useProject.getState().select([clip.id])
    useProject.getState().openEditor(clip.id)
    useProject.getState().undo()
    expect(useProject.getState().selection).toEqual([])
    expect(useProject.getState().editingClip).toBeNull()
  })
})

describe('project files', () => {
  it('saves under the project name, renames with it, and never overwrites another project', async () => {
    const lib = mkdtempSync(join(tmpdir(), 'dv-proj-'))
    const a = await writeProjectFile(lib, null, 'Song', '{"format":"drumvault-project","name":"Song"}')
    expect(a).toBe('Song.dvproj')
    const b = await writeProjectFile(lib, null, 'Song', '{"format":"drumvault-project","name":"Song"}')
    expect(b).toBe('Song 2.dvproj')
    const renamed = await writeProjectFile(lib, b, 'Night: mix', '{"name":"Night: mix"}')
    expect(renamed).toBe('Night- mix.dvproj')
    const dir = join(lib, '.drumvault', 'projects')
    expect(readdirSync(dir).sort()).toEqual(['Night- mix.dvproj', 'Song.dvproj'])
    expect(await readProjectFile(lib, 'Song.dvproj')).toContain('"Song"')
    expect((await listProjects(lib)).map((p) => p.name).sort()).toEqual(['Night: mix', 'Song'])
    await expect(readProjectFile(lib, '../x.dvproj')).rejects.toThrow()
    expect(projectFileName('  ')).toBe('Untitled.dvproj')
  })
})
