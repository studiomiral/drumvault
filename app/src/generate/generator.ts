// The generator (SCOPE.md §6.6): builds a complete drum arrangement from the library.
//
// generate(samples, options, seed, keep) is pure: it picks a structure (a real track's, changed
// a little: template.ts, or one from the grammar: structure.ts), a key for tonal FX, one main
// sample per lane (spread over different zips, matching the feel of the main loop), per-track
// style choices (kick drop-outs, clap rolls, FX density, loop variations, …), then writes every
// lane bar by bar, makes sure something changes every 8 bars, and turns that into ordinary
// Arrange clips. The same seed + library + options + keep gives the same arrangement.

import { expandCompatible } from '../lib/camelot'
import { BEATS_PER_BAR, makeLane, makeMarker, newProject, sampleRef, STEPS_PER_BAR, uid } from '../lib/project'
import type { Category, SampleKind } from '../types/engine'
import { bassPath } from '../audio/schedule'
import type { MidiItem, SampleListItem, SerumPreset, TrackArrangement } from '../types/api'
import type { AudioClip, BassRender, Clip, ClipFilter, PatternClip, Project, StepGroove, Velocity } from '../types/project'
import { bassModel, generatedMidi, generateBassline, isGenerated } from './bassline'
import { keysModel, generateKeys, generatedKeysMidi } from './keys'
import { audible, feelFit, grooveFor, hasFeel, stepGroove } from './feel'
import { Rng } from './rng'
import { barsFor, BUILD_LABEL, KICK_MODE_LABEL, makeStructure, PHRASE, type Section } from './structure'
import { templateFrom } from './template'

export type Role = 'kick' | 'clap' | 'clap2' | 'clap3' | 'hats' | 'hats2' | 'ride' | 'perc' | 'perc2'
  | 'top' | 'top2' | 'top3' | 'top4' | 'groove' | 'bass' | 'keys' | 'fills' | 'fx' | 'fx2' | 'crash' | 'hits' | 'atmos'

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
  { role: 'bass', name: 'Bass', volumeDb: -4, color: '#fda4af' },
  { role: 'keys', name: 'Keys', volumeDb: -7, color: '#c4b5fd' },
  { role: 'fills', name: 'Fills', volumeDb: -5, color: '#fb923c' },
  { role: 'fx', name: 'FX', volumeDb: -9, color: '#a78bfa' },
  { role: 'fx2', name: 'FX 2', volumeDb: -11, color: '#c4b5fd' },
  { role: 'crash', name: 'Crash', volumeDb: -8, color: '#fef08a' },
  { role: 'hits', name: 'Hits', volumeDb: -6, color: '#fde68a' },
  { role: 'atmos', name: 'Atmos', volumeDb: -11, color: '#94a3b8' },
]
/** Lanes that keep playing in the beat or two of silence before a drop. */
const THROUGH_SILENCE = new Set<Role>(['fills', 'fx', 'fx2', 'hits'])

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
  /** Bass (SCOPE.md §6.7): imported basslines and the Serum patch pool; null or empty = no bass. */
  bass?: BassOptions | null
  keys?: BassOptions | null
  /**
   * Project tempo: a whole BPM from this range per track (min = max for a fixed one); null or
   * left out = the library BPM (`bpm`). Loops are sliced and FX stretched to it in playback.
   */
  tempo?: { min: number; max: number } | null
  /**
   * Real tracks' arrangements (the library's processed zips): most generations take one as a
   * template for their structure and rules, changed a little. None: the grammar only.
   */
  templates?: TrackArrangement[] | null
}

/** Share of generations built on a real track's structure when there are templates. */
const TEMPLATE_CHANCE = 0.8

export interface BassOptions {
  /** The MIDI library's basslines: what new basslines are learned from (bassline.ts). */
  midis: MidiItem[]
  /** Loop length of new basslines in bars; null: as long as the library's tend to be. */
  bars?: 1 | 2 | 4 | null
  presets: SerumPreset[]
  /** Starred presets (paths): picked more often. */
  favorites: string[]
  /** Sidechain depth under the kick, 0…1. */
  sidechain: number
}

export interface Keep {
  structure?: Section[]
  key?: string | null
  picks?: Partial<Record<Role, SampleListItem>>
  keysMidi?: MidiItem
  keysPreset?: SerumPreset
  keysEdit?: { notes: [number, number, number, number][]; bars: number }
  bassMidi?: MidiItem
  bassPreset?: SerumPreset
  /** The kept bassline's piano-roll edits. */
  bassEdit?: { notes: [number, number, number, number][]; bars: number }
  /** Track rules to keep (a lane re-roll keeps all but that lane's own). */
  rules?: Rules
  /** Samples (paths) not to pick again when there's another. */
  avoid?: string[]
}

/** The track's rules (see the rules block in generate()), by name. */
export type Rules = Record<string, unknown>

/** The bass of a generation: which bassline through which patch, moved into the track key. */
export interface GenerationBass {
  /** A line written for this track (bassline.ts: generatedMidi), or a file of the MIDI library. */
  midi: MidiItem
  preset: SerumPreset
  /** Semitones to the track key. */
  transpose: number
  /** Edited in the piano roll (this track only): notes at the MIDI's pitch, and the loop length. */
  notes?: [number, number, number, number][]
  bars?: number
  /** The track's feel (16 step offsets), so the bass sits with the loops. */
  groove?: number[]
}

/** What the bass clips render for a generation's bass. */
export function bassRenderOf(b: GenerationBass): BassRender {
  return {
    role: b.midi.role === 'keys' ? 'keys' : 'bass', keyLabel: b.midi.key_label,
    preset: b.preset.path, presetName: b.preset.name, midiId: b.midi.id, midiName: b.midi.name, transpose: b.transpose,
    // A generated line has no file: its notes always go along.
    ...(b.notes || isGenerated(b.midi) ? { notes: b.notes ?? b.midi.notes, bars: b.bars ?? b.midi.bars } : {}),
    ...(b.groove ? { groove: b.groove } : {}),
  }
}

/** Loop length of a generation's bass in bars (edited or the file's). */
export const bassBars = (b: GenerationBass) => b.bars ?? b.midi.bars

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
  bass: GenerationBass | null
  keys: GenerationBass | null
  rules: Rules
  /** Source code of the real track whose structure this one follows, if any. */
  template?: string | null
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

/** Pitches (semitones) for a loop layer played a little higher or lower. */
const PITCHES: [number, number][] = [[-1, 3], [1, 2], [-2, 2], [2, 1]]

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

const PITCH: Record<string, number> = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11,
}

/**
 * Semitones that move a part from one key to another, the nearest way (−6…+5). A major part in
 * a minor track (or the other way) goes to the relative key. Mirror of the engine's
 * midi.transpose_to.
 */
export function transposeTo(from: string | null, to: string | null): number {
  const parse = (k: string) => {
    const m = /^([A-G][#b]?)(m?)$/.exec(k.trim())
    return m && PITCH[m[1]] != null ? { pc: PITCH[m[1]], minor: m[2] === 'm' } : null
  }
  const a = from ? parse(from) : null
  const b = to ? parse(to) : null
  if (!a || !b) return 0
  const pf = a.minor === b.minor ? a.pc : (a.pc + (a.minor ? 3 : -3) + 12) % 12  // to the relative key
  const d = (((b.pc - pf) % 12) + 12) % 12
  return d > 5 ? d - 12 : d
}

/** Bars from an event's start to where its main sound ends (tail excluded). */
export function bodyBars(s: SampleListItem): number {
  if (s.body_bars) return s.body_bars
  const bars = s.bars ?? 1
  return bars > 1 ? bars - 1 : bars  // libraries from before body_bars: assume a one-bar tail
}

// ---- transitions: where events stop before the line they lead into (SCOPE.md §6.6) ----

/** An event stopping this many 16ths (or fewer) before the end of its body runs right up to the line. */
const TO_THE_LINE = 1
/** Events of one transition that stop early stop within this many 16ths of each other. */
const GAP_TOLERANCE = 2
/** An event silent for longer than this before its line doesn't lead into it (a hit on the 1, then a rest). */
const MAX_LEAD_GAP = 8
/** The track's silence before a drop: at most this many 16ths, however early its FX stop. */
const MAX_SILENCE = 8

/** 16ths of silence an event leaves before the end of its body: the producer's own pause before the drop. */
export const gapOf = (s: SampleListItem) => s.shape?.gap ?? 0
const leads = (s: SampleListItem) => gapOf(s) <= MAX_LEAD_GAP

/**
 * Whether an event stopping `gap` 16ths early belongs in a transition stopping `t` early: all
 * run up to the line, or all stop early, about together. Never one riser into the drop and
 * another (or the fill) leaving a beat of silence before it.
 */
export function gapsAgree(gap: number, t: number): boolean {
  return t <= TO_THE_LINE ? gap <= TO_THE_LINE : gap > TO_THE_LINE && Math.abs(gap - t) <= GAP_TOLERANCE
}

const SHAPED_FX: Category[] = ['fx_sweep', 'fx']
/** Builds up to its end: a riser, or a sweep / other FX that measures that way. */
const rising = (s: SampleListItem) => s.category === 'fx_riser' || (SHAPED_FX.includes(s.category) && s.shape?.dir === 'rise')
/** Falls away from its start: a downlifter, or a sweep / other FX that measures that way (unmeasured sweeps too). */
const falling = (s: SampleListItem) => s.category === 'fx_downlifter'
  || (SHAPED_FX.includes(s.category) && (s.shape ? s.shape.dir === 'fall' : s.category === 'fx_sweep'))

/**
 * Whether `b` goes with `a` as a second FX layer into the same line, and how well: another
 * length (a long build with a short lift on top), another texture (noise with a tone), or the
 * same track's. Two of a kind from two tracks don't layer (null).
 */
function complements(a: SampleListItem, b: SampleListItem): number | null {
  const la = bodyBars(a), lb = bodyBars(b)
  const lengths = Math.max(la, lb) / Math.min(la, lb)
  const texture = Math.abs((a.shape?.noise ?? 0.3) - (b.shape?.noise ?? 0.3))
  if (lengths < 1.5 && texture < 0.25 && a.zip_id !== b.zip_id) return null
  return (lengths >= 2 ? 3 : lengths >= 1.5 ? 1.5 : 1) * (1 + 3 * texture) * (a.zip_id === b.zip_id ? 1.5 : 1)
}

/** A loop fits the track's feel from here on (feelFit: 1 the same swing). */
const GOOD_FIT = 0.5

class Picker {
  private used = new Map<number, number>()
  private keys: Set<string> | null

  constructor(private rng: Rng, private ratings: boolean, key: string | null, private avoid = new Set<string>()) {
    this.keys = key ? new Set(expandCompatible([key])) : null
  }

  private weight(s: SampleListItem): number {
    return this.ratings ? 1 + (s.favorite ? 2 : 0) + (s.rating ?? 0) * 0.4 : 1
  }

  /** Not one of the samples to avoid (a lane re-roll's). */
  fresh(s: SampleListItem): boolean {
    return !this.avoid.has(s.rel_path)
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
  pick(cands: SampleListItem[], opts: {
    tonal?: boolean; weight?: (s: SampleListItem) => number; not?: SampleListItem | null
    /** How well a sample fits the track (its feel): good fits come first, before the zip spread. */
    fit?: (s: SampleListItem) => number
  } = {}): SampleListItem | null {
    let c = opts.not ? cands.filter((s) => s.id !== opts.not!.id) : cands
    if (!c.length) c = cands
    if (!c.length) return null
    if (this.avoid.size) {
      const fresh = c.filter((s) => !this.avoid.has(s.rel_path))
      if (fresh.length) c = fresh
    }
    if (opts.tonal && this.keys) {
      const inKey = c.filter((s) => s.key_label && this.keys!.has(s.key_label))
      if (inKey.length) c = inKey
    }
    if (opts.fit) {
      const good = c.filter((s) => opts.fit!(s) >= GOOD_FIT)
      if (good.length) c = good
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
  bass?: BassRender
  /** Loop variations: beats into the loop at `start`, only its first bars, semitones. */
  trim?: number
  loopBars?: number
  pitch?: number
}

/** What a segment repeats, in beats. */
function loopLen(s: Segment): number {
  const bars = s.sample.bars ?? 1
  return Math.max(1, (s.loopBars ? Math.min(s.loopBars, bars) : bars) * BEATS_PER_BAR)
}

/** Segments that play the same way (and so join up into one clip where they meet in phase). */
function alike(a: Segment, b: Segment): boolean {
  return a.sample.id === b.sample.id && (a.pitch ?? 0) === (b.pitch ?? 0) && (a.loopBars ?? 0) === (b.loopBars ?? 0)
    && JSON.stringify(a.filter ?? null) === JSON.stringify(b.filter ?? null) && JSON.stringify(a.bass ?? null) === JSON.stringify(b.bass ?? null)
}

/** Lanes whose one-shot patterns take on the track's feel (the kick and crash stay on the grid). */
const GROOVED = new Set<Role>(['clap', 'clap2', 'clap3', 'hats', 'hats2', 'ride', 'perc', 'perc2', 'top', 'top2', 'top3', 'top4'])

const patternKey = (p: BarPattern) => `${p.sample.rel_path}|${p.steps.join('')}|${JSON.stringify(p.filter ?? null)}`

class Lanes {
  bars = new Map<Role, (BarPattern | null)[]>()
  segs = new Map<Role, Segment[]>()
  /** The track's feel, applied to one-shot patterns on the GROOVED lanes. */
  feel: StepGroove | null = null

  constructor(private total: number) {}

  roles(): Role[] {
    return [...new Set([...this.bars.keys(), ...this.segs.keys()])]
  }

  bar(role: Role, bar: number): BarPattern | null {
    return this.bars.get(role)?.[bar] ?? null
  }

  /** The loop segment of `role` playing all through [from, to) beats, if one does. */
  loopOver(role: Role, from: number, to: number): Segment | null {
    return this.segs.get(role)?.find((s) => s.sample.kind === 'loop' && !s.bass && s.start <= from && s.start + s.length >= to) ?? null
  }

  /**
   * What `role` plays in `bar`: its pattern, and each sound in it (which, how, over which beats,
   * and where its loop is anchored: a loop playing on in phase is the same from bar to bar).
   */
  state(role: Role, bar: number): string {
    const p = this.bar(role, bar)
    let out = p ? patternKey(p) : ''
    const a = bar * BEATS_PER_BAR
    for (const s of this.segs.get(role) ?? []) {
      const from = Math.max(s.start, a)
      const to = Math.min(s.start + s.length, a + BEATS_PER_BAR)
      if (to <= from) continue
      const L = loopLen(s)
      const anchor = s.sample.kind === 'loop' ? (((s.start - (s.trim ?? 0)) % L) + L) % L : s.start
      out += `|${s.sample.id}:${s.pitch ?? 0}:${s.loopBars ?? 0}:${JSON.stringify(s.filter ?? null)}:${anchor}:${from - a}-${to - a}`
    }
    return out
  }

  /** Split `role`'s loops that run across `beat` into two that play on seamlessly. */
  splitAt(role: Role, beat: number): void {
    const segs = this.segs.get(role)
    if (!segs) return
    this.segs.set(role, segs.flatMap((s) => {
      if (s.sample.kind !== 'loop' || s.bass || beat <= s.start || beat >= s.start + s.length) return [s]
      const L = loopLen(s)
      const head = beat - s.start
      return [{ ...s, length: head }, { ...s, start: beat, length: s.length - head, trim: ((s.trim ?? 0) + head) % L }]
    }))
  }

  /** Change how `role`'s loops play within [from, to) beats (only those `which` accepts). */
  vary(role: Role, from: number, to: number, patch: Partial<Segment>, which: (s: Segment) => boolean = () => true): void {
    this.splitAt(role, from)
    this.splitAt(role, to)
    for (const s of this.segs.get(role) ?? []) {
      if (s.sample.kind !== 'loop' || s.bass || s.start < from || s.start + s.length > to || !which(s)) continue
      Object.assign(s, patch)
      if (s.trim) s.trim %= loopLen(s)
    }
  }

  /** `role`'s loops stop for [from, to) beats and play on after it. */
  cut(role: Role, from: number, to: number): void {
    this.splitAt(role, from)
    this.splitAt(role, to)
    const segs = this.segs.get(role)
    if (segs) this.segs.set(role, segs.filter((s) => s.sample.kind !== 'loop' || s.start < from || s.start + s.length > to))
  }

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
        if (this.feel && GROOVED.has(role)) c.groove = grooveFor(this.feel, c.steps)
        out.push(c)
        run = null
      }
      bars.forEach((p, b) => {
        const key = p ? patternKey(p) : ''
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
        const L = loopLen(s)
        // Joined where it plays on in phase: the next part starts where the last one is in the loop.
        if (last && s.sample.kind === 'loop' && alike(last, s) && last.start + last.length === s.start
            && ((((last.trim ?? 0) + s.start - last.start - (s.trim ?? 0)) % L) + L) % L === 0) {
          last.length += s.length
        } else {
          merged.push({ ...s })
        }
      }
      for (const s of merged) {
        const c: AudioClip = {
          id: uid('c'), laneId, type: 'audio', start: s.start, length: s.length, trimBeats: s.trim ?? 0, gainDb: 0,
          sample: sampleRef(s.sample),
        }
        if (s.filter) c.filter = { ...s.filter }
        if (s.bass) c.bass = { ...s.bass }
        if (s.pitch) c.pitch = s.pitch
        if (s.loopBars && s.loopBars < (s.sample.bars ?? 1)) c.loopBars = s.loopBars
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
  // Most tracks follow a real track's structure and rules, changed a little; the rest the grammar.
  const tpl = !keep.structure && opts.templates?.length && rng.chance(TEMPLATE_CHANCE)
    ? templateFrom(rng.pick(opts.templates), rng, barsFor(opts.minMinutes, bpm), barsFor(opts.maxMinutes, bpm)) : null
  const sections = keep.structure ? structuredClone(keep.structure) : tpl?.sections ?? makeStructure(rng, barsFor(minutes, bpm))
  const total = sections.reduce((n, s) => n + s.bars, 0)
  const key = keep.key !== undefined ? keep.key : chooseKey(rng, samples)
  const picker = new Picker(rng, opts.useRatings, key, new Set(keep.avoid))
  const choices: string[] = []

  // ---- main samples (one per lane for the whole track, variations for later drops) ----
  const pool = (f: (s: SampleListItem) => boolean) => samples.filter(f)
  const kept = (role: Role) => (keep.picks?.[role] ? picker.use(keep.picks[role]!) : null)
  const loopsOf = (...cats: Category[]) => pool(of('loop', ...cats))
  const preferShort = (s: SampleListItem) => ((s.bars ?? 1) <= 4 ? 2 : 1)

  /** Up to `n` different samples: `first`, then others from `cands`. */
  const layers = (first: SampleListItem | null, cands: SampleListItem[], n: number, fit?: (s: SampleListItem) => number) => {
    const out = first ? [first] : []
    while (out.length < n) {
      const left = cands.filter((s) => !out.some((o) => o.id === s.id))
      const s = left.length ? picker.pick(left, { fit }) : null
      if (!s) break
      out.push(s)
    }
    return out
  }

  const kick = kept('kick') ?? picker.pick(pool(of('oneshot', 'kick')))
  // The main loops first: the track's feel comes from one of them, the other loops are picked to fit it.
  const topLoops = loopsOf('top')
  const top0 = kept('top') ?? picker.pick(topLoops)
  const groove = kept('groove') ?? picker.pick(loopsOf('groove'))
  let feelSrc = [groove, top0].find(hasFeel) ?? null
  const fits = (s: SampleListItem) => feelFit(s.groove, feelSrc?.groove)
  const clapShots = pool(of('oneshot', 'clap', 'snare'))
  const clap = kept('clap') ?? picker.pick(clapShots)
  // Layered claps (never a second kick): played together on the backbeat in drops.
  const claps = layers(clap, clapShots, rng.weighted([[1, 2], [2, 3], [3, 2]] as const))
  const hatLoops = loopsOf('hat', 'hat_closed', 'hat_open', 'shaker')
  // Rides come in later (drops only), never in intros and outros.
  const ride = picker.pick(loopsOf('ride'), { fit: fits }) ?? picker.pick(pool(of('oneshot', 'ride')))
  const rideSteps = steps(rng.chance(0.5) ? FOUR.map((s) => s + 2) : EIGHTHS, 2)
  const hats = kept('hats') ?? (picker.pick(hatLoops, { weight: preferShort, fit: fits })
    ?? picker.pick(pool(of('oneshot', 'hat_closed', 'hat', 'hat_open'))))
  const hats2 = hats?.kind === 'loop' && rng.chance(0.55) ? picker.pick(hatLoops, { not: hats, fit: fits }) : null
  const percLoops = loopsOf('perc')
  const perc = kept('perc') ?? (picker.pick(percLoops, { weight: preferShort, fit: fits }) ?? picker.pick(pool(of('oneshot', 'perc', 'shaker'))))
  const perc2 = perc?.kind === 'loop' && rng.chance(0.6) ? picker.pick(percLoops, { not: perc, fit: fits }) : null
  // Top loops fill the track up: two to four of them, layered in drops and builds.
  const tops = layers(top0, topLoops, rng.weighted([[2, 2], [3, 3], [4, 2]] as const), fits)
  const top = tops[0] ?? null
  const groove2 = groove ? picker.pick(loopsOf('groove'), { not: groove, fit: fits }) : null
  feelSrc ??= [perc, hats].find(hasFeel) ?? null
  const picks: Partial<Record<Role, SampleListItem>> = {}
  for (const [role, s] of [['kick', kick], ['clap', clap], ['hats', hats], ['perc', perc], ['top', top], ['groove', groove]] as const) {
    if (s) picks[role] = s
  }

  // ---- bass: a new bassline (learned from the MIDI library's) through a Serum patch, in the track key ----
  const bo = opts.bass
  const model = bo?.midis.length && bo.presets.length ? bassModel(bo.midis) : null
  const bassMidi = model ? keep.bassMidi ?? generatedMidi(generateBassline(model, rng, { key, bars: bo!.bars }), key) : null
  const bassPreset = bassMidi && bo
    ? keep.bassPreset ?? rng.pickBy(bo.presets, (p) => 1 + (bo.favorites.includes(p.path) ? 3 : 0)) : null
  const bass: GenerationBass | null = bassMidi && bassPreset
    ? { midi: bassMidi, preset: bassPreset, transpose: transposeTo(bassMidi.key_label, key), ...(keep.bassMidi ? keep.bassEdit : undefined) }
    : null

  // An independent RNG keeps existing drum/bass choices stable when Keys is enabled.
  const ko = opts.keys
  const krng = new Rng(seed ^ 0x4b455953)
  const km = ko?.midis.length && ko.presets.length ? keysModel(ko.midis) : null
  const keysMidi = km ? keep.keysMidi ?? generatedKeysMidi(generateKeys(km, krng, { key, bars: ko!.bars }), key) : null
  const keysPreset = keysMidi && ko
    ? keep.keysPreset ?? krng.pickBy(ko.presets, (p) => 1 + (ko.favorites.includes(p.path) ? 3 : 0)) : null
  const keys: GenerationBass | null = keysMidi && keysPreset
    ? { midi: keysMidi, preset: keysPreset, transpose: transposeTo(keysMidi.key_label, key), ...(keep.keysMidi ? keep.keysEdit : undefined) } : null

  const fills = pool(of('event', 'fill'))
  const rolls = pool(of('event', 'roll'))
  const risers = pool(of('event', 'fx_riser'))
  /** Sweeps and other FX that build up: second layers into drops, sweeps up into breakdowns. */
  const lifts = pool((s) => s.kind === 'event' && rising(s) && s.category !== 'fx_riser')
  const downs = pool((s) => s.kind === 'event' && falling(s))
  const impacts = pool(of('event', 'fx_impact'))
  const atmoses = pool(of('event', 'fx_atmos'))
  const crash = picker.pick(pool(of('oneshot', 'cymbal')))
  const atmos = picker.pick(atmoses, { tonal: true })

  // ---- the producer's own FX into a drop ----
  // Events of one track that lead into the same bar (bodies ending there) or start on it (an
  // impact, a downlifter) were layered there by its producer: a riser, the fill, the impact of
  // one drop are sure to go together.
  const sets = new Map<string, SampleListItem[]>()
  for (const s of samples) {
    if (s.kind !== 'event' || s.shape?.boundary == null) continue
    const onTheLine = s.category === 'fx_impact' || falling(s) || (s.shape.dir === 'hit' && s.shape.onset <= 1)
    if (!onTheLine && !leads(s)) continue
    const k = `${s.zip_id}:${onTheLine ? s.shape.boundary - bodyBars(s) : s.shape.boundary}`
    sets.set(k, [...(sets.get(k) ?? []), s])
  }
  const tonalKeys = key ? new Set(expandCompatible([key])) : null
  const setCands = [...sets.entries()].filter(([, xs]) => xs.some(rising) && xs.length >= 2
    && xs.filter(rising).every((r) => !r.key_label || !tonalKeys || tonalKeys.has(r.key_label)))
    .sort(([a], [b]) => a.localeCompare(b))
  const drawnSet = setCands.length && rng.chance(0.5)
    ? rng.pickBy(setCands, ([, xs]) => (tpl && xs[0].source_code === tpl.source ? 4 : 1))[0] : null
  const inSet = (f: (s: SampleListItem) => boolean) => !!drawnSet && sets.get(drawnSet)!.some((s) => f(s) && (falling(s) || s.category === 'fx_impact' || leads(s)))

  // ---- the track's rules ----
  // Decided once per track and applied to every section of the same kind, so a track has its
  // own logic instead of sounding random: if drop 1 has a crash every 16 bars, so does drop 2.
  // Breakdowns are the exception: a break is a break from the rest, so they vary on their own.
  const drawn = {
    fx: rng.weighted([['sparse', 1], ['normal', 3], ['busy', 1.5]] as const),
    // Every 16 bars in drops (crashes also in intro and outro): a crash on the 1, the bar before
    // it without kick ("four kicks out"), and/or a fill into it.
    phraseCrash: rng.chance(0.75),
    // A crash at the other 8-bar phrase starts of drops too.
    crash8: rng.chance(0.25),
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
    // (With the producer's own FX into a drop: what they layered there.)
    dropFill: inSet((s) => s.category === 'roll') ? 'roll' as const : inSet((s) => s.category === 'fill') ? 'fill' as const
      : rolls.length && rng.chance(0.45) ? 'roll' as const : fills.length && rng.chance(0.85) ? 'fill' as const : null,
    dropRiser: !!drawnSet || (risers.length > 0 && rng.chance(0.8)),
    dropImpact: inSet((s) => s.category === 'fx_impact') || (impacts.length > 0 && rng.chance(0.5)),
    // The silence before drops when their FX and fill run right up to it (else theirs).
    dropSilence: rng.weighted([[0, 1], [1, 2], [2, 2]] as const),
    // FX layers into drops (a second riser or sweep that complements the first, not in sparse
    // tracks), a downlifter as the drop hits, the producer's own FX into a drop ("zip:bar").
    fxLayers: drawnSet ? (sets.get(drawnSet)!.filter(rising).length >= 2 ? 2 : 1)
      : risers.length + lifts.length > 1 ? rng.weighted([[1, 2], [2, 3]] as const) as number : 1,
    dropDown: inSet(falling) || (downs.length > 0 && rng.chance(0.3)),
    dropSet: drawnSet,
    /** 16ths each drop's transition stops before it (by drop bar); measured, kept by re-rolls. */
    dropGaps: null as Record<string, number> | null,
    // Into every breakdown.
    breakFill: fills.length > 0 && rng.chance(0.7),
    breakCrash: rng.chance(0.5),
    breakLastKick: rng.chance(0.4),
    breakDownlifter: downs.length > 0 && rng.chance(0.6),
    // A sweep up into the breakdown (the downlifter falls away from its start).
    breakSweep: lifts.length > 0 && rng.chance(0.35),
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
    // Bass: full in drops; in breakdowns low-passed or out; in builds out, low-passed or a
    // low-pass opening up; intro and outro usually without (DJ friendly), sometimes low-passed.
    bassBreaks: rng.weighted([['filtered', 3], ['none', 2]] as const),
    bassBuild: rng.weighted([['sweep', 3], ['filtered', 1], ['none', 2]] as const),
    bassIO: rng.weighted([['none', 3], ['filtered', 1]] as const),
    bassCutoff: rng.int(220, 420),
    keysBreaks: krng.weighted([['full', 2], ['filtered', 2], ['none', 1]] as const),
    keysBuild: krng.weighted([['sweep', 3], ['filtered', 1], ['none', 2]] as const),
    keysCutoff: krng.int(600, 1600),
    // The feel: how much of the main loop's groove the one-shots and the bass take on.
    feel: rng.int(70, 100) / 100,
    // Loop variations: a top layer (or the second perc / hat loop) a little higher or lower, and
    // in the intro (mirrored in the outro) loops repeating only their first bar or two at first.
    pitchTop: tops.length > 1 && rng.chance(0.35) ? [rng.int(1, tops.length - 1), rng.weighted(PITCHES)] as [number, number] : null,
    pitchPerc2: perc2 && rng.chance(0.25) ? rng.weighted(PITCHES) : null,
    pitchHats2: hats2 && rng.chance(0.2) ? rng.weighted(PITCHES) : null,
    ioShort: rng.chance(0.4) ? rng.weighted([[1, 1], [2, 2]] as const) as number : null,
  }
  const rules: typeof drawn = { ...drawn, ...(tpl?.rules as Partial<typeof drawn> | undefined), ...(keep.rules as Partial<typeof drawn> | undefined) }
  const fxChance = { sparse: 0.45, normal: 0.75, busy: 0.95 }[rules.fx]
  const keptGaps = rules.dropGaps
  const dropGaps: Record<string, number> = {}
  const set = rules.dropSet ? sets.get(rules.dropSet) ?? null : null

  const lanes = new Lanes(total)
  const feel = feelSrc?.groove ? stepGroove(feelSrc.groove, rules.feel) : null
  lanes.feel = feel && audible(feel) ? feel : null
  if (bass && lanes.feel) bass.groove = lanes.feel.offsets
  if (keys && lanes.feel) keys.groove = lanes.feel.offsets
  const pitchOf = (role: Role) => role === 'perc2' ? rules.pitchPerc2 : role === 'hats2' ? rules.pitchHats2
    : rules.pitchTop && TOP_ROLES[rules.pitchTop[0]] === role ? rules.pitchTop[1] : null
  const loop = (role: Role, s: SampleListItem | null, fromBar: number, toBar: number, filter?: ClipFilter, gapBeats = 0) => {
    const pitch = pitchOf(role)
    if (s && toBar > fromBar) {
      lanes.add(role, { sample: s, start: fromBar * 4, length: (toBar - fromBar) * 4 - gapBeats, filter, ...(pitch ? { pitch } : {}) })
    }
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
  /**
   * An event (riser, roll, fill) whose body ends on `endBeat`, if one fits in `room` beats: its
   * own silence before the line comes with it (a riser stopping on beat 7 of 8 leaves the
   * producer's beat of silence). With `gap`, only events stopping that early (gapsAgree).
   */
  const endOn = (job: string, role: Role, cands: SampleListItem[], endBeat: number, room: number, want: number, tonal = false,
                 gap?: number, weight?: (s: SampleListItem) => number) => {
    // Tonal FX in the key when the library has any there, even if that leaves none that fit.
    const inKey = tonal && tonalKeys ? cands.filter((s) => s.key_label && tonalKeys.has(s.key_label)) : []
    const fit = (inKey.length ? inKey : cands)
      .filter((s) => bodyBars(s) * 4 <= room && leads(s) && (gap == null || gapsAgree(gapOf(s), gap)))
    let s = chosen.get(job) ?? null
    if (!s || !fit.some((c) => c.id === s!.id)) {
      s = picker.pick(fit, { tonal, weight: (x) => (weight?.(x) ?? 1) / (1 + Math.abs(bodyBars(x) - want)) })
      if (s && !chosen.has(job)) chosen.set(job, s)
    }
    if (s) place(role, s, endBeat - bodyBars(s) * 4)
    return s
  }
  /** Place on the first of `roles` with nothing playing there yet (FX lanes don't stack sounds). */
  const placeFree = (roles: Role[], s: SampleListItem | null, startBeat: number) => {
    if (!s) return null
    const len = (s.bars ?? 1) * 4
    const role = roles.find((r) => !(lanes.segs.get(r) ?? []).some((x) => x.start < startBeat + len && x.start + x.length > startBeat))
    if (role) place(role, s, startBeat)
    return role ? s : null
  }
  // The producer's own FX into a drop: their riser(s), fill or roll and impact are the track's
  // picks for those jobs (used wherever they fit, as any pick).
  if (set) {
    const seed = (job: string, s: SampleListItem | undefined) => {
      if (s && picker.fresh(s) && !chosen.has(job)) chosen.set(job, picker.use(s))
    }
    const up = set.filter(rising).sort((a, b) => bodyBars(b) - bodyBars(a))
    for (const job of ['riser', 'riser-long']) seed(job, up[0])
    seed('riser2', up[1])
    for (const job of ['roll', 'roll-long']) seed(job, set.find((s) => s.category === 'roll'))
    seed('fill', set.find((s) => s.category === 'fill' && leads(s)))
    seed('impact', set.find((s) => s.category === 'fx_impact'))
    seed('drop-down', set.find(falling))
  }

  // The bass part as a loop "sample" (its file is rendered through Serum for this tempo).
  const bassRender: BassRender | null = bass ? bassRenderOf(bass) : null
  const bassSample: SampleListItem | null = bass && bassRender ? {
    id: bass.midi.id > 0 ? -bass.midi.id : bass.midi.id - 2_000_000_000, rel_path: bassPath(bassRender, bpm), name: `${bass.preset.name} · ${bass.midi.name}`, kind: 'loop',
    category: 'melodic', bpm, bars: bassBars(bass), body_bars: null, key_label: key, key_camelot: null,
    duration_s: (bassBars(bass) * BEATS_PER_BAR * 60) / bpm, channels: 2, favorite: 0, rating: null, tags: null,
    zip_id: -1, source_code: 'Serum',
  } : null
  const bassPart = (from: number, to: number, filter?: ClipFilter, gapBeats = 0) => {
    if (bassSample && bassRender && to > from) {
      lanes.add('bass', { sample: bassSample, start: from * 4, length: (to - from) * 4 - gapBeats, filter, bass: bassRender })
    }
  }

  const keysRender: BassRender | null = keys ? bassRenderOf(keys) : null
  const keysSample: SampleListItem | null = keys && keysRender ? {
    id: keys.midi.id > 0 ? -keys.midi.id : keys.midi.id - 2_000_000_000, rel_path: bassPath(keysRender, bpm), name: `${keys.preset.name} · ${keys.midi.name}`, kind: 'loop',
    category: 'melodic', bpm, bars: bassBars(keys), body_bars: null, key_label: key, key_camelot: null,
    duration_s: (bassBars(keys) * BEATS_PER_BAR * 60) / bpm, channels: 2, favorite: 0, rating: null, tags: null,
    zip_id: -1, source_code: 'Serum',
  } : null
  const keysPart = (from: number, to: number, filter?: ClipFilter, gapBeats = 0) => {
    if (keysSample && keysRender && to > from) {
      lanes.add('keys', { sample: keysSample, start: from * 4, length: (to - from) * 4 - gapBeats, filter, bass: keysRender })
    }
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
          } else {
            if (rules.kickEnd8) kickBar(b - 1, rules.kickEnd8)
            if (rules.crash8) crashAt.add(b)
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

    if (keysSample) {
      const lp = (to: number | null = null): ClipFilter => ({ type: 'lowpass', from: rules.keysCutoff, to, q: 0.8 })
      if (sec.kind === 'drop') keysPart(a, z, undefined, gap)
      else if (sec.kind === 'break' && rules.keysBreaks !== 'none') keysPart(a, z, rules.keysBreaks === 'filtered' ? lp() : undefined)
      else if (sec.kind === 'build' && rules.keysBuild !== 'none') keysPart(a, z, lp(rules.keysBuild === 'sweep' ? 8000 : null), gap)
    }

    // ---- bass: the bassline repeats in drops; elsewhere low-passed or out, by the track's rules ----
    if (bassSample) {
      const lp = (to: number | null = null): ClipFilter => ({ type: 'lowpass', from: rules.bassCutoff, to, q: 0.8 })
      if (sec.kind === 'drop') bassPart(a, z, undefined, gap)
      else if (sec.kind === 'break') { if (rules.bassBreaks === 'filtered') bassPart(a, z, lp()) }
      else if (sec.kind === 'build') {
        if (rules.bassBuild === 'sweep') bassPart(a, z, lp(4000))
        else if (rules.bassBuild === 'filtered') bassPart(a, z, lp())
      } else if (sec.kind === 'intro') { if (rules.bassIO === 'filtered') bassPart(phraseAt(0.5), z, lp()) }
      else if (sec.kind === 'outro') { if (rules.bassIO === 'filtered') bassPart(a, phraseAt(0.5), lp()) }
    }

    // ---- atmos in breakdowns ----
    if (sec.kind === 'break' && atmos && rng.chance(0.85)) loop('atmos', atmos, a, z)

    // ---- transitions: the track's own way into drops, breakdowns and the outro ----
    if (next) {
      const end = z * 4
      const room = sec.bars * 4
      if (intoDrop) {
        // One moment for everything leading into the drop: the riser decides how long before it
        // the sound stops (its producer's choice), the fill or roll and any second FX layer stop
        // with it, and the rest of the track goes silent there too (see the silence below).
        let t: number | undefined = keptGaps?.[z]
        const rollJob = sec.long ? 'roll-long' : 'roll'
        const leadIns = (rules.dropFill === 'roll' ? [...rolls.filter((s) => bodyBars(s) * 4 <= room), ...fills]
          : rules.dropFill === 'fill' ? fills : []).filter((s) => bodyBars(s) <= 2 || s.category === 'roll').filter(leads)
        let riser: SampleListItem | null = null
        if (rules.dropRiser) {
          // A riser the track's fill can stop with (or some fill, when the track has fills into drops).
          const fill = chosen.get(rules.dropFill === 'roll' ? rollJob : 'fill')
          const withFill = fill ? risers.filter((r) => gapsAgree(gapOf(fill), gapOf(r))) : []
          const partnered = withFill.length ? withFill
            : risers.filter((r) => !leadIns.length || leadIns.some((f) => gapsAgree(gapOf(f), gapOf(r))))
          riser = endOn(sec.long ? 'riser-long' : 'riser', 'fx', partnered.length ? partnered : risers, end, room,
                        sec.long ? 8 : sec.bars >= 16 ? 4 : 2, true, t)
          if (riser) t ??= gapOf(riser)
        }
        let lead: SampleListItem | null = null
        if (rules.dropFill === 'roll') lead = endOn(rollJob, 'fills', rolls, end, room, sec.long ? 8 : 4, false, t)
        if (!lead && rules.dropFill) lead = endOn('fill', 'fills', fills, end, 8, 1, false, t)
        if (lead) t ??= gapOf(lead)
        // A second layer: another length or texture than the riser, stopping with it.
        if (riser && rules.fx !== 'sparse' && rules.fxLayers >= 2) {
          const first = riser
          const want = bodyBars(first) >= 4 ? Math.max(1, bodyBars(first) / 4) : Math.min(sec.bars, bodyBars(first) * 4)
          endOn('riser2', 'fx2', [...risers, ...lifts].filter((s) => s.id !== first.id && complements(first, s) != null),
                end, room, want, true, t, (s) => complements(first, s)!)
        }
        if (rules.dropImpact) placeFree(['hits', 'fx2'], trackPick('impact', impacts), end)
        // A downlifter as the drop hits, on a lane that's free there.
        if (rules.dropDown && rules.fx !== 'sparse') placeFree(['hits', 'fx2', 'fx'], trackPick('drop-down', downs, true), end)
        dropGaps[z] = t ?? 0
        crashAt.add(z)  // every drop starts with a crash
      } else if (intoBreak) {
        const fill = rules.breakFill ? endOn('fill', 'fills', fills, end, 8, 1) : null
        if (rules.breakCrash) crashAt.add(z)
        // A sweep up into the breakdown (stopping with the fill), a downlifter falling away from its start.
        if (rules.breakSweep) endOn('sweep', 'fx', lifts, end, room, 2, false, fill ? gapOf(fill) : undefined)
        if (rules.breakDownlifter && rng.chance(fxChance)) placeFree(['hits', 'fx2', 'fx'], trackPick('downlifter', downs, true), end)
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

  // ---- the intro's loops repeat only their first bar or two at first (the outro mirrors it) ----
  if (rules.ioShort) {
    const n = rules.ioShort
    for (const sec of sections) {
      if (sec.kind !== 'intro' && sec.kind !== 'outro') continue
      const half = Math.max(PHRASE, Math.floor(sec.bars / 2 / PHRASE) * PHRASE)
      const [a, z] = sec.kind === 'intro' ? [sec.start, sec.start + half] : [sec.start + sec.bars - half, sec.start + sec.bars]
      for (const role of [...TOP_ROLES, 'perc'] as Role[]) {
        lanes.vary(role, a * 4, z * 4, { loopBars: n, trim: 0 }, (x) => (x.sample.bars ?? 1) > n)
      }
    }
  }

  // ---- something changes every 8 bars: where the arrangement doesn't, a subtle variation ----
  const varied = everyEightBars(lanes, sections, rng, {
    kick, fill: fills.length ? endOn : null, fills,
  })

  // ---- the silence before every drop: where its FX and fill stop (the producer's), or when
  // they run right up to it, the track's beat or two (FX, fills and hits ring through) ----
  rules.dropGaps = dropGaps
  for (const s of sections) {
    if (s.kind !== 'drop' || s.start <= 0) continue
    const t = dropGaps[s.start] ?? 0
    const sixteenths = t > TO_THE_LINE ? Math.min(t, MAX_SILENCE) : rules.dropSilence * 4
    if (sixteenths) lanes.silence(s.start * 4 - sixteenths / 4, s.start * 4, THROUGH_SILENCE)
  }

  // ---- the project ----
  const project = newProject('Generated', bpm)
  project.lengthBars = total
  project.lanes = LANES.map((l, i) => ({ ...makeLane(l.name, i), color: l.color, volumeDb: l.volumeDb }))
  applyMix(project, opts.mix ?? {})
  const bassLane = project.lanes.find((l) => l.name === 'Bass')
  if (bassLane && bo) bassLane.duck = bo.sidechain
  const keysLane = project.lanes.find((l) => l.name === 'Keys')
  if (keysLane && ko) keysLane.duck = ko.sidechain
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
  if (keys) choices.push(`keys in drops, ${rules.keysBreaks} in breakdowns`)
  if (bass) choices.push(`bass in drops, ${rules.bassBreaks === 'filtered' ? 'low-passed' : 'out'} in breakdowns`)
  if (rules.phraseCrash) choices.push(rules.crash8 ? 'crash every 8 bars' : 'crash every 16 bars')
  else if (rules.crash8) choices.push('crash every 8 bars in drops')
  if (rules.phraseKickOut) choices.push('four kicks out every 16 bars')
  if (rules.phraseFill) choices.push('fill every 16 bars')
  if (rules.kickEnd8) choices.push('kick variation every 8 bars')
  if (rules.clapRolls !== 'none') choices.push(`clap rolls every ${rules.clapRolls} bars`)
  if (rules.clapGhost != null) choices.push('ghost claps')
  if (rules.loopGap) choices.push('loops stop before breaks')
  if (tpl) choices.unshift(`structure after ${tpl.source} (${tpl.changes.join(', ')})`)
  if (lanes.feel && feelSrc) {
    const sw = feelSrc.groove?.swing ?? 0
    choices.push(`feel of ${feelSrc.source_code}'s ${feelSrc.category} loop${Math.abs(sw) >= 0.05 ? ` (${Math.round(50 + sw * 50)} % swing)` : ''}`)
  }
  if (rules.pitchTop || rules.pitchPerc2 || rules.pitchHats2) choices.push('a pitched loop layer')
  if (rules.ioShort) choices.push(`intro loops on their first ${rules.ioShort === 1 ? 'bar' : '2 bars'} at first`)
  if (varied) choices.push(`${varied} small variations at 8-bar marks`)
  if (tops.length > 1) choices.push(`${Math.min(tops.length, tracks.tops + 1)} top loops`)
  if (claps.length > 1) choices.push(`${claps.length} layered claps`)
  if (ride) choices.push({ late: 'ride later in drop 1', second: 'ride from drop 2', both: 'ride late in drop 1, then all through' }[rules.ride])
  if (rules.dropKickOut) choices.push('four kicks out before drops')
  const early = Object.values(dropGaps).filter((t) => t > TO_THE_LINE)
  if (early.length) {
    const beats = Math.min(Math.max(...early), MAX_SILENCE) / 4
    choices.push(`FX and fills stop ${beats} beat${beats === 1 ? '' : 's'} before ${early.length < Object.keys(dropGaps).length ? 'a drop' : 'drops'}, the track with them`)
  }
  if (rules.dropSilence && early.length < Object.keys(dropGaps).length) {
    choices.push(`${rules.dropSilence} beat${rules.dropSilence > 1 ? 's' : ''} of silence before drops`)
  }
  if (set && rules.dropSet) choices.push(`FX into drops as ${set[0].source_code} layered them`)
  if (lanes.segs.get('fx2')?.length) choices.push('two FX layers into drops')
  choices.push(`${rules.fx} FX`)

  const byId = new Map(samples.map((s) => [s.rel_path, s]))
  const zips = [...new Set(project.clips.map((c) => byId.get(c.sample.relPath)?.source_code).filter((x): x is string => !!x))].sort()
  return { seed, project, sections, key, choices, zips, picks, bass, keys, rules, template: tpl?.source ?? null }
}

/** Places an event whose main sound ends on `endBeat` (generate's endOn). */
type EndOn = (job: string, role: Role, cands: SampleListItem[], endBeat: number, room: number, want: number,
              tonal?: boolean, gap?: number, weight?: (s: SampleListItem) => number) => SampleListItem | null

/** Which way a variation goes (the last one is less likely next time, so they don't repeat). */
type Tweak = 'kick' | 'hatGap' | 'layerOut' | 'loopVary' | 'clap' | 'fill' | 'lift'

/**
 * Every 8-bar mark inside a section gets a change: where nothing in the arrangement changes
 * there (no new element, no fill, kick variation or crash), one subtle variation is added: a
 * kick variation, the hats stopping for a beat or two, a loop layer out for a bar, a loop playing
 * another part of itself (only its first bars, from another bar) or pitched for the next 8 bars,
 * a clap ghost note, a fill, a high-pass lift on a top loop. The DJ intro and outro keep their
 * steady kick and hats. Returns how many were added.
 */
function everyEightBars(lanes: Lanes, sections: Section[], rng: Rng,
                        ctx: { kick: SampleListItem | null; fill: EndOn | null; fills: SampleListItem[] }): number {
  const changed = (b: number) => lanes.roles().some((r) => {
    const s1 = lanes.state(r, b - 1)
    return lanes.state(r, b) !== s1 || s1 !== lanes.state(r, b - 2)
  })
  const LAYERS: Role[] = ['perc', 'perc2', 'hats2', 'top2', 'top3', 'top4', 'groove']
  const VARY: Role[] = ['top', 'top2', 'top3', 'top4', 'groove', 'perc', 'perc2', 'hats2']
  let last: Tweak | null = null
  let added = 0
  for (const sec of sections) {
    const end = sec.start + sec.bars
    const io = sec.kind === 'intro' || sec.kind === 'outro'
    for (let b = sec.start + PHRASE; b < end; b += PHRASE) {
      if (changed(b)) { last = null; continue }
      const B = b * BEATS_PER_BAR
      const cands: [Tweak, number, () => void][] = []
      const kickBar = lanes.bar('kick', b - 1)
      if (!io && ctx.kick && kickBar && kickBar.steps.join('') === steps(FOUR).join('')) {
        cands.push(['kick', sec.kind === 'drop' ? 2 : 1, () => lanes.setBar('kick', b - 1, { ...kickBar, steps: [...rng.weighted(KICK_PHRASE_ENDS)] })])
      }
      if (!io && lanes.loopOver('hats', B - 4, B + 4)) {
        cands.push(['hatGap', 2, () => lanes.cut('hats', B - rng.pick([1, 2]), B)])
      } else if (lanes.bar('hats', b - 1)) {
        // One-shot hats: the last ones out (or, in the intro and outro, a soft 16th more).
        const p = lanes.bar('hats', b - 1)!
        const s = io ? p.steps.map((v, i) => (i === 15 && !v ? 1 : v)) : p.steps.map((v, i) => (i >= 12 ? 0 : v))
        cands.push(['hatGap', 1.5, () => lanes.setBar('hats', b - 1, { ...p, steps: s as Steps })])
      }
      const out = LAYERS.filter((r) => lanes.loopOver(r, B - 4, B + 4))
      if (out.length) {
        cands.push(['layerOut', 2, () => {
          const r = rng.pick(out)
          lanes.cut(r, B - rng.pick([4, 2]), B)
        }])
      }
      const next = Math.min(end, b + PHRASE) * BEATS_PER_BAR
      // The hats too, though never with a gap in the DJ intro and outro.
      const vary = [...VARY, 'hats' as Role].filter((r) => lanes.loopOver(r, B, next))
      if (vary.length) {
        cands.push(['loopVary', 3, () => {
          const r = rng.pick(vary)
          const seg = lanes.loopOver(r, B, next)!
          const L = loopLen(seg)
          const bars = L / BEATS_PER_BAR  // what it repeats now (only the first bars, maybe)
          const how = rng.weighted([['first', bars >= 2 ? 3 : 0], ['rotate', bars >= 2 ? 2 : 0],
            ['pitch', seg.pitch ? 0 : 1], ['half', (seg.sample.bars ?? 1) === 1 || (io && r === 'hats') ? 0 : 0.5]] as const)
          if (how === 'first') lanes.vary(r, B, next, { loopBars: rng.pick([1, 2].filter((n) => n < bars)), trim: 0 })
          else if (how === 'rotate') {
            // From another bar of the loop than where it is now (else it would just play on).
            const now = ((seg.trim ?? 0) + B - seg.start) % L
            lanes.vary(r, B, next, { trim: (now + BEATS_PER_BAR * rng.int(1, bars - 1)) % L })
          }
          else if (how === 'pitch') lanes.vary(r, B, next, { pitch: rng.pick([-1, 1]) })
          else lanes.cut(r, B + 2, B + 4)  // a short break in the loop on the new part's first bar
        }])
      }
      const clapBar = lanes.bar('clap', b - 1)
      if (!io && clapBar) {
        cands.push(['clap', 1.5, () => {
          const ghost = rng.pick([[13, 15], [11, 14], [15]])
          lanes.setBar('clap', b - 1, { ...clapBar, steps: clapBar.steps.map((v, i) => (ghost.includes(i) && !v ? (i === 15 ? 2 : 1) : v)) as Steps })
        }])
      }
      if (ctx.fill && sec.kind !== 'intro' && sec.kind !== 'outro' && ![b - 2, b - 1, b].some((x) => lanes.state('fills', x))) {
        const endOn = ctx.fill
        cands.push(['fill', 0.8, () => { endOn('fill', 'fills', ctx.fills, B, 8, 1) }])
      }
      const lift = TOP_ROLES.filter((r) => lanes.loopOver(r, B - 4, B) && !lanes.loopOver(r, B - 4, B)!.filter)
      if (lift.length) {
        cands.push(['lift', 1, () => lanes.vary(rng.pick(lift), B - 4, B, { filter: { type: 'highpass', from: 200, to: 2500, q: 0.8 } })])
      }
      // One that really changes something (another if it didn't, say a rotation landing in phase).
      while (cands.length) {
        const pick = rng.pickBy(cands, ([k, w]) => (k === last ? w * 0.3 : w))
        pick[2]()
        cands.splice(cands.indexOf(pick), 1)
        if (changed(b)) {
          last = pick[0]
          added++
          break
        }
      }
    }
  }
  return added
}

/** The track rules each lane owns: re-rolling the lane draws these again, the others stay. */
const LANE_RULES: Partial<Record<Role, string[]>> = {
  kick: ['phraseKickOut', 'kickEnd8', 'dropKickOut', 'dropLastKick', 'breakLastKick', 'ioKickHp'],
  clap: ['clapGhost', 'clapRolls', 'ioClaps'],
  hats: ['hatsInBreaks'],
  ride: ['ride'],
  perc: ['ioPerc', 'perc2From'],
  top: ['dropTops', 'ioTopFirst', 'ioTopSecond'],
  groove: ['grooveFrom', 'grooveSwap', 'switchHalfway'],
  crash: ['phraseCrash', 'crash8', 'breakCrash', 'outroCrash'],
  fills: ['phraseFill', 'dropFill', 'breakFill', 'outroFill'],
  fx: ['fx', 'dropRiser', 'breakSweep', 'fxLayers', 'dropSet'],
  hits: ['dropImpact', 'breakDownlifter', 'dropDown'],
  keys: ['keysBreaks', 'keysBuild', 'keysCutoff'],
  bass: ['bassBreaks', 'bassBuild', 'bassIO', 'bassCutoff'],
}
const LAYER_OF: Partial<Record<Role, Role>> = {
  clap2: 'clap', clap3: 'clap', hats2: 'hats', perc2: 'perc', top2: 'top', top3: 'top', top4: 'top', fx2: 'fx',
}

/**
 * The same track with one lane made again (the Generate view's per-lane button): a new sample
 * and the lane's own rules drawn again (a crash every 8 bars instead of 16, kicks out at other
 * places, fills into other parts, …), over the same structure, key, tempo and track-wide rules
 * (the silence before drops, and where each drop's FX stop). Every other lane stays exactly as
 * it is. Samples already in the track are avoided. On the Bass lane: another bassline and/or
 * patch. Null when nothing new comes out (the library has nothing else: for FX and fills, nothing
 * else in key that stops where the drop's other FX and the track's silence do).
 */
export function rerollLane(all: SampleListItem[], opts: GenerateOptions, g: Generation, laneId: string, seed: number): Generation | null {
  const lane = g.project.lanes.find((l) => l.id === laneId)
  const role = lane && laneRole(lane.name)
  if (!lane || !role) return null
  const own = new Set(LANE_RULES[LAYER_OF[role] ?? role] ?? [])
  const rules = Object.fromEntries(Object.entries(g.rules ?? {}).filter(([k]) => !own.has(k)))
  const picks = Object.fromEntries(Object.entries(g.picks).filter(([r]) => r !== role)) as Generation['picks']
  const sig = (cs: Clip[]) => JSON.stringify(cs.map(({ id: _i, laneId: _l, ...c }) => c))
  const before = g.project.clips.filter((c) => c.laneId === laneId)
  const bpm = g.project.bpm
  for (let i = 0; i < 12; i++) {
    const r = generate(all, { ...opts, tempo: { min: bpm, max: bpm }, bass: role === 'bass' ? opts.bass : null, keys: role === 'keys' ? opts.keys : null }, seed + i * 7919, {
      structure: g.sections, key: g.key, picks, rules, avoid: g.project.clips.map((c) => c.sample.relPath),
    })
    const rl = r.project.lanes.find((l) => l.name === lane.name)
    const clips = rl ? r.project.clips.filter((c) => c.laneId === rl.id) : []
    if (!clips.length || sig(clips) === sig(before)) continue
    if (role !== 'bass' && role !== 'keys' && clips.every((c) => before.some((b) => b.sample.relPath === c.sample.relPath))) continue
    if (role === 'bass' && r.bass && g.bass && r.bass.midi.id === g.bass.midi.id && r.bass.preset.path === g.bass.preset.path) continue
    const project = structuredClone(g.project)
    project.clips = [...project.clips.filter((c) => c.laneId !== laneId), ...clips.map((c) => ({ ...c, laneId }))]
    const nextPicks = { ...g.picks }
    if (r.picks[role]) nextPicks[role] = r.picks[role]
    const nextRules = { ...g.rules, ...Object.fromEntries(Object.entries(r.rules).filter(([k]) => own.has(k))) }
    const byPath = new Map(all.map((s) => [s.rel_path, s]))
    const zips = [...new Set(project.clips.map((c) => byPath.get(c.sample.relPath)?.source_code).filter((x): x is string => !!x))].sort()
    return { ...g, project, picks: nextPicks, rules: nextRules, zips, bass: role === 'bass' ? r.bass : g.bass, keys: role === 'keys' ? r.keys : g.keys }
  }
  return null
}
