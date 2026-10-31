import { describe, expect, it } from 'vitest'
import { isGenerated } from '../src/generate/bassline'
import {
  applyMix, bodyBars, changeKey, gapOf, gapsAgree, generate, LANES, laneRole, newLaneSound, rerollDisco, rerollKeys, rerollLane, rerollStabs, setStabRhythm, setTrackRule,
  transposeTo, type GenerateOptions, type Generation, type Role,
} from '../src/generate/generator'
import { CHOICES, choicesFor, optionKey } from '../src/generate/choices'
import { bassPath } from '../src/audio/schedule'
import type { EventShape, HitItem, LoopGroove, MidiItem, SerumPreset, TrackArrangement } from '../src/types/api'
import { hitPitch } from '../src/generate/disco'
import { feelFit } from '../src/generate/feel'
import { readSections, templateFrom } from '../src/generate/template'
import { SAVED_EXACT, stabRhythm } from '../src/generate/stabs'
import { Rng } from '../src/generate/rng'
import { expandCompatible } from '../src/lib/camelot'
import type { SampleListItem } from '../src/types/api'
import type { Category, SampleKind } from '../src/types/engine'
import type { AudioClip, Clip, PatternClip, Velocity } from '../src/types/project'

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

  it('opens and closes DJ-friendly: >= 16 bars of steady four-on-the-floor kick, hats by the track', () => {
    for (const g of gens) {
      const intro = g.sections[0]
      const outro = g.sections[g.sections.length - 1]
      expect(intro.kind).toBe('intro')
      expect(outro.kind).toBe('outro')
      for (const s of [intro, outro]) {
        expect(s.bars).toBeGreaterThanOrEqual(16)
        // An intro straight into a drop may go quiet for its last two beats (the pre-drop silence),
        // and its drums for the last bar (the breath before drops).
        const intoDrop = s === intro && g.sections[1].kind === 'drop'
        const end = (s.start + s.bars) * 4 - (intoDrop ? 2 : 0)
        const hatsEnd = (s.start + s.bars) * 4 - (intoDrop ? (g.rules.dropBreath === 'all' ? 4 : 2) : 0)
        // Hats none, the half next to the drops, or all through.
        const how = s === intro ? g.rules.introHats : g.rules.outroHats
        const half = s.start + Math.floor(s.bars / 2 / 8) * 8
        for (let beat = s.start * 4; beat < end; beat++) {
          expect(hitAt(g, 'Kick', beat * 4)).toBe(3)
          const inHalf = s === intro ? beat >= half * 4 : beat < half * 4
          if (beat < hatsEnd) expect(covers(g, 'Hats', beat)).toBe(how === 'all' || (how === 'half' && inHalf))
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
          // Elsewhere only the "thin" breakdown kick is high-passed, clearly higher, and the mix
          // high-pass sweeping up in the bars before a drop.
          const hp = Number(g.rules.mixHp ?? 0)
          const intoDrop = g.sections.some((s) => s.kind === 'drop' && c.start >= (s.start - hp) * 4 && c.start < s.start * 4)
          if (intoDrop && c.filter.to != null) expect(c.filter.to).toBeGreaterThan(c.filter.from)
          else expect(c.filter.from).toBeGreaterThanOrEqual(180)
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

  it('plays a patch in the octave saved for it, every track', () => {
    const octaves = { [preset(2).path]: -12, [preset(3).path]: 12 }
    for (let seed = 0; seed < 20; seed++) {
      const g = generate(LIB, { ...OPTS, bass: { ...BASS, octaves } }, 7100 + seed)
      const b = g.bass!
      expect(b.transpose).toBe(octaves[b.preset.path] ?? 0)
      for (const c of g.project.clips) if (c.type === 'audio' && c.bass) expect(c.bass.transpose).toBe(b.transpose)
    }
  })

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
        // Outside drops only high-passed (the sub out), as real tracks do.
        const inDrop = g.sections.some((s) => s.kind === 'drop' && c.start >= s.start * 4 && c.start < (s.start + s.bars) * 4)
        if (!inDrop) expect(c.filter?.type).toBe('highpass')
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
    const most = Math.max(...ts.map((t) => Object.keys(t.rules).length))
    expect(ts.filter((t) => Object.keys(t.rules).length < most).length).toBeGreaterThan(0)
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

describe('Keys generation beside Bass', () => {
  const piano: MidiItem = { id: 765, file_name: 'Piano.mid', name: 'Piano', rel_path: 'MIDI/Keys/Piano.mid', role: 'keys', bars: 1,
    key_label: 'Am', key_camelot: null, notes: [[0, 1.5, 57, 100], [0, 1.5, 60, 90], [0, 1.5, 64, 90], [2.5, 0.5, 57, 100], [2.5, 0.5, 60, 90], [2.5, 0.5, 64, 90]], favorite: 0, source: null, source_code: null }
  const keys = { midis: [piano], presets: [{ path: '/piano.SerumPreset', name: 'Piano', folder: 'Keys', tags: [] }], favorites: [], sidechain: 0.4, bars: 2 as const }
  it('puts polyphonic Keys in drops, keeps DJ intro/outro clean and leaves drum choices unchanged', () => {
    const plain = generate(LIB, OPTS, 42); const g = generate(LIB, { ...OPTS, keys }, 42)
    expect(g.keys?.midi.role).toBe('keys'); expect(g.keys?.midi.bars).toBe(2)
    const lane = g.project.lanes.find((l) => l.name === 'Keys')!
    expect(lane.duck).toBe(0.4)
    const clips = g.project.clips.filter((c) => c.laneId === lane.id)
    expect(clips.length).toBeGreaterThan(0)
    for (const c of clips) {
      expect(c.type === 'audio' && c.bass?.role).toBe('keys')
      expect(g.sections.some((s) => (s.kind === 'intro' || s.kind === 'outro') && c.start < (s.start + s.bars) * 4 && c.start + c.length > s.start * 4)).toBe(false)
    }
    const signature = (g: Generation) => g.project.clips.filter((c) => c.type !== 'audio' || c.bass?.role !== 'keys').map(({ id: _i, laneId: _l, ...c }) => c)
    expect(signature(g)).toEqual(signature(plain)); expect(g.sections).toEqual(plain.sections)
  })
  it('keeps the Keys part and patch independently, including note edits', () => {
    const a = generate(LIB, { ...OPTS, keys }, 41)
    const notes: MidiItem['notes'] = [[0, 3, 69, 90], [0, 3, 72, 85], [0, 3, 76, 80]]
    const b = generate(LIB, { ...OPTS, keys }, 42, { keysMidi: a.keys!.midi, keysPreset: a.keys!.preset, keysEdit: { notes, bars: 1 } })
    expect(b.keys?.notes).toEqual(notes); expect(b.keys?.preset).toEqual(a.keys?.preset); expect(b.keys?.midi.id).toBe(a.keys?.midi.id)
    const clip = b.project.clips.find((c) => c.type === 'audio' && c.bass?.role === 'keys') as AudioClip
    expect(clip.bass?.notes).toEqual(notes); expect(clip.sample.bars).toBe(1)
  })
  it('rerolls Keys without changing other lanes', () => {
    const options = { ...OPTS, keys: { ...keys, midis: [piano, { ...piano, id: 766, notes: piano.notes.map(([s, l, p, v]) => [s + 0.25, l, p, v]) as MidiItem['notes'] }] } }
    const g = generate(LIB, options, 41); const lane = g.project.lanes.find((l) => l.name === 'Keys')!
    const r = rerollLane(LIB, options, g, lane.id, 95)!
    expect(r).not.toBeNull()
    expect(r.project.clips.filter((c) => c.laneId !== lane.id)).toEqual(g.project.clips.filter((c) => c.laneId !== lane.id))
    expect(r.keys).not.toEqual(g.keys)
  })
})

describe('generator: reverb builds', () => {
  const verb = { tops: true, keys: false, every: null, amount: 0.6 }
  const into = (g: Generation, bar: number) => g.project.clips.filter((c) => c.verb && c.start + c.length <= bar * 4 && c.start >= (bar - 2) * 4)

  it('washes the top loops out into every drop and break, rising to the amount where they stop', () => {
    for (let i = 0; i < 20; i++) {
      const g = generate(LIB, { ...OPTS, verb }, 2000 + i)
      const plain = generate(LIB, OPTS, 2000 + i)
      expect(g.sections).toEqual(plain.sections)
      const tops = new Set(g.project.lanes.filter((l) => /^Top/.test(l.name)).map((l) => l.id))
      for (const c of g.project.clips.filter((c) => c.verb)) {
        expect(tops.has(c.laneId)).toBe(true)
        expect(c.verb!.to).toBeGreaterThan(c.verb!.from)
        expect(c.verb!.to).toBeLessThanOrEqual(0.6 + 1e-9)
      }
      g.sections.forEach((s, j) => {
        const next = g.sections[j + 1]
        if (!next || (next.kind !== 'drop' && next.kind !== 'break')) return
        const bar = s.start + s.bars
        const tops = (p: Generation) => p.project.clips.filter((c) => c.laneId.length && /^Top/.test(p.project.lanes.find((l) => l.id === c.laneId)!.name)
          && c.start < bar * 4 && c.start + c.length > (bar - 2) * 4)
        if (!tops(plain).length) return
        const built = into(g, bar)
        expect(built.length).toBeGreaterThan(0)
        // The last one peaks at the amount where the loops stop.
        expect(Math.max(...built.map((c) => c.verb!.to))).toBeCloseTo(0.6, 9)
      })
      // The same sound otherwise: the clips only split where a build starts.
      const sound = (p: Generation) => [...new Set(p.project.clips.map((c) => `${c.laneId}:${c.sample.relPath}`))].sort()
      expect(sound(g).length).toBe(sound(plain).length)
      expect(g.choices.some((c) => c.startsWith('reverb builds on tops into drops and breaks'))).toBe(true)
    }
  })

  it('every 16 bars too, over a bar; nothing when off or on no part', () => {
    const g = generate(LIB, { ...OPTS, verb: { ...verb, every: 16 } }, 2100)
    // Windows: 2 bars into drops and breaks, 1 bar before every 16 bars of a section.
    const windows: [number, number][] = []
    g.sections.forEach((s, j) => {
      const z = s.start + s.bars
      const next = g.sections[j + 1]?.kind
      if (next === 'drop' || next === 'break') windows.push([z - 2, z])
      for (let b = s.start + 16; b <= z; b += 16) if (b !== z || (next !== 'drop' && next !== 'break')) windows.push([b - 1, b])
    })
    const built = g.project.clips.filter((c) => c.verb)
    expect(built.some((c) => windows.some(([a, z]) => z - a === 1 && c.start >= a * 4 && c.start + c.length <= z * 4))).toBe(true)
    for (const c of built) expect(windows.some(([a, z]) => c.start >= a * 4 && c.start + c.length <= z * 4)).toBe(true)
    expect(generate(LIB, { ...OPTS, verb: { ...verb, tops: false } }, 2100).project.clips.some((c) => c.verb)).toBe(false)
    expect(generate(LIB, OPTS, 2100).project.clips.some((c) => c.verb)).toBe(false)
  })

  it('builds on the keys part when asked, keeping its render', () => {
    const piano: MidiItem = { id: 765, file_name: 'Piano.mid', name: 'Piano', rel_path: 'MIDI/Keys/Piano.mid', role: 'keys', bars: 1,
      key_label: 'Am', key_camelot: null, notes: [[0, 1.5, 57, 100], [0, 1.5, 60, 90], [0, 1.5, 64, 90]], favorite: 0, source: null, source_code: null }
    const keys = { midis: [piano], presets: [{ path: '/piano.SerumPreset', name: 'Piano', folder: 'Keys', tags: [] }], favorites: [], sidechain: 0.4, bars: 2 as const }
    const g = generate(LIB, { ...OPTS, keys, verb: { ...verb, tops: false, keys: true } }, 42)
    const lane = g.project.lanes.find((l) => l.name === 'Keys')!.id
    const built = g.project.clips.filter((c) => c.verb)
    expect(built.length).toBeGreaterThan(0)
    for (const c of built) {
      expect(c.laneId).toBe(lane)
      expect(c.type === 'audio' && c.bass?.role).toBe('keys')
    }
  })
})

describe('generator: disco hits', () => {
  const hit = (id: number, key: string | null, pitch_fix = 0): HitItem => ({
    id, kind: 'disco', file_name: `Stab ${id}.wav`, name: `Stab ${id}`, rel_path: `Disco Hits/stab-${id}.wav`, key_label: key, key_camelot: null,
    key_source: key ? 'name' : null, pitch_fix, duration_s: 1.5, channels: 2,
  })
  const HITS = [hit(1, 'Cm'), hit(2, 'F'), hit(3, null), hit(4, 'A', 2)]
  const disco = { hits: HITS }
  const discoLanes = (g: Generation) => new Set(g.project.lanes.filter((l) => /^Disco Hit/.test(l.name)).map((l) => l.id))

  it('drops one or two hits in some tracks, on the 1 of drops (and breaks), moved into the track key', () => {
    let some = 0
    let two = 0
    const where = new Set<string>()
    for (let i = 0; i < 60; i++) {
      const g = generate(LIB, { ...OPTS, disco }, 3000 + i)
      const plain = generate(LIB, OPTS, 3000 + i)
      // The rest of the track is the same with or without them.
      const sig = (p: Generation) => p.project.clips.map(({ id: _i, laneId: _l, ...c }) => c)
      const lanes = discoLanes(g)
      expect(sig({ ...g, project: { ...g.project, clips: g.project.clips.filter((c) => !lanes.has(c.laneId)) } })).toEqual(sig(plain))
      const clips = g.project.clips.filter((c) => lanes.has(c.laneId)) as PatternClip[]
      if (!clips.length) continue
      some++
      if (lanes.size === 2) two++
      where.add(String(g.rules.discoAt))
      const starts = new Set(g.sections.filter((s) => s.kind === 'drop').map((s) => s.start * 4))
      for (const c of clips) {
        expect(c.type).toBe('pattern')
        expect(c.length).toBe(4)
        expect(c.steps.map((v, k) => (v ? k : -1)).filter((k) => k >= 0)).toEqual([0])
        const sec = g.sections.find((s) => c.start >= s.start * 4 && c.start < (s.start + s.bars) * 4)!
        expect(sec.kind === 'drop' || (sec.kind === 'break' && c.start === sec.start * 4 && g.rules.discoAt === 'all')).toBe(true)
        const h = HITS.find((x) => x.rel_path === c.sample.relPath)!
        expect(c.pitch ?? 0).toBe(Math.max(-12, Math.min(12, transposeTo(h.key_label, g.key) + h.pitch_fix)))
      }
      for (const s of starts) expect(clips.some((c) => c.start === s)).toBe(true)
      expect(g.choices.some((c) => c.startsWith('disco hit'))).toBe(true)
    }
    expect(some).toBeGreaterThan(20)
    expect(some).toBeLessThan(60)
    expect(two).toBeGreaterThan(0)
    expect(where.size).toBeGreaterThan(2)
    expect(generate(LIB, OPTS, 3001).project.lanes.some((l) => /^Disco/.test(l.name))).toBe(false)
  })

  it('moves a hit to the relative key across major and minor, plus its own fix', () => {
    expect(hitPitch(hit(1, 'C'), 'Am')).toBe(0)
    expect(hitPitch(hit(1, 'Cm'), 'Fm')).toBe(5)
    expect(hitPitch(hit(1, 'Cm'), 'Am')).toBe(-3)
    expect(hitPitch(hit(1, 'Cm', -2), 'Am')).toBe(-5)
    expect(hitPitch(hit(1, null, 3), 'Am')).toBe(3)
    expect(hitPitch(hit(1, 'Cm', 20), 'Fm')).toBe(12)
  })

  it('draws new disco hits for the same track, the rest exactly as it is', () => {
    const name = (g: Generation, id: string) => g.project.lanes.find((l) => l.id === id)!.name
    const rest = (g: Generation) => g.project.clips.filter((c) => !/^Disco/.test(name(g, c.laneId))).map(({ id: _i, laneId, ...c }) => [name(g, laneId), c])
    for (let i = 0; i < 12; i++) {
      const g = generate(LIB, { ...OPTS, disco }, 3200 + i)
      const r = rerollDisco(LIB, { ...OPTS, disco }, g, 99 + i)!
      expect(r).not.toBeNull()
      expect(rest(r)).toEqual(rest(g))
      expect(r.sections).toEqual(g.sections)
      const hits = r.project.clips.filter((c) => /^Disco/.test(name(r, c.laneId)))
      expect(hits.length).toBeGreaterThan(0)             // the button always brings some
      for (const c of hits) expect(r.project.lanes.some((l) => l.id === c.laneId)).toBe(true)
      expect(r.project.lanes.filter((l) => /^Disco/.test(l.name)).every((l) => hits.some((c) => c.laneId === l.id))).toBe(true)
      const before = new Set(g.project.clips.filter((c) => /^Disco/.test(name(g, c.laneId))).map((c) => c.sample.relPath))
      if (before.size && before.size < HITS.length) expect(hits.some((c) => !before.has(c.sample.relPath))).toBe(true)
      expect(r.choices.filter((c) => c.startsWith('disco hit'))).toHaveLength(1)
    }
    expect(rerollDisco(LIB, OPTS, generate(LIB, OPTS, 1), 5)).toBeNull()
  })

  it('keeps the hits when another lane is made again', () => {
    const g = Array.from({ length: 40 }, (_, i) => generate(LIB, { ...OPTS, disco }, 3100 + i)).find((x) => x.picks.disco)!
    const lane = g.project.lanes.find((l) => l.name === 'Kick')!
    const r = rerollLane(LIB, { ...OPTS, disco }, g, lane.id, 7)!
    const lanes = discoLanes(g)
    expect(r.project.clips.filter((c) => lanes.has(c.laneId))).toEqual(g.project.clips.filter((c) => lanes.has(c.laneId)))
  })
})

describe('generator: another key for the same track', () => {
  const piano: MidiItem = { id: 765, file_name: 'Piano.mid', name: 'Piano', rel_path: 'MIDI/Keys/Piano.mid', role: 'keys', bars: 1,
    key_label: 'Am', key_camelot: null, notes: [[0, 1.5, 57, 100], [0, 1.5, 60, 90], [0, 1.5, 64, 90]], favorite: 0, source: null, source_code: null }
  const bassMidi: MidiItem = { ...piano, id: 766, role: 'bass', name: 'Bass', notes: [[0.5, 0.25, 41, 100], [1.5, 0.25, 41, 100]] }
  const presets = [{ path: '/p.SerumPreset', name: 'P', folder: 'X', tags: [] }]
  const hits: HitItem[] = [{ id: 1, kind: 'disco', file_name: 'Stab Cm.wav', name: 'Stab Cm', rel_path: 'Disco Hits/stab.wav', key_label: 'Cm', key_camelot: null,
    key_source: 'name', pitch_fix: 0, duration_s: 1, channels: 2 }]
  const opts: GenerateOptions = { ...OPTS, bass: { midis: [bassMidi], presets, favorites: [], sidechain: 0.5, octaves: { '/p.SerumPreset': -12 } },
    keys: { midis: [piano], presets, favorites: [], sidechain: 0.4 }, disco: { hits } }
  const TONAL = ['fx_riser', 'fx_downlifter', 'fx_atmos', 'fx']

  it('moves bass, keys and disco hits, swaps FX out of key, and leaves the drums', () => {
    let swaps = 0
    for (let i = 0; i < 15; i++) {
      const g = generate(LIB, opts, 4000 + i)
      const to = KEYS.find((k) => k !== g.key && transposeTo(g.key, k) !== 0)!
      const r = changeKey(LIB, opts, g, to, 11)
      expect(r.key).toBe(to)
      expect(r.sections).toEqual(g.sections)
      expect(r.project.clips.map((c) => c.id)).toEqual(g.project.clips.map((c) => c.id))
      const step = (b: Generation['bass']) => b!.transpose - transposeTo(b!.midi.key_label, g.key)
      expect(r.bass!.transpose - transposeTo(r.bass!.midi.key_label, to)).toBe(step(g.bass))  // the patch octave stays
      expect(step(g.bass)).toBe(-12)
      expect(r.keys!.transpose).toBe(transposeTo(r.keys!.midi.key_label, to))
      const fits = new Set(expandCompatible([to]))
      g.project.clips.forEach((c, k) => {
        const n = r.project.clips[k]
        const s = byPath.get(c.sample.relPath)
        if (c.type === 'audio' && c.bass) {
          expect((n as AudioClip).bass!.transpose).toBe(c.bass.role === 'keys' ? r.keys!.transpose : r.bass!.transpose)
          expect(n.sample.relPath).not.toBe(c.sample.relPath)
        } else if (c.sample.category === 'disco_hit') {
          expect(n.pitch ?? 0).toBe(hitPitch(hits[0], to))
        } else if (s && TONAL.includes(s.category) && s.key_label && !fits.has(s.key_label) && n.sample.relPath !== c.sample.relPath) {
          swaps++
          const x = byPath.get(n.sample.relPath)!
          expect(fits.has(x.key_label!)).toBe(true)
          expect(x.category).toBe(s.category)
          expect([n.start, n.laneId]).toEqual([c.start, c.laneId])
          if (c.length <= (s.bars ?? 1) * 4) {
            expect(bodyBars(x)).toBe(bodyBars(s))
            expect(gapsAgree(gapOf(x), gapOf(s))).toBe(true)
          }
        } else {
          expect(n).toEqual(c)                                                   // drums and the rest: untouched
        }
      })
      expect(r.choices.at(-1)!.startsWith(`in ${to} (made in `)).toBe(true)
    }
    expect(swaps).toBeGreaterThan(0)
  })
})

describe('generator: rides from real tracks', () => {
  // Intro 32, drop 32, break 16, drop 32, outro 32 (as in "structures from real tracks"), with
  // the keys low-passed and opening over the first 16 bars of each drop, the tops quieter in the
  // breakdown, and the whole mix thinner in the 2 bars before each drop.
  const BARS = 144
  const drops = [32, 80]
  const runs = (rs: [number, number][]) => rs.map(([v, n]) => String(v).repeat(n)).join('')
  const series = (f: (b: number) => number | null) => Array.from({ length: BARS }, (_, b) => f(b))
  const into = (b: number) => drops.some((d) => b >= d - 2 && b < d)
  const opening = (b: number) => drops.map((d) => b - d).find((x) => x >= 0 && x < 16)
  const REAL: TrackArrangement = {
    zip_id: 1, source_code: 'S0042', bpm: 124, bars: BARS,
    parts: {
      kick: runs([[2, 31], [0, 1], [2, 32], [0, 16], [2, 32], [2, 32]]), hats: runs([[2, 144]]),
      top: runs([[0, 16], [2, 16], [2, 32], [1, 16], [2, 32], [2, 16], [0, 16]]),
      clap: runs([[0, 32], [2, 32], [0, 16], [2, 32], [0, 32]]),
      bass: runs([[0, 32], [2, 32], [1, 16], [2, 32], [0, 32]]), music: runs([[0, 32], [2, 32], [2, 16], [2, 32], [0, 32]]),
    },
    detail: {
      kick: { db: series(() => 0), bright: series((b) => (into(b) ? 0.6 : 0)) },
      hats: { db: series(() => 0), bright: series((b) => (into(b) ? 0.6 : 0)) },
      bass: { db: series(() => 0), bright: series((b) => (into(b) ? 0.6 : 0)) },
      top: { db: series((b) => (b >= 64 && b < 80 ? -10 : 0)), bright: series((b) => (into(b) ? 0.6 : 0)) },
      music: { db: series((b) => (opening(b) != null ? -6 + opening(b)! * 0.4 : 0)),
        bright: series((b) => (opening(b) != null ? -2.2 + opening(b)! * 0.14 : 0)) },
    },
  }
  const piano: MidiItem = { id: 765, file_name: 'Piano.mid', name: 'Piano', rel_path: 'MIDI/Keys/Piano.mid', role: 'keys', bars: 1,
    key_label: 'Am', key_camelot: null, notes: [[0, 1.5, 57, 100], [0, 1.5, 60, 90], [0, 1.5, 64, 90]], favorite: 0, source: null, source_code: null }
  const keys = { midis: [piano], presets: [{ path: '/piano.SerumPreset', name: 'Piano', folder: 'Keys', tags: [] }], favorites: [], sidechain: 0.4 }
  const opts: GenerateOptions = { ...OPTS, minMinutes: 4, maxMinutes: 5, templates: [REAL], keys }
  const gs = Array.from({ length: 30 }, (_, i) => generate(LIB, opts, 5000 + i))
  const lane = (g: Generation, name: string) => g.project.lanes.find((l) => l.name === name)?.id
  const at = (g: Generation, name: string, bar: number) => g.project.clips.filter((c) => c.laneId === lane(g, name) && c.start <= bar * 4 && c.start + c.length > bar * 4)

  it('rides the keys open over the drops the way the reference track does', () => {
    const built = gs.filter((g) => g.template === 'S0042')
    expect(built.length).toBeGreaterThan(10)
    for (const g of built) {
      const d = g.sections.find((s) => s.kind === 'drop')!
      const early = at(g, 'Keys', d.start + 1)[0]
      if (!early) continue
      expect(early.filter?.type).toBe('lowpass')
      const later = at(g, 'Keys', d.start + Math.min(14, d.bars - 2))[0]
      const cut = (c: Clip) => (c.filter ? (c.filter.to ?? c.filter.from) : 20000)
      expect(cut(later)).toBeGreaterThan(early.filter!.from)          // opening up
      expect(early.gainDb).toBeLessThan(0)
      expect(g.choices.some((c) => c.startsWith('filter and volume rides on') && c.includes('S0042'))).toBe(true)
    }
  })

  it('high-passes the mix into drops when the reference does, the risers and fills left alone', () => {
    const hp = gs.filter((g) => g.template === 'S0042' && g.rules.mixHp === 2)
    expect(hp.length).toBeGreaterThan(5)
    for (const g of hp) {
      for (const d of g.sections.filter((s) => s.kind === 'drop' && s.start >= 2)) {
        const kick = at(g, 'Kick', d.start - 1)[0]
        if (kick?.type === 'pattern' && kick.steps.some(Boolean)) expect(kick.filter).toMatchObject({ type: 'highpass' })
        for (const name of ['FX', 'Fills', 'Crash']) for (const c of at(g, name, d.start - 1)) expect(c.filter?.type).not.toBe('highpass')
      }
      expect(g.choices).toContain('the mix high-passed in the 2 bars before drops')
    }
  })

  it('gives tracks without a reference rides from a like section of one', () => {
    const own = gs.filter((g) => !g.template)
    expect(own.length).toBeGreaterThan(0)
    expect(own.some((g) => g.project.clips.some((c) => c.laneId === lane(g, 'Keys') && c.filter?.type === 'lowpass'))).toBe(true)
    expect(own.some((g) => g.choices.some((c) => c.includes('after S0042')))).toBe(true)
  })

  it('rides the same way when another lane is made again', () => {
    const g = gs.find((x) => x.template === 'S0042' && lane(x, 'Keys'))!
    const r = rerollLane(LIB, opts, g, lane(g, 'Hats')!, 3)!
    const keysOf = (x: Generation) => x.project.clips.filter((c) => c.laneId === lane(x, 'Keys')).map(({ id: _i, ...c }) => c)
    expect(keysOf(r)).toEqual(keysOf(g))
  })
})

describe('generator: breakdowns, the bar before drops and intro hats as in real tracks', () => {
  const nameOf = (g: Generation, c: Clip) => g.project.lanes.find((l) => l.id === c.laneId)?.name ?? ''
  const inBar = (g: Generation, bar: number, names: (n: string) => boolean) =>
    g.project.clips.filter((c) => names(nameOf(g, c)) && c.start < (bar + 1) * 4 && c.start + c.length > bar * 4)
  const bassOpts: GenerateOptions = { ...OPTS, bass: { midis: [{ id: 1, file_name: 'B.mid', name: 'B', rel_path: 'MIDI/Bass/b.mid', role: 'bass', bars: 2,
    key_label: 'Am', key_camelot: null, notes: [[0.5, 0.25, 41, 100]], favorite: 0, source: null, source_code: null }],
    presets: [{ path: '/presets/Bass/P.SerumPreset', name: 'P', folder: 'Bass', tags: [] }], favorites: [], sidechain: 0.5 } }
  const withBass = Array.from({ length: 40 }, (_, i) => generate(LIB, bassOpts, 8800 + i))

  it("keeps a top loop through breakdowns, mostly low-passed, by the track's rule", () => {
    let breaks = 0
    let kept = 0
    for (const g of gens) {
      for (const s of g.sections.filter((x) => x.kind === 'break')) {
        breaks++
        const top = clipsOn(g, 'Tops').find((c) => c.start <= s.start * 4 + 1 && c.start + c.length > s.start * 4 + 1)
        if (g.rules.topsBreaks === 'none') expect(top).toBeUndefined()
        else {
          kept++
          expect(top).toBeDefined()
          if (g.rules.topsBreaks === 'filtered') expect(top!.filter).toMatchObject({ type: 'lowpass', from: g.rules.topsBreakHz, to: null })
          else expect(top!.filter).toBeUndefined()
        }
      }
    }
    expect(kept / breaks).toBeGreaterThan(0.7)
  })

  it("takes a breath in the bar before drops: the tops out, or the tops, drums and bass, by the track's rule", () => {
    const seen = { tops: 0, all: 0, none: 0 }
    const tops = (n: string) => n.startsWith('Tops') || n === 'Groove'
    const drums = (n: string) => /^(Clap|Hats|Perc|Bass)/.test(n)
    for (const g of [...gens, ...withBass]) {
      seen[(g.rules.dropBreath as 'tops' | 'all' | null) ?? 'none']++
      for (const d of g.sections.filter((s) => s.kind === 'drop' && s.start >= 2)) {
        if (!g.rules.dropBreath) continue
        expect(inBar(g, d.start - 1, tops)).toEqual([])
        if (g.rules.dropBreath === 'all') expect(inBar(g, d.start - 1, drums)).toEqual([])
        // Back on the drop's 1.
        expect(inBar(g, d.start, tops).length).toBeGreaterThan(0)
      }
    }
    expect(Object.values(seen).every((n) => n > 10)).toBe(true)
    expect(gens.some((g) => g.choices.includes('tops, drums and bass out in the bar before drops'))).toBe(true)
  })

  it('high-passes the bass outside drops (its sub out), never low-passes it', () => {
    for (const g of withBass) {
      for (const c of clipsOn(g, 'Bass')) {
        if (c.filter) expect(c.filter.type).toBe('highpass')
        if (c.filter && !g.sections.some((s) => s.kind === 'drop' && c.start >= (s.start - Number(g.rules.mixHp ?? 0)) * 4 && c.start < (s.start + s.bars) * 4)) {
          expect(c.filter.from).toBe(g.rules.bassHp)
        }
      }
    }
    expect(withBass.some((g) => clipsOn(g, 'Bass').some((c) => c.filter?.type === 'highpass'))).toBe(true)
  })

  // Intro 32 (hats from halfway), drop 32, break 16 (tops on, darker; bass thin), drop 32, outro
  // 32; before each drop a bar without tops, claps or hats.
  const BARS = 144
  const runs = (rs: [number, number][]) => rs.map(([v, n]) => String(v).repeat(n)).join('')
  const series = (f: (b: number) => number | null) => Array.from({ length: BARS }, (_, b) => f(b))
  const inDrop = (b: number) => (b >= 32 && b < 64) || (b >= 80 && b < 112)
  const REAL: TrackArrangement = {
    zip_id: 1, source_code: 'S0043', bpm: 124, bars: BARS,
    parts: {
      kick: runs([[2, 31], [0, 1], [2, 32], [0, 16], [2, 32], [2, 32]]),
      top: runs([[2, 31], [0, 1], [2, 32], [1, 15], [0, 1], [2, 32], [2, 32]]),
      clap: runs([[0, 32], [2, 32], [2, 15], [0, 1], [2, 32], [0, 32]]),
      hats: runs([[0, 16], [2, 15], [0, 1], [2, 32], [0, 16], [2, 32], [2, 16], [0, 16]]),
      bass: runs([[0, 32], [2, 32], [1, 16], [2, 32], [1, 16], [0, 16]]),
    },
    detail: {
      top: { db: series(() => 0), bright: series((b) => (b >= 64 && b < 80 ? -1 : 0)) },
      bass: { db: series((b) => (inDrop(b) ? 0 : -8)), bright: series((b) => (inDrop(b) ? 0 : 1)) },
    },
  }

  it('learns them from the track a generation is built on', () => {
    expect(readSections(REAL)!.map((s) => s.kind)).toEqual(['intro', 'drop', 'break', 'drop', 'outro'])
    const rng = new Rng(9)
    const ts = Array.from({ length: 40 }, () => templateFrom(REAL, rng, 64 * 1.5, 200)!)
    const share = (k: string, v: unknown) => ts.filter((t) => t.rules[k] === v).length / ts.length
    expect(share('topsBreaks', 'filtered')).toBeGreaterThan(0.75)
    expect(share('topsBreakHz', Math.round(16000 * 2 ** -2.2))).toBeGreaterThan(0.75)
    expect(share('bassHp', 240)).toBeGreaterThan(0.75)
    expect(share('dropBreath', 'all')).toBeGreaterThan(0.75)
    expect(share('introHats', 'half')).toBeGreaterThan(0.75)
    expect(share('outroHats', 'half')).toBeGreaterThan(0.75)
  })
})

describe('generator: chord stabs', () => {
  const stab = (id: number, key: string | null, pitch_fix = 0): HitItem => ({
    id, kind: 'stab', file_name: `Organ ${id}.wav`, name: `Organ ${id}`, rel_path: `Chord Stabs/organ-${id}.wav`, key_label: key,
    key_camelot: null, key_source: key ? 'name' : null, pitch_fix, duration_s: 0.6, channels: 2,
  })
  const STABS = [stab(1, 'Cm'), stab(2, 'F'), stab(3, 'Am', -12), stab(4, 'G'), stab(5, null)]
  const piano: MidiItem = { id: 765, file_name: 'Piano.mid', name: 'Piano', rel_path: 'MIDI/Keys/Piano.mid', role: 'keys', bars: 1,
    key_label: 'Am', key_camelot: null, notes: [[0, 1.5, 57, 100], [0, 1.5, 60, 90], [0, 1.5, 64, 90]], favorite: 0, source: null, source_code: null }
  const keys = { midis: [piano], presets: [{ path: '/piano.SerumPreset', name: 'Piano', folder: 'Keys', tags: [] }], favorites: [], sidechain: 0.4 }
  const opts: GenerateOptions = { ...OPTS, keys, stabs: { hits: STABS } }
  const gs = Array.from({ length: 60 }, (_, i) => generate(LIB, opts, 6100 + i))
  const stabLanes = (g: Generation) => g.project.lanes.filter((l) => /^Stab/.test(l.name))
  const stabClips = (g: Generation) => {
    const ids = new Set(stabLanes(g).map((l) => l.id))
    return g.project.clips.filter((c) => ids.has(c.laneId)) as PatternClip[]
  }
  /** What the stab lanes play together in `bar` (16 velocities). */
  const together = (g: Generation, bar: number) => {
    const out = new Array(16).fill(0)
    for (const c of stabClips(g)) {
      if (c.start > bar * 4 || c.start + c.length <= bar * 4) continue
      const from = ((bar * 4 - c.start) * 4) % c.steps.length
      c.steps.slice(from, from + 16).forEach((v, i) => (out[i] = Math.max(out[i], v)))
    }
    return out
  }

  it('plays chord stabs instead of the keys in about 2 in 3 tracks, never both', () => {
    const withStabs = gs.filter((g) => g.rules.stabs)
    expect(withStabs.length / gs.length).toBeGreaterThan(0.5)
    expect(withStabs.length / gs.length).toBeLessThan(0.85)
    for (const g of gs) {
      const hasKeys = g.project.lanes.some((l) => l.name === 'Keys')
      expect(hasKeys).toBe(!g.rules.stabs)
      expect(stabLanes(g).length > 0).toBe(!!g.rules.stabs)
      if (g.rules.stabs) expect(g.keys).toBeNull()
    }
    // Only stabs: every track; keys only: none.
    expect(Array.from({ length: 10 }, (_, i) => generate(LIB, { ...OPTS, stabs: { hits: STABS } }, 6300 + i)).every((g) => stabLanes(g).length)).toBe(true)
    expect(Array.from({ length: 10 }, (_, i) => generate(LIB, { ...OPTS, keys }, 6300 + i)).some((g) => stabLanes(g).length)).toBe(false)
  })

  it('plays one stab per track, mostly 2 hits a bar, sometimes 1 or 3', () => {
    const perBar = [0, 0, 0, 0, 0]
    for (const g of gs.filter((x) => x.rules.stabs)) {
      expect(stabLanes(g).map((l) => l.name)).toEqual(['Stab'])
      expect(new Set(stabClips(g).map((c) => c.sample.relPath)).size).toBe(1)
      for (const bar of g.rules.stabRhythm as number[][]) perBar[bar.filter(Boolean).length]++
    }
    expect(perBar[0]).toBe(0)
    expect(perBar[4]).toBe(0)
    expect(perBar[2]).toBeGreaterThan(perBar[1] + perBar[3])
    expect(perBar[1]).toBeGreaterThan(0)
    expect(perBar[3]).toBeGreaterThan(0)
  })

  it('plays one funky 2-bar rhythm through every drop, off the kick, in the track key', () => {
    let perBar = 0
    let bars = 0
    for (const g of gs.filter((x) => x.rules.stabs)) {
      const rhythm = g.rules.stabRhythm as number[][]
      for (const d of g.sections.filter((s) => s.kind === 'drop')) {
        for (let b = d.start; b < d.start + Math.min(8, d.bars); b++) {
          const want = rhythm[(b - d.start) % 2]
          expect(together(g, b).map(Boolean)).toEqual(want.map(Boolean))
          perBar += want.filter(Boolean).length
          bars++
        }
      }
      for (const c of stabClips(g)) {
        const h = STABS.find((x) => x.rel_path === c.sample.relPath)!
        expect(c.pitch ?? 0).toBe(hitPitch(h, g.key))
        expect(c.sample.category).toBe('chord_stab')
        expect([1, 2]).toContain(c.patternBars)
      }
      // Merged into long clips, not a clip a bar.
      expect(stabClips(g).length).toBeLessThan(g.project.lengthBars / 2)
    }
    // Often no more than 2 stabs per bar.
    expect(perBar / bars).toBeLessThanOrEqual(2.2)
    expect(perBar / bars).toBeGreaterThanOrEqual(1)
  })

  it('plays in the drops only, or like the keys: the same rhythm low-passed in breakdowns, or nothing there', () => {
    const seen = new Set<string>()
    for (const g of gs.filter((x) => x.rules.stabs)) {
      for (const s of g.sections.filter((x) => x.kind !== 'drop')) {
        const inside = stabClips(g).filter((c) => c.start >= s.start * 4 && c.start < (s.start + s.bars) * 4)
        if (s.kind === 'intro' || s.kind === 'outro' || g.rules.stabsIn === 'drops') expect(inside).toEqual([])
        else if (s.kind === 'break') {
          seen.add(`break:${g.rules.stabsBreaks}`)
          if (g.rules.stabsBreaks === 'none') expect(inside).toEqual([])
          else {
            expect(inside.length).toBeGreaterThan(0)
            for (const c of inside) expect(c.filter?.type).toBe('lowpass')
            expect(together(g, s.start + 2).map(Boolean)).toEqual((g.rules.stabRhythm as number[][])[0].map(Boolean))
          }
        }
      }
    }
    expect(seen).toEqual(new Set(['break:filtered', 'break:none']))
    expect(gs.some((g) => g.rules.stabs && g.rules.stabsIn === 'drops')).toBe(true)
  })

  it('keeps the drums and the bass the same with or without stabs', () => {
    const sig = (g: Generation) => g.project.clips.filter((c) => !/^(Stab|Keys)/.test(g.project.lanes.find((l) => l.id === c.laneId)!.name))
      .map(({ id: _i, laneId: _l, ...c }) => c)
    for (let i = 0; i < 15; i++) expect(sig(generate(LIB, opts, 6200 + i))).toEqual(sig(generate(LIB, { ...OPTS, keys }, 6200 + i)))
  })

  it('makes new stabs for a track, or stabs instead of its keys, the rest as it is', () => {
    const rest = (g: Generation) => g.project.clips.filter((c) => !/^(Stab|Keys)/.test(g.project.lanes.find((l) => l.id === c.laneId)!.name))
      .map(({ id: _i, laneId: _l, ...c }) => c)
    const withKeys = gs.find((g) => !g.rules.stabs)!
    const r = rerollStabs(LIB, opts, withKeys, 11)!
    expect(r.keys).toBeNull()
    expect(r.project.lanes.some((l) => l.name === 'Keys')).toBe(false)
    expect(stabLanes(r).length).toBeGreaterThan(0)
    expect(rest(r)).toEqual(rest(withKeys))
    const withStabs = gs.find((g) => g.rules.stabs)!
    const again = rerollStabs(LIB, opts, withStabs, 12)!
    expect(JSON.stringify(stabClips(again).map(({ id: _i, laneId: _l, ...c }) => c)))
      .not.toBe(JSON.stringify(stabClips(withStabs).map(({ id: _i, laneId: _l, ...c }) => c)))
    expect(rest(again)).toEqual(rest(withStabs))
  })

  describe('played by Serum patches', () => {
    const P = (n: number): SerumPreset => ({ path: `/presets/House - Chord Stabs/Stab ${n}.SerumPreset`, name: `Stab ${n}`, folder: 'House - Chord Stabs', tags: [] })
    const presets = [P(1), P(2), P(3), P(4)]
    const only = Array.from({ length: 20 }, (_, i) => generate(LIB, { ...OPTS, stabs: { hits: [], presets, octaves: { [P(2).path]: -12 } } }, 6400 + i))
    const parts = (g: Generation) => g.project.clips.filter((c): c is AudioClip => c.type === 'audio' && c.bass?.role === 'stab')
    const pc = (n: number) => ((n % 12) + 12) % 12

    it("renders each patch's turns in the rhythm as the track key's seventh chord, a 2-bar loop", () => {
      for (const g of only) {
        expect(stabLanes(g).length).toBeGreaterThan(0)
        expect(parts(g).length).toBeGreaterThan(0)
        const k = /^([A-G]#?)(m?)$/.exec(g.key ?? 'Cm')!
        const root = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].indexOf(k[1])
        const chord = new Set((k[2] ? [0, 3, 7, 10] : [0, 4, 7, 11]).map((x) => pc(root + x)))
        const rhythm = g.rules.stabRhythm as number[][]
        const starts = new Set<number>()
        for (const c of parts(g)) {
          const b = c.bass!
          expect(b.bars).toBe(2)
          expect(b.keyLabel).toBe(g.key)
          expect(c.sample.relPath).toBe(bassPath(b, g.project.bpm))
          expect(c.sample.relPath.startsWith('.drumvault/stabs/')).toBe(true)
          expect(new Set(b.notes!.map(([, , p]) => pc(p)))).toEqual(chord)
          expect(b.transpose).toBe(b.preset === P(2).path ? -12 : 0)
          for (const [st] of b.notes!) starts.add(st)
          // In phase: the loop starts on an even bar.
          expect((c.start / 4) % 2).toBe(0)
        }
        // Together they play the rhythm (with three patches or fewer than the rhythm's hits, some each).
        const want = rhythm.flatMap((bar, i) => bar.flatMap((v, j) => (v ? [i * 4 + j / 4] : [])))
        if (stabLanes(g).length === parts(g).map((c) => c.bass!.preset).filter((x, i, a) => a.indexOf(x) === i).length) {
          expect([...starts].sort((a, b) => a - b)).toEqual(want)
        }
      }
    })

    it('gives a patch that plays a chord from one key the root alone', () => {
      const chordy = presets.map((p) => ({ ...p, chord: true }))
      for (let i = 0; i < 10; i++) {
        const g = generate(LIB, { ...OPTS, stabs: { hits: [], presets: chordy } }, 6450 + i)
        const k = /^([A-G]#?)/.exec(g.key ?? 'C')![1]
        const root = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].indexOf(k)
        for (const c of parts(g)) {
          const notes = c.bass!.notes!
          expect(new Set(notes.map(([st]) => st)).size).toBe(notes.length)
          for (const [, , p] of notes) {
            expect(pc(p)).toBe(root)
            expect(p).toBeGreaterThanOrEqual(48)
            expect(p).toBeLessThan(60)
          }
        }
      }
    })

    it("plays a patch's own chord (from its clip player) on the steps, from the key's root", () => {
      const PIANO = [-12, 0, 10, 12, 14, 15, 19]                  // a spread minor 9 from C
      const own = presets.map((p) => ({ ...p, voicing: PIANO }))
      for (let i = 0; i < 8; i++) {
        const g = generate(LIB, { ...OPTS, stabs: { hits: [], presets: own } }, 6460 + i)
        const k = /^([A-G]#?)(m?)$/.exec(g.key ?? 'Cm')!
        // Its third is minor: in a major key it plays from the relative minor's root.
        const r = pc(['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].indexOf(k[1]) + (k[2] ? 0 : -3))
        const root = 60 + (r > 5 ? r - 12 : r)
        for (const c of parts(g)) {
          expect(c.bass!.stab).toEqual({ voicing: PIANO })
          const byStart = new Map<number, number[]>()
          for (const [st, , p] of c.bass!.notes!) byStart.set(st, [...(byStart.get(st) ?? []), p])
          for (const ps of byStart.values()) expect(ps.sort((a, b) => a - b)).toEqual(PIANO.map((v) => root + v))
        }
        // Another key: the same chord from its root.
        const moved = changeKey(LIB, { ...OPTS, stabs: { hits: [], presets: own } }, g, 'F#m', 1)
        for (const c of parts(moved)) {
          expect(c.bass!.stab).toEqual({ voicing: PIANO })
          expect(Math.min(...c.bass!.notes!.map(([, , p]) => p))).toBe(54 - 12)
        }
      }
    })

    it('draws each stab from the samples and the patches together', () => {
      const mixed = Array.from({ length: 40 }, (_, i) => generate(LIB, { ...OPTS, stabs: { hits: STABS, presets } }, 6500 + i))
      const kinds = mixed.flatMap((g) => stabLanes(g).map((l) => (g.project.clips.find((c) => c.laneId === l.id)?.type)))
      expect(kinds).toContain('audio')
      expect(kinds).toContain('pattern')
    })

    it('moves patch stabs into another key, and makes new ones', () => {
      const g = only.find((x) => x.key && x.key !== 'Dm' && parts(x).length)!
      const moved = changeKey(LIB, { ...OPTS, stabs: { hits: [], presets } }, g, 'Dm', 1)
      for (const [a, b] of parts(g).map((c, i) => [c, parts(moved)[i]] as const)) {
        // The same rhythm and octave, D minor's seventh chord.
        expect(b.bass!.transpose).toBe(a.bass!.transpose)
        expect(b.bass!.keyLabel).toBe('Dm')
        expect(new Set(b.bass!.notes!.map(([, , p]) => pc(p)))).toEqual(new Set([2, 5, 9, 0]))
        expect(b.bass!.notes!.map(([st]) => st)).toEqual(a.bass!.notes!.map(([st]) => st))
        expect(b.sample.relPath).toBe(bassPath(b.bass!, moved.project.bpm))
      }
      const r = rerollStabs(LIB, { ...OPTS, stabs: { hits: [], presets } }, g, 5)!
      expect(new Set(parts(r).map((c) => c.bass!.preset))).not.toEqual(new Set(parts(g).map((c) => c.bass!.preset)))
    })
  })

  describe('rhythms from the step sequencer', () => {
    const on = (...hits: number[]) => Array.from({ length: 16 }, (_, i) => (hits.includes(i) ? 1 : 0))
    const SAVED = [
      { name: 'A', steps: [on(2, 10)] },
      { name: 'B', steps: [on(3, 11)] },
      { name: 'C', steps: [on(2, 7, 10)] },
    ]
    const hits = (b: number[]) => b.flatMap((v, i) => (v ? [i] : []))

    it('replaces the built-ins with the saved ones: some as they are, the rest learned from them', () => {
      const rng = new Rng(3)
      const rs = Array.from({ length: 400 }, () => stabRhythm(rng, SAVED))
      const exact = rs.filter((r) => SAVED.some((x) => JSON.stringify(x.steps) === JSON.stringify(r.map((b) => b.map((v) => (v ? 1 : 0))))))
      // Learned ones can come out as a saved one too.
      expect(exact.length / rs.length).toBeGreaterThan(SAVED_EXACT - 0.05)
      expect(exact.length / rs.length).toBeLessThan(0.75)
      const seen = new Set([2, 3, 7, 10, 11])
      let inSeen = 0
      let all = 0
      for (const r of rs) {
        expect(r.length).toBe(1)                                          // all saved ones are 1 bar
        const n = hits(r[0]).length
        expect(n).toBeGreaterThanOrEqual(2)
        expect(n).toBeLessThanOrEqual(3)
        for (const h of hits(r[0])) { all++; if (seen.has(h)) inSeen++ }
        for (const v of r[0]) expect([0, 3]).toContain(v)                  // on or off
      }
      expect(inSeen / all).toBeGreaterThan(0.9)
      // New ones too, not only copies.
      expect(new Set(rs.map((r) => hits(r[0]).join())).size).toBeGreaterThan(3)
      // Two bars when the saved ones are.
      const two = Array.from({ length: 50 }, () => stabRhythm(rng, [{ name: 'D', steps: [on(2, 10), on(6)] }]))
      expect(two.every((r) => r.length === 2)).toBe(true)
    })

    it('plays a 1-bar rhythm every bar, and an edited rhythm in place, the rest of the track as it is', () => {
      const o: GenerateOptions = { ...OPTS, stabs: { hits: STABS, rhythms: SAVED } }
      const g = Array.from({ length: 20 }, (_, i) => generate(LIB, o, 6600 + i)).find((x) => x.rules.stabs)!
      expect((g.rules.stabRhythm as number[][]).length).toBe(1)
      const d = g.sections.find((x) => x.kind === 'drop')!
      for (let b = d.start; b < d.start + 4; b++) expect(together(g, b).map(Boolean)).toEqual(together(g, d.start).map(Boolean))
      const rhythm = [on(6, 14).map((v) => v * 3), on(3).map((v) => v * 3)] as Velocity[][]
      const e = setStabRhythm(LIB, o, g, rhythm)!
      expect(e.rules.stabRhythm).toEqual(rhythm)
      expect(together(e, d.start).map(Boolean)).toEqual(rhythm[0].map(Boolean))
      expect(together(e, d.start + 1).map(Boolean)).toEqual(rhythm[1].map(Boolean))
      const rest = (x: Generation) => x.project.clips.filter((c) => !/^Stab/.test(x.project.lanes.find((l) => l.id === c.laneId)!.name))
        .map(({ id: _i, laneId: _l, ...c }) => c)
      expect(rest(e)).toEqual(rest(g))
      expect(new Set(stabClips(e).map((c) => c.sample.relPath))).toEqual(new Set(stabClips(g).map((c) => c.sample.relPath)))
      // A patch gets its notes where the steps are.
      const P: SerumPreset = { path: '/p/Stab.SerumPreset', name: 'Stab', folder: 'x', tags: [] }
      const po: GenerateOptions = { ...OPTS, stabs: { hits: [], presets: [P] } }
      const pg = generate(LIB, po, 6700)
      const pe = setStabRhythm(LIB, po, pg, rhythm)!
      const part = pe.project.clips.find((c): c is AudioClip => c.type === 'audio' && c.bass?.role === 'stab')!
      expect([...new Set(part.bass!.notes!.map(([st]) => st))].sort((a, b) => a - b)).toEqual([1.5, 3.5, 4.75])
      expect(part.bass!.bars).toBe(2)
      // Only the steps change: the same chord, patch and octave (even when the patch would get another chord now).
      const before = pg.project.clips.find((c): c is AudioClip => c.type === 'audio' && c.bass?.role === 'stab')!
      const chordAt = (ns: [number, number, number, number][], st: number) => ns.filter(([x]) => x === st).map(([, , p]) => p).sort()
      const first = Math.min(...before.bass!.notes!.map(([st]) => st))
      const was = chordAt(before.bass!.notes!, first)
      const now = setStabRhythm(LIB, { ...OPTS, stabs: { hits: [], presets: [{ ...P, voicing: [0, 7, 15] }] } }, pg, rhythm)!
      const np = now.project.clips.find((c): c is AudioClip => c.type === 'audio' && c.bass?.role === 'stab')!
      for (const st of [1.5, 3.5, 4.75]) expect(chordAt(np.bass!.notes!, st)).toEqual(was)
      expect({ ...np.bass, notes: undefined, bars: undefined }).toEqual({ ...before.bass, notes: undefined, bars: undefined })
    })
  })

  it('moves the stabs into another key with the rest of the track', () => {
    const g = gs.find((x) => x.rules.stabs && x.key && x.key !== 'Dm')!
    const moved = changeKey(LIB, opts, g, 'Dm', 1)
    for (const c of stabClips(moved)) expect(c.pitch ?? 0).toBe(hitPitch(STABS.find((x) => x.rel_path === c.sample.relPath)!, 'Dm'))
  })
})

describe('generator: changing a made track (choices, a new sound, keys instead of stabs)', () => {
  const ALL = LANES.map((l) => l.role)
  /** A lane's clips without ids, by lane name. */
  const lanesOf = (g: Generation) => Object.fromEntries(g.project.lanes.map((l) => [l.name,
    g.project.clips.filter((c) => c.laneId === l.id).map(({ id: _i, laneId: _l, ...c }) => c)]))
  const piano: MidiItem = { id: 765, file_name: 'Piano.mid', name: 'Piano', rel_path: 'MIDI/Keys/Piano.mid', role: 'keys', bars: 1,
    key_label: 'Am', key_camelot: null, notes: [[0, 1.5, 57, 100], [0, 1.5, 60, 90], [0, 1.5, 64, 90]], favorite: 0, source: null, source_code: null }
  const keys = { midis: [piano], presets: [{ path: '/piano.SerumPreset', name: 'Piano', folder: 'Keys', tags: [] }], favorites: [], sidechain: 0.4 }

  it('makes the same track again from where its RNG was, a rule set to what it was', () => {
    for (const g of gens.slice(0, 25)) {
      const again = setTrackRule(LIB, OPTS, g, 'introHats', g.rules.introHats, ALL)
      expect(lanesOf(again)).toEqual(lanesOf(g))
      expect(again.rules).toEqual(g.rules)
    }
  })

  it('changes only the lanes a choice shapes, and the track keeps the new value', () => {
    let n = 0
    for (const g of gens.filter((x) => x.rules.topsBreaks === 'filtered' && x.sections.some((s) => s.kind === 'break')).slice(0, 10)) {
      const choice = CHOICES.find((c) => c.rule === 'topsBreaks')!
      const r = setTrackRule(LIB, OPTS, g, 'topsBreaks', 'none', choice.roles)
      expect(r.rules.topsBreaks).toBe('none')
      const before = lanesOf(g)
      const after = lanesOf(r)
      for (const [name, clips] of Object.entries(before)) {
        if (!choice.roles.includes(laneRole(name)!)) expect(after[name]).toEqual(clips)
      }
      // No top loop in a breakdown any more.
      for (const s of r.sections.filter((x) => x.kind === 'break')) {
        for (const l of r.project.lanes.filter((x) => /^Tops/.test(x.name))) {
          expect(r.project.clips.some((c) => c.laneId === l.id && c.start < (s.start + s.bars) * 4 && c.start + c.length > s.start * 4)).toBe(false)
        }
      }
      n++
    }
    expect(n).toBeGreaterThan(3)
  })

  it('lists only the lanes a choice moves (a layer that plays in drops only is not one of the intro\'s)', () => {
    const nameOf = new Map(LANES.map((l) => [l.role, l.name]))
    const unmoved: string[] = []
    for (const c of CHOICES) {
      for (const role of c.roles) {
        const name = nameOf.get(role)!
        const tracks = gens.filter((g) => laneOf(g, name) && (!c.when || c.when(g))).slice(0, 30)
        if (!tracks.length) continue
        const moved = tracks.some((g) => c.options.some((o) => {
          if (optionKey(o.value) === optionKey(g.rules[c.rule])) return false
          return JSON.stringify(lanesOf(setTrackRule(LIB, OPTS, g, c.rule, o.value, [role]))[name]) !== JSON.stringify(lanesOf(g)[name])
        }))
        if (!moved) unmoved.push(`${c.rule}: ${name}`)
      }
    }
    expect(unmoved).toEqual([])
  })

  it('brings the clap and the perc in the half of the intro and the outro next to the drops', () => {
    const at = (g: Generation, name: string, from: number, to: number) =>
      g.project.clips.some((c) => c.laneId === laneOf(g, name) && c.start < to * 4 && c.start + c.length > from * 4)
    let n = 0
    for (const g of gens.filter((x) => x.rules.ioClaps && x.rules.ioPerc && laneOf(x, 'Clap') && laneOf(x, 'Perc')).slice(0, 10)) {
      const intro = g.sections[0]
      const outro = g.sections.at(-1)!
      for (const name of ['Clap', 'Perc']) {
        expect(at(g, name, intro.start + intro.bars / 2, intro.start + intro.bars)).toBe(true)
        expect(at(g, name, outro.start, outro.start + outro.bars / 2)).toBe(true)
        expect(at(g, name, intro.start, intro.start + 8)).toBe(false)
        expect(at(g, name, outro.start + outro.bars - 8, outro.start + outro.bars)).toBe(false)
      }
      const off = setTrackRule(LIB, OPTS, setTrackRule(LIB, OPTS, g, 'ioClaps', false, ['clap']), 'ioPerc', false, ['perc'])
      for (const name of ['Clap', 'Perc']) {
        expect(at(off, name, intro.start, intro.start + intro.bars)).toBe(false)
        expect(at(off, name, outro.start, outro.start + outro.bars)).toBe(false)
      }
      n++
    }
    expect(n).toBeGreaterThan(3)
  })

  it('keeps a lane made again before as it is now, when a choice remakes it', () => {
    const g = gens[3]
    const clap = laneOf(g, 'Clap')!
    const rolled = rerollLane(LIB, OPTS, g, clap, 77)!
    const r = setTrackRule(LIB, OPTS, rolled, 'ioClaps', !rolled.rules.ioClaps, CHOICES.find((c) => c.rule === 'ioClaps')!.roles)
    const sample = (x: Generation) => x.project.clips.find((c) => c.laneId === laneOf(x, 'Clap'))?.sample.relPath
    expect(sample(r)).toBe(sample(rolled))
    expect(r.picks.clap?.rel_path).toBe(rolled.picks.clap?.rel_path)
  })

  it('keeps the bass and keys parts exactly as they play now when a choice remakes their lanes', () => {
    const opts: GenerateOptions = { ...OPTS, keys }
    const g = generate(LIB, opts, 7301)
    g.keys = { ...g.keys!, transpose: g.keys!.transpose + 12 }
    for (const c of g.project.clips) if (c.type === 'audio' && c.bass?.role === 'keys') c.bass = { ...c.bass, transpose: g.keys.transpose }
    const value = g.rules.keysBreaks === 'none' ? 'filtered' : 'none'
    const r = setTrackRule(LIB, opts, g, 'keysBreaks', value, ['keys'])
    const parts = r.project.clips.filter((c): c is AudioClip => c.type === 'audio' && c.bass?.role === 'keys')
    expect(parts.length).toBeGreaterThan(0)
    for (const c of parts) expect(c.bass!.transpose).toBe(g.keys.transpose)
  })

  it('locks choices for every track', () => {
    const locks = { introHats: 'none', dropBreath: 'all', topsBreaks: 'open' }
    for (let i = 0; i < 20; i++) {
      const g = generate(LIB, { ...OPTS, locks }, 8800 + i)
      expect(g.rules).toMatchObject(locks)
    }
  })

  it('offers the choices that apply to a track, with its value among their options', () => {
    for (const g of gens.slice(0, 30)) {
      const list = choicesFor(g)
      expect(list.some((c) => c.rule === 'bassBreaks')).toBe(!!g.bass)
      for (const c of list) expect(c.options.map((o) => JSON.stringify(o.value ?? null))).toContain(JSON.stringify(g.rules[c.rule] ?? null))
    }
  })

  it('gives a lane other sounds of the same kind where it plays, the rest exactly as it is', () => {
    // (Tonal FX only swap for ones in a key that fits: this library has none besides their own.)
    for (const name of ['Clap', 'Hats', 'Tops', 'Fills']) {
      const g = gens.find((x) => laneOf(x, name))!
      const id = laneOf(g, name)!
      const r = newLaneSound(LIB, OPTS, g, id, 5)!
      expect(r).not.toBeNull()
      const was = g.project.clips.filter((c) => c.laneId === id)
      const now = r.project.clips.filter((c) => c.laneId === id)
      expect(now.map((c) => [c.start, c.type === 'pattern' ? c.steps : null])).toEqual(was.map((c) => [c.start, c.type === 'pattern' ? c.steps : null]))
      expect(now.some((c, i) => c.sample.relPath !== was[i].sample.relPath)).toBe(true)
      now.forEach((c, i) => {
        const a = byPath.get(was[i].sample.relPath)!
        const b = byPath.get(c.sample.relPath)!
        expect([b.kind, b.category]).toEqual([a.kind, a.category])
        if (a.kind === 'event' && c.length <= (a.bars ?? 1) * 4) {
          expect(bodyBars(b)).toBe(bodyBars(a))
          expect(gapsAgree(gapOf(b), gapOf(a))).toBe(true)
        }
      })
      expect(r.project.clips.filter((c) => c.laneId !== id)).toEqual(g.project.clips.filter((c) => c.laneId !== id))
    }
  })

  it('plays keys instead of chord stabs, going with the bass, the rest as it is', () => {
    const stab: HitItem = { id: 1, kind: 'stab', file_name: 'Organ.wav', name: 'Organ', rel_path: 'Chord Stabs/organ.wav', key_label: 'Cm',
      key_camelot: null, key_source: 'name', pitch_fix: 0, duration_s: 0.6, channels: 2 }
    const opts: GenerateOptions = { ...OPTS, keys, stabs: { hits: [stab] } }
    const g = Array.from({ length: 20 }, (_, i) => generate(LIB, opts, 9100 + i)).find((x) => x.rules.stabs)!
    const r = rerollKeys(LIB, opts, g, 3)!
    expect(r.keys).not.toBeNull()
    expect(r.rules.stabs).toBe(false)
    expect(r.project.lanes.some((l) => l.name === 'Stab')).toBe(false)
    expect(r.project.lanes.some((l) => l.name === 'Keys')).toBe(true)
    const rest = (x: Generation) => Object.fromEntries(Object.entries(lanesOf(x)).filter(([n]) => n !== 'Keys' && n !== 'Stab'))
    expect(rest(r)).toEqual(rest(g))
    const roles: Role[] = r.project.lanes.map((l) => laneRole(l.name)!).filter(Boolean)
    expect(roles).toContain('keys')
  })
})
