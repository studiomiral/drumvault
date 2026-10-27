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

export type Role = 'kick' | 'clap' | 'hats' | 'perc' | 'top' | 'groove' | 'fills' | 'fx' | 'hits' | 'atmos'

/** Lanes of a generated project, in order, with a starting mix. */
export const LANES: { role: Role; name: string; volumeDb: number; color: string }[] = [
  { role: 'kick', name: 'Kick', volumeDb: 0, color: '#e2c35f' },
  { role: 'clap', name: 'Clap', volumeDb: -3, color: '#f472b6' },
  { role: 'hats', name: 'Hats', volumeDb: -6, color: '#22d3ee' },
  { role: 'perc', name: 'Perc', volumeDb: -7, color: '#4ee3a6' },
  { role: 'top', name: 'Tops', volumeDb: -6, color: '#60a5fa' },
  { role: 'groove', name: 'Groove', volumeDb: -8, color: '#a3e635' },
  { role: 'fills', name: 'Fills', volumeDb: -5, color: '#fb923c' },
  { role: 'fx', name: 'FX', volumeDb: -9, color: '#a78bfa' },
  { role: 'hits', name: 'Hits', volumeDb: -6, color: '#fbcfe8' },
  { role: 'atmos', name: 'Atmos', volumeDb: -11, color: '#94a3b8' },
]

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
  const minutes = opts.minMinutes + rng.next() * Math.max(0, opts.maxMinutes - opts.minMinutes)
  const sections = keep.structure ? structuredClone(keep.structure) : makeStructure(rng, barsFor(minutes, opts.bpm))
  const total = sections.reduce((n, s) => n + s.bars, 0)
  const key = keep.key !== undefined ? keep.key : chooseKey(rng, samples)
  const picker = new Picker(rng, opts.useRatings, key)
  const choices: string[] = []

  // ---- main samples (one per lane for the whole track, variations for later drops) ----
  const pool = (f: (s: SampleListItem) => boolean) => samples.filter(f)
  const kept = (role: Role) => (keep.picks?.[role] ? picker.use(keep.picks[role]!) : null)
  const loopsOf = (...cats: Category[]) => pool(of('loop', ...cats))
  const preferShort = (s: SampleListItem) => ((s.bars ?? 1) <= 4 ? 2 : 1)

  const kick = kept('kick') ?? picker.pick(pool(of('oneshot', 'kick')))
  const clap = kept('clap') ?? picker.pick(pool(of('oneshot', 'clap', 'snare')))
  const hatLoops = loopsOf('hat', 'hat_closed', 'hat_open', 'ride', 'shaker')
  const hats = kept('hats') ?? (picker.pick(hatLoops, { weight: preferShort })
    ?? picker.pick(pool(of('oneshot', 'hat_closed', 'hat', 'hat_open'))))
  const percLoops = loopsOf('perc')
  const perc = kept('perc') ?? (picker.pick(percLoops, { weight: preferShort }) ?? picker.pick(pool(of('oneshot', 'perc', 'shaker'))))
  const perc2 = perc?.kind === 'loop' && rng.chance(0.5) ? picker.pick(percLoops, { not: perc }) : null
  const top = kept('top') ?? picker.pick(loopsOf('top'))
  const top2 = top ? picker.pick(loopsOf('top'), { not: top }) : null
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

  // ---- per-track style ----
  const style = {
    dropouts: rng.weighted([[0, 2], [0.3, 3], [0.6, 2]] as const),
    clapGhost: rng.chance(0.3),
    clapRolls: rng.chance(0.35),
    preDropGap: rng.chance(0.4),
    fillRate: rng.pick([0.25, 0.5, 0.75]),
    fx: rng.weighted([['sparse', 1], ['normal', 3], ['busy', 1.5]] as const),
    hatsInBreaks: rng.chance(0.5),
    percIntro: rng.chance(0.6),
    loopGaps: rng.chance(0.4),
    groovyFirstDrop: rng.chance(0.6),
  }
  const fxChance = { sparse: 0.45, normal: 0.75, busy: 0.95 }[style.fx]

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
  /** An event (riser, roll, fill) whose main sound ends exactly on `endBeat`, if one fits in `room` beats. */
  const endOn = (role: Role, cands: SampleListItem[], endBeat: number, room: number, want: number, tonal = false) => {
    const fit = cands.filter((s) => bodyBars(s) * 4 <= room)
    const s = picker.pick(fit, { tonal, weight: (x) => 1 / (1 + Math.abs(bodyBars(x) - want)) })
    if (s) place(role, s, endBeat - bodyBars(s) * 4)
    return s
  }

  let dropIndex = 0
  sections.forEach((sec, i) => {
    const a = sec.start
    const z = sec.start + sec.bars
    const next = sections[i + 1]
    const intoDrop = next?.kind === 'drop'
    const half = a + Math.floor(sec.bars / 2 / PHRASE) * PHRASE || a + sec.bars / 2

    // ---- kick ----
    const kickBar = (b: number, s: Steps, filter?: ClipFilter) => kick && lanes.setBar('kick', b, { sample: kick, steps: s, filter })
    if (sec.kind === 'break') {
      const mode = sec.kick ?? 'out'
      const filter: ClipFilter | undefined = mode === 'filtered' ? { type: 'lowpass', from: rng.int(150, 400), to: null, q: 0.9 }
        : mode === 'sweep' ? { type: 'lowpass', from: 120, to: 16000, q: 1.2 } : undefined
      const pat = mode === 'halftime' ? steps([0, 8]) : mode === 'downbeats' ? steps([0]) : steps(FOUR)
      if (mode !== 'out') for (let b = a; b < z; b++) kickBar(b, pat, filter)
      if (mode !== 'out' && mode !== 'sweep' && intoDrop && style.preDropGap) kickBar(z - 1, steps([0, 4, 8]), filter)
    } else {
      for (let b = a; b < z; b++) kickBar(b, steps(FOUR))
      if (sec.kind === 'drop' || sec.kind === 'build') {
        for (let b = a + PHRASE - 1; b < z - 1; b += PHRASE) {
          if (sec.kind === 'drop' && rng.chance(style.dropouts)) kickBar(b, rng.weighted(KICK_PHRASE_ENDS))
        }
        if ((intoDrop && style.preDropGap) || (next?.kind === 'break' && rng.chance(0.4))) kickBar(z - 1, steps([0, 4, 8]))
      }
    }

    // ---- clap ----
    const clapBar = (b: number, s: Steps) => clap && lanes.setBar('clap', b, { sample: clap, steps: s })
    const backbeat = () => {
      const s = steps(TWO_FOUR)
      if (style.clapGhost) s[rng.pick([7, 15, 14])] = 1
      return s
    }
    if (sec.kind === 'drop') {
      const s = backbeat()
      for (let b = a; b < z; b++) clapBar(b, s)
      for (let b = a + PHRASE - 1; b < z; b += PHRASE) {
        if (style.clapRolls && rng.chance(0.5)) clapBar(b, [0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 2, 2, 3, 3])
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
    } else if (sec.kind === 'outro') {
      for (let b = a; b < half; b++) clapBar(b, steps(TWO_FOUR))
    } else if (sec.kind === 'intro' && rng.chance(0.25)) {
      for (let b = half; b < z; b++) clapBar(b, steps(TWO_FOUR, 2))
    }

    // ---- hats: always in intro and outro (DJ mixing), in breaks by style ----
    const hatShot = (v: Velocity = 3) => steps(OFFBEAT, v)
    if (sec.kind === 'break') {
      if (style.hatsInBreaks) layer('hats', hats, a, z, hatShot(2), { type: 'highpass', from: 900, to: null, q: 0.7 })
    } else {
      layer('hats', hats, a, z, hatShot())
    }

    // ---- perc ----
    const p = sec.kind === 'drop' && dropIndex >= 1 && perc2 ? perc2 : perc
    const percShot = steps([3, 7, 10, 14], 2)
    if (sec.kind === 'intro') { if (style.percIntro) layer('perc', p, half, z, percShot) }
    else if (sec.kind === 'build') layer('perc', p, sec.build === 'layered' ? a + Math.min(PHRASE, sec.bars / 2) : a, z, percShot)
    else if (sec.kind === 'drop') layer('perc', p, a, z, percShot)
    else if (sec.kind === 'break') { if (rng.chance(0.6)) layer('perc', p, a, z, percShot, rng.chance(0.5) ? { type: 'highpass', from: 400, to: null, q: 0.7 } : undefined) }
    else if (sec.kind === 'outro') layer('perc', p, a, half, percShot)

    // ---- tops and groove ----
    const gap = next?.kind === 'break' && style.loopGaps ? rng.pick([1, 2]) : 0
    if (sec.kind === 'drop') {
      const t1 = dropIndex >= 1 && top2 && rng.chance(0.6) ? top2 : top
      const g1 = dropIndex >= 1 && groove2 && rng.chance(0.5) ? groove2 : groove
      const mid = sec.switchHalfway && sec.bars >= 2 * PHRASE ? a + Math.floor(sec.bars / 2 / PHRASE) * PHRASE : z
      loop('top', t1, a, mid, undefined, mid === z ? gap : 0)
      if (mid < z) loop('top', t1 === top ? top2 ?? top : top, mid, z, undefined, gap)
      if (sec.peak || dropIndex > 0 || style.groovyFirstDrop) {
        loop('groove', g1, a, mid, undefined, mid === z ? gap : 0)
        if (mid < z) loop('groove', g1 === groove ? groove2 ?? groove : groove, mid, z, undefined, gap)
      }
      dropIndex++
    } else if (sec.kind === 'build') {
      if (sec.build === 'filter') loop('top', top, a, z, { type: 'lowpass', from: 300, to: 18000, q: 1 })
      else if (sec.build === 'all') { loop('top', top, a, z); loop('groove', groove, Math.max(a, z - PHRASE), z) }
      else if (sec.build === 'doubletime') loop('top', top, a + Math.floor(sec.bars / 2 / PHRASE) * PHRASE, z)
      else if (sec.bars >= 2 * PHRASE) loop('top', top, z - PHRASE, z)
    } else if (sec.kind === 'break' && rng.chance(0.25)) {
      loop('top', top, a, z, { type: 'lowpass', from: 600, to: null, q: 0.7 })
    } else if (sec.kind === 'outro') {
      loop('top', top, a, Math.min(z, a + PHRASE))
    }

    // ---- atmos in breakdowns ----
    if (sec.kind === 'break' && atmos && rng.chance(0.85)) loop('atmos', atmos, a, z)

    // ---- transitions: fills, rolls, risers, downlifters, impacts, crashes ----
    if (next) {
      const end = z * 4
      if (intoDrop) {
        let roll: SampleListItem | null = null
        if (rolls.length && rng.chance(0.45)) roll = endOn('fills', rolls, end, sec.bars * 4, sec.long ? 8 : 4)
        if (!roll && fills.length && rng.chance(0.85)) endOn('fills', fills, end, 8, 1)
        if (risers.length && rng.chance(fxChance)) endOn('fx', risers, end, sec.bars * 4, sec.long ? 8 : sec.bars >= 16 ? 4 : 2, true)
        if (impacts.length && rng.chance(fxChance * 0.6)) place('hits', picker.pick(impacts), end)
        else if (crash && rng.chance(0.6)) lanes.setBar('hits', z, { sample: crash, steps: steps([0]) })
      } else if (next.kind === 'break') {
        if (fills.length && rng.chance(0.7)) endOn('fills', fills, end, 8, 1)
        if (downs.length && rng.chance(fxChance * 0.7)) place('hits', picker.pick(downs, { tonal: true }), end)
        if (sweeps.length && rng.chance(style.fx === 'busy' ? 0.5 : 0.2)) place('fx', picker.pick(sweeps), end)
      } else if (next.kind === 'outro') {
        if (fills.length && rng.chance(0.5)) endOn('fills', fills, end, 8, 1)
        if (crash && rng.chance(0.5)) lanes.setBar('hits', z, { sample: crash, steps: steps([0]) })
      }
    }
    // Fills inside drops, at 16-bar phrase ends.
    if (sec.kind === 'drop' && fills.length) {
      for (let b = a + 2 * PHRASE; b < z; b += 2 * PHRASE) if (rng.chance(style.fillRate)) endOn('fills', fills, b * 4, 8, 1)
    }
  })

  // ---- the project ----
  const project = newProject('Generated', opts.bpm)
  project.lengthBars = total
  project.lanes = LANES.map((l, i) => ({ ...makeLane(l.name, i), color: l.color, volumeDb: l.volumeDb }))
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
  if (style.dropouts) choices.push('kick drop-outs at phrase ends')
  if (style.clapRolls) choices.push('clap rolls')
  if (style.clapGhost) choices.push('ghost claps')
  if (style.loopGaps) choices.push('loops stop before breaks')
  choices.push(`${style.fx} FX`)

  const byId = new Map(samples.map((s) => [s.rel_path, s]))
  const zips = [...new Set(project.clips.map((c) => byId.get(c.sample.relPath)?.source_code).filter((x): x is string => !!x))].sort()
  return { seed, project, sections, key, choices, zips, picks }
}
