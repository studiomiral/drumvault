import { describe, expect, it } from 'vitest'
import { bassPath } from '../src/audio/schedule'
import { bassRenderOf, generate, type GenerateOptions } from '../src/generate/generator'
import { patchPool as bassPatches, samplePatch } from '../src/generate/basspatch'
import type { HitItem, MidiItem, SampleListItem, SerumPreset } from '../src/types/api'
import type { Category, SampleKind } from '../src/types/engine'
import type { AudioClip } from '../src/types/project'

const BPM = 124
const hit = (id: number, kind: HitItem['kind'], key: string | null): HitItem => ({
  id, kind, file_name: `h${id}.wav`, name: `h${id}`, rel_path: `${kind === 'bass' ? 'Bass Samples' : 'Chord Stabs'}/h${id}.wav`, key_label: key, key_camelot: null,
  key_source: key ? 'name' : null, pitch_fix: 0, duration_s: 1, channels: 2,
})
const serum: SerumPreset[] = Array.from({ length: 12 }, (_, i) => ({ path: `/presets/Bass/P${i}.SerumPreset`, name: `P${i}`, folder: 'Bass', tags: [] }))
const hits = [hit(1, 'bass', 'A'), hit(2, 'bass', 'C'), hit(3, 'bass', null), hit(4, 'stab', 'Am')]

function library(): SampleListItem[] {
  const out: SampleListItem[] = []
  let id = 1
  for (let z = 1; z <= 4; z++) {
    const add = (kind: SampleKind, category: Category) => out.push({
      id: id++, rel_path: `${kind}/${category}/${z}_${id}.wav`, name: `${category}_${id}`, kind, category, bpm: kind === 'oneshot' ? null : BPM, bars: kind === 'oneshot' ? null : 2,
      body_bars: null, key_label: 'Am', key_camelot: null, duration_s: 1, channels: 2, favorite: 0, rating: null, tags: null, zip_id: z, source_code: `S000${z}`, groove: null, shape: null,
    })
    for (const c of ['kick', 'clap', 'hat_closed', 'perc', 'cymbal'] as Category[]) add('oneshot', c)
    for (const c of ['hat', 'perc', 'top', 'groove'] as Category[]) add('loop', c)
  }
  return out
}
const midi: MidiItem = { id: 1, file_name: 'B.mid', name: 'B', rel_path: 'MIDI/Bass/b.mid', role: 'bass', bars: 2, key_label: 'Am', key_camelot: null,
  notes: [[0, 0.5, 33, 100], [1.5, 0.5, 33, 100], [4, 0.5, 36, 100]], favorite: 0, source: null, source_code: null }
const OPTS: GenerateOptions = { bpm: BPM, minMinutes: 4, maxMinutes: 6, zipIds: null, useRatings: true }
const withBass = (presets: SerumPreset[]): GenerateOptions => ({ ...OPTS, bass: { midis: [midi], presets, favorites: [], sidechain: 0.6 } })
const LIB = library()

describe('bass: a Serum patch or a one-shot sample', () => {
  it('offers the Bass Samples page\'s one-shots that have a note, beside the Serum patches, by the source chosen', () => {
    expect(bassPatches('serum', serum, hits)).toBe(serum)
    const samples = bassPatches('samples', serum, hits)
    expect(samples.map((p) => p.path)).toEqual(['Bass Samples/h1.wav', 'Bass Samples/h2.wav'])   // not the one without a note, not the stab
    expect(samples.every((p) => p.sample && p.folder === 'Bass Samples')).toBe(true)
    expect(bassPatches('both', serum, hits)).toHaveLength(14)
    expect(samplePatch(hits[0])).toEqual({ path: 'Bass Samples/h1.wav', name: 'h1', folder: 'Bass Samples', tags: [], sample: true })
  })

  it('gives a track one kind or the other with even chances, however many there are of each', () => {
    const pool = bassPatches('both', serum, hits)   // 12 patches, 2 samples
    const gens = Array.from({ length: 80 }, (_, i) => generate(LIB, withBass(pool), 300 + i))
    const sampled = gens.filter((g) => g.bass!.preset.sample).length
    expect(sampled).toBeGreaterThan(25)
    expect(sampled).toBeLessThan(55)
    // The same seed, the same bass.
    expect(generate(LIB, withBass(pool), 301).bass!.preset.path).toBe(gens[1].bass!.preset.path)
    // One kind only in the pool: always that.
    expect(Array.from({ length: 10 }, (_, i) => generate(LIB, withBass(bassPatches('samples', serum, hits)), 300 + i)).every((g) => g.bass!.preset.sample)).toBe(true)
    expect(Array.from({ length: 10 }, (_, i) => generate(LIB, withBass(serum), 300 + i)).some((g) => g.bass!.preset.sample)).toBe(false)
  })

  it('plays the track\'s written bassline through the sample: the same render, clips and file naming as a patch', () => {
    const g = Array.from({ length: 20 }, (_, i) => generate(LIB, withBass(bassPatches('samples', serum, hits)), 300 + i))[0]
    const b = g.bass!
    const render = bassRenderOf(b)
    expect(render.preset).toMatch(/^Bass Samples\//)
    expect(render.role).toBe('bass')
    expect(render.notes?.length).toBeGreaterThan(0)
    const clips = g.project.clips.filter((c): c is AudioClip => c.type === 'audio' && !!c.bass && c.bass.role === 'bass')
    expect(clips.length).toBeGreaterThan(0)
    for (const c of clips) {
      expect(c.bass!.preset).toBe(b.preset.path)
      expect(c.sample.relPath).toBe(bassPath(c.bass!, g.project.bpm))
      expect(c.sample.relPath.startsWith('.drumvault/bass/')).toBe(true)
    }
    // The drums are the same whichever kind of bass the track has.
    const drums = (x: typeof g) => JSON.stringify(x.project.clips.filter((c) => !(c.type === 'audio' && c.bass)).map(({ id: _i, laneId: _l, ...c }) => c))
    expect(drums(generate(LIB, withBass(serum), 300))).toBe(drums(g))
  })
})
