import { describe, expect, it } from 'vitest'
import { bassPath } from '../src/audio/schedule'
import { BED_DUCK, bedBars, bedShift } from '../src/generate/ambience'
import { changeKey, generate, rerollBed, type GenerateOptions, type Generation } from '../src/generate/generator'
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

  it('repeats a loop with a rhythm on its own bars, whatever the track tempo', () => {
    // A 2-bar guitar loop at 120 (4 s), a 1-bar one at 125, a 3-bar atmos cut, an 8- and a 32-bar loop.
    const loop = (bars: number, bpm: number) => ({ duration_s: (bars * 240) / bpm, bpm })
    expect([128, 118].map((t) => bedBars(loop(2, 120), t))).toEqual([4, 4])
    expect([bedBars(loop(1, 125), BPM), bedBars(loop(3, 124), BPM), bedBars(loop(8, 122), BPM), bedBars(loop(32, 122), BPM)])
      .toEqual([4, 6, 8, 16])
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

  it('never pitches noise; always pitches a tonal bed, never leaving it where it was recorded', () => {
    const bed = (key_label: string | null, tonal: number | null = 1, pitch_fix = 0) => ({ key_label, tonal, pitch_fix })
    expect([bedShift(bed(null, 0), 'Am'), bedShift(bed(null, null), null), bedShift(bed(null, 0), 'F#')]).toEqual([0, 0, 0])
    expect(bedShift(bed('Gm'), 'Am')).toBe(2)
    expect(bedShift(bed('Fm'), 'Am')).toBe(4)
    expect(bedShift(bed('Am'), 'Am')).toBeNull()        // its own key: it would be heard as recorded
    expect(bedShift(bed('C'), 'Am')).toBeNull()         // the relative key: the same notes
    expect(bedShift(bed('Am', 1, 1), 'Am')).toBe(1)     // a pitch fix moves it after all
    expect(bedShift(bed('Bbm', 1, 1), 'Am')).toBeNull()   // read a semitone high, fixed: it is in Am
    expect(bedShift(bed(null), 'Am')).toBeNull()        // tonal without a key: not used
    expect(bedShift(bed('Gm'), null)).toBeNull()        // a track without a key: not used
    // A key from before (tonal unmeasured) is a tonal bed; within a tritone either way.
    expect(bedShift(bed('Ebm', null), 'Am')).toBe(-6)
    expect(Math.max(...['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'].map((k) => Math.abs(bedShift(bed(`${k}m`), 'Am') ?? 0)))).toBeLessThanOrEqual(6)
  })

  it('picks only tonal beds that move into the track key, rendered there', () => {
    const tonal = (id: number, key: string): HitItem => ({ ...tex(id, 30), key_label: key, key_source: 'name', tonal: 1 })
    const opts = { ...OPTS, ambience: { hits: [tonal(11, 'Am'), tonal(12, 'C'), tonal(13, 'Gm')] } }
    const made = Array.from({ length: 30 }, (_, i) => generate(LIB, opts, 2100 + i)).filter((g) => g.key === 'Am' && bedClips(g).length)
    expect(made.length).toBeGreaterThan(10)
    for (const g of made) {
      for (const c of bedClips(g)) expect([c.bass!.preset, c.bass!.transpose, c.bass!.keyLabel]).toEqual(['Ambience/t13.wav', 2, 'Am'])
      expect(g.choices.some((x) => x.includes('a tonal bed pitched +2 into Am'))).toBe(true)
    }
    // Only beds that wouldn't move: none at all.
    const still = { ...OPTS, ambience: { hits: [tonal(11, 'Am'), tonal(12, 'C')] } }
    for (let i = 0; i < 20; i++) {
      const g = generate(LIB, still, 2100 + i)
      if (g.key === 'Am') expect(bedClips(g)).toEqual([])
    }
  })

  it('moves a tonal bed with the key menu, swaps one that would stop moving, and leaves noise alone', () => {
    const tonal = (id: number, key: string): HitItem => ({ ...tex(id, 30), key_label: key, key_source: 'name', tonal: 1 })
    const opts = { ...OPTS, ambience: { hits: [tonal(13, 'Gm'), tonal(14, 'Em')] } }
    const g = Array.from({ length: 40 }, (_, i) => generate(LIB, opts, 2300 + i))
      .find((x) => x.key === 'Am' && bedClips(x)[0]?.bass!.preset === 'Ambience/t13.wav')!
    expect(g).toBeTruthy()
    const inDm = changeKey(LIB, opts, g, 'Dm', 1)                    // Gm → Dm: -5, the same bed
    expect(bedClips(inDm).map((c) => [c.bass!.preset, c.bass!.transpose, c.bass!.keyLabel])).toEqual([['Ambience/t13.wav', -5, 'Dm']])
    expect(bedClips(inDm)[0].sample.relPath).toBe(bassPath(bedClips(inDm)[0].bass!, g.project.bpm))
    const inGm = changeKey(LIB, opts, g, 'Gm', 1)                    // its own key: the other bed takes its place
    expect(bedClips(inGm).map((c) => [c.bass!.preset, c.bass!.transpose])).toEqual([['Ambience/t14.wav', 3]])
    const alone = { ...OPTS, ambience: { hits: [tonal(13, 'Gm')] } }
    const gone = changeKey(LIB, alone, g, 'Bb', 1)                   // the relative key, and no other bed: it goes
    expect(bedClips(gone)).toEqual([])
    expect(gone.picks.bed).toBeUndefined()
    expect(gone.project.lanes.some((l) => l.name === 'Ambience')).toBe(false)
    // Noise stays exactly as it was in any key.
    const n = gens.find((x) => bedClips(x).length)!
    expect(bedClips(changeKey(LIB, OPTS, n, 'F#m', 1))).toEqual(bedClips(n))
  })
})
