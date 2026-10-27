// The generator (SCOPE.md §6.6): builds a complete drum arrangement from the library.
//
// generate(samples, options, seed, keep) is pure: it picks a structure (structure.ts), a key
// for tonal FX, one main sample per lane (spread over different zips), per-track style
// choices (kick drop-outs, clap rolls, FX density, …), then writes every lane bar by bar and
// turns that into ordinary Arrange clips. The same seed + library + options + keep gives the
// same arrangement.

import { expandCompatible } from '../lib/camelot'
import { BEATS_PER_BAR, makeLane, makeMarker, newProject, sampleRef, STEPS_PER_BAR, uid } from '../lib/project'
import type { SampleListItem } from '../types/api'
import type { Category, SampleKind } from '../types/engine'
import type { AudioClip, Clip, ClipFilter, PatternClip, Project, Velocity } from '../types/project'
import { Rng } from './rng'
import { barsFor, BUILD_LABEL, KICK_MODE_LABEL, makeStructure, PHRASE, type Section } from './structure'

export type Role = 'kick' | 'clap' | 'clap2' | 'clap3' | 'hats' | 'hats2' | 'ride' | 'perc' | 'perc2'
  | 'top' | 'top2' | 'top3' | 'top4' | 'groove' | 'fills' | 'fx' | 'crash' | 'hits' | 'atmos'

/** Volume per lane (dB on top of the starting mix), set with the Generate view's lane sliders. */
export type Mix = Partial<Record<Role, number>>

/**
 * Lanes of a generated project, in order, with a starting mix. Layers of the same kind (up to
 * three claps, four top loops, …) get their own lane, each a little quieter.
 */
export const LANES: { role: Role; name: string; volumeDb: number; color: string }[] = [
  { role: 'kick', name: 'Kick', volumeDb: -2, color: '#e2c35f' },
  { role: 'clap', name: 'Clap', volumeDb: -3, color: '#f472b6' },
  { role: 'clap2', name: 'Clap 2', volumeDb: -7, color: '#f9a8d4' },
  { role: 'clap3', name: 'Clap 3', volumeDb: -9, color: '#fbcfe8' },
  { role: 'hats', name: 'Hats', volumeDb: -6, color: '#22d3ee' },
  { role: 'hats2', name: 'Hats 2', volumeDb: -9, color: '#67e8f9' },
  { role: 'ride', name: 'Ride', volumeDb: -9, color: '#5eead4' },
  { role: 'perc', name: 'Perc', volumeDb: -7, color: '#4ee3a6' },
  { role: 'perc2', name: 'Perc 2', volumeDb: -9, color: '#86efac' },
  { role: 'top', name: 'Tops', volumeDb: -6, color: '#60a5fa' },
  { role: 'top2', name: 'Tops 2', volumeDb: -8, color: '#7dd3fc' },
  { role: 'top3', name: 'Tops 3', volumeDb: -9, color: '#93c5fd' },
  { role: 'top4', name: 'Tops 4', volumeDb: -10, color: '#a5b4fc' },
  { role: 'groove', name: 'Groove', volumeDb: -8, color: '#a3e635' },
  { role: 'fills', name: 'Fills', volumeDb: -5, color: '#fb923c' },
  { role: 'fx', name: 'FX', volumeDb: -9, color: '#a78bfa' },
  { role: 'crash', name: 'Crash', volumeDb: -8, color: '#fef08a' },
  { role: 'hits', name: 'Hits', volumeDb: -6, color: '#fde68a' },
  { role: 'atmos', name: 'Atmos', volumeDb: -11, color: '#94a3b8' },
]
/** Lanes that keep playing in the beat or two of silence before a drop. */
const THROUGH_SILENCE = new Set<Role>(['fills', 'fx', 'hits'])

export function laneRole(laneName: string): Role | undefined {
  return LANES.find((x) => x.name === laneName)?.role
}
const TOP_ROLES: Role[] = ['top', 'top2', 'top3', 'top4']
const CLAP_ROLES: Role[] = ['clap', 'clap2', 'clap3']

/** Lane volumes = the starting mix + the Generate view's sliders (dB per group). */
export function applyMix(project: Project, mix: Mix): void {
  for (const lane of project.lanes) {
    const l = LANES.find((x) => x.name === lane.name)
    if (l) lane.volumeDb = l.volumeDb + (mix[l.role] ?? 0)
  }
}

/** Lanes whose main sample can be kept while cycling. */
export const KEEPABLE: Role[] = ['kick', 'clap', 'hats', 'perc', 'top', 'groove']

export interface GenerateOptions {
  bpm: number
  minMinutes: number
  maxMinutes: number
  /** Only samples from these zips; null = all. */
  zipIds: number[] | null
  /** Favourites and ratings make samples more likely. */
  useRatings: boolean
  /** Volume per lane in dB, on top of the starting mix. */
  mix?: Mix
  /**
   * Project tempo: a whole BPM from this range per track (min = max for a fixed one); null or
   * left out = the library BPM (`bpm`). Loops are sliced and FX stretched to it in playback.
   */
  tempo?: { min: number; max: number } | null
}

export interface Keep {
  structure?: Section[]
  key?: string | null
  picks?: Partial<Record<Role, SampleListItem>>
}

export interface Generation {
  seed: number
  project: Project
  sections: Section[]
  key: string | null
  /** Human-readable choices: structure, build styles, kick treatments, pattern variations. */
  choices: string[]
  /** Source codes of the zips the samples come from. */
  zips: string[]
  /** The main sample per lane (for "keep"). */
  picks: Partial<Record<Role, SampleListItem>>
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

type Steps = Velocity[]

function steps(hits: number[], v: Velocity = 3): Steps {
  const out: Steps = new Array(STEPS_PER_BAR).fill(0)
  for (const h of hits) out[h] = v
  return out
}

const FOUR = [0, 4, 8, 12]
const TWO_FOUR = [4, 12]
const OFFBEAT = [2, 6, 10, 14]
const EIGHTHS = [0, 2, 4, 6, 8, 10, 12, 14]
const SIXTEENTHS = Array.from({ length: STEPS_PER_BAR }, (_, i) => i)

/** Kick variations at the end of a phrase ("leave a kick out at the end of 8 bars"). */
const KICK_PHRASE_ENDS: [Steps, number][] = [
  [steps([0, 4, 8]), 4],              // last kick out
  [steps([0, 4]), 2],                 // last two out
  [steps([0, 4, 8, 14]), 1.5],        // last kick pushed to the 16th before the one
  [[3, 0, 0, 0, 3, 0, 0, 0, 3, 0, 0, 0, 3, 0, 2, 3], 1],  // a little kick roll into the one
]

// ---------------------------------------------------------------------------
// Sample pools and picks
// ---------------------------------------------------------------------------

const of = (kind: SampleKind, ...cats: Category[]) => (s: SampleListItem) => s.kind === kind && cats.includes(s.category)
const TONAL: Category[] = ['fx_riser', 'fx_downlifter', 'fx_atmos', 'fx']

/** Bars from an event's start to where its main sound ends (tail excluded). */
export function bodyBars(s: SampleListItem): number {
  if (s.body_bars) return s.body_bars
  const bars = s.bars ?? 1
  return bars > 1 ? bars - 1 : bars  // libraries from before body_bars: assume a one-bar tail
}

class Picker {
  private used = new Map<number, number>()
  private keys: Set<string> | null

  constructor(private rng: Rng, private ratings: boolean, key: string | null) {
    this.keys = key ? new Set(expandCompatible([key])) : null
  }

  private weight(s: SampleListItem): number {
    return this.ratings ? 1 + (s.favorite ? 2 : 0) + (s.rating ?? 0) * 0.4 : 1
  }

  /** Mark a kept sample's zip as used, so other lanes still spread over other zips. */
  use(s: SampleListItem): SampleListItem {
    this.used.set(s.zip_id, (this.used.get(s.zip_id) ?? 0) + 1)
    return s
  }

  /**
   * A sample from `cands`: from the least-used zips (so lanes come from different imports),
   * in the track key's neighbourhood for tonal FX, weighted by favourites/ratings.
   */
  pick(cands: SampleListItem[], opts: { tonal?: boolean; weight?: (s: SampleListItem) => number; not?: SampleListItem | null } = {}): SampleListItem | null {
    let c = opts.not ? cands.filter((s) => s.id !== opts.not!.id) : cands
    if (!c.length) c = cands
    if (!c.length) return null
    if (opts.tonal && this.keys) {
      const inKey = c.filter((s) => s.key_label && this.keys!.has(s.key_label))
      if (inKey.length) c = inKey
    }
    const least = Math.min(...c.map((s) => this.used.get(s.zip_id) ?? 0))
    c = c.filter((s) => (this.used.get(s.zip_id) ?? 0) === least)
    return this.use(this.rng.pickBy(c, (s) => this.weight(s) * (opts.weight?.(s) ?? 1)))
  }
}

function chooseKey(rng: Rng, samples: SampleListItem[]): string | null {
  const tonal = samples.filter((s) => s.kind === 'event' && TONAL.includes(s.category) && s.key_label)
  const pool = tonal.length ? tonal : samples.filter((s) => s.key_label)
  return pool.length ? rng.pick(pool).key_label : null
}

// ---------------------------------------------------------------------------
// Lane contents (bar by bar), then clips
// ---------------------------------------------------------------------------

interface BarPattern {
  sample: SampleListItem
  steps: Steps
  filter?: ClipFilter
}

interface Segment {
  sample: SampleListItem
  start: number    // beats
  length: number   // beats
  filter?: ClipFilter
}

class Lanes {
  bars = new Map<Role, (BarPattern | null)[]>()
  segs = new Map<Role, Segment[]>()

  constructor(private total: number) {}

  setBar(role: Role, bar: number, p: BarPattern | null): void {
    if (bar < 0 || bar >= this.total) return
    if (!this.bars.has(role)) this.bars.set(role, new Array(this.total).fill(null))
    this.bars.get(role)![bar] = p
  }

  add(role: Role, seg: Segment): void {
    if (seg.length <= 0 || seg.start < 0) return
    if (!this.segs.has(role)) this.segs.set(role, [])
    this.segs.get(role)!.push(seg)
  }

  /**
   * Silence [from, to) beats on every lane but `keep`: pattern steps are cleared, loops end
   * early (a drop's moment of silence).
   */
  silence(from: number, to: number, keep: Set<Role>): void {
    for (const [role, bars] of this.bars) {
      if (keep.has(role)) continue
      for (let b = Math.floor(from / BEATS_PER_BAR); b * BEATS_PER_BAR < to; b++) {
        const p = bars[b]
        if (!p) continue
        const s0 = Math.max(0, Math.round((from - b * BEATS_PER_BAR) * 4))
        const s1 = Math.min(STEPS_PER_BAR, Math.round((to - b * BEATS_PER_BAR) * 4))
        const steps = p.steps.map((v, i) => (i >= s0 && i < s1 ? 0 : v)) as Steps
        bars[b] = steps.some((v) => v) ? { ...p, steps } : null
      }
    }
    for (const [role, segs] of this.segs) {
      if (keep.has(role)) continue
      this.segs.set(role, segs.flatMap((s) => {
        const end = s.start + s.length
        if (end <= from || s.start >= to) return [s]
        return s.start < from ? [{ ...s, length: from - s.start }] : []
      }))
    }
  }

  /** Bar patterns become pattern clips (runs of identical bars merge); segments become audio clips. */
  clips(laneIds: Map<Role, string>): Clip[] {
    const out: Clip[] = []
    for (const [role, bars] of this.bars) {
      const laneId = laneIds.get(role)!
      let run: { start: number; len: number; p: BarPattern; key: string } | null = null
      const flush = () => {
        if (!run) return
        const c: PatternClip = {
          id: uid('c'), laneId, type: 'pattern', start: run.start * BEATS_PER_BAR, length: run.len * BEATS_PER_BAR,
          gainDb: 0, sample: sampleRef(run.p.sample), patternBars: 1, steps: [...run.p.steps],
        }
        if (run.p.filter) c.filter = { ...run.p.filter }
        out.push(c)
        run = null
      }
      bars.forEach((p, b) => {
        const key = p ? `${p.sample.rel_path}|${p.steps.join('')}|${JSON.stringify(p.filter ?? null)}` : ''
        if (run && key === run.key) run.len++
        else {
          flush()
          if (p) run = { start: b, len: 1, p, key }
        }
      })
      flush()
    }
    for (const [role, segs] of this.segs) {
      const laneId = laneIds.get(role)!
      const sorted = [...segs].sort((a, b) => a.start - b.start)
      const merged: Segment[] = []
      for (const s of sorted) {
        const last = merged[merged.length - 1]
        const L = (s.sample.bars ?? 1) * BEATS_PER_BAR
        if (last && s.sample.kind === 'loop' && last.sample.id === s.sample.id && last.start + last.length === s.start
            && (s.start - last.start) % L === 0 && JSON.stringify(last.filter) === JSON.stringify(s.filter)) {
          last.length += s.length
        } else {
          merged.push({ ...s })
        }
      }
      for (const s of merged) {
        const c: AudioClip = {
          id: uid('c'), laneId, type: 'audio', start: s.start, length: s.length, trimBeats: 0, gainDb: 0,
          sample: sampleRef(s.sample),
        }
        if (s.filter) c.filter = { ...s.filter }
        out.push(c)
      }
    }
    return out.sort((a, b) => a.start - b.start)
  }
}

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

export function generate(all: SampleListItem[], opts: GenerateOptions, seed: number, keep: Keep = {}): Generation {
  const rng = new Rng(seed)
  const samples = opts.zipIds ? all.filter((s) => opts.zipIds!.includes(s.zip_id)) : all
  const bpm = !opts.tempo ? opts.bpm
    : opts.tempo.max > opts.tempo.min ? rng.int(Math.round(opts.tempo.min), Math.round(opts.tempo.max)) : opts.tempo.min
  const minutes = opts.minMinutes + rng.next() * Math.max(0, opts.maxMinutes - opts.minMinutes)
  const sections = keep.structure ? structuredClone(keep.structure) : makeStructure(rng, barsFor(minutes, bpm))
  const total = sections.reduce((n, s) => n + s.bars, 0)
  const key = keep.key !== undefined ? keep.key : chooseKey(rng, samples)
  const picker = new Picker(rng, opts.useRatings, key)
  const choices: string[] = []

  // ---- main samples (one per lane for the whole track, variations for later drops) ----
  const pool = (f: (s: SampleListItem) => boolean) => samples.filter(f)
  const kept = (role: Role) => (keep.picks?.[role] ? picker.use(keep.picks[role]!) : null)
  const loopsOf = (...cats: Category[]) => pool(of('loop', ...cats))
  const preferShort = (s: SampleListItem) => ((s.bars ?? 1) <= 4 ? 2 : 1)

  /** Up to `n` different samples: `first`, then others from `cands`. */
  const layers = (first: SampleListItem | null, cands: SampleListItem[], n: number) => {
    const out = first ? [first] : []
    while (out.length < n) {
      const left = cands.filter((s) => !out.some((o) => o.id === s.id))
      const s = left.length ? picker.pick(left) : null
      if (!s) break
      out.push(s)
    }
    return out
  }

  const kick = kept('kick') ?? picker.pick(pool(of('oneshot', 'kick')))
  const clapShots = pool(of('oneshot', 'clap', 'snare'))
  const clap = kept('clap') ?? picker.pick(clapShots)
  // Layered claps (never a second kick): played together on the backbeat in drops.
  const claps = layers(clap, clapShots, rng.weighted([[1, 2], [2, 3], [3, 2]] as const))
  const hatLoops = loopsOf('hat', 'hat_closed', 'hat_open', 'shaker')
  // Rides come in later (drops only), never in intros and outros.
  const ride = picker.pick(loopsOf('ride')) ?? picker.pick(pool(of('oneshot', 'ride')))
  const rideSteps = steps(rng.chance(0.5) ? FOUR.map((s) => s + 2) : EIGHTHS, 2)
  const hats = kept('hats') ?? (picker.pick(hatLoops, { weight: preferShort })
    ?? picker.pick(pool(of('oneshot', 'hat_closed', 'hat', 'hat_open'))))
  const hats2 = hats?.kind === 'loop' && rng.chance(0.55) ? picker.pick(hatLoops, { not: hats }) : null
  const percLoops = loopsOf('perc')
  const perc = kept('perc') ?? (picker.pick(percLoops, { weight: preferShort }) ?? picker.pick(pool(of('oneshot', 'perc', 'shaker'))))
  const perc2 = perc?.kind === 'loop' && rng.chance(0.6) ? picker.pick(percLoops, { not: perc }) : null
  const topLoops = loopsOf('top')
  // Top loops fill the track up: two to four of them, layered in drops and builds.
  const tops = layers(kept('top') ?? picker.pick(topLoops), topLoops, rng.weighted([[2, 2], [3, 3], [4, 2]] as const))
  const top = tops[0] ?? null
  const groove = kept('groove') ?? picker.pick(loopsOf('groove'))
  const groove2 = groove ? picker.pick(loopsOf('groove'), { not: groove }) : null
  const picks: Partial<Record<Role, SampleListItem>> = {}
  for (const [role, s] of [['kick', kick], ['clap', clap], ['hats', hats], ['perc', perc], ['top', top], ['groove', groove]] as const) {
    if (s) picks[role] = s
  }

  const fills = pool(of('event', 'fill'))
  const rolls = pool(of('event', 'roll'))
  const risers = pool(of('event', 'fx_riser'))
  const downs = pool(of('event', 'fx_downlifter'))
  const impacts = pool(of('event', 'fx_impact'))
  const sweeps = pool(of('event', 'fx_sweep', 'fx'))
  const atmoses = pool(of('event', 'fx_atmos'))
  const crash = picker.pick(pool(of('oneshot', 'cymbal')))
  const atmos = picker.pick(atmoses, { tonal: true })

  // ---- the track's rules ----
  // Decided once per track and applied to every section of the same kind, so a track has its
  // own logic instead of sounding random: if drop 1 has a crash every 16 bars, so does drop 2.
  // Breakdowns are the exception: a break is a break from the rest, so they vary on their own.
  const rules = {
    fx: rng.weighted([['sparse', 1], ['normal', 3], ['busy', 1.5]] as const),
    // Every 16 bars in drops (crashes also in intro and outro): a crash on the 1, the bar before
    // it without kick ("four kicks out"), and/or a fill into it.
    phraseCrash: rng.chance(0.75),
    phraseKickOut: rng.chance(0.5),
    phraseFill: fills.length > 0 && rng.chance(0.55),
    // The same kick variation at the other 8-bar phrase ends of every drop (or none).
    kickEnd8: rng.chance(0.55) ? rng.weighted(KICK_PHRASE_ENDS) : null,
    clapGhost: rng.chance(0.3) ? rng.pick([7, 15, 14]) : null,
    clapRolls: rng.weighted([['none', 3], ['16', 2], ['8', 1]] as const),
    // Into every drop: four kicks out (or just the last kick), roll or fill, riser, impact,
    // a beat or two of silence, and always a crash on the 1.
    dropKickOut: rng.chance(0.75),
    dropLastKick: rng.chance(0.5),
    dropFill: rolls.length && rng.chance(0.45) ? 'roll' as const : fills.length && rng.chance(0.85) ? 'fill' as const : null,
    dropRiser: risers.length > 0 && rng.chance(0.8),
    dropImpact: impacts.length > 0 && rng.chance(0.5),
    dropSilence: rng.weighted([[0, 1], [1, 2], [2, 2]] as const),
    // Into every breakdown.
    breakFill: fills.length > 0 && rng.chance(0.7),
    breakCrash: rng.chance(0.5),
    breakLastKick: rng.chance(0.4),
    breakDownlifter: downs.length > 0 && rng.chance(0.6),
    breakSweep: sweeps.length > 0 && rng.chance(0.35),
    loopGap: rng.weighted([[0, 3], [1, 1], [2, 1]] as const),
    // Drops: how many top loops (the last drop one more), groove and second perc from which drop,
    // a later groove variation, a switch of loops halfway.
    dropTops: Math.max(1, Math.min(tops.length, rng.int(2, 3))),
    grooveFrom: rng.chance(0.6) ? 0 : 1,
    grooveSwap: !!groove2 && rng.chance(0.4),
    perc2From: rng.chance(0.4) ? 0 : 1,
    switchHalfway: rng.chance(0.25),
    // Rides: later in the first drop, and/or all through the later ones.
    ride: rng.weighted([['late', 2], ['second', 2], ['both', 3]] as const),
    // Intro and outro mirror each other: tops, claps and perc come in the same way they leave.
    ioTopFirst: rng.chance(0.65) ? 0 : 0.5,
    ioTopSecond: tops.length > 1 && rng.chance(0.75) ? rng.pick([0.5, 0.75]) : null,
    ioClaps: rng.chance(0.3),
    ioPerc: rng.chance(0.6),
    outroFill: fills.length > 0 && rng.chance(0.5),
    outroCrash: rng.chance(0.8),
    // The kick's sub thinned out a little in intro and outro, so it mixes over another track.
    ioKickHp: rng.int(60, 110),
    hatsInBreaks: rng.chance(0.5),
  }
  const fxChance = { sparse: 0.45, normal: 0.75, busy: 0.95 }[rules.fx]

  const lanes = new Lanes(total)
  const loop = (role: Role, s: SampleListItem | null, fromBar: number, toBar: number, filter?: ClipFilter, gapBeats = 0) => {
    if (s && toBar > fromBar) lanes.add(role, { sample: s, start: fromBar * 4, length: (toBar - fromBar) * 4 - gapBeats, filter })
  }
  /** A loop lane that may be a one-shot pattern when no loop was found. */
  const layer = (role: Role, s: SampleListItem | null, fromBar: number, toBar: number, shotSteps: Steps, filter?: ClipFilter, gapBeats = 0) => {
    if (!s) return
    if (s.kind === 'loop') loop(role, s, fromBar, toBar, filter, gapBeats)
    else for (let b = fromBar; b < toBar; b++) lanes.setBar(role, b, { sample: s, steps: shotSteps, filter })
  }
  const place = (role: Role, s: SampleListItem | null, startBeat: number) => {
    if (s) lanes.add(role, { sample: s, start: startBeat, length: (s.bars ?? 1) * 4 })
  }
  /** One sample per job for the whole track (the track's fill, roll, riser, …); another only if it doesn't fit. */
  const chosen = new Map<string, SampleListItem>()
  const trackPick = (job: string, cands: SampleListItem[], tonal = false) => {
    let s = chosen.get(job) ?? null
    if (!s || !cands.some((c) => c.id === s!.id)) {
      s = picker.pick(cands, { tonal })
      if (s && !chosen.has(job)) chosen.set(job, s)
    }
    return s
  }
  /** An event (riser, roll, fill) whose main sound ends exactly on `endBeat`, if one fits in `room` beats. */
  const endOn = (job: string, role: Role, cands: SampleListItem[], endBeat: number, room: number, want: number, tonal = false) => {
    const fit = cands.filter((s) => bodyBars(s) * 4 <= room)
    let s = chosen.get(job) ?? null
    if (!s || !fit.some((c) => c.id === s!.id)) {
      s = picker.pick(fit, { tonal, weight: (x) => 1 / (1 + Math.abs(bodyBars(x) - want)) })
      if (s && !chosen.has(job)) chosen.set(job, s)
    }
    if (s) place(role, s, endBeat - bodyBars(s) * 4)
    return s
  }

  const crashAt = new Set<number>()
  const tracks = { tops: Math.min(tops.length, rules.dropTops) }
  let dropIndex = 0
  sections.forEach((sec, i) => {
    const a = sec.start
    const z = sec.start + sec.bars
    const next = sections[i + 1]
    const intoDrop = next?.kind === 'drop'
    const intoBreak = next?.kind === 'break'
    const half = a + Math.floor(sec.bars / 2 / PHRASE) * PHRASE || a + sec.bars / 2
    /** Bars where a 16-bar part starts inside this section (bar 17, 33, …). */
    const marks: number[] = []
    for (let b = a + 2 * PHRASE; b < z; b += 2 * PHRASE) marks.push(b)

    // ---- kick ----
    const kickBar = (b: number, s: Steps, filter?: ClipFilter) => kick && lanes.setBar('kick', b, { sample: kick, steps: s, filter })
    if (sec.kind === 'break') {
      const mode = sec.kick ?? 'out'
      const filter: ClipFilter | undefined = mode === 'filtered' ? { type: 'lowpass', from: rng.int(150, 400), to: null, q: 0.9 }
        : mode === 'sweep' ? { type: 'lowpass', from: 120, to: 16000, q: 1.2 }
          : mode === 'thin' ? { type: 'highpass', from: rng.int(180, 350), to: null, q: 0.7 } : undefined
      const pat = mode === 'downbeats' ? steps([0]) : steps(FOUR)
      if (mode !== 'out') for (let b = a; b < z; b++) kickBar(b, pat, filter)
      if (mode !== 'out' && intoDrop && rules.dropKickOut) lanes.setBar('kick', z - 1, null)
      else if (mode !== 'out' && mode !== 'sweep' && intoDrop && rules.dropLastKick) kickBar(z - 1, steps([0, 4, 8]), filter)
    } else if (sec.kind === 'intro' || sec.kind === 'outro') {
      // DJ intro/outro: a steady, slightly high-passed kick; crashes follow the track's 16-bar rule.
      for (let b = a; b < z; b++) kickBar(b, steps(FOUR), { type: 'highpass', from: rules.ioKickHp, to: null, q: 0.7 })
      if (rules.phraseCrash) for (const m of marks) crashAt.add(m)
    } else {
      for (let b = a; b < z; b++) kickBar(b, steps(FOUR))
      if (sec.kind === 'drop') {
        for (let b = a + PHRASE; b < z; b += PHRASE) {
          if (marks.includes(b)) {
            if (rules.phraseKickOut) lanes.setBar('kick', b - 1, null)
            if (rules.phraseKickOut || rules.phraseCrash) crashAt.add(b)
          } else if (rules.kickEnd8 && b < z) {
            kickBar(b - 1, rules.kickEnd8)
          }
        }
      }
      if (intoDrop && rules.dropKickOut) lanes.setBar('kick', z - 1, null)
      else if ((intoDrop && rules.dropLastKick) || (intoBreak && rules.breakLastKick)) kickBar(z - 1, steps([0, 4, 8]))
    }

    // ---- clap ----
    const clapBar = (b: number, s: Steps) => clap && lanes.setBar('clap', b, { sample: clap, steps: s })
    /** All clap layers together (drops). */
    const clapsBar = (b: number, s: Steps) => claps.forEach((c, i) => lanes.setBar(CLAP_ROLES[i], b, { sample: c, steps: s }))
    if (sec.kind === 'drop') {
      const s = steps(TWO_FOUR)
      if (rules.clapGhost != null) s[rules.clapGhost] = 1
      for (let b = a; b < z; b++) clapsBar(b, s)
      const every = rules.clapRolls === '8' ? PHRASE : 2 * PHRASE
      if (rules.clapRolls !== 'none') {
        for (let b = a + every - 1; b < z; b += every) clapsBar(b, [0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 2, 2, 3, 3])
      }
    } else if (sec.kind === 'build') {
      const style_ = sec.build ?? 'layered'
      for (let b = a; b < z; b++) {
        const t = (b - a) / sec.bars
        if (style_ === 'doubletime') {
          // Density doubles towards the drop: quarters, 8ths, 16ths, louder as it goes.
          clapBar(b, t < 1 / 3 ? steps(FOUR, 2) : t < 2 / 3 ? steps(EIGHTHS, 2) : steps(SIXTEENTHS, b === z - 1 ? 3 : 2))
        } else if (style_ !== 'layered' || b >= a + Math.min(PHRASE, sec.bars / 2)) {
          clapBar(b, steps(TWO_FOUR))
        }
      }
    } else if (sec.kind === 'break' && rng.chance(0.3)) {
      for (let b = a; b < z; b++) clapBar(b, steps(TWO_FOUR, 2))
    } else if (sec.kind === 'intro' && rules.ioClaps) {
      for (let b = half; b < z; b++) clapBar(b, steps(TWO_FOUR, 2))
    } else if (sec.kind === 'outro' && rules.ioClaps) {
      for (let b = a; b < half; b++) clapBar(b, steps(TWO_FOUR, 2))
    }

    // ---- hats: always in intro and outro (DJ mixing), in breaks by the track's rule ----
    const hatShot = (v: Velocity = 3) => steps(OFFBEAT, v)
    if (sec.kind === 'break') {
      if (rules.hatsInBreaks) layer('hats', hats, a, z, hatShot(2), { type: 'highpass', from: 900, to: null, q: 0.7 })
    } else {
      layer('hats', hats, a, z, hatShot())
      // A second hat loop on top in drops (and the second half of long builds).
      if (sec.kind === 'drop') loop('hats2', hats2, a, z)
      else if (sec.kind === 'build' && sec.bars >= 2 * PHRASE) loop('hats2', hats2, z - PHRASE, z)
    }

    // ---- ride: drops only, later in the first one and/or all through the later ones ----
    if (sec.kind === 'drop' && ride) {
      const late = dropIndex === 0 && rules.ride !== 'second'
      const full = dropIndex >= 1 && rules.ride !== 'late'
      const from = late ? a + Math.max(PHRASE, Math.floor(sec.bars / 2 / PHRASE) * PHRASE) : full ? a : z
      if (from < z) layer('ride', ride, from, z, rideSteps)
      if (late && from < z && rules.phraseCrash) crashAt.add(from)  // only if the track crashes on new parts
    }

    // ---- perc ----
    const percShot = steps([3, 7, 10, 14], 2)
    if (sec.kind === 'drop') {
      layer('perc', perc, a, z, percShot)
      if (dropIndex >= rules.perc2From || sec.peak) loop('perc2', perc2, a, z)
    } else if (sec.kind === 'intro') { if (rules.ioPerc) layer('perc', perc, half, z, percShot) }
    else if (sec.kind === 'outro') { if (rules.ioPerc) layer('perc', perc, a, half, percShot) }
    else if (sec.kind === 'build') layer('perc', perc, sec.build === 'layered' ? a + Math.min(PHRASE, sec.bars / 2) : a, z, percShot)
    else if (sec.kind === 'break' && rng.chance(0.6)) {
      layer('perc', perc, a, z, percShot, rng.chance(0.5) ? { type: 'highpass', from: 400, to: null, q: 0.7 } : undefined)
    }

    // ---- tops (layered, each top loop on its own lane) and groove ----
    const gap = intoBreak ? rules.loopGap : 0
    const topLayer = (j: number, from: number, to: number, filter?: ClipFilter, gapBeats = 0) =>
      loop(TOP_ROLES[j], tops[j] ?? null, from, to, filter, gapBeats)
    /** The phrase boundary nearest `frac` of the section; strictly inside it for 0 < frac < 1. */
    const phraseAt = (frac: number) => {
      if (frac <= 0) return a
      if (frac >= 1) return z
      const n = sec.bars / PHRASE
      return a + Math.max(1, Math.min(n - 1, Math.round(n * frac))) * PHRASE
    }
    if (sec.kind === 'drop') {
      // The same top loops in every drop; the last drop adds one more.
      const count = Math.min(tops.length, tracks.tops + (sec.peak ? 1 : 0))
      const mid = rules.switchHalfway && sec.bars >= 2 * PHRASE ? a + Math.floor(sec.bars / 2 / PHRASE) * PHRASE : z
      for (let j = 0; j < count; j++) topLayer(j, a, z, undefined, gap)
      const g1 = dropIndex >= 1 && rules.grooveSwap ? groove2 : groove
      if (dropIndex >= rules.grooveFrom || sec.peak) {
        loop('groove', g1, a, mid, undefined, mid === z ? gap : 0)
        if (mid < z) loop('groove', g1 === groove ? groove2 ?? groove : groove, mid, z, undefined, gap)
      }
      dropIndex++
    } else if (sec.kind === 'build') {
      if (sec.build === 'filter') {
        for (let j = 0; j < Math.min(2, tops.length); j++) topLayer(j, a, z, { type: 'lowpass', from: 300, to: 18000, q: 1 })
      } else if (sec.build === 'all') {
        for (let j = 0; j < tracks.tops; j++) topLayer(j, a, z)
        loop('groove', groove, Math.max(a, z - PHRASE), z)
      } else {
        // Layered and double-time builds: one more top loop per phrase towards the drop.
        const startAt = sec.build === 'doubletime' ? a + Math.floor(sec.bars / 2 / PHRASE) * PHRASE : a
        const phrases = Math.max(1, (z - startAt) / PHRASE)
        for (let j = 0; j < tracks.tops; j++) {
          const from = startAt + Math.floor((j * phrases) / tracks.tops) * PHRASE
          if (from < z) topLayer(j, from, z)
        }
      }
    } else if (sec.kind === 'break' && rng.chance(0.35)) {
      topLayer(0, a, z, { type: 'lowpass', from: 600, to: null, q: 0.7 })
    } else if (sec.kind === 'intro') {
      // Mix-in intro: a top loop from the start (or halfway), a second one joining later …
      topLayer(0, phraseAt(rules.ioTopFirst), z)
      if (rules.ioTopSecond != null) topLayer(1, phraseAt(rules.ioTopSecond), z)
    } else if (sec.kind === 'outro') {
      // … and the outro mirrors it: the tops leave the way they came in.
      topLayer(0, a, phraseAt(1 - rules.ioTopFirst))
      if (rules.ioTopSecond != null) topLayer(1, a, phraseAt(1 - rules.ioTopSecond))
    }

    // ---- atmos in breakdowns ----
    if (sec.kind === 'break' && atmos && rng.chance(0.85)) loop('atmos', atmos, a, z)

    // ---- transitions: the track's own way into drops, breakdowns and the outro ----
    if (next) {
      const end = z * 4
      if (intoDrop) {
        if (rules.dropFill === 'roll') {
          if (!endOn(sec.long ? 'roll-long' : 'roll', 'fills', rolls, end, sec.bars * 4, sec.long ? 8 : 4) && fills.length) {
            endOn('fill', 'fills', fills, end, 8, 1)
          }
        } else if (rules.dropFill === 'fill') {
          endOn('fill', 'fills', fills, end, 8, 1)
        }
        if (rules.dropRiser) endOn(sec.long ? 'riser-long' : 'riser', 'fx', risers, end, sec.bars * 4, sec.long ? 8 : sec.bars >= 16 ? 4 : 2, true)
        if (rules.dropImpact) place('hits', trackPick('impact', impacts), end)
        crashAt.add(z)  // every drop starts with a crash
      } else if (intoBreak) {
        if (rules.breakFill) endOn('fill', 'fills', fills, end, 8, 1)
        if (rules.breakCrash) crashAt.add(z)
        if (rules.breakDownlifter && rng.chance(fxChance)) place('hits', trackPick('downlifter', downs, true), end)
        if (rules.breakSweep) place('fx', trackPick('sweep', sweeps), end)
      } else if (next.kind === 'outro') {
        if (rules.outroFill) endOn('fill', 'fills', fills, end, 8, 1)
        if (rules.outroCrash) crashAt.add(z)
      }
    }
    // The track's fill into every 16-bar part of a drop.
    if (sec.kind === 'drop' && rules.phraseFill) for (const m of marks) endOn('fill', 'fills', fills, m * 4, 8, 1)
  })

  // ---- crashes on the 1 of key moments ----
  if (crash) for (const b of crashAt) if (b < total) lanes.setBar('crash', b, { sample: crash, steps: steps([0]) })

  // ---- the track's beat or two of silence before every drop (FX, fills and hits ring through) ----
  if (rules.dropSilence) {
    for (const s of sections) {
      if (s.kind === 'drop' && s.start > 0) lanes.silence(s.start * 4 - rules.dropSilence, s.start * 4, THROUGH_SILENCE)
    }
  }

  // ---- the project ----
  const project = newProject('Generated', bpm)
  project.lengthBars = total
  project.lanes = LANES.map((l, i) => ({ ...makeLane(l.name, i), color: l.color, volumeDb: l.volumeDb }))
  applyMix(project, opts.mix ?? {})
  const laneIds = new Map(LANES.map((l, i) => [l.role, project.lanes[i].id]))
  project.clips = lanes.clips(laneIds)
  const used = new Set(project.clips.map((c) => c.laneId))
  project.lanes = project.lanes.filter((l) => used.has(l.id))
  project.markers = sections.map((s) => makeMarker(s.label, s.start * 4, (s.start + s.bars) * 4))

  // ---- what was chosen ----
  const n = (k: Section['kind']) => sections.filter((s) => s.kind === k).length
  choices.push(`${n('drop')} drops, ${n('break')} breakdown${n('break') === 1 ? '' : 's'}`)
  for (const s of sections) {
    if (s.kind === 'build') choices.push(BUILD_LABEL[s.build ?? 'layered'])
    if (s.kind === 'break') choices.push(`${s.label}: ${KICK_MODE_LABEL[s.kick ?? 'out']}${s.long ? ' (long)' : ''}`)
  }
  if (bpm !== opts.bpm) choices.push(`${bpm} BPM (library ${opts.bpm})`)
  if (rules.phraseCrash) choices.push('crash every 16 bars')
  if (rules.phraseKickOut) choices.push('four kicks out every 16 bars')
  if (rules.phraseFill) choices.push('fill every 16 bars')
  if (rules.kickEnd8) choices.push('kick variation every 8 bars')
  if (rules.clapRolls !== 'none') choices.push(`clap rolls every ${rules.clapRolls} bars`)
  if (rules.clapGhost != null) choices.push('ghost claps')
  if (rules.loopGap) choices.push('loops stop before breaks')
  if (tops.length > 1) choices.push(`${Math.min(tops.length, tracks.tops + 1)} top loops`)
  if (claps.length > 1) choices.push(`${claps.length} layered claps`)
  if (ride) choices.push({ late: 'ride later in drop 1', second: 'ride from drop 2', both: 'ride late in drop 1, then all through' }[rules.ride])
  if (rules.dropKickOut) choices.push('four kicks out before drops')
  if (rules.dropSilence) choices.push(`${rules.dropSilence} beat${rules.dropSilence > 1 ? 's' : ''} of silence before drops`)
  choices.push(`${rules.fx} FX`)

  const byId = new Map(samples.map((s) => [s.rel_path, s]))
  const zips = [...new Set(project.clips.map((c) => byId.get(c.sample.relPath)?.source_code).filter((x): x is string => !!x))].sort()
  return { seed, project, sections, key, choices, zips, picks }
}
