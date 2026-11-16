import { describe, expect, it } from 'vitest'
import { bassPath } from '../src/audio/schedule'
import { BED_DUCK, bedBars } from '../src/generate/ambience'
import { generate, rerollBed, type GenerateOptions, type Generation } from '../src/generate/generator'
import type { HitItem, SampleListItem } from '../src/types/api'
import type { Category, SampleKind } from '../src/types/engine'
import type { AudioClip } from '../src/types/project'

const BPM = 124
function library(): SampleListItem[] {
  const out: SampleListItem[] = []
  let id = 1
  for (let z = 1; z <= 6; z++) {
    const add = (kind: SampleKind, category: Category, bars: number | null = null) => out.push({
      id: id++, rel_path: `${kind}/${category}/${z}_${id}.wav`, name: `${category}_${id}`, kind, category, bpm: kind === 'oneshot' ? null : BPM, bars,
      body_bars: null, key_label: 'Am', key_camelot: null, duration_s: 1, channels: 2, favorite: 0, rating: null, tags: null, zip_id: z, source_code: `S000${z}`,
      groove: null, shape: null,
    })
    for (const c of ['kick', 'clap', 'snare', 'hat_closed', 'perc', 'cymbal'] as Category[]) add('oneshot', c)
    add('loop', 'hat', 2); add('loop', 'perc', 2); add('loop', 'top', 2); add('loop', 'top', 4); add('loop', 'groove', 4)
  }
  return out
}
const tex = (id: number, seconds: number): HitItem => ({ id, kind: 'ambience', file_name: `t${id}.wav`, name: `Texture ${id}`, rel_path: `Ambience/t${id}.wav`,
  key_label: null, key_camelot: null, key_source: null, pitch_fix: 0, duration_s: seconds, channels: 2 })
const OPTS: GenerateOptions = { bpm: BPM, minMinutes: 4, maxMinutes: 6, zipIds: null, useRatings: true, ambience: { hits: [tex(1, 40), tex(2, 20), tex(3, 6)] } }
const LIB = library()
const gens = Array.from({ length: 60 }, (_, i) => generate(LIB, OPTS, 1500 + i))
const bedClips = (g: Generation) => g.project.clips.filter((c): c is AudioClip => c.type === 'audio' && c.bass?.role === 'ambience')

describe('the ambience bed', () => {
  it('lies under most tracks, from the end of the intro to the start of the outro, in one constant clip', () => {
    const withBed = gens.filter((g) => bedClips(g).length)
    expect(withBed.length).toBeGreaterThan(gens.length * 0.7)
    expect(withBed.length).toBeLessThan(gens.length)
    for (const g of withBed) {
      const [c, ...more] = bedClips(g)
      expect(more).toEqual([])   // constant: not cut by the silence before drops, the breath or the mix high-pass
      const intro = g.sections[0]
      const outro = g.sections.at(-1)!
      expect(c.start).toBe((intro.start + intro.bars) * 4)
      expect(c.start + c.length).toBe(outro.start * 4)
      expect(c.gainTo).toBeUndefined()
      expect(c.filter).toBeUndefined()
      expect([c.fadeIn, c.fadeOut]).toEqual([4, 4])
      expect(c.sample.relPath).toBe(bassPath(c.bass!, g.project.bpm))
      expect(c.sample.relPath.startsWith('.drumvault/ambience/')).toBe(true)
      const lane = g.project.lanes.find((l) => l.name === 'Ambience')!
      expect(lane.duck).toBe(BED_DUCK)
      // Very quiet: far under the kick; its low end cut.
      expect(lane.levelDb!).toBeLessThanOrEqual(g.project.lanes.find((l) => l.name === 'Kick')!.levelDb! - 15)
      expect(lane.eq?.bands.some((b) => b.type === 'highpass')).toBe(true)
      expect(g.choices.some((x) => x.startsWith('ambience bed: '))).toBe(true)
    }
  })

  it('loops as many bars as the texture fills, never moved into a key', () => {
    expect([bedBars({ duration_s: 40 }, BPM), bedBars({ duration_s: 20 }, BPM), bedBars({ duration_s: 6 }, BPM)]).toEqual([16, 8, 4])
    for (const g of gens) for (const c of bedClips(g)) expect([c.bass!.transpose, c.bass!.keyLabel, c.pitch]).toEqual([0, null, undefined])
  })

  it('leaves the rest of the track as it is, and is made again with another texture', () => {
    const g = gens.find((x) => bedClips(x).length)!
    const bare = generate(LIB, { ...OPTS, ambience: null }, g.seed)
    expect(bedClips(bare)).toEqual([])
    const rest = (x: Generation) => JSON.stringify(x.project.clips.filter((c) => !(c.type === 'audio' && c.bass?.role === 'ambience')).map(({ id: _i, laneId: _l, ...c }) => c))
    expect(rest(bare)).toBe(rest(g))
    const r = rerollBed(LIB, OPTS, g, 3)!
    expect(bedClips(r)[0].bass!.preset).not.toBe(bedClips(g)[0].bass!.preset)
    expect(rest(r)).toBe(rest(g))
    const none = gens.find((x) => !bedClips(x).length)!
    expect(bedClips(rerollBed(LIB, OPTS, none, 3)!).length).toBe(1)
  })
})
