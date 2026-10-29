import { describe, expect, it } from 'vitest'
import { isGenerated } from '../src/generate/bassline'
import { applyMix, bodyBars, gapOf, gapsAgree, generate, LANES, rerollLane, transposeTo, type GenerateOptions, type Generation } from '../src/generate/generator'
import { bassPath } from '../src/audio/schedule'
import type { EventShape, LoopGroove, MidiItem, SerumPreset, TrackArrangement } from '../src/types/api'
import { feelFit } from '../src/generate/feel'
import { readSections, templateFrom } from '../src/generate/template'
import { Rng } from '../src/generate/rng'
import { expandCompatible } from '../src/lib/camelot'
import type { SampleListItem } from '../src/types/api'
import type { Category, SampleKind } from '../src/types/engine'
import type { AudioClip, Clip, PatternClip } from '../src/types/project'

const BPM = 124
const OPTS: GenerateOptions = { bpm: BPM, minMinutes: 4, maxMinutes: 6, zipIds: null, useRatings: true }
const KEYS = ['Am', 'Fm', 'Gm', 'Dm', 'C', 'F']

/** A measured loop groove: straight, or the odd 16ths `swing` late; accents on the offbeats. */
function groove(swing: number): LoopGroove {
  return {
    offsets: Array.from({ length: 16 }, (_, k) => (k % 2 ? swing : 0)),
    levels: Array.from({ length: 16 }, (_, k) => (k % 4 === 2 ? 0 : -6)),
    hits: new Array(16).fill(2), swing, push: 0,
  }
}

/**
 * An event's measured shape: `gap` 16ths of silence before its body ends, its body ending on
 * `line` of its track (or starting there, for what falls or hits).
 */
function shape(dir: EventShape['dir'], gap: number, line: number | null, body: number, noise = 0.3): EventShape {
  const end = body * 16 - gap
  const onLine = dir === 'fall' || dir === 'hit'
  return { onset: 0, end, gap, peak: dir === 'rise' ? end - 1 : 0, dir, noise, boundary: line == null ? null : onLine ? line + body : line }
}

/**
 * Six zips, each with every kind of sample the generator uses (the odd ones' loops swung).
 * Each track's events lead into (or start on) its bar 64; in the even ones the short riser
 * stops a beat before it, in zip 2 the fill too (3 16ths), in 3 and 6 the fill (4), in zip 2
 * the short roll (4). Every track also has a "fill" that is a hit on the 1 and a rest.
 */
function library(): SampleListItem[] {
  const out: SampleListItem[] = []
  let id = 1
  const add = (zip: number, kind: SampleKind, category: Category, bars: number | null = null, body: number | null = null,
               sh: EventShape | null = null) => {
    const code = `S${String(zip).padStart(4, '0')}`
    out.push({
      id: id++, rel_path: `${kind}/${category}/${code}_${id}.wav`, name: `${category}_${id}`, kind, category,
      bpm: kind === 'oneshot' ? null : BPM, bars, body_bars: body, key_label: KEYS[zip - 1], key_camelot: null,
      duration_s: 1, channels: 2, favorite: zip === 2 ? 1 : 0, rating: null, tags: null, zip_id: zip, source_code: code,
      groove: kind === 'loop' ? groove(zip % 2 ? 0.2 : 0) : null, shape: sh,
    })
  }
  for (let z = 1; z <= 6; z++) {
    for (const c of ['kick', 'clap', 'snare', 'hat_closed', 'hat_open', 'perc', 'cymbal'] as Category[]) add(z, 'oneshot', c)
    add(z, 'loop', 'hat', 1); add(z, 'loop', 'hat', 2); add(z, 'loop', 'perc', 2); add(z, 'loop', 'top', 2)
    add(z, 'loop', 'top', 4); add(z, 'loop', 'groove', 4)
    if (z % 2) add(z, 'loop', 'ride', 2)
    add(z, 'event', 'fill', 2, 1, shape('flat', z === 2 ? 3 : z % 3 === 0 ? 4 : 0, 64, 1))
    add(z, 'event', 'fill', 2, 1, shape('hit', 14, 32, 1))
    add(z, 'event', 'roll', 5, 4, shape('rise', z === 2 ? 4 : 0, 64, 4)); add(z, 'event', 'roll', 9, 8, shape('rise', 0, 128, 8))
    add(z, 'event', 'fx_riser', 5, 4, shape('rise', z % 2 ? 0 : 4, 64, 4, 0.6))
    add(z, 'event', 'fx_riser', 9, 8, shape('rise', 0, 128, 8, 0.1))
    add(z, 'event', 'fx_downlifter', 6, 5, shape('fall', 0, 64, 5))
    add(z, 'event', 'fx_impact', 2, 1, shape('hit', 0, 64, 1)); add(z, 'event', 'fx_atmos', 8, 8, shape('flat', 0, null, 8))
    add(z, 'event', 'fx_sweep', 3, 2, z <= 3 ? shape('rise', 0, 64, 2, 0.7) : shape('fall', 0, 64, 2, 0.7))
  }
  return out
}

const LIB = library()
const byPath = new Map(LIB.map((s) => [s.rel_path, s]))
const gens = Array.from({ length: 150 }, (_, i) => generate(LIB, OPTS, 1000 + i))

const laneOf = (g: Generation, name: string) => g.project.lanes.find((l) => l.name === name)?.id
/** 16ths of silence before the drop at `bar`: where its FX stop, else the track's rule. */
function silenceBefore(g: Generation, bar: number): number {
  const t = Number((g.rules.dropGaps as Record<string, number> | null)?.[bar] ?? 0)
  return t > 1 ? Math.min(t, 8) : Number(g.rules.dropSilence) * 4
}
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
      // One fill sample per track for the one-bar fills into drops and 16-bar parts, unless a
      // drop's FX stop at another moment than it does: then one that stops with them.
      const fillLane = g.project.lanes.find((l) => l.name === 'Fills')
      const oneBar = g.project.clips.filter((c) => c.laneId === fillLane?.id && c.sample.category === 'fill' && c.sample.bars === 2)
      const fillsUsed = [...new Set(oneBar.map((c) => c.sample.relPath))].map((p) => byPath.get(p)!)
      expect(fillsUsed.length).toBeLessThanOrEqual(2)
      if (fillsUsed.length === 2) expect(gapsAgree(gapOf(fillsUsed[0]), gapOf(fillsUsed[1]))).toBe(false)
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

  /** What leads into the line at `beat`: events on the fill and FX lanes whose body ends there. */
  const leadsInto = (g: Generation, beat: number) => g.project.clips.filter((c) => {
    const s = byPath.get(c.sample.relPath)
    const lane = g.project.lanes.find((l) => l.id === c.laneId)?.name ?? ''
    return s?.kind === 'event' && ['Fills', 'FX', 'FX 2'].includes(lane) && c.start + bodyBars(s) * 4 === beat
  }).map((c) => byPath.get(c.sample.relPath)!)

  it('stops everything leading into a drop at one moment: the riser\'s, the fill\'s and the second layer\'s', () => {
    let early = 0, checked = 0
    for (const g of gens) {
      for (const d of g.sections.filter((s) => s.kind === 'drop' && s.start > 0)) {
        const into = leadsInto(g, d.start * 4)
        if (into.length < 2) continue
        const t = gapOf(into[0])
        for (const s of into) expect(gapsAgree(gapOf(s), t), `${g.seed}: ${into.map(gapOf)}`).toBe(true)
        expect(gapsAgree((g.rules.dropGaps as Record<string, number>)[d.start], t)).toBe(true)
        if (t > 1) early++
        checked++
      }
    }
    expect(checked).toBeGreaterThan(150)
    expect(early).toBeGreaterThan(20)                  // the producers' beat of silence is used, not avoided
  })

  it('goes silent where the FX stop, but lets them ring through it', () => {
    let seen = 0
    for (const g of gens) {
      for (const d of g.sections.filter((s) => s.kind === 'drop' && s.start > 0)) {
        const t = Number((g.rules.dropGaps as Record<string, number>)[d.start])
        if (t <= 1) continue
        const n = Math.min(t, 8)
        for (const l of g.project.lanes) {
          if (['FX', 'FX 2', 'Fills', 'Hits', 'Crash'].includes(l.name)) continue
          for (let k = 1; k <= n; k++) expect(hitAt(g, l.name, d.start * 16 - k), `${g.seed} ${l.name}`).toBe(0)
          const beat = d.start * 4 - n / 8
          expect(g.project.clips.some((c) => c.laneId === l.id && c.type === 'audio' && c.start <= beat && c.start + c.length > beat)).toBe(false)
        }
        seen++
      }
    }
    expect(seen).toBeGreaterThan(20)
  })

  it('never uses a hit-and-rest fill as a lead-in', () => {
    for (const g of gens) {
      for (const c of g.project.clips) expect(gapOf(byPath.get(c.sample.relPath) ?? LIB[0])).toBeLessThanOrEqual(8)
    }
  })

  it('layers a second FX into drops that complements the first', () => {
    let layered = 0
    for (const g of gens) {
      for (const d of g.sections.filter((s) => s.kind === 'drop' && s.start > 0)) {
        const fx = leadsInto(g, d.start * 4).filter((s) => s.category !== 'fill' && s.category !== 'roll')
        if (fx.length < 2) continue
        expect(fx[0].id).not.toBe(fx[1].id)
        // Another length, another texture or the same track's: not two of a kind from two tracks.
        expect(bodyBars(fx[0]) !== bodyBars(fx[1]) || fx[0].shape!.noise !== fx[1].shape!.noise || fx[0].zip_id === fx[1].zip_id).toBe(true)
        layered++
      }
    }
    expect(layered).toBeGreaterThan(40)
  })

  it('ends sweeps that rise on a section line and starts the ones that fall on one', () => {
    let rises = 0, falls = 0
    for (const g of gens) {
      const lines = new Set(g.sections.map((s) => s.start * 4))
      for (const c of g.project.clips) {
        const s = byPath.get(c.sample.relPath)
        if (s?.category !== 'fx_sweep' && s?.category !== 'fx_downlifter') continue
        if (s.shape!.dir === 'rise') { expect(lines.has(c.start + bodyBars(s) * 4)).toBe(true); rises++ }
        else { expect(lines.has(c.start)).toBe(true); falls++ }
      }
    }
    expect(rises).toBeGreaterThan(20)
    expect(falls).toBeGreaterThan(20)
  })

  it("sometimes takes a producer's own FX into a drop, all from that moment of one track", () => {
    let used = 0
    for (const g of gens) {
      if (!g.rules.dropSet) continue
      const zip = Number(String(g.rules.dropSet).split(':')[0])
      const d = g.sections.find((s) => s.kind === 'drop' && s.start > 0)!
      const fx = leadsInto(g, d.start * 4).filter((s) => s.category === 'fx_riser')
      if (fx.some((s) => s.zip_id === zip)) used++
    }
    expect(used).toBeGreaterThan(15)
  })

  it('still places FX by name in a library measured before shapes', () => {
    const old = LIB.map(({ shape: _s, ...s }) => s)
    for (let i = 0; i < 20; i++) {
      const g = generate(old, OPTS, 50 + i)
      expect(g.rules.dropSet).toBeNull()
      const drops = new Set(g.sections.filter((s) => s.kind === 'drop').map((s) => s.start * 4))
      for (const c of g.project.clips.filter((c) => c.sample.category === 'fx_riser')) {
        expect(drops.has(c.start + bodyBars(byPath.get(c.sample.relPath)!) * 4)).toBe(true)
      }
    }
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

  it('makes one lane new (sound and pattern) and leaves every other lane exactly as it was', () => {
    let patternChanged = 0, transitionsNew = 0
    for (const g of gens.slice(0, 30)) {
      for (const name of ['Kick', 'Clap', 'Tops 2', 'Crash', 'Fills', 'FX']) {
        const laneId = laneOf(g, name)
        if (!laneId) continue
        const r = rerollLane(LIB, OPTS, g, laneId, 77)
        // Fills and FX must stop where the drops' silence is: there may be no other in the library.
        if (['Fills', 'FX'].includes(name) && !r) continue
        expect(r).not.toBeNull()
        if (['Fills', 'FX'].includes(name)) transitionsNew++
        const others = (x: Generation) => JSON.stringify(x.project.clips.filter((c) => c.laneId !== laneId))
        expect(others(r!)).toBe(others(g))                                  // the rest untouched
        expect(r!.sections).toEqual(g.sections)
        expect(r!.project.bpm).toBe(g.project.bpm)
        expect(r!.rules.dropSilence).toBe(g.rules.dropSilence)              // track-wide rules stay
        const before = clipsOn(g, name), after = clipsOn(r!, name)
        expect(after.length).toBeGreaterThan(0)
        const elsewhere = new Set(g.project.clips.filter((c) => c.laneId !== laneId).map((c) => c.sample.relPath))
        for (const c of after) expect(elsewhere.has(c.sample.relPath)).toBe(false)  // not a sound already in the track
        const oldSounds = new Set(before.map((c) => c.sample.relPath))
        expect(after.some((c) => !oldSounds.has(c.sample.relPath))).toBe(true)      // a new sound
        const place = (cs: Clip[]) => JSON.stringify(cs.map((c) => [c.start, c.length, c.type === 'pattern' ? c.steps : null]))
        if (place(after) !== place(before)) patternChanged++
        // The silence before drops still holds on the new lane (fills and FX ring through).
        expect(r!.rules.dropGaps).toEqual(g.rules.dropGaps)
        if (!['Fills', 'FX'].includes(name)) {
          for (const s of g.sections.filter((x) => x.kind === 'drop' && x.start > 0)) {
            const n = silenceBefore(g, s.start)
            if (!n) continue
            const beat = s.start * 4 - n / 8
            expect(after.filter((c) => c.type === 'audio').some((c) => c.start <= beat && c.start + c.length > beat)).toBe(false)
            for (let k = 1; k <= n; k++) expect(hitAt(r!, name, s.start * 16 - k)).toBe(0)
          }
        }
      }
    }
    expect(patternChanged).toBeGreaterThan(40)                              // not just another sample
    expect(transitionsNew).toBeGreaterThan(40)
  })

  it('lets a re-rolled crash come more or less often than before', () => {
    const counts = new Set<string>()
    for (const g of gens.slice(0, 10)) {
      const laneId = laneOf(g, 'Crash')!
      const n = clipsOn(g, 'Crash').length
      for (let i = 0; i < 6; i++) {
        const r = rerollLane(LIB, OPTS, g, laneId, 300 + i)!
        const m = clipsOn(r, 'Crash').length
        counts.add(m > n ? 'more' : m < n ? 'less' : 'same')
      }
    }
    expect(counts.has('more') && counts.has('less')).toBe(true)
  })

  it("doesn't re-roll when the library has nothing else for the lane", () => {
    const g = gens[0]
    const kickOnly = LIB.filter((s) => s.category !== 'kick' || s.id === g.picks.kick!.id)
    const r = rerollLane(kickOnly, OPTS, g, laneOf(g, 'Kick')!, 1)
    if (r) expect(clipsOn(r, 'Kick')[0].sample.relPath).toBe(clipsOn(g, 'Kick')[0].sample.relPath)  // the same sound, another pattern at most
  })

  it('has a seeded random source that repeats', () => {
    const a = new Rng(1), b = new Rng(1)
    expect(Array.from({ length: 5 }, () => a.next())).toEqual(Array.from({ length: 5 }, () => b.next()))
  })
})

describe('generator: bass (Serum 2)', () => {
  const midi = (id: number, key: string | null, bars = 2): MidiItem => ({
    id, file_name: `Bass ${id}.mid`, name: `Bass ${id}`, rel_path: `MIDI/Bass/b${id}.mid`, role: 'bass', bars,
    key_label: key, key_camelot: null, notes: [[0.5, 0.25, 41, 100]], favorite: 0, source: null, source_code: null,
  })
  const preset = (n: number): SerumPreset => ({ path: `/presets/Bass/P${n}.SerumPreset`, name: `P${n}`, folder: 'Bass', tags: [] })
  const BASS = { midis: [midi(1, 'Am'), midi(2, 'Fm', 4), midi(3, null)], presets: [preset(1), preset(2), preset(3)], favorites: [], sidechain: 0.5 }

  it('plays a new bassline (learned from the MIDI) in every drop, in the track key, on a ducking Bass lane', () => {
    for (let seed = 0; seed < 40; seed++) {
      const g = generate(LIB, { ...OPTS, bass: BASS }, 7000 + seed)
      expect(g.bass).not.toBeNull()
      const b = g.bass!
      expect(isGenerated(b.midi)).toBe(true)                                   // written, not one of the files
      expect([b.midi.key_label, b.transpose]).toEqual([g.key, 0])
      expect(b.midi.notes.length).toBeGreaterThan(0)
      const lane = g.project.lanes.find((l) => l.name === 'Bass')!
      expect(lane.duck).toBe(0.5)
      const clips = g.project.clips.filter((c) => c.laneId === lane.id)
      for (const d of g.sections.filter((s) => s.kind === 'drop')) {
        expect(clips.some((c) => c.start <= d.start * 4 && c.start + c.length > d.start * 4 + 4 && !c.filter)).toBe(true)
      }
      for (const c of clips) {
        expect(c.type === 'audio' && c.bass).toMatchObject({ preset: b.preset.path, midiId: b.midi.id, transpose: b.transpose,
          notes: b.midi.notes, bars: b.midi.bars })
        expect(c.sample.relPath).toBe(bassPath((c as never as { bass: Parameters<typeof bassPath>[0] }).bass, g.project.bpm))
        // Outside drops only low-passed.
        const inDrop = g.sections.some((s) => s.kind === 'drop' && c.start >= s.start * 4 && c.start < (s.start + s.bars) * 4)
        if (!inDrop) expect(c.filter?.type).toBe('lowpass')
      }
    }
  })

  it("plays the bassline with the track's feel (the same groove as the one-shots)", () => {
    let swung = 0
    for (let seed = 0; seed < 40; seed++) {
      const g = generate(LIB, { ...OPTS, bass: BASS }, 7100 + seed)
      const shots = g.project.clips.find((c) => c.type === 'pattern' && c.groove) as PatternClip | undefined
      const bass = g.project.clips.filter((c): c is AudioClip => c.type === 'audio' && !!c.bass)
      for (const c of bass) expect(c.bass!.groove).toEqual(shots ? shots.groove!.offsets : undefined)
      if (shots && bass.length) swung++
      expect(g.bass!.groove).toEqual(shots?.groove?.offsets)
    }
    expect(swung).toBeGreaterThan(10)
  })

  it('writes basslines of the length asked for', () => {
    for (const bars of [1, 2, 4] as const) {
      for (let seed = 0; seed < 5; seed++) expect(generate(LIB, { ...OPTS, bass: { ...BASS, bars } }, 7200 + seed).bass!.midi.bars).toBe(bars)
    }
    expect(generate(LIB, { ...OPTS, bass: { ...BASS, midis: [] } }, 7).bass).toBeNull()        // nothing to learn from
  })

  it('keeps the bassline and patch when asked, and leaves bass out without material', () => {
    const first = generate(LIB, { ...OPTS, bass: BASS }, 11)
    const kept = generate(LIB, { ...OPTS, bass: BASS }, 12, { bassMidi: first.bass!.midi, bassPreset: first.bass!.preset })
    expect([kept.bass!.midi.id, kept.bass!.preset.path]).toEqual([first.bass!.midi.id, first.bass!.preset.path])
    expect(generate(LIB, OPTS, 11).bass).toBeNull()
    expect(generate(LIB, { ...OPTS, bass: { ...BASS, presets: [] } }, 11).bass).toBeNull()
    expect(generate(LIB, OPTS, 11).project.lanes.some((l) => l.name === 'Bass')).toBe(false)
  })

  it("keeps a bassline's piano-roll edits when the bassline is kept", () => {
    const first = generate(LIB, { ...OPTS, bass: BASS }, 21)
    const edit = { notes: [[0, 1, 30, 100]] as [number, number, number, number][], bars: 1 }
    const g = generate(LIB, { ...OPTS, bass: BASS }, 22, { bassMidi: first.bass!.midi, bassEdit: edit })
    expect(g.bass).toMatchObject(edit)
    const clip = g.project.clips.find((c) => c.type === 'audio' && c.bass)!
    expect(clip.type === 'audio' && clip.bass).toMatchObject(edit)
    expect(clip.sample.bars).toBe(1)
    // Not kept: no edits carried over.
    expect(generate(LIB, { ...OPTS, bass: BASS }, 22, { bassEdit: edit }).bass!.notes).toBeUndefined()
  })

  it('moves a part into the track key the nearest way, via the relative key across scales', () => {
    expect(transposeTo('Am', 'Fm')).toBe(-4)
    expect(transposeTo('Fm', 'Am')).toBe(4)
    expect(transposeTo('C', 'Am')).toBe(0)
    expect(transposeTo('G#m', 'Am')).toBe(1)
    expect(transposeTo(null, 'Am')).toBe(0)
  })
})

describe('generator: feel, loop variations and a change every 8 bars', () => {
  const laneRole = (g: Generation, id: string) => g.project.lanes.find((l) => l.id === id)!.name

  it("plays the one-shots and the bass with the main loop's feel; the kick stays on the grid", () => {
    let swung = 0
    for (const g of gens) {
      for (const c of g.project.clips) {
        if (c.type !== 'pattern') continue
        const name = laneRole(g, c.laneId)
        if (name === 'Kick' || name === 'Crash') expect(c.groove).toBeUndefined()
        if (c.groove) {
          expect(c.groove.offsets).toHaveLength(16)
          expect(Math.max(...c.groove.offsets.map(Math.abs))).toBeLessThanOrEqual(0.2)
          // Accents never make a pattern quieter overall: its loudest step stays at 0 dB.
          const played = c.steps.flatMap((v, i) => (v ? [c.groove!.gains[i % 16]] : []))
          expect(Math.max(...played)).toBeCloseTo(0, 6)
          swung++
        }
      }
      const bass = g.project.clips.find((c) => c.type === 'audio' && c.bass)
      if (bass && g.project.clips.some((c) => c.type === 'pattern' && c.groove)) expect((bass as AudioClip).bass!.groove).toBeDefined()
    }
    expect(swung).toBeGreaterThan(100)
    expect(gens.some((g) => g.choices.some((c) => c.includes('% swing')))).toBe(true)
  })

  it('picks loops that fit the feel of the main loop', () => {
    let fit = 0
    let all = 0
    for (const g of gens) {
      const main = g.picks.groove ?? g.picks.top
      if (!main?.groove) continue
      for (const c of g.project.clips) {
        const s = byPath.get(c.sample.relPath)
        if (c.type !== 'audio' || s?.kind !== 'loop' || s === main) continue
        all++
        if (feelFit(s.groove, main.groove) > 0.9) fit++
      }
    }
    expect(fit / all).toBeGreaterThan(0.7)  // half the library swings, half doesn't
  })

  it('varies loops: pitched layers, only the first bars, played from another bar', () => {
    const audio = gens.flatMap((g) => g.project.clips.filter((c): c is AudioClip => c.type === 'audio' && !c.bass))
    const pitched = audio.filter((c) => c.pitch)
    expect(pitched.length).toBeGreaterThan(20)
    for (const c of pitched) {
      expect(Math.abs(c.pitch!)).toBeLessThanOrEqual(2)
      expect(['top', 'perc', 'hat', 'groove']).toContain(c.sample.category)
    }
    const short = audio.filter((c) => c.loopBars)
    expect(short.length).toBeGreaterThan(20)
    for (const c of short) expect(c.loopBars!).toBeLessThan(c.sample.bars!)
    expect(audio.filter((c) => c.trimBeats && c.sample.category !== 'fill').length).toBeGreaterThan(20)
    // Intro loops sometimes play only their first bars at first, and the outro mirrors it.
    expect(gens.some((g) => g.choices.some((c) => c.startsWith('intro loops on their first')))).toBe(true)
  })

  it('changes something at every 8-bar mark inside a section', () => {
    let marks = 0
    let missed = 0
    for (const g of gens) {
      const sig = (laneId: string, bar: number) => g.project.clips.filter((c) => c.laneId === laneId
        && c.start < (bar + 1) * 4 && c.start + c.length > bar * 4).map((c) => {
        const from = Math.max(c.start, bar * 4) - bar * 4
        const to = Math.min(c.start + c.length, bar * 4 + 4) - bar * 4
        if (c.type === 'audio') return `${c.id}:${from}-${to}`
        const i = (bar * 4 - c.start) * 4
        return `${c.sample.relPath}:${c.steps.slice(i % c.steps.length, i % c.steps.length + 16).join('')}:${from}-${to}`
      }).join(',')
      for (const s of g.sections) {
        for (let b = s.start + 8; b < s.start + s.bars; b += 8) {
          marks++
          const moved = g.project.lanes.some((l) => {
            const s1 = sig(l.id, b - 1)
            return sig(l.id, b) !== s1 || s1 !== sig(l.id, b - 2)
          })
          if (!moved) missed++
        }
      }
    }
    expect(marks).toBeGreaterThan(1000)
    expect(missed).toBe(0)
  })
})

describe('generator: structures from real tracks', () => {
  /** A produced track: per part, a run of [level, bars] (0 silent, 1 quiet, 2 full). */
  function track(code: string, runs: Record<string, [number, number][]>): TrackArrangement {
    const parts = Object.fromEntries(Object.entries(runs).map(([p, rs]) => [p, rs.map(([v, n]) => String(v).repeat(n)).join('')]))
    return { zip_id: 1, source_code: code, bpm: 124, bars: Math.max(...Object.values(parts).map((x) => x.length)), parts }
  }
  // Intro 32 (tops in from bar 17), drop 32, break 16 (no kick, hats on), drop 32 with the ride, outro 32.
  const REAL = track('S0042', {
    kick: [[2, 31], [0, 1], [2, 32], [0, 16], [2, 32], [2, 32]],  // four kicks out before drop 1
    hats: [[2, 32], [2, 32], [2, 16], [2, 32], [2, 32]],
    top: [[0, 16], [2, 16], [2, 32], [0, 16], [2, 32], [2, 16], [0, 16]],
    clap: [[0, 32], [2, 32], [0, 16], [2, 32], [0, 32]],
    ride: [[0, 32], [0, 32], [0, 16], [2, 32], [0, 32]],
    bass: [[0, 32], [2, 32], [1, 16], [2, 32], [0, 32]],
    crash: [[0, 32], ...Array.from({ length: 2 }, () => [[2, 1], [0, 15]] as [number, number][]).flat(), [0, 16], [2, 1], [0, 15], [2, 1], [0, 15], [0, 32]],
  })

  it("reads a track's sections the way it was produced", () => {
    expect(readSections(REAL)!.map((s) => [s.kind, s.to - s.from])).toEqual([
      ['intro', 32], ['drop', 32], ['break', 16], ['drop', 32], ['outro', 32],
    ])
  })

  it('takes its structure and rules about 90 %, and changes the rest', () => {
    const rng = new Rng(5)
    const ts = Array.from({ length: 40 }, () => templateFrom(REAL, rng, 64 * 1.5, 200)!)
    for (const t of ts) {
      expect(t.source).toBe('S0042')
      expect(t.changes.length).toBeGreaterThan(0)
      expect(t.sections.map((s) => s.kind)).toEqual(['intro', 'drop', 'break', 'drop', 'outro'])
      expect(t.sections[0].bars).toBe(32)
      expect(t.sections.at(-1)!.peak ?? t.sections.at(-2)!.peak).toBe(true)
    }
    const share = (k: string, v: unknown) => ts.filter((t) => t.rules[k] === v).length / ts.length
    expect(share('hatsInBreaks', true)).toBeGreaterThan(0.75)
    expect(share('ioClaps', false)).toBeGreaterThan(0.75)
    expect(share('ioTopFirst', 0.5)).toBeGreaterThan(0.75)
    expect(share('dropKickOut', true)).toBeGreaterThan(0.75)
    expect(share('bassBreaks', 'filtered')).toBeGreaterThan(0.75)
    expect(share('ride', 'second')).toBeGreaterThan(0.75)
    expect(share('phraseCrash', true)).toBeGreaterThan(0.75)
    // Not a copy: lengths and some rules differ between takes.
    expect(new Set(ts.map((t) => t.sections.map((s) => s.bars).join())).size).toBeGreaterThan(2)
    expect(ts.filter((t) => Object.keys(t.rules).length < 9).length).toBeGreaterThan(0)
  })

  it('builds most generations on a real track when the library has them, within the length range', () => {
    const tg = Array.from({ length: 60 }, (_, i) => generate(LIB, { ...OPTS, templates: [REAL] }, 9000 + i))
    const based = tg.filter((g) => g.template === 'S0042')
    expect(based.length).toBeGreaterThan(tg.length * 0.6)
    expect(based.length).toBeLessThan(tg.length)
    for (const g of based) {
      expect(g.choices[0]).toMatch(/^structure after S0042 \(/)
      expect(g.sections.filter((s) => s.kind === 'drop').length).toBeGreaterThanOrEqual(1)
      const minutes = (g.project.lengthBars * 4) / BPM
      expect(minutes).toBeGreaterThanOrEqual(4 - 0.15)
      expect(minutes).toBeLessThanOrEqual(6 + 0.15)
      // The producer's choice: no claps in the intro (unless that rule was drawn again).
      if (g.rules.ioClaps === false) expect(covers(g, 'Clap', (g.sections[0].start + g.sections[0].bars - 1) * 4)).toBe(false)
    }
    // Same seed, same track.
    expect(strip(generate(LIB, { ...OPTS, templates: [REAL] }, 9001))).toBe(strip(generate(LIB, { ...OPTS, templates: [REAL] }, 9001)))
  })

  it("ignores arrangements that don't read as a dance track", () => {
    expect(templateFrom(track('S0001', { kick: [[0, 64]], hats: [[2, 64]] }), new Rng(1), 64, 200)).toBeNull()
    expect(templateFrom(track('S0002', { kick: [[2, 24]] }), new Rng(1), 64, 200)).toBeNull()
  })
})
