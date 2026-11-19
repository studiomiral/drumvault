import { describe, expect, it } from 'vitest'
import { isGenerated } from '../src/generate/bassline'
import { stringsBars } from '../src/generate/strings'
import { breakShape } from '../src/generate/character'
import {
  applyMix, arcOf, bodyBars, changeKey, gapOf, gapsAgree, generate, LANES, laneRole, liftBars, newLaneSound, newStringsSound, rerollDisco, rerollStrings, rerollVocal, rerollLane, rerollStabs, setStabRhythm, setTrackRule,
  transposeTo, type GenerateOptions, type Generation,
} from '../src/generate/generator'
import { CHOICES, choicesFor, optionKey } from '../src/generate/choices'
import { dropRanges, KICK_LEVEL_DB, laneLoudness } from '../src/generate/balance'
import { bassPath } from '../src/audio/schedule'
import type { EventShape, HitItem, LoopGroove, MidiItem, SerumPreset, TrackArrangement } from '../src/types/api'
import { hitPitch } from '../src/generate/disco'
import type { VocalTake } from '../src/generate/vocals'
import { feelFit } from '../src/generate/feel'
import { mainBuildOf, mainBuilds, readReference, readSections, templateFrom, templateFromReference } from '../src/generate/template'
import { arcFit, bestOf, scoreGeneration } from '../src/generate/score'
import type { MixProfile, ReferenceTrack } from '../src/types/engine'
import { SAVED_EXACT, stabParts, stabRhythm } from '../src/generate/stabs'
import { Rng } from '../src/generate/rng'
import { expandCompatible } from '../src/lib/camelot'
import { bassy } from '../src/generate/eq'
import { halfwayBars } from '../src/generate/structure'
import { fillSlices } from '../src/generate/fills'
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
  if (g.rules.dropIn != null) return t                                     // the track's own way in, the same into every drop
  return t > 1 ? Math.min(t, 8) : Number(g.rules.dropSilence) * 4
}
/** A drop the big build leads into: the first after the long breakdown, in a track that builds big. */
function bigDrop(g: Generation, s: Generation['sections'][number]): boolean {
  return g.rules.bigBuild === 'big' && s.kind === 'drop' && g.sections.some((x, i) => x.long && g.sections.slice(i + 1).find((y) => y.kind === 'drop') === s)
}
/** Bars the mix high-pass runs before drop `s` (the big build's when that is longer). */
function hpBefore(g: Generation, s: Generation['sections'][number]): number {
  return Math.max(Number(g.rules.mixHp ?? 0), bigDrop(g, s) ? Number(g.rules.bigHp ?? 0) : 0)
}
/** The same tracks, the way they were made before the track-wide way into drops and the big build. */
const LEGACY: GenerateOptions = { ...OPTS, locks: { dropIn: null, bigBuild: 'usual' } }
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
        const end = (s.start + s.bars) * 4 - (intoDrop ? Math.max(2, silenceBefore(g, g.sections[1].start) / 4) : 0)
        const hatsEnd = (s.start + s.bars) * 4 - (intoDrop ? (g.rules.dropBreath === 'all' ? 4 : 2) : 0)
        // Hats none, the half next to the drops, or all through; with the lift, none until the
        // bars it fills up over (hats come in first).
        const how = s === intro ? g.rules.introHats : g.rules.outroHats
        const half = s.start + halfwayBars(s.bars)
        const lift = s === intro ? s.start + s.bars - liftBars(s.bars) : s.start + liftBars(s.bars)
        // (A kick roll building into the first drop takes the Kick lane's place over the intro's last bars.)
        const roll = s === intro && intoDrop && g.rules.buildup === 'kickRoll'
          ? (s.start + s.bars - Math.min(Number(g.rules.buildupBars), Math.max(1, Math.floor(s.bars / 4)))) * 4 : Infinity
        for (let beat = s.start * 4; beat < end; beat++) {
          if (beat < roll) expect(hitAt(g, 'Kick', beat * 4)).toBe(3)
          else expect(hitAt(g, 'Build-up', beat * 4)).toBe(3)
          const inHalf = s === intro ? beat >= half * 4 : beat < half * 4
          const inLift = !!g.rules.ioLift && (s === intro ? beat >= lift * 4 : beat < lift * 4)
          // (Where nothing else would play with the kick, the hats do: the kick is never alone.)
          const want = how === 'all' || (how === 'half' && inHalf) || (how === 'none' && inLift)
          const bar = Math.floor(beat / 4) * 4
          const alone = !g.project.lanes.some((l) => !['kick', 'hats', 'crash', 'fx', 'fx2', 'fx3', 'hits', 'atmos', 'bed'].includes(laneRole(l.name) ?? '')
            && [0, 1, 2, 3].some((k) => covers(g, l.name, bar + k)))
          if (beat < hatsEnd) expect(covers(g, 'Hats', beat)).toBe(want || alone)
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
          const intoDrop = g.sections.some((s) => s.kind === 'drop' && c.start >= (s.start - hpBefore(g, s)) * 4 && c.start < s.start * 4)
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

  it('applies the lane volume sliders at 0 dB by default, the starting mix as levels where nothing is measured', () => {
    const g = generate(LIB, { ...OPTS, mix: { top: -3, kick: 2 } }, 1234)
    const lane = (name: string) => g.project.lanes.find((l) => l.name === name)
    const start = (name: string) => LANES.find((l) => l.name === name)!.startDb
    expect(lane('Kick')!.volumeDb).toBe(2)
    expect(lane('Tops')!.volumeDb).toBe(-3)
    if (lane('Tops 2')) expect(lane('Tops 2')!.volumeDb).toBe(0)  // its own slider
    // The test library has no loudness measured: each lane plays at its step in the starting mix.
    for (const l of g.project.lanes) expect(l.levelDb).toBe(start(l.name))
    expect(g.choices.some((c) => c.startsWith('mix balanced'))).toBe(false)
    applyMix(g.project, {})
    expect(lane('Kick')!.volumeDb).toBe(0)
  })

  it('brings rides in only in drops: later in the first one and/or all through later ones', () => {
    let seen = 0
    for (const g of gens) {
      const drops = g.sections.filter((s) => s.kind === 'drop')
      for (const c of clipsOn(g, 'Ride')) {
        const d = drops.findIndex((s) => c.start >= s.start * 4 && c.start < (s.start + s.bars) * 4)
        // (Past a drop's end it only fades out into the breakdown: the groove carried through.)
        if (d < 0) {
          expect(g.sections.some((s) => s.kind === 'break' && s.start * 4 === c.start)).toBe(true)
          expect(c.gainTo).toBeLessThan(-10)
          continue
        }
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
      // (A lean first drop straight after the intro brings its last top loop in halfway.)
      const lean = (s: Generation['sections'][number]) => s === g.sections[1] && g.rules.firstDrop === 'lean'
      const counts = new Set(drops.filter((s) => !s.peak && !lean(s)).map(tops))
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
      // (A build-up of claps into the first drop takes the claps' place over the intro's last bars,
      // or brings them in where the intro had none: the outro has no build-up to mirror.)
      if (g.rules.buildup === 'claps' && g.sections[1].kind === 'drop') continue
      const lanesIn = (s: Generation['sections'][number]) => g.project.lanes
        .filter((l) => ['Tops', 'Tops 2', 'Clap', 'Perc'].includes(l.name)
          && g.project.clips.some((c) => c.laneId === l.id && c.start < (s.start + s.bars) * 4 && c.start + c.length > s.start * 4))
        .map((l) => l.name)
      const sorted = (xs: string[]) => [...new Set(xs)].sort()
      expect(sorted(lanesIn(outro))).toEqual(sorted(lanesIn(intro)))
    }
  })

  it('fills the intro up over its last bars with what the drops have, and thins the outro out the same way', () => {
    const plays = (g: Generation, name: string, from: number, to: number) =>
      clipsOn(g, name).some((c) => c.start < to * 4 && c.start + c.length > from * 4)
    let n = 0
    for (const g of gens.filter((x) => x.rules.ioLift && !x.rules.ioClaps && x.rules.buildup !== 'claps' && laneOf(x, 'Clap'))) {
      const intro = g.sections[0]
      const outro = g.sections.at(-1)!
      const iz = intro.start + intro.bars
      const oz = outro.start + outro.bars
      // The claps join last, within the bars the intro fills up over, and leave first in the outro.
      expect(plays(g, 'Clap', intro.start, iz - liftBars(intro.bars))).toBe(false)
      expect(plays(g, 'Clap', iz - 4, iz - 1)).toBe(true)
      expect(plays(g, 'Clap', outro.start, outro.start + 4)).toBe(true)
      expect(plays(g, 'Clap', outro.start + liftBars(outro.bars), oz)).toBe(false)
      // Hats (when the track's rule has none there) come in first: no later than the claps.
      if (g.rules.introHats === 'none') {
        const first = (name: string) => Math.min(...clipsOn(g, name).filter((c) => c.start < iz * 4).map((c) => c.start))
        expect(first('Hats')).toBeLessThanOrEqual(first('Clap'))
      }
      // Without the lift, the intro keeps its claps out.
      const off = setTrackRule(LIB, OPTS, g, 'ioLift', false, ['hats', 'perc', 'top2', 'clap'])
      expect(plays(off, 'Clap', intro.start, iz)).toBe(false)
      n++
    }
    expect(n).toBeGreaterThan(10)
    // Most tracks lift, some don't.
    const lifted = gens.filter((g) => g.rules.ioLift).length
    expect(lifted).toBeGreaterThan(gens.length * 0.6)
    expect(lifted).toBeLessThan(gens.length)
  })

  it('starts a first drop straight after the intro leaner, with its layers in by halfway', () => {
    const plays = (g: Generation, name: string, from: number, to: number) =>
      clipsOn(g, name).some((c) => c.start < to * 4 && c.start + c.length > from * 4)
    let n = 0
    for (const g of gens.filter((x) => x.sections[1].kind === 'drop' && x.rules.firstDrop === 'lean' && x.sections[1].bars >= 16)) {
      const d = g.sections[1]
      const half = d.start + halfwayBars(d.bars)
      // Its first phrase without the clap layers and the second hats; groove and second perc halfway.
      for (const name of ['Clap 2', 'Clap 3', 'Hats 2']) expect(plays(g, name, d.start, d.start + 8)).toBe(false)
      for (const name of ['Groove', 'Perc 2']) expect(plays(g, name, d.start, half)).toBe(false)
      if (laneOf(g, 'Clap 2')) expect(plays(g, 'Clap 2', d.start + 8, d.start + 9)).toBe(true)
      // Full from the start, it has them from its first bar.
      const full = setTrackRule(LIB, OPTS, g, 'firstDrop', 'full', ['clap2', 'clap3', 'hats2', 'perc2', 'top2', 'top3', 'groove'])
      if (laneOf(full, 'Clap 2')) expect(plays(full, 'Clap 2', d.start, d.start + 1)).toBe(true)
      n++
    }
    expect(n).toBeGreaterThan(5)
    // The later drops stay full: the lean one is only the first, straight after the intro.
    for (const g of gens.filter((x) => x.rules.firstDrop === 'lean' && laneOf(x, 'Clap 2'))) {
      for (const s of g.sections.filter((x) => x.kind === 'drop' && x !== g.sections[1])) {
        expect(plays(g, 'Clap 2', s.start, s.start + 1)).toBe(true)
      }
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

  /** The same seeds made the way tracks were before the track-wide way into drops (each riser's own gap). */
  const legacy = Array.from({ length: 150 }, (_, i) => generate(LIB, LEGACY, 1000 + i))
  /** What leads into the line at `beat`: events on the fill and FX lanes whose body ends there. */
  const leadsInto = (g: Generation, beat: number) => g.project.clips.filter((c) => {
    const s = byPath.get(c.sample.relPath)
    const lane = g.project.lanes.find((l) => l.id === c.laneId)?.name ?? ''
    return s?.kind === 'event' && ['Fills', 'FX', 'FX 2'].includes(lane) && c.start + bodyBars(s) * 4 === beat
  }).map((c) => byPath.get(c.sample.relPath)!)

  it('stops everything leading into a drop at one moment: the riser\'s, the fill\'s and the second layer\'s', () => {
    let early = 0, checked = 0
    for (const g of legacy) {
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
    for (const g of legacy) {
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
    for (const g of legacy) {
      for (const d of g.sections.filter((s) => s.kind === 'drop' && s.start > 0)) {
        const fx = leadsInto(g, d.start * 4).filter((s) => s.category !== 'fill' && s.category !== 'roll')
        if (fx.length < 2) continue
        expect(fx[0].id).not.toBe(fx[1].id)
        // Another length, another texture or the same track's: not two of a kind from two tracks.
        expect(bodyBars(fx[0]) !== bodyBars(fx[1]) || fx[0].shape!.noise !== fx[1].shape!.noise || fx[0].zip_id === fx[1].zip_id).toBe(true)
        layered++
      }
    }
    // (Fewer since the short breakdowns are mostly 8 bars: a 2-bar riser into the drop after one is often left alone.)
    expect(layered).toBeGreaterThan(20)
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
    expect([...kicks].sort()).toEqual(['filtered', 'kept', 'out', 'sweep', 'thin'])  // four to the floor or out: no half-time kick, none on the 1 only
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
  // A line with notes next to each other in a beat (somewhere to slide).
  const RICH: MidiItem = { ...midi(4, 'Am', 1), notes: [[0, 0.5, 45, 100], [0.75, 0.25, 57, 100], [1.5, 0.25, 55, 100], [1.75, 0.25, 52, 100], [2.5, 0.5, 45, 100], [3.5, 0.25, 57, 100], [3.75, 0.25, 55, 100]] }

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
        // Outside drops only high-passed (the sub out), as real tracks do; a track led by its bassline
        // has it in the clear from the second part of its breakdowns.
        const inDrop = g.sections.some((s) => s.kind === 'drop' && c.start >= s.start * 4 && c.start < (s.start + s.bars) * 4)
        const exposed = g.rules.lead === 'bass' && g.sections.some((s) => s.kind === 'break' && c.start === breakShape(s.start, s.bars).lead * 4)
        if (!inDrop && !exposed) expect(c.filter?.type).toBe('highpass')
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

  it('writes basslines of the length asked for: a loop of 2, 4 or 8 beats', () => {
    for (const beats of [2, 4, 8] as const) {
      for (let seed = 0; seed < 5; seed++) {
        const m = generate(LIB, { ...OPTS, bass: { ...BASS, beats } }, 7200 + seed).bass!.midi
        expect([m.bars, m.name.endsWith(`(${beats} beats)`)]).toEqual([beats === 8 ? 2 : 1, true])
      }
    }
    expect(generate(LIB, { ...OPTS, bass: { ...BASS, midis: [] } }, 7).bass).toBeNull()        // nothing to learn from
  })

  it('writes the same drums whatever the bassline (the line has an RNG of its own)', () => {
    const drums = (g: ReturnType<typeof generate>) => JSON.stringify(g.project.clips.filter((c) => c.type === 'pattern').map((c) => [c.start, c.sample.relPath]))
    for (let seed = 0; seed < 5; seed++) {
      expect(drums(generate(LIB, { ...OPTS, bass: { ...BASS, beats: 2 } }, 7300 + seed))).toBe(drums(generate(LIB, { ...OPTS, bass: { ...BASS, beats: 8 } }, 7300 + seed)))
    }
  })

  it('slides a note only on a patch that glides', () => {
    const overlaps = (glide: boolean) => Array.from({ length: 30 }, (_, seed) => {
      const presets = BASS.presets.map((p) => ({ ...p, glide }))
      const n = generate(LIB, { ...OPTS, bass: { ...BASS, midis: [midi(1, 'Am'), RICH], presets } }, 7400 + seed).bass!.midi.notes
      return n.slice(0, -1).filter(([s, l], i) => s + l > n[i + 1][0] + 1e-9).length
    }).reduce((a, b) => a + b, 0)
    expect(overlaps(false)).toBe(0)
    expect(overlaps(true)).toBeGreaterThan(0)
  })

  it('turns the bassline at phrase ends in drops: the last loop of the phrase plays its turn, the loop all through otherwise', () => {
    for (const [every, kind] of [['8', 'pickup'], ['16', 'gap'], ['drop', 'octave']] as const) {
      for (let seed = 0; seed < 8; seed++) {
        const g = generate(LIB, { ...OPTS, bass: BASS, locks: { bassTurn: every, bassTurnKind: kind } }, 7500 + seed)
        const b = g.bass!
        const L = (b.midi.bars) * 4
        const lane = g.project.lanes.find((l) => l.name === 'Bass')!
        const clips = g.project.clips.filter((c): c is AudioClip => c.laneId === lane.id && c.type === 'audio')
        const turns = clips.filter((c) => c.bass?.turn)
        for (const d of g.sections.filter((s) => s.kind === 'drop')) {
          const ends = [...Array.from({ length: Math.floor((d.bars - 1) / (every === '8' ? 8 : every === '16' ? 16 : 1e9)) }, (_, i) => d.start + (i + 1) * (every === '8' ? 8 : 16)), d.start + d.bars]
          for (const end of ends) {
            const t = turns.find((c) => c.start === end * 4 - L)
            expect(t, `seed ${seed}: a turn before bar ${end}`).toBeDefined()
            expect(t!.bass).toMatchObject({ turn: kind, notes: b.midi.notes, midiId: b.midi.id })
            expect(t!.sample.relPath).toBe(bassPath(t!.bass!, g.project.bpm))
            expect(t!.sample.relPath).toContain(`-t${kind}`)
          }
        }
        // Only in drops.
        for (const t of turns) expect(g.sections.some((s) => s.kind === 'drop' && t.start >= s.start * 4 && t.start < (s.start + s.bars) * 4)).toBe(true)
      }
    }
    const none = generate(LIB, { ...OPTS, bass: BASS, locks: { bassTurn: 'none' } }, 7500)
    expect(none.project.clips.some((c) => c.type === 'audio' && c.bass?.turn)).toBe(false)
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
      // (Fills too: a short fill is never played as recorded.)
      expect(['top', 'perc', 'hat', 'groove', 'fill']).toContain(c.sample.category)
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
        // (A breakdown with the groove carried through has its own shape: its parts closing, held,
        // opening, the layer coming in. A held stretch of it is meant to hold.)
        if (s.kind === 'break' && g.rules.glue) continue
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
      if (g.rules.ioClaps === false && !g.rules.ioLift) expect(covers(g, 'Clap', (g.sections[0].start + g.sections[0].bars - 1) * 4)).toBe(false)
    }
    // Same seed, same track.
    expect(strip(generate(LIB, { ...OPTS, templates: [REAL] }, 9001))).toBe(strip(generate(LIB, { ...OPTS, templates: [REAL] }, 9001)))
  })

  it("ignores arrangements that don't read as a dance track", () => {
    expect(templateFrom(track('S0001', { kick: [[0, 64]], hats: [[2, 64]] }), new Rng(1), 64, 200)).toBeNull()
    expect(templateFrom(track('S0002', { kick: [[2, 24]] }), new Rng(1), 64, 200)).toBeNull()
  })
})

describe('generator: structures and arcs from reference tracks', () => {
  type Kind = 'intro' | 'build' | 'drop' | 'break' | 'outro'
  /** A finished mix as the engine profiles it: `lead` silent bars, then the sections bar by bar. */
  function reference(name: string, runs: [Kind, number][], lead = 0, arc = { lift: 3, depth: 9 }, current = true): ReferenceTrack {
    const kick: boolean[] = []
    const full: boolean[] = []
    const lufs: (number | null)[] = []
    for (let b = 0; b < lead; b++) { kick.push(false); full.push(false); lufs.push(null) }
    for (const [kind, bars] of runs) {
      for (let b = 0; b < bars; b++) {
        kick.push(kind !== 'break')
        full.push(kind === 'drop')
        lufs.push(kind === 'drop' ? -8 : kind === 'break' ? -17 : kind === 'build' ? -14 + (4 * b) / bars : -12)
      }
    }
    const drops: MixProfile['drops'] = []
    for (let b = 0; b < full.length; b++) {
      if (full[b] && !full[b - 1]) drops.push({ bar: b, bars: full.slice(b).findIndex((x) => !x), lufs: -8, lift_lu: arc.lift, lift_low_db: 12 })
    }
    const profile = {
      seconds: (full.length * 240) / 124, bpm: 124, bars: full.length, sections_known: false, lufs: -8, peak_db: -0.3, true_peak_db: -0.1,
      plr_db: 8, bar_lufs: lufs, full_bars: full.filter(Boolean).length, full_lufs: -8, regions: null, width_db: -10, low_side_db: -30,
      drops, lift_lu: arc.lift, lift_low_db: 12, break_depth_lu: arc.depth, dc_db: -90, head_ms: 0, tail_db: -60, intro: null, outro: null,
      ...(current ? { bar_kick: kick, bar_full: full, bar_low_db: lufs.map((v) => (v == null ? null : v - 6)) } : {}),
    } as MixProfile
    return { rel_path: `${name}.wav`, name, bpm: 124, key_label: 'Am', grid_confidence: 0.9, error: null, analyzed_at: '', profile }
  }
  const RUNS: [Kind, number][] = [['intro', 32], ['build', 16], ['drop', 32], ['break', 16], ['build', 8], ['drop', 32], ['outro', 32]]
  const REF = reference('Ref A', RUNS, 2)

  it("reads a reference's sections from its kick and drops, on the grid of its first drop", () => {
    expect(readReference(REF.profile!)!.map((s) => [s.kind, s.from, s.to - s.from])).toEqual([
      ['intro', 2, 32], ['build', 34, 16], ['drop', 50, 32], ['break', 82, 16], ['build', 98, 8], ['drop', 106, 32], ['outro', 138, 32],
    ])
    // Measured before the profile kept the bars' kicks: nothing to read.
    expect(readReference(reference('Old', RUNS, 0, undefined, false).profile!)).toBeNull()
  })

  it('takes its structure, its breakdown kick and its arc, without rides of its own', () => {
    const rng = new Rng(3)
    for (let i = 0; i < 30; i++) {
      const t = templateFromReference(REF, rng, 64 * 1.5, 200)!
      expect(t.label).toBe('the reference “Ref A”')
      expect(t.sections.map((x) => x.kind)).toEqual(['intro', 'build', 'drop', 'break', 'build', 'drop', 'outro'])
      expect(t.sections.every((x) => !x.src)).toBe(true)
      expect(t.sections.filter((x) => x.kind === 'drop').at(-1)!.peak).toBe(true)
      expect(t.arc).toEqual({ liftLu: 3, breakDepthLu: 9 })
    }
    const ts = Array.from({ length: 40 }, () => templateFromReference(REF, rng, 64 * 1.5, 200)!)
    // No kick in its breakdown, and none in the bar before its drops: kept mostly (12 % drawn again, some changed).
    expect(ts.filter((t) => t.sections.find((x) => x.kind === 'break')!.kick === 'out').length).toBeGreaterThan(ts.length * 0.5)
    expect(ts.filter((t) => t.rules.dropKickOut === false).length).toBeGreaterThan(ts.length * 0.75)
  })

  it('shares structures evenly with the zips, and scores against the arc it follows', () => {
    const REAL: TrackArrangement = {
      zip_id: 1, source_code: 'S0042', bpm: 124, bars: 144, parts: {
        kick: '2'.repeat(32) + '2'.repeat(32) + '0'.repeat(16) + '2'.repeat(64),
        bass: '0'.repeat(32) + '2'.repeat(32) + '0'.repeat(16) + '2'.repeat(32) + '0'.repeat(32),
        hats: '2'.repeat(144),
      },
    }
    const opts = { ...OPTS, templates: [REAL], references: [REF] }
    const tg = Array.from({ length: 80 }, (_, i) => generate(LIB, opts, 7000 + i))
    const fromRef = tg.filter((g) => g.template === 'Ref A')
    const fromZip = tg.filter((g) => g.template === 'S0042')
    expect(fromRef.length).toBeGreaterThan(tg.length * 0.25)
    expect(fromZip.length).toBeGreaterThan(tg.length * 0.25)
    for (const g of fromRef) {
      expect(g.choices[0]).toMatch(/^structure after the reference “Ref A” \(/)
      expect(g.arc).toEqual({ liftLu: 3, breakDepthLu: 9, from: 'the reference “Ref A”' })
    }
    // A track not on the reference aims at the references' arc all the same (candidates are scored alike).
    for (const g of fromZip) expect(g.arc).toEqual({ liftLu: 3, breakDepthLu: 9, from: 'the reference “Ref A”' })
    // Same seed, same track.
    expect(strip(generate(LIB, opts, 7001))).toBe(strip(generate(LIB, opts, 7001)))
    // Without references, nothing changes: no arc, and the same tracks as before.
    const plain = generate(LIB, { ...OPTS, templates: [REAL] }, 7003)
    expect(plain.arc).toBeNull()
    expect(strip(plain)).toBe(strip(generate(LIB, { ...OPTS, templates: [REAL], references: [] }, 7003)))

  })

  it('scores candidates on the arc, from the plan', () => {
    // Measured samples: the plan's loudness can be worked out.
    const loud = LIB.map((x, i) => ({ ...x, energy_db: (x.category.startsWith('hat') ? -12 : -16) + (i % 7) - 3 }))
    const make = (seed: number) => generate(loud, { ...OPTS, references: [REF], templates: [] }, seed)
    const g = Array.from({ length: 20 }, (_, i) => make(7200 + i)).find((x) => x.arc && x.sections.filter((y) => y.kind === 'drop').length > 1)!
    const sc = scoreGeneration(loud, g)
    expect(sc.arc).toBeGreaterThan(0)
    expect(sc.arc).toBeLessThanOrEqual(1)
    expect(sc.breakDepth).toBeGreaterThan(0)
    // The same plan against an arc far from it scores lower.
    const far = scoreGeneration(loud, { ...g, arc: { liftLu: 30, breakDepthLu: 40, from: 'x' } })
    expect(far.total).toBeLessThan(sc.total)
    const best = bestOf(loud, 7100, 4, make)
    if (best.arc) expect(best.choices.join('\n')).toMatch(/arc \d\.\d\d against /)
  })

  it("aims at the references' median arc otherwise", () => {
    const three = [reference('A', RUNS, 0, { lift: 2, depth: 6 }), reference('B', RUNS, 0, { lift: 3, depth: 8 }), reference('C', RUNS, 0, { lift: 5, depth: 12 })]
    expect(arcOf(three, null)).toEqual({ liftLu: 3, breakDepthLu: 8, from: '3 reference tracks' })
    expect(arcOf(three.slice(0, 2), null)).toEqual({ liftLu: 2.5, breakDepthLu: 7, from: '2 reference tracks' })
    expect(arcOf([], null)).toBeNull()
    // Nearer the arc scores higher; nothing to compare, nothing scored.
    const arc = { liftLu: 3, breakDepthLu: 8, from: 'x' }
    expect(arcFit(arc, [{ lu: 3 }], 8)).toBeCloseTo(1)
    expect(arcFit(arc, [{ lu: 3.5 }], 9)!).toBeGreaterThan(arcFit(arc, [{ lu: 6 }], 14)!)
    expect(arcFit(arc, [], null)).toBeNull()
    expect(arcFit(null, [{ lu: 3 }], 8)).toBeNull()
  })
})

describe('generator: reverb builds', () => {
  const verb = { tops: true, every: null, amount: 0.6 }
  // (The big build's reverb is its own: tested with it.)
  const OPTS_: GenerateOptions = { ...OPTS, locks: { bigBuild: 'usual' } }
  const into = (g: Generation, bar: number) => g.project.clips.filter((c) => c.verb && c.start + c.length <= bar * 4 && c.start >= (bar - 2) * 4)

  it('washes the top loops out into every drop and break, rising to the amount where they stop', () => {
    for (let i = 0; i < 20; i++) {
      const g = generate(LIB, { ...OPTS_, verb }, 2000 + i)
      const plain = generate(LIB, OPTS_, 2000 + i)
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
    const g = generate(LIB, { ...OPTS_, verb: { ...verb, every: 16 } }, 2100)
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
    expect(generate(LIB, { ...OPTS_, verb: { ...verb, tops: false } }, 2100).project.clips.some((c) => c.verb)).toBe(false)
    expect(generate(LIB, OPTS_, 2100).project.clips.some((c) => c.verb)).toBe(false)
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
  const bassMidi: MidiItem = { id: 766, file_name: 'Bass.mid', name: 'Bass', rel_path: 'MIDI/Bass/Bass.mid', role: 'bass', bars: 1,
    key_label: 'Am', key_camelot: null, notes: [[0.5, 0.25, 41, 100], [1.5, 0.25, 41, 100]], favorite: 0, source: null, source_code: null }
  const presets = [{ path: '/p.SerumPreset', name: 'P', folder: 'X', tags: [] }]
  const hits: HitItem[] = [{ id: 1, kind: 'disco', file_name: 'Stab Cm.wav', name: 'Stab Cm', rel_path: 'Disco Hits/stab.wav', key_label: 'Cm', key_camelot: null,
    key_source: 'name', pitch_fix: 0, duration_s: 1, channels: 2 }]
  const opts: GenerateOptions = { ...OPTS, bass: { midis: [bassMidi], presets, favorites: [], sidechain: 0.5, octaves: { '/p.SerumPreset': -12 } }, disco: { hits } }
  const TONAL = ['fx_riser', 'fx_downlifter', 'fx_atmos', 'fx']

  it('moves the bass and disco hits, swaps FX out of key, and leaves the drums', () => {
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
      const fits = new Set(expandCompatible([to]))
      g.project.clips.forEach((c, k) => {
        const n = r.project.clips[k]
        const s = byPath.get(c.sample.relPath)
        if (c.type === 'audio' && c.bass) {
          expect((n as AudioClip).bass!.transpose).toBe(r.bass!.transpose)
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
  // the tops low-passed and opening over the first 16 bars of each drop and quieter in the
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
      top: { db: series((b) => (opening(b) != null ? -6 + opening(b)! * 0.4 : b >= 64 && b < 80 ? -10 : 0)),
        bright: series((b) => (into(b) ? 0.6 : opening(b) != null ? -2.2 + opening(b)! * 0.14 : 0)) },
    },
  }
  const opts: GenerateOptions = { ...OPTS, minMinutes: 4, maxMinutes: 5, templates: [REAL] }
  const gs = Array.from({ length: 30 }, (_, i) => generate(LIB, opts, 5000 + i))
  const lane = (g: Generation, name: string) => g.project.lanes.find((l) => l.name === name)?.id
  const at = (g: Generation, name: string, bar: number) => g.project.clips.filter((c) => c.laneId === lane(g, name) && c.start <= bar * 4 && c.start + c.length > bar * 4)

  it('rides the tops up over the drops the way the reference track does, with the fader only: no low-pass while a drop plays', () => {
    const built = gs.filter((g) => g.template === 'S0042')
    expect(built.length).toBeGreaterThan(10)
    let ridden = 0
    for (const g of built) {
      const d = g.sections.find((s) => s.kind === 'drop')!
      const early = at(g, 'Tops', d.start + 1)[0]
      if (!early) continue
      expect(early.filter?.type).not.toBe('lowpass')
      if (early.gainDb < 0) {
        ridden++
        expect(early.gainTo ?? 0).toBeGreaterThan(early.gainDb)      // coming up
      }
      expect(g.choices.some((c) => c.startsWith('filter and volume rides on') && c.includes('S0042'))).toBe(true)
    }
    expect(ridden).toBeGreaterThan(5)
  })

  it('never low-passes the top loops or the groove while a drop plays (builds and breakdowns may)', () => {
    let filteredElsewhere = 0
    for (const g of gs) {
      for (const c of g.project.clips) {
        const name = g.project.lanes.find((l) => l.id === c.laneId)?.name ?? ''
        if (!/^(Tops|Groove)/.test(name) || c.filter?.type !== 'lowpass') continue
        const inDrop = g.sections.some((s) => s.kind === 'drop' && c.start >= s.start * 4 && c.start < (s.start + s.bars) * 4)
        expect(inDrop, `${name} low-passed at beat ${c.start}`).toBe(false)
        filteredElsewhere++
      }
    }
    expect(filteredElsewhere).toBeGreaterThan(0)
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
    const ridden = (g: Generation) => g.sections.some((d) => d.kind === 'drop' && (at(g, 'Tops', d.start + 1)[0]?.gainDb ?? 0) < 0)
    expect(own.some(ridden)).toBe(true)
    expect(own.some((g) => g.choices.some((c) => c.includes('after S0042')))).toBe(true)
  })

  it('rides the same way when another lane is made again', () => {
    const g = gs.find((x) => x.template === 'S0042' && lane(x, 'Tops'))!
    const r = rerollLane(LIB, opts, g, lane(g, 'Hats')!, 3)!
    const topsOf = (x: Generation) => x.project.clips.filter((c) => c.laneId === lane(x, 'Tops')).map(({ id: _i, ...c }) => c)
    expect(topsOf(r)).toEqual(topsOf(g))
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
        // In the breakdown's hold: after what stays has closed (4 bars), before it opens again.
        const at = (s.start + Math.min(4, Math.max(1, Math.floor(s.bars / 4)))) * 4 + 1
        const top = clipsOn(g, 'Tops').find((c) => c.start <= at && c.start + c.length > at)
        // Out by the rule: the top loop only fades out past the line (or back in before the next part).
        if (g.rules.topsBreaks === 'none') expect(top?.gainTo == null).toBe(!top)
        else {
          kept++
          expect(top).toBeDefined()
          if (g.rules.topsBreaks === 'filtered') expect(top!.filter).toMatchObject({ type: 'lowpass' })
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
        if (c.filter && !g.sections.some((s) => s.kind === 'drop' && c.start >= (s.start - hpBefore(g, s)) * 4 && c.start < (s.start + s.bars) * 4)) {
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
  const opts: GenerateOptions = { ...OPTS, stabs: { hits: STABS } }
  const gs = Array.from({ length: 60 }, (_, i) => generate(LIB, opts, 6100 + i))
  // Tracks of stabs taking turns, as before one loop of them (rule `stabLoop`; its own tests in stabs.test.ts).
  const turns = Array.from({ length: 60 }, (_, i) => generate(LIB, { ...opts, locks: { stabLoop: false } }, 6100 + i))
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

  it('plays chord stabs in every track while there are some, none without', () => {
    for (const g of gs) {
      expect(g.rules.stabs).toBe(true)
      expect(stabLanes(g).length).toBeGreaterThan(0)
    }
    for (const o of [OPTS, { ...OPTS, stabs: { hits: [] } }]) {
      const none = Array.from({ length: 10 }, (_, i) => generate(LIB, o, 6300 + i))
      expect(none.some((g) => g.rules.stabs || stabLanes(g).length)).toBe(false)
    }
  })

  it('plays one to three different stabs per track, mostly 2 hits a bar, sometimes 1 or 3', () => {
    const perBar = [0, 0, 0, 0, 0]
    const counts = [0, 0, 0, 0]
    for (const g of gs.filter((x) => x.rules.stabs)) {
      const names = stabLanes(g).map((l) => l.name)
      expect(names).toEqual(['Stab', 'Stab 2', 'Stab 3'].slice(0, names.length))
      counts[names.length]++
      // One sample a lane, a different one on each.
      const perLane = stabLanes(g).map((l) => new Set(stabClips(g).filter((c) => c.laneId === l.id).map((c) => c.sample.relPath)))
      for (const s of perLane) expect(s.size).toBe(1)
      expect(new Set(perLane.map((s) => [...s][0])).size).toBe(names.length)
      for (const bar of g.rules.stabRhythm as number[][]) perBar[bar.filter(Boolean).length]++
    }
    // Mostly one or two, sometimes three.
    expect(counts[1]).toBeGreaterThan(counts[3])
    expect(counts[2]).toBeGreaterThan(counts[3])
    expect(counts[3]).toBeGreaterThan(0)
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
      const drops = g.sections.filter((s) => s.kind === 'drop')
      for (const d of drops) {
        // (A first drop may start on the lean rhythm; the last bar of a phrase may turn.)
        if (g.rules.stabsGrow && d === drops[0]) continue
        for (let b = d.start; b < d.start + Math.min(7, d.bars); b++) {
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
      // Merged into longer clips, not a clip a bar (where no filter moves from bar to bar; a phrase's last bar is its own).
      for (const l of stabLanes(g)) expect(stabClips(g).filter((c) => c.laneId === l.id && !c.filter).length).toBeLessThan(g.project.lengthBars / 2)
    }
    // Often no more than 2 stabs per bar.
    expect(perBar / bars).toBeLessThanOrEqual(2.2)
    expect(perBar / bars).toBeGreaterThanOrEqual(1)
  })

  it('never plays two stabs on the same step: they take turns in the rhythm', () => {
    let turnsByBar = 0
    for (const g of turns.filter((x) => stabLanes(x).length > 1)) {
      const rhythm = g.rules.stabRhythm as number[][]
      const drops = g.sections.filter((s) => s.kind === 'drop')
      const d = drops[drops.length - 1]
      // (A track's only drop may start on the lean rhythm: its first stabs of each bar alone.)
      const lean = !!g.rules.stabsGrow && drops.length === 1
      for (let b = d.start; b < d.start + 4; b++) {
        const hits = new Array(16).fill(0)
        for (const l of stabLanes(g)) {
          for (const c of stabClips(g).filter((x) => x.laneId === l.id && x.start <= b * 4 && x.start + x.length > b * 4)) {
            const from = ((b * 4 - c.start) * 4) % c.steps.length
            c.steps.slice(from, from + 16).forEach((v, i) => (hits[i] += v ? 1 : 0))
          }
        }
        expect(Math.max(...hits)).toBeLessThanOrEqual(1)                                   // never together
        if (!lean) expect(hits.map(Boolean)).toEqual(rhythm[(b - d.start) % rhythm.length].map(Boolean))  // the whole rhythm
      }
      if (g.choices.some((c) => c.includes('taking turns bar by bar'))) turnsByBar++
    }
    expect(turnsByBar).toBeGreaterThan(0)
  })

  it('splits a rhythm into turns: a bar each, or hit by hit, as many as there are hits', () => {
    const on = (...h: number[]) => Array.from({ length: 16 }, (_, i) => (h.includes(i) ? 3 : 0)) as Velocity[]
    const r = [on(2, 10), on(6)]
    const hitsOf = (p: Velocity[][]) => p.map((b) => b.flatMap((v, i) => (v ? [i] : [])))
    expect(stabParts(r, 1, 'bars')).toEqual([r])
    expect(stabParts(r, 2, 'bars').map(hitsOf)).toEqual([[[2, 10], []], [[], [6]]])
    expect(stabParts(r, 2, 'hits').map(hitsOf)).toEqual([[[2], [6]], [[10], []]])
    expect(stabParts(r, 3, 'hits').map(hitsOf)).toEqual([[[2], []], [[10], []], [[], [6]]])
    // A 1-bar rhythm takes turns over two bars; never more stabs than hits.
    expect(stabParts([on(4)], 3, 'hits').map(hitsOf)).toEqual([[[4], []], [[], [4]]])
    // Three stabs always go hit by hit.
    expect(stabParts(r, 3, 'bars').length).toBe(3)
  })

  it('plays in the drops; through breakdowns low-passed, or fading out past the line; teased at the end of a long intro', () => {
    const seen = new Set<string>()
    for (const g of turns.filter((x) => x.rules.stabs)) {
      g.sections.forEach((s, i) => {
        if (s.kind === 'drop') return
        const next = g.sections[i + 1]
        const inside = stabClips(g).filter((c) => c.start >= s.start * 4 && c.start < (s.start + s.bars) * 4)
        const keys = g.rules.stabsIn === 'keys'
        if (s.kind === 'outro') expect(inside).toEqual([])
        else if (s.kind === 'intro') {
          // A dark tease over its last 8 bars, only in an intro long enough to keep 16 bars clean.
          const tease = g.rules.stabsTease && s.bars >= 24 && (next?.kind === 'drop' || next?.kind === 'build')
          if (!tease) expect(inside).toEqual([])
          else {
            seen.add('tease')
            expect(inside.length).toBeGreaterThan(0)
            for (const c of inside) {
              expect(c.start).toBeGreaterThanOrEqual((s.start + s.bars - 8) * 4)
              expect(c.filter?.type).toBe('lowpass')
              expect(c.gainDb).toBeLessThan(0)
            }
          }
        } else if (s.kind === 'build') {
          if (!keys) expect(inside).toEqual([])
        } else if (g.rules.lead === 'stab') {
          // The track's lead: in the clear from the breakdown's second part on, after leaving the line.
          seen.add('break:lead')
          const from = breakShape(s.start, s.bars).lead
          // (Only the mix high-pass into the drop, when the track has one, on its last bars.)
          for (const c of inside) if (c.start >= from * 4) expect(c.filter?.type).not.toBe('lowpass')
          expect(inside.some((c) => c.start >= from * 4)).toBe(true)
        } else if (keys && g.rules.stabsBreaks === 'filtered') {
          seen.add('break:through')
          expect(inside.length).toBeGreaterThan(0)
          for (const c of inside) expect(c.filter?.type).toBe('lowpass')
          expect(together(g, s.start + 2).map(Boolean)).toEqual((g.rules.stabRhythm as number[][])[0].map(Boolean))
        } else {
          // Out of the breakdown: at most two bars past the line, darker and softer.
          seen.add('break:leave')
          for (const c of inside) {
            expect(c.start + c.length).toBeLessThanOrEqual((s.start + 2) * 4)
            expect(c.filter?.type).toBe('lowpass')
            expect(c.gainDb).toBeLessThan(0)
          }
        }
      })
    }
    expect(seen).toEqual(new Set(['tease', 'break:through', 'break:leave', 'break:lead']))
    expect(gs.some((g) => g.rules.stabs && g.rules.stabsIn === 'drops')).toBe(true)
  })

  it('keeps the drums and the bass the same with or without stabs', () => {
    const sig = (g: Generation) => g.project.clips.filter((c) => !/^Stab/.test(g.project.lanes.find((l) => l.id === c.laneId)!.name))
      .map(({ id: _i, laneId: _l, ...c }) => c)
    // (Not a track led by its stabs: it keeps a top loop less, to give them room.)
    let n = 0
    for (let i = 0; i < 30; i++) {
      const g = generate(LIB, opts, 6200 + i)
      if (g.rules.lead === 'stab') continue
      expect(sig(g)).toEqual(sig(generate(LIB, OPTS, 6200 + i)))
      n++
    }
    expect(n).toBeGreaterThan(8)
  })

  it('makes new stabs for a track, or stabs in one without, the rest as it is', () => {
    const rest = (g: Generation) => g.project.clips.filter((c) => !/^Stab/.test(g.project.lanes.find((l) => l.id === c.laneId)!.name))
      .map(({ id: _i, laneId: _l, ...c }) => c)
    const without = generate(LIB, OPTS, 6100)
    const r = rerollStabs(LIB, opts, without, 11)!
    expect(stabLanes(r).length).toBeGreaterThan(0)
    expect(rest(r)).toEqual(rest(without))
    const withStabs = gs[0]
    const again = rerollStabs(LIB, opts, withStabs, 12)!
    expect(JSON.stringify(stabClips(again).map(({ id: _i, laneId: _l, ...c }) => c)))
      .not.toBe(JSON.stringify(stabClips(withStabs).map(({ id: _i, laneId: _l, ...c }) => c)))
    expect(rest(again)).toEqual(rest(withStabs))
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
    })
  })

  it('moves the stabs into another key with the rest of the track', () => {
    const g = gs.find((x) => x.rules.stabs && x.key && x.key !== 'Dm')!
    const moved = changeKey(LIB, opts, g, 'Dm', 1)
    for (const c of stabClips(moved)) expect(c.pitch ?? 0).toBe(hitPitch(STABS.find((x) => x.rel_path === c.sample.relPath)!, 'Dm'))
  })
})

describe('generator: changing a made track (choices, a new sound)', () => {
  const ALL = LANES.map((l) => l.role)
  /** A lane's clips without ids, by lane name. */
  const lanesOf = (g: Generation) => Object.fromEntries(g.project.lanes.map((l) => [l.name,
    g.project.clips.filter((c) => c.laneId === l.id).map(({ id: _i, laneId: _l, ...c }) => c)]))

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
      // No top loop stays in a breakdown any more: what plays there is fading out past the line, or back in.
      for (const s of r.sections.filter((x) => x.kind === 'break')) {
        for (const l of r.project.lanes.filter((x) => /^Tops/.test(x.name))) {
          for (const c of r.project.clips.filter((x) => x.laneId === l.id && x.start < (s.start + s.bars) * 4 && x.start + x.length > s.start * 4)) {
            expect(c.gainTo).toBeDefined()
          }
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
      const noLift = setTrackRule(LIB, OPTS, g, 'ioLift', false, ['clap', 'perc'])
      const off = setTrackRule(LIB, OPTS, setTrackRule(LIB, OPTS, noLift, 'ioClaps', false, ['clap']), 'ioPerc', false, ['perc'])
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

  it('keeps the bass part exactly as it plays now when a choice remakes its lane', () => {
    const line: MidiItem = { id: 766, file_name: 'Bass.mid', name: 'Bass', rel_path: 'MIDI/Bass/Bass.mid', role: 'bass', bars: 1,
      key_label: 'Am', key_camelot: null, notes: [[0.5, 0.25, 45, 100], [1.5, 0.25, 45, 100]], favorite: 0, source: null, source_code: null }
    const bass = { midis: [line], presets: [{ path: '/bass.SerumPreset', name: 'Bass', folder: 'Bass', tags: [] }], favorites: [], sidechain: 0.5 }
    const opts: GenerateOptions = { ...OPTS, bass }
    const g = generate(LIB, opts, 7301)
    g.bass = { ...g.bass!, transpose: g.bass!.transpose + 12 }
    for (const c of g.project.clips) if (c.type === 'audio' && c.bass) c.bass = { ...c.bass, transpose: g.bass.transpose }
    const value = g.rules.bassBreaks === 'none' ? 'filtered' : 'none'
    const r = setTrackRule(LIB, opts, g, 'bassBreaks', value, ['bass'])
    const parts = r.project.clips.filter((c): c is AudioClip => c.type === 'audio' && !!c.bass)
    expect(parts.length).toBeGreaterThan(0)
    for (const c of parts) expect(c.bass!.transpose).toBe(g.bass.transpose)
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
})

describe('generator: build-ups into drops', () => {
  const at = (g: Generation, name: string, bar: number) =>
    g.project.clips.find((c): c is PatternClip => c.type === 'pattern' && c.laneId === laneOf(g, name) && c.start <= bar * 4 && c.start + c.length > bar * 4)
  const hits = (c: PatternClip | undefined) => (c ? c.steps.slice(0, 16).filter(Boolean).length : 0)
  /** Locked so nothing else moves the bars before drops: no silence, no FX or fill stopping early, the usual build into every drop. */
  const quiet = (locks: Record<string, unknown>): GenerateOptions => ({ ...OPTS, locks: { dropSilence: 0, dropIn: 'straight', bigBuild: 'usual', dropRiser: false, dropFill: null, dropBreath: null, mixHp: 0, ...locks } })
  const intoDrops = (g: Generation) => g.sections.slice(0, -1).filter((_s, i) => g.sections[i + 1].kind === 'drop')
  const barsOf = (g: Generation, sec: Generation['sections'][number]) =>
    Math.min(g.rules.buildup === 'none' ? 0 : (g.rules.buildupBars as number), Math.floor(sec.bars / (sec.kind === 'intro' ? 4 : 2)))

  it('rolls a snare in 16ths into every drop, opening from low-passed and thinning out at the end, louder as it goes', () => {
    for (let i = 0; i < 12; i++) {
      const g = generate(LIB, quiet({ buildup: 'snareRoll', buildupBars: 8 }), 4100 + i)
      expect(g.picks.buildup?.category).toMatch(/snare|clap/)
      expect(g.project.clips.some((c) => c.sample.category === 'roll')).toBe(false)
      for (const sec of intoDrops(g)) {
        const n = barsOf(g, sec)
        const z = sec.start + sec.bars
        expect(at(g, 'Build-up', z - n - 1)).toBeUndefined()
        const bars = Array.from({ length: n }, (_, j) => at(g, 'Build-up', z - n + j)!)
        for (const c of bars) expect(hits(c)).toBe(16)
        const hp = Math.ceil(n / 4)
        bars.forEach((c, j) => expect(c.filter!.type).toBe(j < n - hp ? 'lowpass' : 'highpass'))
        expect(bars[0].gainDb).toBe(-15)
        expect(bars[n - 1].gainTo).toBe(0)
        for (let j = 1; j < n; j++) expect(bars[j].gainDb).toBeGreaterThanOrEqual(bars[j - 1].gainDb)
        expect(bars[n - 1].steps[15]).toBe(3)
        expect(bars[0].steps[0]).toBe(1)
      }
    }
  })

  it('plays a snare in quarters, then 8ths, then 16ths', () => {
    const g = generate(LIB, quiet({ buildup: 'snareSteps', buildupBars: 8 }), 4200)
    const sec = intoDrops(g).find((s) => barsOf(g, s) === 8)!
    const z = sec.start + sec.bars
    expect(hits(at(g, 'Build-up', z - 8))).toBe(4)
    expect(hits(at(g, 'Build-up', z - 4))).toBe(8)
    expect(hits(at(g, 'Build-up', z - 1))).toBe(16)
  })

  it('rolls the kick low-passed in 8ths with the kick lane out there, and claps every beat with the claps out', () => {
    const k = generate(LIB, quiet({ buildup: 'kickRoll', buildupBars: 4, dropKickOut: false, dropLastKick: false }), 4300)
    for (const sec of intoDrops(k)) {
      const z = sec.start + sec.bars
      for (let b = z - barsOf(k, sec); b < z; b++) {
        const c = at(k, 'Build-up', b)!
        expect(c.sample.relPath).toBe(k.picks.kick!.rel_path)
        expect(hits(c)).toBe(8)
        expect(c.filter?.type).toBe('lowpass')
        expect(at(k, 'Kick', b)).toBeUndefined()
      }
      if (sec.kind !== 'break') expect(at(k, 'Kick', z - barsOf(k, sec) - 1)).toBeDefined()
    }
    const c = generate(LIB, quiet({ buildup: 'claps', buildupBars: 4 }), 4400)
    for (const sec of intoDrops(c)) {
      const z = sec.start + sec.bars
      for (let b = z - barsOf(c, sec); b < z; b++) {
        expect(at(c, 'Build-up', b)!.steps.slice(0, 16).map((v, s) => (v ? s : -1)).filter((s) => s >= 0)).toEqual([0, 4, 8, 12])
        expect(at(c, 'Clap', b)).toBeUndefined()
      }
    }
  })

  it('brings crashes faster into drops (half bars, quarters, 8ths), or on the last four counts', () => {
    const f = generate(LIB, quiet({ buildupCrash: 'faster' }), 4500)
    for (const sec of f.sections.filter((s) => s.kind === 'drop' && s.start > 0)) {
      expect([3, 2, 1].map((k) => hits(at(f, 'Crash', sec.start - k)))).toEqual([2, 4, 8])
      expect(hits(at(f, 'Crash', sec.start))).toBeGreaterThan(0)
    }
    const l = generate(LIB, quiet({ buildupCrash: 'last4' }), 4500)
    for (const sec of l.sections.filter((s) => s.kind === 'drop' && s.start > 0)) expect(hits(at(l, 'Crash', sec.start - 1))).toBe(4)
    expect(l.choices).toContain('crashes on the last four counts into drops')
  })

  it('goes without a roll sample when it has a build-up, and without the build-up when the roll is locked', () => {
    const withRoll = gens.filter((g) => g.rules.dropFill === 'roll')
    expect(withRoll.length).toBeGreaterThan(0)
    for (const g of gens) if (g.rules.buildup !== 'none') expect(g.rules.dropFill).not.toBe('roll')
    const locked = generate(LIB, { ...OPTS, locks: { dropFill: 'roll' } }, gens.find((g) => g.rules.buildup !== 'none')!.seed)
    expect(locked.rules.buildup).toBe('none')
    expect(laneOf(locked, 'Build-up')).toBeUndefined()
  })

  it('makes the Build-up lane again as another build-up, the kick lane following, the rest as it is', () => {
    const g = generate(LIB, { ...OPTS, locks: { buildup: 'kickRoll' } }, 4600)
    const r = rerollLane(LIB, OPTS, g, laneOf(g, 'Build-up')!, 11)!
    expect(r.rules.buildup).not.toBe('kickRoll')
    const sec = intoDrops(r)[0]
    const z = sec.start + sec.bars
    expect(at(r, 'Kick', z - 2)).toBeDefined()
    const same = (x: Generation, name: string) => JSON.stringify(x.project.clips.filter((c) => c.laneId === laneOf(x, name)).map(({ id: _i, laneId: _l, ...c }) => c))
    for (const name of ['Hats', 'Tops', 'Perc', 'Crash', 'FX']) expect(same(r, name)).toBe(same(g, name))
  })

  it('remakes a track from before build-ups without one', () => {
    const g = structuredClone(gens.find((x) => x.rules.buildup !== 'none' && laneOf(x, 'Clap'))!)
    const id = laneOf(g, 'Build-up')!
    g.project.clips = g.project.clips.filter((c) => c.laneId !== id)
    g.project.lanes = g.project.lanes.filter((l) => l.id !== id)
    for (const k of ['buildup', 'buildupBars', 'buildupCrash']) delete g.rules[k]
    const r = setTrackRule(LIB, OPTS, g, 'clapRolls', g.rules.clapRolls === 'none' ? '16' : 'none', [...CHOICES.find((c) => c.rule === 'clapRolls')!.roles, 'kick'])
    expect(laneOf(r, 'Build-up')).toBeUndefined()
    expect(r.rules.buildup).toBeUndefined()
  })
})

describe('generator: the mix balance', () => {
  // The test library with loudness measured: every sample its own level (hats louder than the rest).
  const loud = LIB.map((s, i) => ({ ...s, energy_db: (s.category.startsWith('hat') ? -12 : -16) + (i % 7) - 3 }))
  const byPathLoud = new Map(loud.map((s) => [s.rel_path, s]))
  const opts: GenerateOptions = { ...OPTS, templates: [] }
  const heard = (g: Generation, name: string) => {
    const lane = g.project.lanes.find((l) => l.name === name)!
    return laneLoudness(g.project.clips.filter((c) => c.laneId === lane.id), byPathLoud, g.project.bpm, dropRanges(g.sections))!
      + lane.volumeDb + (lane.levelDb ?? 0)
  }

  it('brings every lane to its place against the kick, whatever its samples\' levels', () => {
    for (let i = 0; i < 10; i++) {
      const g = generate(loud, opts, 8100 + i)
      expect(g.project.lanes.every((l) => l.levelDb != null)).toBe(true)
      expect(heard(g, 'Kick')).toBeCloseTo(KICK_LEVEL_DB, 0)
      if (!laneOf(g, 'Hats 2')) expect(heard(g, 'Hats') - heard(g, 'Kick')).toBeCloseTo(-10, 0)
      expect(g.choices).toContain('mix balanced on house defaults')
    }
    // A library not measured yet: the starting mix as before.
    expect(generate(LIB, opts, 8100).project.lanes.every((l) => l.levelDb === LANES.find((x) => x.name === l.name)!.startDb)).toBe(true)
  })

  it('compresses almost every lane, never the kick or the FX', () => {
    const g = generate(loud, opts, 8100)
    const comp = (name: string) => g.project.lanes.find((l) => l.name === name)?.comp
    expect(comp('Kick')).toBeUndefined()
    for (const l of g.project.lanes) if (/^(FX|Fills|Crash|Hits)/.test(l.name)) expect(l.comp).toBeUndefined()
    expect(comp('Clap')?.ratio).toBe(4)
    expect(comp('Hats')).toBeDefined()
    expect(g.project.lanes.filter((l) => l.comp).length).toBeGreaterThanOrEqual(4)
  })

  it('glues the drums on one bus, the kick with them, nothing else', () => {
    const g = generate(loud, opts, 8100)
    const on = g.project.lanes.filter((l) => l.bus).map((l) => l.name)
    expect(on).toContain('Kick')
    expect(on).toContain('Clap')
    expect(on).toContain('Hats')
    expect(on.some((n) => /^(FX|Bass|Stab|Strings|Fills|Crash)/.test(n))).toBe(false)
    expect(g.project.drumBus?.ratio).toBe(2)
    expect(g.project.drumBus?.thresholdDb).toBeLessThan(0)
  })

  it('levels a lane again when it gets another sound or is made again', () => {
    const g = generate(loud, opts, 8200)
    const hats = laneOf(g, 'Hats')!
    const level = (x: Generation) => x.project.lanes.find((l) => l.name === 'Hats')!.levelDb!
    const swapped = newLaneSound(loud, opts, g, hats, 3)!
    const rolled = rerollLane(loud, opts, g, hats, 5)!
    for (const x of [swapped, rolled]) {
      const before = g.project.clips.find((c) => c.laneId === hats)!.sample.relPath
      const after = x.project.clips.find((c) => c.laneId === laneOf(x, 'Hats'))!.sample.relPath
      if (byPathLoud.get(before)!.energy_db !== byPathLoud.get(after)!.energy_db) expect(level(x)).not.toBe(level(g))
      // (Levels are in half-dB steps.)
      expect(Math.abs(heard(x, 'Hats') - heard(x, 'Kick') - (heard(g, 'Hats') - heard(g, 'Kick')))).toBeLessThanOrEqual(0.51)
    }
  })
})

describe('generator: strings', () => {
  const str = (id: number, key: string | null, name: string): HitItem => ({ id, kind: 'strings', file_name: `${name} ${key ?? ''}.wav`, name,
    rel_path: `Strings/${name.toLowerCase()}.wav`, key_label: key, key_camelot: null, key_source: key ? 'name' : null, pitch_fix: 0, duration_s: 30, channels: 2 })
  // A minor third apart: every key has one within 3 semitones; the keyless one is never used.
  const HITS = [str(41, 'Am', 'Warm'), str(42, 'Cm', 'Lush'), str(43, 'Ebm', 'Wide'), str(44, 'F#m', 'Dark'), str(45, null, 'Unknown')]
  const opts: GenerateOptions = { ...OPTS, strings: { hits: HITS, sidechain: 0.7 } }
  const gs = Array.from({ length: 80 }, (_, i) => generate(LIB, opts, 7700 + i))
  const stringClips = (g: Generation) => g.project.clips.filter((c): c is AudioClip => c.type === 'audio' && c.bass?.role === 'strings')
  const withStrings = gs.filter((g) => g.picks.strings)
  const hitOf = (g: Generation) => HITS.find((h) => h.rel_path === stringClips(g)[0].bass!.preset)!

  it('plays strings under some tracks, from the Strings page samples, with a random stream of its own', () => {
    expect(withStrings.length).toBeGreaterThan(gs.length * 0.4)
    expect(withStrings.length).toBeLessThan(gs.length * 0.9)
    expect(generate(LIB, OPTS, 7700).project.lanes.some((l) => l.name === 'Strings')).toBe(false)
    expect(generate(LIB, { ...OPTS, strings: { hits: [] } }, 7700).project.lanes.some((l) => l.name === 'Strings')).toBe(false)
    // The rest of the track is the same with or without strings.
    for (const g of gs.slice(0, 12)) {
      const bare = generate(LIB, OPTS, g.seed)
      const others = (x: Generation) => strip({ ...x, project: { ...x.project, clips: x.project.clips.filter((c) => !(c.type === 'audio' && c.bass?.role === 'strings')) } })
      expect(others(g)).toBe(others(bare))
    }
  })

  it('plays them as a supporting layer: from the second drop, in the second half of drops, or in the breakdowns', () => {
    const seen = new Set<string>()
    for (const g of withStrings) {
      seen.add(String(g.rules.stringsAt))
      const mid = (s: Generation['sections'][number]) => (s.start + s.bars / 2) * 4
      const late = (s: Generation['sections'][number]) => (s.start + s.bars - 2) * 4
      const drops = g.sections.filter((s) => s.kind === 'drop')
      const breaks = g.sections.filter((s) => s.kind === 'break')
      // Never under the intro or the outro, and never at the very start of the first drop.
      expect(covers(g, 'Strings', mid(g.sections[0]))).toBe(false)
      expect(covers(g, 'Strings', mid(g.sections.at(-1)!))).toBe(false)
      expect(covers(g, 'Strings', drops[0].start * 4)).toBe(false)
      const at = g.rules.stringsAt === 'breaks' && !breaks.length ? 'halves' : g.rules.stringsAt
      if (at === 'later') {
        if (drops.length > 1) {
          for (const d of drops.slice(1)) expect(covers(g, 'Strings', mid(d))).toBe(true)
          expect(covers(g, 'Strings', late(drops[0]))).toBe(false)
        } else expect(covers(g, 'Strings', late(drops[0]))).toBe(true)
      }
      if (at === 'halves') for (const d of drops) expect(covers(g, 'Strings', late(d))).toBe(true)
      if (at === 'breaks') {
        for (const b of breaks) expect(covers(g, 'Strings', mid(b))).toBe(true)
        for (const d of drops) expect(covers(g, 'Strings', mid(d))).toBe(false)
      }
      // There at once where the part starts (on the drop, after the fill), leaving with a fade; in a breakdown it rises into the drop.
      // (A part split where a ride starts: the fade on its last piece, the rise going on across it.)
      const cs = stringClips(g)
      for (const c of cs) {
        expect(c.fadeIn).toBeUndefined()
        const goesOn = cs.some((x) => x.start === c.start + c.length)
        if (!goesOn) {
          expect(c.fadeOut).toBeGreaterThan(0)
          expect(c.fadeOut!).toBeLessThanOrEqual(c.length / 2)
        }
        if (at === 'breaks') {
          const first = !cs.some((x) => x.start + x.length === c.start)
          if (first) expect(c.gainDb).toBe(-6)
          if (!goesOn) expect(c.gainTo).toBe(0)
        }
      }
      // Ducking under the kick, by the module's sidechain.
      expect(g.project.lanes.find((l) => l.name === 'Strings')!.duck).toBe(0.7)
      expect(g.choices.some((c) => c.startsWith('strings from ') && c.includes('fading out'))).toBe(true)
    }
    expect([...seen].sort()).toEqual(['breaks', 'halves', 'later'])
  })

  it('starts a sample again on every line of its own length: a 4-bar sample every 4 bars, never bars of silence', () => {
    const bars4 = (4 * 4 * 60) / 125   // a 4-bar loop cut at 125 BPM: just under 4 bars at 124
    const short = { ...OPTS, strings: { hits: HITS.map((h) => ({ ...h, duration_s: bars4 })) } }
    const got = Array.from({ length: 30 }, (_, i) => generate(LIB, short, 7700 + i)).filter((g) => g.picks.strings)
    expect(got.length).toBeGreaterThan(5)
    for (const g of got) {
      for (const c of stringClips(g)) {
        expect(c.bass!.bars).toBe(4)
        expect(c.sample.bars).toBe(4)
        expect(c.sample.relPath).toMatch(/-b4-/)   // its own file, not the 8-bar part's
      }
      expect(g.choices.some((c) => c.includes('every 4 bars'))).toBe(true)
    }
    expect(stringsBars({ duration_s: 30 }, 124)).toBe(8)
    expect(stringsBars({ duration_s: 3.9 }, 124)).toBe(2)
    expect(stringsBars({ duration_s: 0.5 }, 124)).toBe(1)
  })

  it('plays the sample as it is, moved at most 3 semitones into the key, starting again every 8 bars', () => {
    for (const g of withStrings) {
      const cs = stringClips(g)
      const r = cs[0].bass!
      expect(cs.every((c) => JSON.stringify(c.bass) === JSON.stringify(r))).toBe(true)  // one sample, one render
      expect(r.preset.startsWith('Strings/')).toBe(true)
      expect(hitOf(g).key_label).not.toBeNull()
      expect(r.transpose).toBe(hitPitch(hitOf(g), g.key))
      expect(Math.abs(r.transpose)).toBeLessThanOrEqual(3)
      expect(r.drone).toBeUndefined()
      expect(r.bars).toBe(8)   // (a 30-second sample fills 8 bars)
      for (const c of cs) {
        expect(c.sample.bars).toBe(8)
        expect(c.sample.relPath).toBe(bassPath(r, g.project.bpm))
        expect(c.sample.relPath.startsWith('.drumvault/strings/')).toBe(true)
        expect(c.sample.relPath).not.toMatch(/-b\d-/)
      }
    }
  })

  it('leaves out samples without a key or further than 3 semitones from it', () => {
    const far = { ...OPTS, strings: { hits: [str(51, 'Ebm', 'Far'), str(52, null, 'Unknown')] } }  // 6 from A minor
    for (let i = 0; i < 20; i++) expect(generate(LIB, far, 7900 + i, { key: 'Am' }).picks.strings).toBeUndefined()
    const near = { ...OPTS, strings: { hits: [str(53, 'Bm', 'Near')] } }
    const got = Array.from({ length: 20 }, (_, i) => generate(LIB, near, 7900 + i, { key: 'Am' })).filter((g) => g.picks.strings)
    expect(got.length).toBeGreaterThan(0)
    for (const g of got) expect(stringClips(g)[0].bass!.transpose).toBe(-2)
  })

  it('makes new strings, or another sample where they play, the rest as it is', () => {
    const none = gs.find((g) => !g.picks.strings)!
    const added = rerollStrings(LIB, opts, none, 5)!
    expect(added.picks.strings).toBeTruthy()
    expect(stringClips(added).length).toBeGreaterThan(0)
    const rest = (x: Generation) => JSON.stringify(x.project.clips.filter((c) => !(c.type === 'audio' && c.bass?.role === 'strings')).map(({ id: _i, laneId: _l, ...c }) => c))
    expect(rest(added)).toBe(rest(none))
    const g = withStrings.find((x) => HITS.filter((h) => h.key_label && Math.abs(hitPitch(h, x.key)) <= 3).length > 1)!
    const other = newStringsSound(LIB, opts, g, 9)!
    expect(other.picks.strings!.id).not.toBe(g.picks.strings!.id)
    expect(other.rules.stringsAt).toBe(g.rules.stringsAt)
    expect(rest(other)).toBe(rest(g))
  })

  it('moves the strings into another key, or another sample when theirs is too far, or none', () => {
    const g = withStrings[0]
    const own = hitOf(g).key_label!
    const r = changeKey(LIB, opts, g, own, 3)
    const b = stringClips(r)[0].bass!
    expect([b.keyLabel, b.transpose, b.preset]).toEqual([own, 0, hitOf(g).rel_path])
    expect(stringClips(r)[0].sample.relPath).toBe(bassPath(b, r.project.bpm))
    // Only one sample, and the new key more than 3 semitones from it: no strings.
    const single = { ...OPTS, strings: { hits: [hitOf(g)] } }
    const far = ['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm'].find((k) => Math.abs(transposeTo(own, k)) > 3)!
    const gone = changeKey(LIB, single, g, far, 3)
    expect(stringClips(gone)).toEqual([])
    expect(gone.picks.strings).toBeUndefined()
    expect(gone.project.lanes.some((l) => l.name === 'Strings')).toBe(false)
  })
})

describe('generator: vocals', () => {
  const take = (id: string, key: string, used: string[] = []): VocalTake => ({
    id, lines: ['Hold on to me'], voice: 'female', mood: 'gospel', bpm: 124, key, seconds: 25, createdAt: '2026-11-02T00:00:00Z',
    source: 'elevenlabs', model: 'music_v1', format: 'mp3_44100_128', headers: {}, credits: null, take: `Vocals/${id}/take.mp3`,
    vocal: `Vocals/${id}/vocal.wav`, stems: [], durationS: 25, keyHeard: key, usedIn: used,
    analysis: {
      key, bpm: 124,
      phrases: [{ path: `Vocals/${id}/phrases/phrase-2bars.wav`, bars: 2, period_s: 3.87, stretch: 1 }, { path: `Vocals/${id}/phrases/phrase-8bars.wav`, bars: 8, period_s: 15.5, stretch: 1 }],
      chops: [{ path: `Vocals/${id}/chops/chop-01.wav`, note: 64, seconds: 0.3, energy_db: -20 }, { path: `Vocals/${id}/chops/chop-02.wav`, note: 67.2, seconds: 0.25, energy_db: -22 }],
    },
  })
  const TAKES = [take('a', 'Em'), take('b', 'Am'), take('c', 'C', ['Generated 03'])]
  const opts: GenerateOptions = { ...OPTS, vocals: { takes: TAKES } }
  const gs = Array.from({ length: 60 }, (_, i) => generate(LIB, opts, 8800 + i))
  const on = (g: Generation, name: string) => g.project.clips.filter((c) => c.laneId === laneOf(g, name))

  it('sings a vocal in every track, with a random stream of its own', () => {
    for (const g of gs) {
      expect(g.picks.vocal).toBeTruthy()
      expect(on(g, 'Vocal').length + on(g, 'Vocal Chops').length).toBeGreaterThan(0)
    }
    expect(generate(LIB, OPTS, 8800).project.lanes.some((l) => l.name === 'Vocal' || l.name === 'Vocal Chops')).toBe(false)
    const voc = (c: Clip) => c.sample.relPath.startsWith('Vocals/') || c.sample.relPath.startsWith('.drumvault/vocals/')
    for (const g of gs.slice(0, 10)) {
      const bare = generate(LIB, OPTS, g.seed)
      const others = (x: Generation) => strip({ ...x, project: { ...x.project, clips: x.project.clips.filter((c) => !voc(c)) } })
      expect(others(g)).toBe(others(bare))
    }
  })

  it('takes a vocal no export has used yet while there is one', () => {
    for (const g of gs) expect(g.picks.vocal!.rel_path).not.toBe('Vocals/c/vocal.wav')
  })

  it('sings only the phrase (no chops), moved into the track key, never in the intro or outro', () => {
    const where = new Set<string>()
    for (const g of gs) {
      where.add(String(g.rules.vocalAt))
      expect(on(g, 'Vocal Chops')).toEqual([])
      expect(g.project.lanes.some((l) => l.name === 'Vocal Chops')).toBe(false)
      expect(on(g, 'Vocal').length).toBeGreaterThan(0)
      const intro = g.sections[0]
      const outro = g.sections.at(-1)!
      for (const c of on(g, 'Vocal') as AudioClip[]) {
        expect(c.start).toBeGreaterThanOrEqual((intro.start + intro.bars) * 4)
        expect(c.start).toBeLessThan(outro.start * 4)
        const t = TAKES.find((x) => x.id === c.bass!.vocal!.take)!
        expect(c.bass!.role).toBe('vocal')
        expect(c.bass!.transpose).toBe(Math.max(-12, Math.min(12, transposeTo(t.analysis.key, g.key))))
        expect(c.sample.relPath).toBe(bassPath(c.bass!, g.project.bpm))
        expect([2, 8]).toContain(c.bass!.bars)
      }
      // In the second halves only: each drop's phrase starts halfway.
      if (g.rules.vocalAt === 'halves') {
        for (const d of g.sections.filter((x) => x.kind === 'drop' && x.bars >= 16)) {
          expect(on(g, 'Vocal').some((c) => c.start === (d.start + halfwayBars(d.bars)) * 4)).toBe(true)
        }
      }
      expect(g.rules.vocalUse).toBeUndefined()
    }
    expect([...where].sort()).toEqual(['breaks', 'drops', 'drops_breaks', 'halves'])
  })

  it('moves the vocal into another key, and makes a new vocal with the rest as it is', () => {
    const g = gs.find((x) => on(x, 'Vocal').length)!
    const to = g.key === 'Dm' ? 'F' : 'Dm'
    const r = changeKey(LIB, opts, g, to, 3)
    for (const c of on(r, 'Vocal') as AudioClip[]) expect(c.bass!.transpose).toBe(Math.max(-12, Math.min(12, transposeTo(c.bass!.vocal!.key, to))))
    const n = rerollVocal(LIB, opts, g, 4)!
    const rest = (x: Generation) => JSON.stringify(x.project.clips.filter((c) => !c.sample.relPath.startsWith('Vocals/') && !c.sample.relPath.startsWith('.drumvault/vocals/')).map(({ id: _i, laneId: _l, ...c }) => c))
    expect(rest(n)).toBe(rest(g))
    expect(on(n, 'Vocal').length).toBeGreaterThan(0)
    expect(on(n, 'Vocal Chops')).toEqual([])
  })

  it('sings the take made for a track in Arrange, the rest as it is, even once it is exported', () => {
    const voc = (c: Clip) => c.sample.relPath.startsWith('Vocals/') || c.sample.relPath.startsWith('.drumvault/vocals/')
    const rest = (x: Generation) => JSON.stringify(x.project.clips.filter((c) => !voc(c)).map(({ id: _i, laneId: _l, ...c }) => c))
    for (const made of [take('d', 'Fm'), take('e', 'G', ['Generated 07'])]) {
      const bare = generate(LIB, OPTS, 8900)
      const n = rerollVocal(LIB, { ...OPTS, vocals: { takes: [made] } }, bare, 5)!
      expect(n.picks.vocal!.rel_path).toBe(`Vocals/${made.id}/vocal.wav`)
      expect(on(n, 'Vocal').length).toBeGreaterThan(0)
      expect(rest(n)).toBe(rest(bare))
    }
  })
})

describe('bassy hits and impacts', () => {
  /** A tone (24 bands, dB against the total) with `low` dB in the bands under 100 Hz and `rest` above. */
  const tone = (low: number, rest: number) => Array.from({ length: 24 }, (_, i) => (i < 4 ? low : rest))
  const impactsOf = (g: Generation) => g.project.clips.filter((c) => byPath.get(c.sample.relPath)?.category === 'fx_impact')
  const kickAt = (g: Generation, bar: number) => Array.from({ length: 16 }, (_, k) => bar * 16 + k).some((t) => hitAt(g, 'Kick', t) > 0)
    || clipsOn(g, 'Build-up').some((c) => c.type === 'pattern' && byPath.get(c.sample.relPath)?.category === 'kick' && c.start <= bar * 4 && c.start + c.length > bar * 4)

  it('measures the low end: an impact with most of its power under 100 Hz is bassy, one not measured counts as bassy', () => {
    expect(bassy({ category: 'fx_impact', tone: tone(-3, -25) })).toBe(true)
    expect(bassy({ category: 'fx_impact', tone: tone(-40, -12) })).toBe(false)
    expect(bassy({ category: 'fx_downlifter', tone: tone(-40, -12) })).toBe(false)
    expect(bassy({ category: 'fx_impact', tone: null })).toBe(true)
    expect(bassy({ category: 'fx_downlifter', tone: null })).toBe(false)
  })

  it('never plays one on a drop: it opens breakdowns and build-ups where no kick plays under it', () => {
    let placed = 0
    for (const g of gens) {
      const drops = new Set(g.sections.filter((s) => s.kind === 'drop').map((s) => s.start * 4))
      const opens = new Set(g.sections.filter((s) => s.kind === 'break' || s.kind === 'build').map((s) => s.start * 4))
      for (const c of impactsOf(g)) {
        placed++
        expect(drops.has(c.start)).toBe(false)
        expect(opens.has(c.start)).toBe(true)
        expect(kickAt(g, c.start / 4)).toBe(false)
      }
    }
    expect(placed).toBeGreaterThan(20)
  })

  it('lets an impact without much bass hit the drops as before', () => {
    const lib = LIB.map((s) => (s.category === 'fx_impact' ? { ...s, tone: tone(-40, -12) } : s))
    const at = new Map(lib.map((s) => [s.rel_path, s]))
    let onDrops = 0
    for (let i = 0; i < 40; i++) {
      const g = generate(lib, OPTS, 1000 + i)
      const drops = new Set(g.sections.filter((s) => s.kind === 'drop').map((s) => s.start * 4))
      onDrops += g.project.clips.filter((c) => at.get(c.sample.relPath)?.category === 'fx_impact' && drops.has(c.start)).length
    }
    expect(onDrops).toBeGreaterThan(10)
  })
})

describe('generator: one groove (the drums carry through breakdowns)', () => {
  const DRUMS = /^(Hats|Perc|Tops|Groove|Ride)/
  const THREAD = /^(Hats|Perc|Tops)$/
  const nameOf = (g: Generation, c: Clip) => g.project.lanes.find((l) => l.id === c.laneId)!.name
  const within = (c: Clip, from: number, to: number) => c.start < to * 4 && c.start + c.length > from * 4
  const breaksOf = (g: Generation) => g.sections.filter((s) => s.kind === 'break')
  const dropsOf = (g: Generation) => g.sections.filter((s) => s.kind === 'drop')

  it('always keeps a part going: no bar of a breakdown without hats, perc or a top loop', () => {
    let bars = 0
    for (const g of gens) {
      expect(g.rules.glue).toBe(true)
      for (const s of breaksOf(g)) {
        // (The last bar belongs to the way into the drop: the breath and the silence before it.)
        for (let b = s.start; b < s.start + s.bars - 1; b++) {
          expect(g.project.clips.some((c) => THREAD.test(nameOf(g, c)) && within(c, b, b + 1))).toBe(true)
          bars++
        }
      }
    }
    expect(bars).toBeGreaterThan(500)
  })

  it('plays the drops\' own drums there, never a sound the drops don\'t have', () => {
    for (const g of gens) {
      const inDrops = new Set(g.project.clips.filter((c) => dropsOf(g).some((d) => within(c, d.start, d.start + d.bars))).map((c) => `${nameOf(g, c)}|${c.sample.relPath}`))
      for (const s of breaksOf(g)) {
        for (const c of g.project.clips.filter((x) => DRUMS.test(nameOf(g, x)) && within(x, s.start, s.start + s.bars) && x.start >= s.start * 4)) {
          expect(inDrops.has(`${nameOf(g, c)}|${c.sample.relPath}`)).toBe(true)
        }
      }
    }
  })

  it('treats everything it plays there: filtered or riding in level, never as loud and open as in the drop', () => {
    for (const g of gens) {
      for (const s of breaksOf(g)) {
        for (const c of g.project.clips.filter((x) => DRUMS.test(nameOf(g, x)) && x.start >= s.start * 4 && x.start < (s.start + s.bars) * 4)) {
          expect(!!c.filter || c.gainDb < 0 || c.gainTo != null).toBe(true)
        }
      }
    }
  })

  it('moves across the line: what leaves fades out after it, one loop after the other', () => {
    let fades = 0
    const lengths = new Set<number>()
    for (const g of gens) {
      for (const s of breaksOf(g)) {
        for (const c of g.project.clips.filter((x) => /^(Hats 2|Perc 2|Groove|Tops [234])$/.test(nameOf(g, x)) && x.start === s.start * 4)) {
          expect(c.filter).toMatchObject({ type: 'lowpass' })
          // The fade, with the part a split leaves of it (a ride over the last bars before a drop).
          let end = c
          for (;;) {
            // (The same fade going on: falling on, its filter where the last piece's ended; not the part opening back up into the drop.)
            const more = g.project.clips.find((x) => x.laneId === c.laneId && x.start === end.start + end.length && x.sample.relPath === c.sample.relPath && x.gainDb === end.gainTo
              && (x.gainTo ?? x.gainDb) <= x.gainDb && x.filter?.from === end.filter?.to)
            if (!more) break
            end = more as typeof c
          }
          const length = end.start + end.length - c.start
          // Fading 16 dB over at most 8 bars (cut short where the breath or the silence before a drop takes its end).
          expect(end.gainTo! - c.gainDb).toBeLessThanOrEqual((-16 * length) / (8 * 4) + 0.5)
          expect(length).toBeLessThanOrEqual(8 * 4)
          lengths.add(length)
          fades++
        }
      }
    }
    expect(fades).toBeGreaterThan(100)
    expect(lengths.size).toBeGreaterThan(1)
  })

  it('opens up into the next part: what stays ends its breakdown open and at full level', () => {
    let opened = 0
    for (const g of gens) {
      g.sections.forEach((s, i) => {
        const next = g.sections[i + 1]
        if (s.kind !== 'break' || next?.kind !== 'drop' || g.rules.dropBreath === 'all') return
        const z = (s.start + s.bars) * 4
        // What stays (the thread) ends its breakdown riding up to 0 dB with its filter opening (a
        // part that leaves fades out over the whole of a short breakdown, and isn't the thread).
        const lastOf = (name: string) => g.project.clips.filter((c) => nameOf(g, c) === name && c.type === 'audio' && c.start >= s.start * 4 && c.start < z && c.gainTo != null)
          .sort((x, y) => y.start + y.length - (x.start + x.length))[0]
        const lasts = ['Hats', 'Perc'].map(lastOf).filter(Boolean)
        if (!lasts.length) return
        expect(lasts.some((c) => c!.gainTo === 0)).toBe(true)
        opened++
      })
    }
    expect(opened).toBeGreaterThan(40)
  })

  it('takes the big breakdown deepest; the short ones are lighter copies of it with more drums', () => {
    let pairs = 0
    let groove = 0
    for (const g of gens.filter((x) => breaksOf(x).some((s) => s.long) && breaksOf(x).length >= 2)) {
      // (The perc held darker in the big one, where the track keeps it through breakdowns.)
      const through = g.rules.gluePerc === 'through'
      const holdOf = (s: Generation['sections'][number]) => {
        const at = (s.start + Math.min(4, Math.max(1, Math.floor(s.bars / 4)))) * 4 + 1
        return clipsOn(g, 'Perc').find((c) => c.start <= at && c.start + c.length > at)?.filter?.from
      }
      const long = breaksOf(g).find((s) => s.long)!
      for (const s of breaksOf(g).filter((x) => !x.long)) {
        // Shorter than the big one.
        expect(s.bars).toBeLessThan(long.bars)
        // Hats and perc going all through it (the last bar is the way into the drop) and a soft clap with them.
        for (let b = s.start; b < s.start + s.bars - 1; b++) {
          for (const name of ['Hats', 'Perc']) {
            if (!clipsOn(g, name).length) continue
            expect(g.project.clips.some((c) => nameOf(g, c) === name && within(c, b, b + 1)), `${g.seed} ${name} ${b}`).toBe(true)
          }
        }
        if (clipsOn(g, 'Clap').length) groove++
        const [h, hl] = [holdOf(s), holdOf(long)]
        if (through && h != null && hl != null) { expect(hl).toBeLessThanOrEqual(h); pairs++ }
      }
      // (Drawn by the rules; a real track's breakdowns keep their own kicks.)
      const shorts = breaksOf(g).filter((x) => !x.long)
      if (!g.template) expect(new Set(shorts.map((x) => x.kick)).size).toBe(1)
    }
    expect(pairs).toBeGreaterThan(10)
    expect(groove).toBeGreaterThan(10)
  })

  it('has a big breakdown in every track drawn by the rules, its kick mostly out', () => {
    const drawn = gens.filter((x) => breaksOf(x).length && !x.template)
    const longs = drawn.flatMap((g) => breaksOf(g).filter((s) => s.long))
    expect(drawn.length).toBeGreaterThan(10)
    for (const g of drawn) expect(breaksOf(g).filter((s) => s.long).length).toBe(1)
    expect(longs.filter((s) => s.kick === 'out').length).toBeGreaterThan(longs.length * 0.5)
  })

  it('can be switched off: each breakdown its own again, the other lanes as they were', () => {
    const choice = CHOICES.find((c) => c.rule === 'glue')!
    let n = 0
    for (const g of gens.filter((x) => breaksOf(x).length).slice(0, 8)) {
      const r = setTrackRule(LIB, OPTS, g, 'glue', false, choice.roles)
      expect(r.rules.glue).toBe(false)
      for (const s of breaksOf(r)) {
        for (const c of r.project.clips.filter((x) => /^(Hats 2|Perc 2|Groove|Ride)$/.test(nameOf(r, x)) && x.start >= s.start * 4 && x.start < (s.start + s.bars) * 4)) {
          // Nothing fades across the line: what plays in a breakdown starts and stays as it is.
          expect(c.gainTo).toBeUndefined()
        }
      }
      const kick = (x: Generation) => JSON.stringify(clipsOn(x, 'Kick').map(({ id: _i, laneId: _l, ...c }) => c))
      expect(kick(r)).toBe(kick(g))
      n++
    }
    expect(n).toBeGreaterThan(3)
  })
})

describe('generator: the way into drops, the same into every drop', () => {
  const drops = (g: Generation) => g.sections.filter((s) => s.kind === 'drop' && s.start > 0)
  const byWay = (way: string) => gens.filter((g) => g.rules.dropIn === way)

  it('draws one way in per track: straight in, a gap with the drum fill alone in it, or a gap with the FX pulling in', () => {
    for (const way of ['straight', 'gap', 'suck']) expect(byWay(way).length).toBeGreaterThan(15)
    for (const g of gens) {
      const want = g.rules.dropIn === 'straight' ? 0 : Number(g.rules.dropInBeats) * 4
      for (const d of drops(g)) expect((g.rules.dropGaps as Record<string, number>)[d.start]).toBe(want)
    }
    expect(byWay('straight')[0].choices).toContain('straight into every drop')
  })

  it('leaves only the drum fill sounding in a gap, before every drop', () => {
    let filled = 0
    for (const g of byWay('gap')) {
      const n = Number(g.rules.dropInBeats) * 4
      for (const d of drops(g)) {
        const mid = d.start * 4 - n / 8
        for (const l of g.project.lanes) {
          if (['Fills', 'Hits'].includes(l.name)) continue
          for (let k = 1; k <= n; k++) expect(hitAt(g, l.name, d.start * 16 - k), `${g.seed} ${l.name}`).toBe(0)
          expect(g.project.clips.some((c) => c.laneId === l.id && c.type === 'audio' && c.start <= mid && c.start + c.length > mid), `${g.seed} ${l.name}`).toBe(false)
        }
        if (g.rules.dropFill && covers(g, 'Fills', mid)) filled++
      }
      expect(g.rules.dropFill).not.toBeNull()                          // a gap has its drum fill
    }
    expect(filled).toBeGreaterThan(20)
  })

  it('lets the FX pull into the 1 through a gap that silences the rest', () => {
    let pulled = 0
    for (const g of byWay('suck')) {
      const n = Number(g.rules.dropInBeats) * 4
      for (const d of drops(g)) {
        for (const name of ['Kick', 'Clap', 'Hats', 'Perc', 'Tops', 'Bass']) {
          for (let k = 1; k <= n; k++) expect(hitAt(g, name, d.start * 16 - k)).toBe(0)
        }
        if (['FX', 'FX 2', 'FX 3'].some((x) => covers(g, x, d.start * 4 - 0.25))) pulled++
      }
    }
    expect(pulled).toBeGreaterThan(10)
  })
})

describe('generator: the big build into the drops after the long breakdown', () => {
  const vopts: GenerateOptions = { ...OPTS, verb: { tops: true, every: null, amount: 0.6 } }
  const tracks = Array.from({ length: 80 }, (_, i) => generate(LIB, vopts, 6100 + i))
  const big = tracks.filter((g) => g.sections.some((s) => bigDrop(g, s)))
  const at = (g: Generation, name: string, bar: number) =>
    g.project.clips.find((c): c is PatternClip => c.type === 'pattern' && c.laneId === laneOf(g, name) && c.start <= bar * 4 && c.start + c.length > bar * 4)
  const hits = (c: PatternClip | undefined, bar: number) => {
    if (!c) return 0
    const from = ((bar * 4 - c.start) * 4) % c.steps.length
    return c.steps.slice(from, from + 16).filter(Boolean).length
  }
  /** The big drop, and the bars the build runs before it (reaching back into the long breakdown). */
  const buildOf = (g: Generation) => {
    const d = g.sections.find((s) => bigDrop(g, s))!
    const i = g.sections.indexOf(d)
    let a = g.sections[i - 1].start
    for (let j = i - 2; j >= 0 && g.sections[j].kind !== 'drop'; j--) a = g.sections[j].start
    return { d, n: Math.min(Number(g.rules.bigBars), d.start - a) }
  }

  it('builds big in most tracks with a long breakdown, the rest as into the other drops', () => {
    const withLong = tracks.filter((g) => g.sections.some((s) => s.long))
    expect(big.length).toBeGreaterThan(withLong.length * 0.4)
    expect(big.length).toBeLessThan(withLong.length)
    for (const g of big) {
      const { n } = buildOf(g)
      expect([4, 8, 16]).toContain(Number(g.rules.bigBars))
      expect(g.choices.find((c) => c.startsWith('the big build'))).toContain(`${n} bars`)
    }
    for (const g of tracks.filter((x) => x.rules.bigBuild === 'usual')) expect(laneOf(g, 'FX 3')).toBeUndefined()
  })

  it('layers its drums: claps on the beat, in 8ths, in 16ths; a snare joining halfway; louder and opening as they go (thinning out under the high-pass)', () => {
    let claps = 0, snares = 0
    for (const g of big) {
      const { d, n } = buildOf(g)
      const a = d.start - n
      const rolled = g.rules.dropFill === 'roll'
      const withClaps = g.rules.bigDrums !== 'snare' || rolled
      // (The bar before the drop may breathe or go silent: the bars before it.)
      for (let b = a; b < d.start - 1; b++) {
        const x = (b - a) / n
        if (withClaps && laneOf(g, 'Clap')) {
          expect(hits(at(g, 'Clap', b), b), `${g.seed} bar ${b}`).toBe(x < 0.5 ? 4 : x < 0.75 ? 8 : 16)
          const c = at(g, 'Clap', b)!
          expect(c.filter?.type).toBe(b >= d.start - Math.max(Number(g.rules.mixHp ?? 0), Number(g.rules.bigHp ?? 0)) ? 'highpass' : 'lowpass')
          if (b === a) expect(c.gainDb).toBe(-9)
          claps++
        }
        const s0 = withClaps ? Math.floor(n / 2) : 0
        if (!rolled && g.rules.bigDrums !== 'claps' && b - a >= s0) {
          const y = (b - a - s0) / (n - s0)
          const want = g.rules.bigSnare === 'steps' ? (y < 1 / 3 ? 4 : y < 2 / 3 ? 8 : 16) : y < 0.5 ? 8 : 16
          expect(hits(at(g, 'Build-up', b), b), `${g.seed} bar ${b}`).toBe(want)
          snares++
        }
      }
      if (rolled) expect(at(g, 'Build-up', a)).toBeUndefined()           // a roll sample is the snare roll there
    }
    expect(claps).toBeGreaterThan(40)
    expect(snares).toBeGreaterThan(40)
  })

  it('takes the kick out, brings it back four on the floor over its second half, or rolls it over its last quarter', () => {
    const seen = new Set<string>()
    for (const g of big) {
      const { d, n } = buildOf(g)
      const a = d.start - n
      seen.add(String(g.rules.bigKick))
      for (let b = a; b < d.start - 1; b++) {
        const k = hits(at(g, 'Kick', b), b)
        if (g.rules.bigKick === 'out') expect(k).toBe(0)
        else if (g.rules.bigKick === 'back' && b >= a + Math.floor(n / 2)) {
          expect(k).toBe(4)
          expect(at(g, 'Kick', b)!.filter?.type).toBe(b >= d.start - Math.max(Number(g.rules.mixHp ?? 0), Number(g.rules.bigHp ?? 0)) ? 'highpass' : 'lowpass')
        } else if (g.rules.bigKick === 'roll' && b >= d.start - Math.max(2, Math.floor(n / 4))) expect(k).toBe(8)
      }
    }
    expect(seen).toEqual(new Set(['out', 'back', 'roll']))
  })

  it('stacks its risers into the drop, the longest over the build, a short lift on FX 3; crashes coming faster', () => {
    let three = 0, crashes = 0
    for (const g of big) {
      const { d } = buildOf(g)
      const into = (name: string) => clipsOn(g, name).find((c) => {
        const s = LIB.find((x) => x.rel_path === c.sample.relPath)
        return s?.kind === 'event' && c.start + bodyBars(s) * 4 === d.start * 4
      })
      expect(into('FX'), `${g.seed}`).toBeDefined()
      if (Number(g.rules.bigRisers) >= 3 && into('FX 3')) {
        three++
        expect(bodyBars(LIB.find((x) => x.rel_path === into('FX 3')!.sample.relPath)!)).toBeLessThanOrEqual(2)
      }
      if (g.rules.bigCrash && laneOf(g, 'Crash') && g.rules.dropIn !== 'gap') {
        expect([4, 3, 2].map((k) => hits(at(g, 'Crash', d.start - k), d.start - k))).toEqual([1, 2, 4])
        crashes++
      }
    }
    expect(three).toBeGreaterThan(5)
    expect(crashes).toBeGreaterThan(5)
    // The other drops keep the track's usual way: never a third FX layer.
    for (const g of big) {
      for (const d of g.sections.filter((s) => s.kind === 'drop' && !bigDrop(g, s))) {
        expect(clipsOn(g, 'FX 3').some((c) => c.start < d.start * 4 && c.start + c.length >= d.start * 4)).toBe(false)
      }
    }
  })

  it('sends its drums to reverb rising to the drop and throws a delay every 4 bars, the drop dry', () => {
    let wet = 0
    for (const g of big.filter((x) => ['drums', 'drums+stabs', 'drums+tops', 'all'].includes(String(x.rules.bigVerb)))) {
      const { d, n } = buildOf(g)
      const a = d.start - n
      const rolled = g.rules.dropFill === 'roll'
      const plays = [...(g.rules.bigDrums !== 'snare' || rolled ? ['Clap'] : []), ...(!rolled && g.rules.bigDrums !== 'claps' ? ['Build-up'] : [])]
      for (const name of plays) {
        const cs = clipsOn(g, name).filter((c) => c.start >= a * 4 && c.start < (d.start - 1) * 4)
        for (const c of cs) {
          expect(c.verb!.to).toBeGreaterThanOrEqual(c.verb!.from)
          expect(c.verb!.to).toBeLessThanOrEqual(0.85 + 1e-9)
          const bar = c.start / 4 - a
          if ((bar + 1) % 4 === 0 && c.length === 4) expect(c.echo).toBeGreaterThan(0)
          wet++
        }
        // Dry on the drop.
        for (const c of clipsOn(g, name).filter((c) => c.start >= d.start * 4 && c.start < (d.start + 1) * 4)) expect(c.verb).toBeUndefined()
      }
    }
    expect(wet).toBeGreaterThan(40)
    // The top loops wash out over the whole build when the effects take them.
    const tops = big.filter((x) => ['drums+tops', 'all'].includes(String(x.rules.bigVerb)))
    expect(tops.some((g) => {
      const { d, n } = buildOf(g)
      return clipsOn(g, 'Tops').some((c) => c.verb && c.start < (d.start - n / 2) * 4 && c.start >= (d.start - n) * 4)
    })).toBe(true)
  })

  it('high-passes the mix over its last bars when its rule is longer than the track\'s', () => {
    let seen = 0
    for (const g of big.filter((x) => Number(x.rules.bigHp) > Number(x.rules.mixHp ?? 0))) {
      const { d } = buildOf(g)
      const hp = Number(g.rules.bigHp)
      // The build's own drums thin out there (their low-pass gives way), and the parts without a filter of their own.
      const n = buildOf(g).n
      for (const name of ['Clap', 'Build-up', 'Kick']) {
        for (let b = d.start - Math.min(n, hp); b < d.start - 1; b++) {
          const c = at(g, name, b)
          if (c?.filter && hits(c, b)) expect(c.filter.type, `${g.seed} ${name} ${b}`).toBe('highpass')
        }
      }
      const swept = g.project.clips.filter((c) => c.filter?.type === 'highpass' && c.filter.to != null && c.filter.to > c.filter.from
        && c.start >= (d.start - hp) * 4 && c.start < (d.start - Number(g.rules.mixHp ?? 0)) * 4)
      if (swept.length) seen++
    }
    expect(seen).toBeGreaterThan(3)
  })

  it('builds as long as the user\'s tracks do into their drop after the long breakdown: the reference it\'s built on, else their spread', () => {
    const run = (rs: [string, number][]) => rs.map(([v, n]) => v.repeat(n)).join('')
    // Intro 16, drop 32, break 32 (its fills over the last 16 bars, the kick back over the last 8), drop 32, outro 16.
    const ref = (code: string, fillBars: number, kickBars: number): TrackArrangement => ({
      zip_id: 9, source_code: code, bpm: 124, bars: 128,
      parts: {
        kick: run([['2', 48], ['0', 32 - kickBars], ['1', kickBars], ['2', 48]]),
        bass: run([['0', 16], ['2', 32], ['0', 32], ['2', 32], ['0', 16]]),
        top: run([['2', 128]]), hats: run([['2', 128]]),
        fills: fillBars ? run([['0', 80 - fillBars], ['1', fillBars - 1], ['0', 49]]) : '0'.repeat(128),
        fx: run([['0', 76], ['2', 4], ['0', 48]]),
      },
    })
    expect(mainBuildOf(ref('S0901', 16, 8))).toEqual({ bars: 16, kick: true, claps: false })
    expect(mainBuildOf(ref('S0902', 8, 0))).toMatchObject({ bars: 8, kick: false })
    expect(mainBuildOf(ref('S0903', 0, 0))).toMatchObject({ bars: 4 })              // no fills: the FX at full
    expect(mainBuilds([ref('S0901', 16, 8), ref('S0902', 8, 0)]).length).toBe(2)
    // Every track drawing from three references builds 8 or 16 bars, never another length.
    const refs = [ref('S0901', 16, 8), ref('S0902', 8, 0), ref('S0904', 16, 0)]
    const gs = Array.from({ length: 30 }, (_, i) => generate(LIB, { ...OPTS, templates: refs, locks: { bigBuild: 'big' } }, 6300 + i))
    for (const g of gs) {
      const code = g.sections.find((s) => bigDrop(g, s))?.src?.code
      const own = code ? refs.find((r) => r.source_code === code) : undefined
      if (own) expect(g.rules.bigBars).toBe(mainBuildOf(own)!.bars)
      else expect([8, 16]).toContain(g.rules.bigBars)
    }
    expect(new Set(gs.map((g) => g.rules.bigBars))).toEqual(new Set([8, 16]))
  })
})


describe('generator: phrasing and the kick never alone', () => {
  it('changes halfway on a 16-bar line: a 48-bar drop after 16 bars, never 24 and 24', () => {
    expect(halfwayBars(48)).toBe(16)
    expect(halfwayBars(40)).toBe(16)
    expect(halfwayBars(32)).toBe(16)
    expect(halfwayBars(64)).toBe(32)
    expect(halfwayBars(56)).toBe(32)
    expect(halfwayBars(24)).toBe(16)
    expect(halfwayBars(16)).toBe(8)   // one round: its phrase line
    expect(halfwayBars(8)).toBe(4)
    // A disco hit halfway through a drop lands on one of its 16-bar lines.
    for (const g of gens) {
      const id = laneOf(g, 'Disco Hit')
      if (!id) continue
      for (const s of g.sections.filter((x) => x.kind === 'drop' && x.bars > 16)) {
        for (const c of g.project.clips.filter((x) => x.laneId === id && x.start > s.start * 4 && x.start < (s.start + s.bars) * 4)) {
          expect((c.start / 4 - s.start) % 16).toBe(0)
        }
      }
    }
  })

  it('never leaves the kick alone in an intro or an outro', () => {
    const alongside = (role: string) => !['kick', 'crash', 'fx', 'fx2', 'fx3', 'hits', 'atmos', 'bed'].includes(role)
    const sounds = (c: Clip, b: number) => {
      if (c.start > b * 4 || c.start + c.length <= b * 4) return false
      if (c.type !== 'pattern') return true
      const k = Math.floor((b * 4 - c.start) / 4) % c.patternBars
      return c.steps.slice(k * 16, (k + 1) * 16).some((v) => v > 0)
    }
    for (const g of gens) {
      const role = new Map(g.project.lanes.map((l) => [l.id, laneRole(l.name) ?? '']))
      for (const s of g.sections.filter((x) => x.kind === 'intro' || x.kind === 'outro')) {
        for (let b = s.start; b < s.start + s.bars; b++) {
          const on = g.project.clips.filter((c) => sounds(c, b)).map((c) => role.get(c.laneId)!)
          if (on.includes('kick')) expect(on.some(alongside), `${s.kind} bar ${b + 1}: ${on.join(', ')}`).toBe(true)
        }
      }
    }
  })
})

describe('generator: intros gated, fills made anew', () => {
  it('maps a fill\'s 16ths: spliced by halves, beat by beat or the last beat, reworked in its last bar, its silence its own', () => {
    const halves = fillSlices(1, 'halves', null)
    expect(halves.slice(0, 8).every(([s]) => s === 0) && halves.slice(8).every(([s]) => s === 1)).toBe(true)
    expect(halves.map(([, i]) => i)).toEqual(Array.from({ length: 16 }, (_, i) => i))
    expect(fillSlices(1, 'alternate', null).map(([s]) => s)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1])
    expect(fillSlices(1, null, 'repeatFirst').map(([, i]) => i).slice(4, 8)).toEqual([0, 1, 2, 3])
    expect(fillSlices(1, null, 'swap').map(([, i]) => i).slice(4, 12)).toEqual([8, 9, 10, 11, 4, 5, 6, 7])
    expect(fillSlices(1, null, 'stutter8').map(([, i]) => i).slice(12)).toEqual([12, 13, 12, 13])
    expect(fillSlices(1, null, 'stutter16').map(([, i]) => i).slice(12)).toEqual([12, 12, 12, 12])
    // A 2-bar fill: the splice through both bars, the rework only in the last.
    const two = fillSlices(2, 'last', 'stutter16')
    expect(two[12][0]).toBe(1)
    expect(two.map(([, i]) => i).slice(12, 16)).toEqual([12, 13, 14, 15])
    expect(two.map(([, i]) => i).slice(28)).toEqual([28, 28, 28, 28])
    // Its silence before the line stays its own.
    expect(fillSlices(1, 'halves', 'stutter16', 2).slice(14)).toEqual([[0, 14], [0, 15]])
  })

  it('never plays a short fill as it was recorded: each fill of a track its own variant, the same each time', () => {
    let seen = 0
    for (const g of gens) {
      const fills = clipsOn(g, 'Fills').filter((c): c is AudioClip => c.type === 'audio' && c.sample.category === 'fill' && (c.sample.bars ?? 1) <= 2)
      const by = new Map<string, string>()
      for (const c of fills) {
        expect([-2, -1, 1, 2]).toContain(c.pitch)
        const v = JSON.stringify([c.pitch, c.remix ?? null])
        if (by.has(c.sample.relPath)) expect(v).toBe(by.get(c.sample.relPath))
        by.set(c.sample.relPath, v)
        seen++
      }
      if (fills.length) expect(g.choices.some((x) => x.startsWith('fills made anew'))).toBe(true)
    }
    expect(seen).toBeGreaterThan(20)
  })

  it('gates the intro\'s top loops, opening up every 8 bars, the plain loop in its last phrase', () => {
    let gated = 0
    for (const g of gens.filter((x) => x.rules.introGate)) {
      const intro = g.sections[0]
      const phrases = Math.floor(intro.bars / 8)
      const ids = new Set(g.project.lanes.filter((l) => /^Tops/.test(l.name)).map((l) => l.id))
      const at = (bar: number) => g.project.clips.find((c) => ids.has(c.laneId) && c.start <= bar * 4 && c.start + c.length > bar * 4) as AudioClip | undefined
      const open = (bar: number) => { const c = at(bar); return c ? (c.chop ? c.chop.filter(Boolean).length : 16) : null }
      const counts = Array.from({ length: phrases }, (_, k) => open(intro.start + k * 8)).filter((n): n is number => n != null)
      if (counts.length < 2) continue
      gated++
      for (let k = 1; k < counts.length; k++) expect(counts[k]).toBeGreaterThanOrEqual(counts[k - 1])
      expect(counts[0]).toBeLessThan(16)
      // (Its last phrase plain: checked where it starts; its last bar may be the breath before a drop.)
      const last = open(intro.start + (phrases - 1) * 8)
      if (last != null) expect(last).toBe(16)
      // Never past the intro.
      expect(g.project.clips.some((c) => c.type === 'audio' && c.chop && c.start >= (intro.start + intro.bars) * 4)).toBe(false)
    }
    expect(gated).toBeGreaterThan(10)
    expect(gens.filter((x) => x.rules.introGate).length).toBeGreaterThan(gens.length * 0.4)
  })
})
