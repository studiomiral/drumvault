import { describe, expect, it } from 'vitest'
import { applyMix, bodyBars, generate, LANES, type GenerateOptions, type Generation } from '../src/generate/generator'
import { Rng } from '../src/generate/rng'
import { expandCompatible } from '../src/lib/camelot'
import type { SampleListItem } from '../src/types/api'
import type { Category, SampleKind } from '../src/types/engine'
import type { AudioClip, Clip, PatternClip } from '../src/types/project'

const BPM = 124
const OPTS: GenerateOptions = { bpm: BPM, minMinutes: 4, maxMinutes: 6, zipIds: null, useRatings: true }
const KEYS = ['Am', 'Fm', 'Gm', 'Dm', 'C', 'F']

/** Six zips, each with every kind of sample the generator uses. */
function library(): SampleListItem[] {
  const out: SampleListItem[] = []
  let id = 1
  const add = (zip: number, kind: SampleKind, category: Category, bars: number | null = null, body: number | null = null) => {
    const code = `S${String(zip).padStart(4, '0')}`
    out.push({
      id: id++, rel_path: `${kind}/${category}/${code}_${id}.wav`, name: `${category}_${id}`, kind, category,
      bpm: kind === 'oneshot' ? null : BPM, bars, body_bars: body, key_label: KEYS[zip - 1], key_camelot: null,
      duration_s: 1, channels: 2, favorite: zip === 2 ? 1 : 0, rating: null, tags: null, zip_id: zip, source_code: code,
    })
  }
  for (let z = 1; z <= 6; z++) {
    for (const c of ['kick', 'clap', 'snare', 'hat_closed', 'hat_open', 'perc', 'cymbal'] as Category[]) add(z, 'oneshot', c)
    add(z, 'loop', 'hat', 1); add(z, 'loop', 'hat', 2); add(z, 'loop', 'perc', 2); add(z, 'loop', 'top', 2)
    add(z, 'loop', 'top', 4); add(z, 'loop', 'groove', 4)
    if (z % 2) add(z, 'loop', 'ride', 2)
    add(z, 'event', 'fill', 2, 1); add(z, 'event', 'roll', 5, 4); add(z, 'event', 'roll', 9, 8)
    add(z, 'event', 'fx_riser', 5, 4); add(z, 'event', 'fx_riser', 9, 8); add(z, 'event', 'fx_downlifter', 6, 5)
    add(z, 'event', 'fx_impact', 2, 1); add(z, 'event', 'fx_atmos', 8, 8); add(z, 'event', 'fx_sweep', 3, 2)
  }
  return out
}

const LIB = library()
const byPath = new Map(LIB.map((s) => [s.rel_path, s]))
const gens = Array.from({ length: 150 }, (_, i) => generate(LIB, OPTS, 1000 + i))

const laneOf = (g: Generation, name: string) => g.project.lanes.find((l) => l.name === name)?.id
const clipsOn = (g: Generation, name: string) => g.project.clips.filter((c) => c.laneId === laneOf(g, name))
/** Velocity of a lane's pattern at a 16th step (absolute), 0 if silent. */
function hitAt(g: Generation, name: string, step16: number): number {
  for (const c of clipsOn(g, name)) {
    if (c.type !== 'pattern') continue
    const s0 = c.start * 4
    if (step16 >= s0 && step16 < s0 + c.length * 4) return (c as PatternClip).steps[(step16 - s0) % c.steps.length]
  }
  return 0
}
const covers = (g: Generation, name: string, beat: number) => clipsOn(g, name).some((c) => c.start <= beat && c.start + c.length > beat)
const strip = (g: Generation) => JSON.stringify(g.project.clips.map(({ id: _i, laneId: _l, ...c }) => c))

describe('generator: rules every generation keeps', () => {
  it('is 4 to 6 minutes, in phrase-aligned sections that cover the track', () => {
    for (const g of gens) {
      const bars = g.project.lengthBars
      const minutes = (bars * 4 * 60) / BPM / 60
      expect(minutes).toBeGreaterThanOrEqual(4 - 0.15)
      expect(minutes).toBeLessThanOrEqual(6 + 0.15)
      let at = 0
      for (const s of g.sections) {
        expect(s.start).toBe(at)
        expect(s.bars % 8).toBe(0)
        at += s.bars
      }
      expect(at).toBe(bars)
      expect(g.project.markers.map((m) => m.start)).toEqual(g.sections.map((s) => s.start * 4))
      // Section names travel with the project to Arrange (Send to Arrange copies the project).
      expect(g.project.markers.map((m) => [m.name, m.start, m.end])).toEqual(
        g.sections.map((s) => [s.label, s.start * 4, (s.start + s.bars) * 4]))
    }
  })

  it('opens and closes DJ-friendly: >= 16 bars of steady four-on-the-floor kick with hats', () => {
    for (const g of gens) {
      const intro = g.sections[0]
      const outro = g.sections[g.sections.length - 1]
      expect(intro.kind).toBe('intro')
      expect(outro.kind).toBe('outro')
      for (const s of [intro, outro]) {
        expect(s.bars).toBeGreaterThanOrEqual(16)
        // An intro straight into a drop may go quiet for its last two beats (the pre-drop silence).
        const end = (s.start + s.bars) * 4 - (s === intro && g.sections[1].kind === 'drop' ? 2 : 0)
        for (let beat = s.start * 4; beat < end; beat++) {
          expect(hitAt(g, 'Kick', beat * 4)).toBe(3)
          expect(covers(g, 'Hats', beat)).toBe(true)
        }
      }
    }
  })

  it('high-passes the kick a little in the intro and outro, and only there', () => {
    for (const g of gens) {
      const io = g.sections.filter((s) => s.kind === 'intro' || s.kind === 'outro')
      for (const c of clipsOn(g, 'Kick')) {
        const inIO = io.some((s) => c.start >= s.start * 4 && c.start < (s.start + s.bars) * 4)
        if (inIO) {
          expect(c.filter?.type).toBe('highpass')
          expect(c.filter!.from).toBeGreaterThanOrEqual(60)
          expect(c.filter!.from).toBeLessThanOrEqual(110)
        } else if (c.filter?.type === 'highpass') {
          // Elsewhere only the "thin" breakdown kick is high-passed, clearly higher.
          expect(c.filter.from).toBeGreaterThanOrEqual(180)
        }
      }
    }
  })

  it('layers top loops (each on its own lane) and claps, never two kicks', () => {
    const topLanes = (g: Generation) => g.project.lanes.filter((l) => l.name.startsWith('Tops')).length
    expect(gens.some((g) => topLanes(g) >= 3)).toBe(true)
    expect(gens.filter((g) => topLanes(g) >= 2).length).toBeGreaterThan(gens.length * 0.8)
    for (const g of gens) {
      expect(g.project.lanes.filter((l) => l.name.startsWith('Kick')).length).toBe(1)
      // In the peak drop at least two top loops play at once.
      const peak = g.sections.filter((s) => s.kind === 'drop').at(-1)!
      const mid = (peak.start + peak.bars / 2) * 4
      const playing = g.project.lanes.filter((l) => l.name.startsWith('Tops') && covers(g, l.name, mid))
      expect(playing.length).toBeGreaterThanOrEqual(Math.min(2, topLanes(g)))
    }
    const layered = gens.find((g) => g.project.lanes.some((l) => l.name === 'Clap 3'))!
    expect(layered).toBeDefined()
    const drop = layered.sections.find((s) => s.kind === 'drop')!
    for (const name of ['Clap', 'Clap 2', 'Clap 3']) expect(hitAt(layered, name, drop.start * 16 + 4)).toBe(3)
    // Intros and outros carry top loops too.
    expect(gens.filter((g) => covers(g, 'Tops', (g.sections[0].start + g.sections[0].bars - 1) * 4)).length)
      .toBeGreaterThan(gens.length * 0.8)
  })

  it('applies the lane volume sliders on top of the starting mix', () => {
    const g = generate(LIB, { ...OPTS, mix: { top: -3, kick: 2 } }, 1234)
    const vol = (name: string) => g.project.lanes.find((l) => l.name === name)?.volumeDb
    const base = (name: string) => LANES.find((l) => l.name === name)!.volumeDb
    expect(vol('Kick')).toBe(base('Kick') + 2)
    expect(vol('Tops')).toBe(base('Tops') - 3)
    if (vol('Tops 2') != null) expect(vol('Tops 2')).toBe(base('Tops 2'))  // its own slider
    applyMix(g.project, {})
    expect(vol('Kick')).toBe(base('Kick'))
    expect(base('Kick')).toBeLessThan(0)  // the kick starts a little lower than before
  })

  it('brings rides in only in drops: later in the first one and/or all through later ones', () => {
    let seen = 0
    for (const g of gens) {
      const drops = g.sections.filter((s) => s.kind === 'drop')
      for (const c of clipsOn(g, 'Ride')) {
        const d = drops.findIndex((s) => c.start >= s.start * 4 && c.start < (s.start + s.bars) * 4)
        expect(d).toBeGreaterThanOrEqual(0)
        if (d === 0) expect(c.start).toBeGreaterThan(drops[0].start * 4)
        seen++
      }
    }
    expect(seen).toBeGreaterThan(50)
  })

  it('announces drops: a crash on the 1, often four kicks out and a beat or two of silence before', () => {
    let kickOuts = 0
    let silences = 0
    for (const g of gens) {
      for (const s of g.sections.filter((x) => x.kind === 'drop')) {
        const one = s.start * 16  // 16th step of the drop's downbeat
        expect(hitAt(g, 'Crash', one)).toBe(3)
        if ([0, 4, 8, 12].every((k) => hitAt(g, 'Kick', one - 16 + k) === 0)) kickOuts++
        // Silence: nothing but FX, fills and hits sounds in the last beat before the drop.
        const quiet = g.project.lanes.filter((l) => !['FX', 'Fills', 'Hits', 'Crash'].includes(l.name))
          .every((l) => !g.project.clips.some((c) => c.laneId === l.id && c.start < s.start * 4 && c.start + c.length > s.start * 4 - 1
            && (c.type !== 'pattern' || c.steps.slice(12).some((v) => v))))
        if (quiet) silences++
      }
    }
    const drops = gens.reduce((n, g) => n + g.sections.filter((x) => x.kind === 'drop').length, 0)
    expect(kickOuts).toBeGreaterThan(drops * 0.5)
    expect(silences).toBeGreaterThan(drops * 0.5)
  })

  it('gives every drop the same rules: 16-bar marks, top loops, the same fill', () => {
    const at16 = (g: Generation, s: Generation['sections'][number]) => {
      const marks = []
      for (let b = s.start + 16; b < s.start + s.bars; b += 16) marks.push(b)
      return marks.map((b) => [hitAt(g, 'Crash', b * 16) > 0,
        [0, 4, 8, 12].every((k) => hitAt(g, 'Kick', b * 16 - 16 + k) === 0)].join())
    }
    let compared = 0
    for (const g of gens) {
      const drops = g.sections.filter((s) => s.kind === 'drop')
      const marks = new Set(drops.flatMap((s) => at16(g, s)))
      expect(marks.size).toBeLessThanOrEqual(1)  // crash and kicks-out the same at every 16-bar mark
      const tops = (s: Generation['sections'][number]) =>
        g.project.lanes.filter((l) => l.name.startsWith('Tops') && covers(g, l.name, (s.start + 1) * 4)).length
      const counts = new Set(drops.filter((s) => !s.peak).map(tops))
      expect(counts.size).toBeLessThanOrEqual(1)
      // One fill sample per track for the one-bar fills into drops and 16-bar parts.
      const fillLane = g.project.lanes.find((l) => l.name === 'Fills')
      const oneBar = g.project.clips.filter((c) => c.laneId === fillLane?.id && c.sample.category === 'fill' && c.sample.bars === 2)
      expect(new Set(oneBar.map((c) => c.sample.relPath)).size).toBeLessThanOrEqual(1)
      if (drops.length > 1 && marks.size) compared++
    }
    expect(compared).toBeGreaterThan(20)
  })

  it('mirrors the intro in the outro', () => {
    for (const g of gens) {
      const intro = g.sections[0]
      const outro = g.sections[g.sections.length - 1]
      const lanesIn = (s: Generation['sections'][number]) => g.project.lanes
        .filter((l) => ['Tops', 'Tops 2', 'Clap', 'Perc'].includes(l.name)
          && g.project.clips.some((c) => c.laneId === l.id && c.start < (s.start + s.bars) * 4 && c.start + c.length > s.start * 4))
        .map((l) => l.name).sort()
      expect(lanesIn(outro)).toEqual(lanesIn(intro))
    }
  })

  it('ends risers and rolls exactly on a drop downbeat', () => {
    let checked = 0
    for (const g of gens) {
      const drops = new Set(g.sections.filter((s) => s.kind === 'drop').map((s) => s.start * 4))
      for (const c of g.project.clips) {
        if (c.sample.category !== 'fx_riser' && c.sample.category !== 'roll') continue
        expect(drops.has(c.start + bodyBars(byPath.get(c.sample.relPath)!) * 4)).toBe(true)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(100)
  })

  it('spreads samples over the zips and keeps tonal FX in the track key', () => {
    for (const g of gens) {
      expect(g.zips.length).toBeGreaterThanOrEqual(3)
      const keys = new Set(expandCompatible([g.key!]))
      for (const c of g.project.clips) {
        if (['fx_riser', 'fx_downlifter', 'fx_atmos'].includes(c.sample.category)) {
          expect(keys.has(byPath.get(c.sample.relPath)!.key_label!)).toBe(true)
        }
      }
    }
  })

  it('picks a whole tempo per track from the range, the same for the same seed', () => {
    const bpms = Array.from({ length: 40 }, (_, i) => generate(LIB, { ...OPTS, tempo: { min: 120, max: 128 } }, 300 + i).project.bpm)
    expect(bpms.every((b) => Number.isInteger(b) && b >= 120 && b <= 128)).toBe(true)
    expect(new Set(bpms).size).toBeGreaterThan(4)
    expect(generate(LIB, { ...OPTS, tempo: { min: 120, max: 128 } }, 7).project.bpm)
      .toBe(generate(LIB, { ...OPTS, tempo: { min: 120, max: 128 } }, 7).project.bpm)
    expect(generate(LIB, { ...OPTS, tempo: { min: 126, max: 126 } }, 7).project.bpm).toBe(126)
    expect(generate(LIB, OPTS, 7).project.bpm).toBe(BPM)
  })

  it('gives the same arrangement for the same seed', () => {
    expect(strip(generate(LIB, OPTS, 42))).toBe(strip(generate(LIB, OPTS, 42)))
    expect(strip(generate(LIB, OPTS, 42))).not.toBe(strip(generate(LIB, OPTS, 43)))
  })
})

describe('generator: variety', () => {
  it('produces many structures and every kick treatment, build style and pattern variation', () => {
    const shapes = new Set(gens.map((g) => g.sections.map((s) => `${s.kind}${s.bars}`).join(' ')))
    expect(shapes.size).toBeGreaterThan(60)
    const kicks = new Set(gens.flatMap((g) => g.sections.map((s) => s.kick).filter(Boolean)))
    expect([...kicks].sort()).toEqual(['downbeats', 'filtered', 'kept', 'out', 'sweep', 'thin'])  // no half-time kick
    const builds = new Set(gens.flatMap((g) => g.sections.map((s) => s.build).filter(Boolean)))
    expect([...builds].sort()).toEqual(['all', 'doubletime', 'filter', 'layered'])
    expect(gens.some((g) => g.sections.filter((s) => s.kind === 'break').length === 1)).toBe(true)
    expect(gens.some((g) => g.sections.filter((s) => s.kind === 'break').length >= 3)).toBe(true)
    // Kick drop-outs at phrase ends, filtered kicks, filter sweeps on loops.
    const kickPatterns = new Set(gens.flatMap((g) => clipsOn(g, 'Kick').map((c) => (c as PatternClip).steps.join(''))))
    expect(kickPatterns.has('3000300030000000')).toBe(true)
    expect(gens.some((g) => clipsOn(g, 'Kick').some((c) => c.filter?.type === 'lowpass' && c.filter.to != null))).toBe(true)
    expect(gens.some((g) => clipsOn(g, 'Tops').some((c) => c.filter?.to != null))).toBe(true)
  })

  it('makes the long breakdown the longest one when there is one', () => {
    for (const g of gens) {
      const breaks = g.sections.filter((s) => s.kind === 'break')
      const long = breaks.find((s) => s.long)
      if (long) for (const b of breaks) if (b !== long) expect(long.bars).toBeGreaterThan(b.bars)
    }
  })
})

describe('generator: keep and edge cases', () => {
  it('keeps the structure, key and kick when asked, and re-rolls the rest', () => {
    const first = gens[0]
    const kept = Array.from({ length: 10 }, (_, i) => generate(LIB, OPTS, 5000 + i, {
      structure: first.sections, key: first.key, picks: { kick: first.picks.kick },
    }))
    for (const g of kept) {
      expect(g.sections).toEqual(first.sections)
      expect(g.key).toBe(first.key)
      expect(g.picks.kick!.id).toBe(first.picks.kick!.id)
    }
    expect(new Set(kept.map((g) => g.picks.top!.id)).size).toBeGreaterThan(1)
  })

  it('limits picks to the chosen zips', () => {
    const g = generate(LIB, { ...OPTS, zipIds: [3, 4] }, 7)
    expect(g.zips).toEqual(['S0003', 'S0004'])
  })

  it('still builds a track from a library of one-shots only', () => {
    const shots = LIB.filter((s) => s.kind === 'oneshot')
    const g = generate(shots, OPTS, 9)
    expect(clipsOn(g, 'Kick').length).toBeGreaterThan(0)
    expect(clipsOn(g, 'Hats').every((c) => c.type === 'pattern')).toBe(true)
    expect(g.project.clips.every((c: Clip) => c.type === 'pattern' || (c as AudioClip).sample.kind !== 'loop')).toBe(true)
  })

  it('has a seeded random source that repeats', () => {
    const a = new Rng(1), b = new Rng(1)
    expect(Array.from({ length: 5 }, () => a.next())).toEqual(Array.from({ length: 5 }, () => b.next()))
  })
})
