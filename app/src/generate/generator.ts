// The generator (SCOPE.md §6.6): builds a complete drum arrangement from the library.
//
// generate(samples, options, seed, keep) is pure: it picks a structure (a real track's, changed
// a little: template.ts, or one from the grammar: structure.ts), a key for tonal FX, one main
// sample per lane (spread over different zips, matching the feel of the main loop), per-track
// style choices (kick drop-outs, clap rolls, FX density, loop variations, …), then writes every
// lane bar by bar, makes sure something changes every 8 bars, and turns that into ordinary
// Arrange clips. The same seed + library + options + keep gives the same arrangement.

import { expandCompatible } from '../lib/camelot'
import { BEATS_PER_BAR, makeLane, makeMarker, newProject, replaceSample, sampleRef, STEPS_PER_BAR, uid } from '../lib/project'
import type { Category, SampleKind } from '../types/engine'
import { bassPath, droneRenderPrefix } from '../audio/schedule'
import type { HitItem, MidiItem, SampleListItem, SavedStabRhythm, SerumPreset, TrackArrangement } from '../types/api'
import type { AudioClip, BassRender, Clip, ClipFilter, ClipReverb, DroneRhythm, DroneWarp, PatternClip, Project, StepGroove, Velocity } from '../types/project'
import { bassModel, generateBassline, generatedMidi, isGenerated } from './bassline'
import { hitPitch, hitSample } from './disco'
import { DRONE_CHANCE, droneInKey, droneItem, droneRender, droneSample, type DroneLook } from './drones'
import { chopPitch, chopSample, phraseRender, phraseSample, vocalItem, type VocalTake } from './vocals'
import { stabRhythm } from './stabs'
import { BASS_HP_MIN_HZ, MIX_HP_FROM_HZ, MIX_HP_TO_HZ, rideSources, ridePieces, sectionBars, type RidePart } from './rides'
import { audible, feelFit, grooveFor, hasFeel, stepGroove } from './feel'
import { Rng } from './rng'
import { barsFor, BUILD_LABEL, KICK_MODE_LABEL, makeStructure, PHRASE, type Section } from './structure'
import { templateFrom } from './template'
import { balanceFrom, dropRanges, levelLanes, type Balance } from './balance'
import { bassy, eqLanes } from './eq'

export type Role = 'kick' | 'clap' | 'clap2' | 'clap3' | 'buildup' | 'hats' | 'hats2' | 'ride' | 'perc' | 'perc2'
  | 'top' | 'top2' | 'top3' | 'top4' | 'groove' | 'bass' | 'fills' | 'fx' | 'fx2' | 'crash' | 'hits' | 'atmos'
  | 'disco' | 'disco2' | 'stab' | 'drone' | 'vocal' | 'vchop'

/** Volume per lane (dB on top of the balanced mix), set with the Generate view's lane sliders. */
export type Mix = Partial<Record<Role, number>>

/**
 * Lanes of a generated project, in order. Layers of the same kind (up to three claps, four top
 * loops, …) get their own lane, each a little quieter (`startDb`: the step between them). The mix
 * balance (balance.ts) levels each lane; `startDb` is also the level of a lane whose samples
 * aren't measured yet (the starting mix from before the balance). The sliders start at 0 dB.
 */
export const LANES: { role: Role; name: string; startDb: number; color: string }[] = [
  { role: 'kick', name: 'Kick', startDb: -2, color: '#e2c35f' },
  { role: 'clap', name: 'Clap', startDb: -3, color: '#f472b6' },
  { role: 'clap2', name: 'Clap 2', startDb: -7, color: '#f9a8d4' },
  { role: 'clap3', name: 'Clap 3', startDb: -9, color: '#fbcfe8' },
  { role: 'buildup', name: 'Build-up', startDb: -5, color: '#fb7185' },
  { role: 'hats', name: 'Hats', startDb: -6, color: '#22d3ee' },
  { role: 'hats2', name: 'Hats 2', startDb: -9, color: '#67e8f9' },
  { role: 'ride', name: 'Ride', startDb: -9, color: '#5eead4' },
  { role: 'perc', name: 'Perc', startDb: -7, color: '#4ee3a6' },
  { role: 'perc2', name: 'Perc 2', startDb: -9, color: '#86efac' },
  { role: 'top', name: 'Tops', startDb: -6, color: '#60a5fa' },
  { role: 'top2', name: 'Tops 2', startDb: -8, color: '#7dd3fc' },
  { role: 'top3', name: 'Tops 3', startDb: -9, color: '#93c5fd' },
  { role: 'top4', name: 'Tops 4', startDb: -10, color: '#a5b4fc' },
  { role: 'groove', name: 'Groove', startDb: -8, color: '#a3e635' },
  { role: 'bass', name: 'Bass', startDb: -4, color: '#fda4af' },
  { role: 'stab', name: 'Stab', startDb: -7, color: '#fcd34d' },
  { role: 'drone', name: 'Drone', startDb: -12, color: '#99f6e4' },
  { role: 'vocal', name: 'Vocal', startDb: -3, color: '#f9a8d4' },
  { role: 'vchop', name: 'Vocal Chops', startDb: -6, color: '#fbcfe8' },
  { role: 'disco', name: 'Disco Hit', startDb: -6, color: '#f0abfc' },
  { role: 'disco2', name: 'Disco Hit 2', startDb: -7, color: '#f5d0fe' },
  { role: 'fills', name: 'Fills', startDb: -5, color: '#fb923c' },
  { role: 'fx', name: 'FX', startDb: -9, color: '#a78bfa' },
  { role: 'fx2', name: 'FX 2', startDb: -11, color: '#c4b5fd' },
  { role: 'crash', name: 'Crash', startDb: -8, color: '#fef08a' },
  { role: 'hits', name: 'Hits', startDb: -6, color: '#fde68a' },
  { role: 'atmos', name: 'Atmos', startDb: -11, color: '#94a3b8' },
]
/** Lanes that keep playing in the beat or two of silence before a drop. */
const THROUGH_SILENCE = new Set<Role>(['fills', 'fx', 'fx2', 'hits'])
/** The Drone lane's sidechain depth when Generate doesn't set one. */
const DRONE_SIDECHAIN = 0.6
/** The rules a drone's lane owns, kept with a kept drone. */
export const DRONE_RULES = ['droneAt', 'droneRhythm', 'droneWarp', 'droneOctave', 'droneStart'] as const

export function laneRole(laneName: string): Role | undefined {
  return LANES.find((x) => x.name === laneName)?.role
}
const TOP_ROLES: Role[] = ['top', 'top2', 'top3', 'top4']
const CLAP_ROLES: Role[] = ['clap', 'clap2', 'clap3']
/** What an intro's lift brings in (and an outro's lets go). */
type LiftRole = 'hats' | 'perc' | 'top2' | 'clap'
/** Bars an intro (or outro) of `bars` fills up over (thins out over): 8, or 16 from 32 bars. */
export const liftBars = (bars: number) => (bars >= 32 ? 16 : 8)
/** The chord stab lane (SCOPE.md §6.9): one sample playing the track's stab rhythm. */
export const STAB_ROLES: Role[] = ['stab']
/** What stops with the tops in a full breath before drops. */
const BREATH_DRUMS: Role[] = [...CLAP_ROLES, 'hats', 'hats2', 'perc', 'perc2', 'bass']
/** A bass build's high-pass ends here: the sub coming in towards the drop. */
const BASS_SWEEP_TO_HZ = 40

/**
 * The build-ups into drops (SCOPE.md §6.6), programmed on their own lane over the last bars
 * before each drop: a snare roll in 16ths opening from low-passed and thinning out at the end,
 * a snare in quarters, 8ths, then 16ths, a low-passed kick in 8ths (the kick lane out there), or
 * claps on every beat (the clap lane out there). Each gets louder towards the drop.
 */
export const BUILDUPS = ['snareRoll', 'snareSteps', 'kickRoll', 'claps'] as const
export type Buildup = typeof BUILDUPS[number] | 'none'
/** The snare roll's low-pass opens from … to … Hz, then a high-pass rises from … to … Hz over its last quarter. */
const ROLL_LP_FROM_HZ = 350
const ROLL_LP_TO_HZ = 16000
const ROLL_HP_FROM_HZ = 60
const ROLL_HP_TO_HZ = 1800
/** The kick roll's low-pass opens from … to … Hz. */
const KICK_ROLL_LP_FROM_HZ = 160
const KICK_ROLL_LP_TO_HZ = 2400
/** dB each build-up starts at, rising evenly to 0 on the drop. */
const BUILDUP_FROM_DB: Record<typeof BUILDUPS[number], number> = { snareRoll: -15, snareSteps: -9, kickRoll: -6, claps: -4 }
/** Crashes coming faster into drops: per bar before it, how often (16ths apart) and how loud (dB). */
const CRASH_FASTER: [number, number][] = [[8, -6], [4, -3], [2, 0]]
const BUILDUP_NOTE: Record<typeof BUILDUPS[number], string> = {
  snareRoll: 'snare roll opening up', snareSteps: 'snare in 4ths, 8ths, 16ths', kickRoll: 'low-passed kick roll', claps: 'claps on every beat',
}
/**
 * Rules newer than some saved generations: a track made before them is remade without them
 * (no build-up appears on a lane made again).
 */
const LATER_RULES: Rules = { buildup: 'none', buildupBars: 4, buildupCrash: 'none', ioLift: false, firstDrop: 'full', droneIn: false, vocalIn: false }
const rulesOf = (g: Generation): Rules => ({ ...LATER_RULES, ...g.rules })

/** A lane's step in the starting mix (see LANES). */
const startingDb = (role: Role) => LANES.find((l) => l.role === role)?.startDb ?? 0

/**
 * Every generated lane of `project` (or `only` these) brought to its place in the balance
 * (balance.ts): the producers' in the user's tracks, else the house defaults; and its EQ (eq.ts).
 */
function balanceLanes(project: Project, all: SampleListItem[], opts: GenerateOptions, sections: Section[], only?: Set<string>): Balance & { measured: number } {
  const hits = [...opts.disco?.hits ?? [], ...opts.stabs?.hits ?? []].map(hitSample)
  const byPath = new Map([...all, ...hits].map((s) => [s.rel_path, s]))
  const balance = balanceFrom(opts.templates ?? [])
  const drops = dropRanges(sections)
  const measured = levelLanes(project, byPath, balance, drops, laneRole, startingDb, only)
  eqLanes(project, byPath, opts.templates ?? [], drops, laneRole, only)
  return { ...balance, measured }
}

/** Lane volumes = the Generate view's sliders (dB per lane, 0 by default). */
export function applyMix(project: Project, mix: Mix): void {
  for (const lane of project.lanes) {
    const l = LANES.find((x) => x.name === lane.name)
    if (l) lane.volumeDb = mix[l.role] ?? 0
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
  /** Volume per lane in dB, on top of the balanced mix. */
  mix?: Mix
  /** Bass (SCOPE.md §6.7): imported basslines and the Serum patch pool; null or empty = no bass. */
  bass?: BassOptions | null
  /** Reverb builds on top loops; null or left out = none. */
  verb?: VerbOptions | null
  /** Disco hits (SCOPE.md §6.8) a track may drop at key moments; null or empty = none. */
  disco?: { hits: HitItem[] } | null
  /**
   * Chord stabs (SCOPE.md §6.9) every track plays: the Chord Stabs page's samples, moved into the
   * track key; null or empty = none.
   */
  stabs?: {
    hits: HitItem[]
    /** Rhythms saved in the step sequencer: they replace the built-in ones (some tracks take one as it is, the rest learn from them). */
    rhythms?: SavedStabRhythm[]
  } | null
  /**
   * Drones (SCOPE.md §6.10) some tracks run under them: the Drones page's samples, and the Drone
   * lane's sidechain depth; null or empty = none.
   */
  drones?: { hits: HitItem[]; sidechain?: number } | null
  /**
   * Vocals (SCOPE.md §6.11): the Vocals page's analysed takes, one sung in every track (one not
   * used in an export yet while there are some); null or empty = none.
   */
  vocals?: { takes: VocalTake[] } | null
  /**
   * Choices locked in Generate (choices.ts): these rules, whatever the track would draw or the
   * real track it's built on does. Applied last, also when a lane is made again.
   */
  locks?: Rules | null
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
  /** Octave per preset (semitones by path), on top of the move into the track key. */
  octaves?: Record<string, number>
  /** Sidechain depth under the kick, 0…1. */
  sidechain: number
}

/**
 * Reverb builds (SCOPE.md §6.6): the loops' reverb send rising into every drop and breakdown
 * (over 2 bars), and if `every` is set also at the end of every 8 or 16 bars (over 1 bar).
 */
export interface VerbOptions {
  tops: boolean
  every: 8 | 16 | null
  /** The send where a build peaks, 0…1. */
  amount: number
}

/** Rides: which lanes take the moves of which part of the reference track, and its name. */
const RIDE_ROLES: [RidePart, Role[], string][] = [
  ['bass', ['bass'], 'bass'], ['top', ['top', 'top2', 'top3', 'top4', 'groove'], 'tops'],
]
/** The mix high-pass into drops leaves the moments alone: risers, fills, impacts, crashes, hits. */
const MIX_HP_ROLES = (r: Role) => !['fills', 'fx', 'fx2', 'hits', 'crash', 'disco', 'disco2'].includes(r)

/** A seed from a structure's shape (FNV-1a): the same sections, the same rides. */
function structureSeed(sections: Section[]): number {
  let h = 0x811c9dc5
  for (const ch of JSON.stringify(sections.map((s) => [s.kind, s.bars, s.src ?? null]))) {
    h ^= ch.charCodeAt(0)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

/** Bars a reverb build rises over: into drops and breakdowns, and at phrase ends. */
const VERB_INTO_BARS = 2
const VERB_PHRASE_BARS = 1

export interface Keep {
  structure?: Section[]
  key?: string | null
  picks?: Partial<Record<Role, SampleListItem>>
  bassMidi?: MidiItem
  bassPreset?: SerumPreset
  /** The kept bassline's piano-roll edits. */
  bassEdit?: { notes: [number, number, number, number][]; bars: number }
  /** Track rules to keep (a lane re-roll keeps all but that lane's own). */
  rules?: Rules
  /** Samples (paths) not to pick again when there's another. */
  avoid?: string[]
  /**
   * Make the track again as it was made (its `rngAt`), with the kept picks and rules: what
   * doesn't follow from a changed rule comes out the same.
   */
  replay?: number
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
    role: 'bass', keyLabel: b.midi.key_label,
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
  /** The RNG's state once structure and key were chosen (a replay goes on from there). */
  rngAt?: number
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

  /** Take back a pick another (kept) sample stands in for. */
  unuse(s: SampleListItem): void {
    this.used.set(s.zip_id, Math.max(0, (this.used.get(s.zip_id) ?? 0) - 1))
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
  /** Semitones (a disco hit moved into the track key). */
  pitch?: number
  /** A volume ride over the bar (a build-up getting louder): dB at its start, and at its end. */
  gainDb?: number
  gainTo?: number
}

interface Segment {
  sample: SampleListItem
  start: number    // beats
  length: number   // beats
  filter?: ClipFilter
  verb?: ClipReverb
  /** A volume ride (dB at the start and the end); no ride when left out. */
  gainDb?: number
  gainTo?: number
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
    && JSON.stringify(a.verb ?? null) === JSON.stringify(b.verb ?? null)
    && (a.gainDb ?? 0) === (b.gainDb ?? 0) && a.gainTo === b.gainTo
}

/** Lanes whose one-shot patterns take on the track's feel (the kick and crash stay on the grid). */
// (Not the chord stabs: they sit straight on the grid, where a patch's arp keeps them anyway.)
const GROOVED = new Set<Role>(['clap', 'clap2', 'clap3', 'hats', 'hats2', 'ride', 'perc', 'perc2', 'top', 'top2', 'top3', 'top4'])

const patternKey = (p: BarPattern) => `${p.sample.rel_path}|${p.steps.join('')}|${JSON.stringify(p.filter ?? null)}|${p.pitch ?? 0}|${p.gainDb ?? 0}|${p.gainTo ?? ''}`

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

  /** Split `role`'s loops that run across `beat` into two that play on seamlessly (`rendered`: bass parts too). */
  splitAt(role: Role, beat: number, rendered = false): void {
    const segs = this.segs.get(role)
    if (!segs) return
    this.segs.set(role, segs.flatMap((s) => {
      if (s.sample.kind !== 'loop' || (s.bass && !rendered) || beat <= s.start || beat >= s.start + s.length) return [s]
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

  /**
   * A reverb build on `role`'s loops over [from, to) beats: the send rising to
   * `peak` where they stop (at `to`, or earlier when they stop before the line). False when
   * nothing plays there.
   */
  swell(role: Role, from: number, to: number, peak: number): boolean {
    this.splitAt(role, from, true)
    this.splitAt(role, to, true)
    const segs = (this.segs.get(role) ?? []).filter((s) => s.sample.kind === 'loop' && s.start >= from && s.start < to)
    if (!segs.length) return false
    const end = Math.max(...segs.map((s) => s.start + s.length))
    const at = (beat: number) => peak * Math.min(1, (beat - from) / (end - from)) ** 2
    for (const s of segs) s.verb = { from: at(s.start), to: at(s.start + s.length) }
    return true
  }

  /**
   * A ride on `role`'s loops (rendered parts too) over [from, to) beats: a filter sweeping from
   * `filter.from` to `filter.to` Hz and/or the volume from `gainDb` to `gainTo` dB, evenly across
   * [from, to) (a loop covering only part of it gets its share). Loops that have a filter or a ride
   * already (a build's, a breakdown's) keep theirs. False when nothing plays there.
   */
  ride(role: Role, from: number, to: number, r: { filter?: ClipFilter; gainDb: number; gainTo?: number }): boolean {
    this.splitAt(role, from, true)
    this.splitAt(role, to, true)
    const segs = (this.segs.get(role) ?? []).filter((s) => s.sample.kind === 'loop' && s.start >= from && s.start < to
      && !s.filter && s.gainTo == null && !s.gainDb)
    const t = (beat: number) => Math.min(1, (beat - from) / (to - from))
    const hz = (beat: number) => r.filter!.from * ((r.filter!.to ?? r.filter!.from) / r.filter!.from) ** t(beat)
    const db = (beat: number) => r.gainDb + ((r.gainTo ?? r.gainDb) - r.gainDb) * t(beat)
    for (const s of segs) {
      const e = s.start + s.length
      if (r.filter) {
        const [a, z] = [Math.round(hz(s.start)), Math.round(hz(e))]
        s.filter = { ...r.filter, from: a, to: r.filter.to == null || a === z ? null : z }
      }
      const [a, z] = [Math.round(db(s.start) * 2) / 2, Math.round(db(e) * 2) / 2]
      if (a) s.gainDb = a
      if (z !== a) s.gainTo = z
    }
    return segs.length > 0
  }

  /** `role`'s loops (`rendered`: bass parts too) stop for [from, to) beats and play on after it. */
  cut(role: Role, from: number, to: number, rendered = false): void {
    this.splitAt(role, from, rendered)
    this.splitAt(role, to, rendered)
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
   * early (a drop's moment of silence); one running on past it (a drone all through) plays on
   * after it, from where its loop is there.
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
    for (const role of [...this.segs.keys()]) {
      if (keep.has(role)) continue
      this.splitAt(role, to, true)
      this.segs.set(role, this.segs.get(role)!.flatMap((s) => {
        const end = s.start + s.length
        if (end <= from || s.start >= to) return [s]
        return s.start < from ? [{ ...s, length: from - s.start }] : []
      }))
    }
  }

  /**
   * Bar patterns become pattern clips (runs of identical bars merge; on the stab lanes also runs
   * of a 2-bar rhythm, as 2-bar patterns); segments become audio clips.
   */
  clips(laneIds: Map<Role, string>): Clip[] {
    const out: Clip[] = []
    for (const [role, bars] of this.bars) {
      const laneId = laneIds.get(role)!
      const emit = (start: number, len: number, p: BarPattern, steps: Steps, patternBars: 1 | 2) => {
        if (!steps.some(Boolean)) return
        const c: PatternClip = {
          id: uid('c'), laneId, type: 'pattern', start: start * BEATS_PER_BAR, length: len * BEATS_PER_BAR,
          gainDb: p.gainDb ?? 0, sample: sampleRef(p.sample), patternBars, steps: [...steps],
        }
        if (p.gainTo != null) c.gainTo = p.gainTo
        if (p.filter) c.filter = { ...p.filter }
        if (p.pitch) c.pitch = p.pitch
        if (this.feel && GROOVED.has(role)) c.groove = grooveFor(this.feel, c.steps)
        out.push(c)
      }
      const key = (b: number) => (bars[b] ? patternKey(bars[b]!) : '')
      const rest = (b: number) => (bars[b] ? patternKey({ ...bars[b]!, steps: [] }) : '')
      for (let b = 0; b < bars.length;) {
        const p = bars[b]
        if (!p) { b++; continue }
        if (STAB_ROLES.includes(role) && key(b + 1) && key(b + 1) !== key(b) && rest(b + 1) === rest(b)) {
          let pairs = 1
          while (key(b + 2 * pairs) === key(b) && key(b + 2 * pairs + 1) === key(b + 1)) pairs++
          if (pairs >= 2) {
            emit(b, 2 * pairs, p, [...p.steps, ...bars[b + 1]!.steps], 2)
            b += 2 * pairs
            continue
          }
        }
        let n = 1
        while (key(b + n) === key(b)) n++
        emit(b, n, p, p.steps, 1)
        b += n
      }
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
          id: uid('c'), laneId, type: 'audio', start: s.start, length: s.length, trimBeats: s.trim ?? 0, gainDb: s.gainDb ?? 0,
          sample: sampleRef(s.sample),
        }
        if (s.gainTo != null) c.gainTo = s.gainTo
        if (s.filter) c.filter = { ...s.filter }
        if (s.verb) c.verb = { ...s.verb }
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
  // A replay (one of the track's rules changed) goes on from where the track's own RNG was here.
  if (keep.replay != null) rng.restore(keep.replay)
  const rngAt = rng.save()
  const picker = new Picker(rng, opts.useRatings, key, new Set(keep.avoid))
  const choices: string[] = []

  // ---- main samples (one per lane for the whole track, variations for later drops) ----
  const pool = (f: (s: SampleListItem) => boolean) => samples.filter(f)
  /**
   * A lane's kept sample, else `draw()`. In a replay the sample is drawn all the same (and the
   * kept one swapped in), so the RNG and the zip spread go on as they did when the track was made.
   */
  const keptOr = (role: Role, draw: () => SampleListItem | null) => {
    const k = keep.picks?.[role]
    if (!k) return draw()
    if (keep.replay == null) return picker.use(k)
    const d = draw()
    if (d?.id === k.id) return d
    if (d) picker.unuse(d)
    return picker.use(k)
  }
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

  const kick = keptOr('kick', () => picker.pick(pool(of('oneshot', 'kick'))))
  // The main loops first: the track's feel comes from one of them, the other loops are picked to fit it.
  const topLoops = loopsOf('top')
  const top0 = keptOr('top', () => picker.pick(topLoops))
  const groove = keptOr('groove', () => picker.pick(loopsOf('groove')))
  let feelSrc = [groove, top0].find(hasFeel) ?? null
  const fits = (s: SampleListItem) => feelFit(s.groove, feelSrc?.groove)
  const clapShots = pool(of('oneshot', 'clap', 'snare'))
  const clap = keptOr('clap', () => picker.pick(clapShots))
  // Layered claps (never a second kick): played together on the backbeat in drops.
  const claps = layers(clap, clapShots, rng.weighted([[1, 2], [2, 3], [3, 2]] as const))
  const hatLoops = loopsOf('hat', 'hat_closed', 'hat_open', 'shaker')
  // Rides come in later (drops only), never in intros and outros.
  const ride = picker.pick(loopsOf('ride'), { fit: fits }) ?? picker.pick(pool(of('oneshot', 'ride')))
  const rideSteps = steps(rng.chance(0.5) ? FOUR.map((s) => s + 2) : EIGHTHS, 2)
  const hats = keptOr('hats', () => picker.pick(hatLoops, { weight: preferShort, fit: fits })
    ?? picker.pick(pool(of('oneshot', 'hat_closed', 'hat', 'hat_open'))))
  const hats2 = hats?.kind === 'loop' && rng.chance(0.55) ? picker.pick(hatLoops, { not: hats, fit: fits }) : null
  const percLoops = loopsOf('perc')
  const perc = keptOr('perc', () => picker.pick(percLoops, { weight: preferShort, fit: fits }) ?? picker.pick(pool(of('oneshot', 'perc', 'shaker'))))
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

  // ---- bass (SCOPE.md §6.7): a new riff learned from the MIDI page, through a Serum patch, in the
  // track key ----
  const bo = opts.bass
  const model = bo?.midis.length && bo.presets.length ? bassModel(bo.midis) : null
  const bassMidi = model
    ? keep.bassMidi ?? generatedMidi(generateBassline(model, rng, { key, bars: bo!.bars }), key) : null
  const bassPreset = bassMidi && bo
    ? keep.bassPreset ?? rng.pickBy(bo.presets, (p) => 1 + (bo.favorites.includes(p.path) ? 3 : 0)) : null
  const bass: GenerationBass | null = bassMidi && bassPreset
    ? { midi: bassMidi, preset: bassPreset, transpose: transposeTo(bassMidi.key_label, key) + (bo?.octaves?.[bassPreset.path] ?? 0), ...(keep.bassMidi ? keep.bassEdit : undefined) }
    : null

  // ---- chord stabs (SCOPE.md §6.9): the Chord Stabs page's samples, in every track while there
  // are some; an RNG of their own, so the drums and the bass are the same with or without them ----
  const srng = new Rng(seed ^ 0x53544142)
  const stabItems = opts.stabs?.hits ?? []
  const stabPool = stabItems.map(hitSample)
  const stabOf = new Map(stabItems.map((h) => [h.rel_path, h]))
  const keptRule = keep.rules?.stabs as boolean | undefined
  const useStabs = stabPool.length > 0 && (keptRule ?? true)
  const stabs: SampleListItem[] = []
  if (useStabs) {
    const keptIds = STAB_ROLES.map((r) => keep.picks?.[r]?.id)
    for (const role of STAB_ROLES) {
      const own = keep.picks?.[role] ? stabPool.find((x) => x.id === keep.picks![role]!.id) : undefined
      const cands = stabPool.filter((x) => !stabs.includes(x) && !keptIds.includes(x.id))
      const fresh = cands.filter((x) => !keep.avoid?.includes(x.rel_path))
      const pick = own ?? (fresh.length ? srng.pick(fresh) : cands.length ? srng.pick(cands) : null)
      if (pick) stabs.push(pick)
    }
    stabs.forEach((x, i) => (picks[STAB_ROLES[i]] = x))
  }

  // ---- disco hits (SCOPE.md §6.8): the Disco Hits page's samples, moved into the track key. An
  // RNG of their own keeps the rest of the track the same with or without them ----
  const drng = new Rng(seed ^ 0x44495343)
  const hpRng = new Rng(seed ^ 0x4d495848)
  // The build-ups into drops and their snare: an RNG of their own too.
  const brng = new Rng(seed ^ 0x4255494c)
  // How the track fills up out of its intro (and thins out into its outro): an RNG of its own too.
  const lrng = new Rng(seed ^ 0x4c494654)
  const buildDrawn = {
    buildup: brng.weighted([['none', 3], ['snareRoll', 2], ['snareSteps', 2], ['kickRoll', 1.5], ['claps', 1.5]] as const) as Buildup,
    buildupBars: brng.weighted([[2, 1], [4, 3], [8, 2]] as const) as number,
    buildupCrash: brng.weighted([['none', 4], ['faster', 1.5], ['last4', 1.5]] as const) as 'none' | 'faster' | 'last4',
  }
  const snares = pool(of('oneshot', 'snare')).filter((x) => !claps.some((c) => c.id === x.id))
  const snareCands = snares.length ? snares : clapShots.filter((x) => !claps.some((c) => c.id === x.id))
  const freshSnares = snareCands.filter((x) => !keep.avoid?.includes(x.rel_path))
  const drawnSnare = (freshSnares.length ? freshSnares : snareCands).length ? brng.pick(freshSnares.length ? freshSnares : snareCands) : null
  const keptSnare = keep.picks?.buildup && of('oneshot', 'snare', 'clap')(keep.picks.buildup) ? keep.picks.buildup : null
  const snare = keptSnare ?? drawnSnare ?? clap
  const hitItems = opts.disco?.hits ?? []
  const hitPool = hitItems.map(hitSample)
  // ---- drones (SCOPE.md §6.10): the Drones page's samples. An RNG of their own, like the disco hits ----
  const orng = new Rng(seed ^ 0x44524f4e)
  const droneHits = opts.drones?.hits ?? []
  // ---- vocals (SCOPE.md §6.11): the Vocals page's takes. An RNG of their own too ----
  const vrng = new Rng(seed ^ 0x564f434c)
  const takes = opts.vocals?.takes ?? []
  const hitOf = new Map(hitItems.map((h) => [h.rel_path, h]))

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
    // Or a build-up of the track's own (none when it takes a producer's roll), the bars it runs,
    // and crashes building the drop: faster and faster, or on the last four counts.
    buildup: inSet((s) => s.category === 'roll') ? 'none' as Buildup : buildDrawn.buildup,
    buildupBars: buildDrawn.buildupBars,
    buildupCrash: buildDrawn.buildupCrash,
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
    // Hats in the intro and outro (a choice per track, more often in the outro): none, the half
    // next to the drops, or all through.
    introHats: rng.weighted([['none', 4], ['half', 3], ['all', 3]] as const),
    outroHats: rng.weighted([['none', 2], ['half', 1], ['all', 4]] as const),
    // Breakdowns keep a top loop going, mostly low-passed (as in most real tracks).
    topsBreaks: rng.weighted([['filtered', 5], ['open', 3], ['none', 1]] as const),
    topsBreakHz: rng.int(900, 5000),
    // A breath in the bar before drops: the tops stop there, or the tops and the drums (claps,
    // hats, perc) and the bass, while fills and FX play on.
    dropBreath: rng.weighted([[null, 3], ['tops', 2], ['all', 3]] as const),
    // Bass: full in drops; in breakdowns high-passed (its sub out, as real tracks do) or out; in
    // builds out, high-passed, or a high-pass letting the sub in towards the drop; intro and outro
    // usually without (DJ friendly), sometimes high-passed.
    bassBreaks: rng.weighted([['filtered', 3], ['none', 2]] as const),
    bassBuild: rng.weighted([['filtered', 3], ['sweep', 1], ['none', 2]] as const),
    bassIO: rng.weighted([['none', 3], ['filtered', 1]] as const),
    bassHp: rng.int(BASS_HP_MIN_HZ + 10, 380),
    // The whole mix high-passed in the bars before drops (also when the track it's built on does it).
    mixHp: hpRng.chance(0.3) ? hpRng.weighted([[1, 1], [2, 2], [4, 1]] as const) as number : 0,
    // The intro fills up over its last bars with what the drops have and it doesn't yet (hats,
    // perc, a second top, claps), one by one, and the outro lets them go the same way; a first drop
    // straight after the intro starts leaner, its layers coming in over its first half.
    ioLift: lrng.chance(0.8),
    firstDrop: lrng.weighted([['lean', 3], ['full', 1]] as const),
    // Disco hits in some tracks: one or two, on the 1 where each drop starts and halfway through
    // it, or every 16 or 8 bars of the drops, or also where each breakdown starts.
    discoIn: hitPool.length > 0 && drng.chance(0.6),
    discoCount: drng.weighted([[1, 2], [2, 1]] as const) as number,
    discoAt: drng.weighted([['drops', 3], ['16', 2], ['8', 1], ['all', 2]] as const),
    // A drone in some tracks: in the drops, all through, or all but the intro and outro. Its own
    // take on the sample, so the same one sounds new: an octave down or up sometimes, a warp
    // (slowed down 2× or 4×, reversed), the part of it the loop starts from, and sometimes a
    // rhythm (a soft 8th, 16th or dotted gate, swells to the offbeats, chopped 16ths).
    droneIn: droneHits.length > 0 && orng.chance(DRONE_CHANCE),
    droneAt: orng.weighted([['drops', 3], ['all', 2], ['inner', 3]] as const),
    droneRhythm: orng.weighted([['pump', 5], ['gate8', 1.5], ['gate16', 1.5], ['swell', 1.5], ['dotted', 1], ['chop', 1]] as const) as DroneRhythm,
    droneWarp: orng.weighted([['none', 3], ['slow2', 2], ['slow4', 1.5], ['reverse', 1]] as const) as DroneWarp,
    droneOctave: orng.weighted([[0, 4], [-12, 2], [12, 1]] as const) as number,
    droneStart: orng.int(0, 99) / 100,
    // A vocal in every track: its phrase loop, its chops, or both; the long or the short loop; the
    // phrase in the drops, in their second halves, in drops and breakdowns, or in breakdowns (a
    // reverb build on it there); the chops in the drops (where the phrase isn't), also into them.
    vocalIn: takes.length > 0,
    vocalUse: vrng.weighted([['phrase', 3], ['chops', 2], ['both', 4]] as const) as 'phrase' | 'chops' | 'both',
    vocalLoop: vrng.weighted([['long', 1], ['short', 1]] as const) as 'long' | 'short',
    vocalAt: vrng.weighted([['drops', 3], ['halves', 2], ['drops_breaks', 3], ['breaks', 1]] as const) as 'drops' | 'halves' | 'drops_breaks' | 'breaks',
    chopsAt: vrng.weighted([['drops', 3], ['drops_builds', 1]] as const) as 'drops' | 'drops_builds',
    chopRhythm: stabRhythm(vrng),
    // The feel: how much of the main loop's groove the one-shots and the bass take on.
    feel: rng.int(70, 100) / 100,
    // Loop variations: a top layer (or the second perc / hat loop) a little higher or lower, and
    // in the intro (mirrored in the outro) loops repeating only their first bar or two at first.
    pitchTop: tops.length > 1 && rng.chance(0.35) ? [rng.int(1, tops.length - 1), rng.weighted(PITCHES)] as [number, number] : null,
    pitchPerc2: perc2 && rng.chance(0.25) ? rng.weighted(PITCHES) : null,
    pitchHats2: hats2 && rng.chance(0.2) ? rng.weighted(PITCHES) : null,
    ioShort: rng.chance(0.4) ? rng.weighted([[1, 1], [2, 2]] as const) as number : null,
    // Chord stabs and their 2-bar rhythm; in drops only, or also low-passed in breakdowns and
    // builds ('keys': where keys parts played before stabs replaced them).
    stabs: useStabs,
    stabRhythm: stabRhythm(srng, opts.stabs?.rhythms ?? []),
    stabsIn: srng.weighted([['drops', 1], ['keys', 1]] as const),
    stabsBreaks: srng.weighted([['filtered', 2], ['none', 1]] as const),
    stabsBuild: srng.weighted([['sweep', 2], ['filtered', 1], ['none', 1]] as const),
    stabsCutoff: srng.int(700, 1800),
  }
  const rules: typeof drawn = { ...drawn, ...(tpl?.rules as Partial<typeof drawn> | undefined), ...(keep.rules as Partial<typeof drawn> | undefined),
    ...(opts.locks as Partial<typeof drawn> | undefined) }
  // A build-up or a roll sample into drops, not both: a locked roll goes without the build-up,
  // otherwise the build-up takes the roll's place (a fill can still lead in with it).
  if (rules.buildup !== 'none' && rules.dropFill === 'roll') {
    if (opts.locks && 'dropFill' in opts.locks && !('buildup' in opts.locks)) rules.buildup = 'none'
    else rules.dropFill = fills.length ? 'fill' : null
  }
  const fxChance = { sparse: 0.45, normal: 0.75, busy: 0.95 }[rules.fx]
  const keptGaps = rules.dropGaps
  const dropGaps: Record<string, number> = {}
  const set = rules.dropSet ? sets.get(rules.dropSet) ?? null : null

  const lanes = new Lanes(total)
  const feel = feelSrc?.groove ? stepGroove(feelSrc.groove, rules.feel) : null
  lanes.feel = feel && audible(feel) ? feel : null
  if (bass && lanes.feel) bass.groove = lanes.feel.offsets
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

  /** What each stab lane plays of the track's stab rhythm (all of it), and its pitch in the track key. */
  const stabSteps = stabs.map(() => rules.stabRhythm)
  const stabPitch = stabs.map((x) => (stabOf.has(x.rel_path) ? hitPitch(stabOf.get(x.rel_path)!, key) : 0))
  /** The stab rhythm over [from, to) bars, a bar at a time (a sweeping filter moving bar by bar). */
  const stabBars = (from: number, to: number, filter?: ClipFilter) => {
    const hz = (b: number) => Math.round(filter!.from * ((filter!.to ?? filter!.from) / filter!.from) ** ((b - from) / (to - from)))
    stabs.forEach((x, i) => {
      for (let b = from; b < to; b++) {
        const f = filter && (filter.to == null ? filter : { ...filter, from: hz(b), to: hz(b + 1) })
        lanes.setBar(STAB_ROLES[i], b, {
          sample: x, steps: [...stabSteps[i][(b - from) % stabSteps[i].length]], ...(f ? { filter: f } : {}), ...(stabPitch[i] ? { pitch: stabPitch[i] } : {}),
        })
      }
    })
  }

  const crashAt = new Set<number>()
  const tracks = { tops: Math.min(tops.length, rules.dropTops) }
  /**
   * The lift of an intro (rule `ioLift`): what the drops have that it doesn't yet, in the order it
   * joins (hats, perc, a second top loop, claps), each with the bars before the intro's end it
   * comes in at, spread over its last 8 bars (16 in an intro of 32 or more) on 4-bar steps. The
   * outro lets them go the same way, from its start.
   */
  const liftOf = (sec: Section): [LiftRole, number][] => {
    if (!rules.ioLift || (sec.kind !== 'intro' && sec.kind !== 'outro')) return []
    const missing = ([
      ['hats', !!hats && (sec.kind === 'intro' ? rules.introHats : rules.outroHats) === 'none'],
      ['perc', !!perc && !rules.ioPerc],
      ['top2', tops.length > 1 && rules.ioTopSecond == null],
      ['clap', !!clap && !rules.ioClaps],
    ] as const).filter(([, m]) => m).map(([r]) => r)
    const w = liftBars(sec.bars)
    return missing.map((r, k) => [r, w - Math.floor((k * w) / 4 / missing.length) * 4])
  }
  /**
   * The track's build-up over the last bars of `sec`, into the drop after it: bar by bar on the
   * Build-up lane, louder as it goes (a kick roll or claps take the kick or clap lane's place there).
   */
  const buildUp = (sec: Section) => {
    const type = rules.buildup as Buildup
    if (type === 'none') return
    const sample = type === 'kickRoll' ? kick : type === 'claps' ? clap : snare
    if (!sample) return
    const z = sec.start + sec.bars
    // At most half the section, a quarter of an intro (its mix-in half stays the intro's).
    const n = Math.min(rules.buildupBars, Math.max(1, Math.floor(sec.bars / (sec.kind === 'intro' ? 4 : 2))))
    const a = z - n
    const fromDb = BUILDUP_FROM_DB[type]
    const db = (bar: number) => Math.round(fromDb * (1 - (bar - a) / n) * 2) / 2 || 0
    const sweep = (f0: number, f1: number, x0: number, x1: number, type_: ClipFilter['type'], n_: number): ClipFilter => ({
      type: type_, from: Math.round(f0 * (f1 / f0) ** (x0 / n_)), to: Math.round(f0 * (f1 / f0) ** (x1 / n_)), q: 0.7,
    })
    // The snare roll: low-pass opening, then a high-pass thinning it out over its last quarter.
    const hpBars = Math.ceil(n / 4)
    const lpBars = n - hpBars
    for (let b = a; b < z; b++) {
      const j = b - a
      const s_ = new Array(STEPS_PER_BAR).fill(0) as Steps
      for (let k = 0; k < STEPS_PER_BAR; k++) {
        const t = (j * STEPS_PER_BAR + k) / (n * STEPS_PER_BAR)
        const on = type === 'snareRoll' ? true
          : type === 'snareSteps' ? (t < 1 / 3 ? k % 4 === 0 : t < 2 / 3 ? k % 2 === 0 : true)
            : type === 'kickRoll' ? k % 2 === 0 : k % 4 === 0
        if (!on) continue
        s_[k] = (type === 'snareRoll' ? (t < 1 / 3 ? 1 : t < 2 / 3 ? 2 : 3) : type === 'kickRoll' ? 3 : t < 1 / 2 ? 2 : 3) as Velocity
      }
      const filter = type === 'snareRoll'
        ? (j < lpBars ? sweep(ROLL_LP_FROM_HZ, ROLL_LP_TO_HZ, j, j + 1, 'lowpass', lpBars) : sweep(ROLL_HP_FROM_HZ, ROLL_HP_TO_HZ, j - lpBars, j - lpBars + 1, 'highpass', hpBars))
        : type === 'kickRoll' ? sweep(KICK_ROLL_LP_FROM_HZ, KICK_ROLL_LP_TO_HZ, j, j + 1, 'lowpass', n) : undefined
      lanes.setBar('buildup', b, { sample, steps: s_, ...(filter ? { filter } : {}), gainDb: db(b), gainTo: db(b + 1) })
      if (type === 'kickRoll') lanes.setBar('kick', b, null)
      if (type === 'claps') for (const r of CLAP_ROLES) lanes.setBar(r, b, null)
    }
    if (sample === snare) picks.buildup = snare
    built = n
  }
  let built = 0

  let dropIndex = 0
  sections.forEach((sec, i) => {
    const a = sec.start
    const z = sec.start + sec.bars
    const next = sections[i + 1]
    const intoDrop = next?.kind === 'drop'
    const intoBreak = next?.kind === 'break'
    const half = a + Math.floor(sec.bars / 2 / PHRASE) * PHRASE || a + sec.bars / 2
    // A first drop straight after the intro starts leaner (rule `firstDrop`): the clap layers and
    // the second hat loop join after its first phrase, its last top loop, the groove and the second
    // perc halfway (bars `leanEarly`, `leanLate`; the drop's start otherwise).
    const lean = sec.kind === 'drop' && dropIndex === 0 && sections[i - 1]?.kind === 'intro' && rules.firstDrop === 'lean'
    const leanEarly = lean ? Math.min(z, a + PHRASE) : a
    const leanLate = lean ? (sec.bars >= 2 * PHRASE ? half : z) : a
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
      for (let b = a; b < z; b++) (b < leanEarly ? clapBar : clapsBar)(b, s)
      const every = rules.clapRolls === '8' ? PHRASE : 2 * PHRASE
      if (rules.clapRolls !== 'none') {
        for (let b = a + every - 1; b < z; b += every) (b < leanEarly ? clapBar : clapsBar)(b, [0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 2, 2, 3, 3])
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

    // ---- hats: in intro, outro and breaks by the track's rules ----
    const hatShot = (v: Velocity = 3) => steps(OFFBEAT, v)
    if (sec.kind === 'break') {
      if (rules.hatsInBreaks) layer('hats', hats, a, z, hatShot(2), { type: 'highpass', from: 900, to: null, q: 0.7 })
    } else if (sec.kind === 'intro' || sec.kind === 'outro') {
      const how = sec.kind === 'intro' ? rules.introHats : rules.outroHats
      if (how === 'all') layer('hats', hats, a, z, hatShot())
      else if (how === 'half') layer('hats', hats, sec.kind === 'intro' ? half : a, sec.kind === 'intro' ? z : half, hatShot())
    } else {
      layer('hats', hats, a, z, hatShot())
      // A second hat loop on top in drops (and the second half of long builds).
      if (sec.kind === 'drop') loop('hats2', hats2, leanEarly, z)
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
      if (dropIndex >= rules.perc2From || sec.peak) loop('perc2', perc2, leanLate, z)
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
      for (let j = 0; j < count; j++) topLayer(j, j > 0 && j === count - 1 ? leanLate : a, z, undefined, gap)
      const g1 = dropIndex >= 1 && rules.grooveSwap ? groove2 : groove
      if (dropIndex >= rules.grooveFrom || sec.peak) {
        if (leanLate < mid) {
          loop('groove', g1, leanLate, mid, undefined, mid === z ? gap : 0)
          if (mid < z) loop('groove', g1 === groove ? groove2 ?? groove : groove, mid, z, undefined, gap)
        } else loop('groove', g1, leanLate, z, undefined, gap)  // a lean drop 1: it comes in halfway
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
    } else if (sec.kind === 'break') {
      if (rules.topsBreaks !== 'none') {
        topLayer(0, a, z, rules.topsBreaks === 'filtered' ? { type: 'lowpass', from: rules.topsBreakHz, to: null, q: 0.7 } : undefined)
      }
    } else if (sec.kind === 'intro') {
      // Mix-in intro: a top loop from the start (or halfway), a second one joining later …
      topLayer(0, phraseAt(rules.ioTopFirst), z)
      if (rules.ioTopSecond != null) topLayer(1, phraseAt(rules.ioTopSecond), z)
    } else if (sec.kind === 'outro') {
      // … and the outro mirrors it: the tops leave the way they came in.
      topLayer(0, a, phraseAt(1 - rules.ioTopFirst))
      if (rules.ioTopSecond != null) topLayer(1, a, phraseAt(1 - rules.ioTopSecond))
    }

    // ---- the lift: what the intro doesn't have yet joins one by one over its last bars, and the
    // outro lets it go the same way, so drops don't come out of (or fall into) nothing ----
    for (const [role, d] of liftOf(sec)) {
      const [from, to] = sec.kind === 'intro' ? [z - d, z] : [a, a + d]
      if (role === 'hats') layer('hats', hats, from, to, hatShot())
      else if (role === 'perc') layer('perc', perc, from, to, percShot)
      else if (role === 'top2') topLayer(1, from, to)
      else for (let b = from; b < to; b++) clapBar(b, steps(TWO_FOUR, 2))
    }

    // ---- chord stabs: the rhythm through every drop; elsewhere nothing, or the same rhythm
    // low-passed in breakdowns and builds (by the track's rules) ----
    if (stabs.length) {
      const lp = (to: number | null = null): ClipFilter => ({ type: 'lowpass', from: rules.stabsCutoff, to, q: 0.8 })
      if (sec.kind === 'drop') stabBars(a, z)
      else if (rules.stabsIn === 'keys' && sec.kind === 'break' && rules.stabsBreaks === 'filtered') stabBars(a, z, lp())
      else if (rules.stabsIn === 'keys' && sec.kind === 'build' && rules.stabsBuild !== 'none') {
        stabBars(a, z, lp(rules.stabsBuild === 'sweep' ? 8000 : null))
      }
    }

    // ---- bass: the bassline repeats in drops; elsewhere high-passed (its sub out) or out, by the
    // track's rules ----
    if (bassSample) {
      const hp = (to: number | null = null): ClipFilter => ({ type: 'highpass', from: rules.bassHp, to, q: 0.7 })
      if (sec.kind === 'drop') bassPart(a, z, undefined, gap)
      else if (sec.kind === 'break') { if (rules.bassBreaks === 'filtered') bassPart(a, z, hp()) }
      else if (sec.kind === 'build') {
        if (rules.bassBuild === 'sweep') bassPart(a, z, hp(BASS_SWEEP_TO_HZ))
        else if (rules.bassBuild === 'filtered') bassPart(a, z, hp())
      } else if (sec.kind === 'intro') { if (rules.bassIO === 'filtered') bassPart(phraseAt(0.5), z, hp()) }
      else if (sec.kind === 'outro') { if (rules.bassIO === 'filtered') bassPart(a, phraseAt(0.5), hp()) }
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
        // The impact as the drop hits, unless it's bassy: its boom would fight the kick (it opens
        // the breakdowns and build-ups instead, below).
        const impact = rules.dropImpact ? trackPick('impact', impacts) : null
        if (impact && !bassy(impact)) placeFree(['hits', 'fx2'], impact, end)
        // A downlifter as the drop hits, on a lane that's free there (never a bassy one).
        const down = rules.dropDown && rules.fx !== 'sparse' ? trackPick('drop-down', downs, true) : null
        if (down && !bassy(down)) placeFree(['hits', 'fx2', 'fx'], down, end)
        dropGaps[z] = t ?? 0
        crashAt.add(z)  // every drop starts with a crash
        buildUp(sec)
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

  // ---- a bassy impact opens the breakdowns and build-ups instead of hitting the drops, where no
  // kick plays under its boom (the kick lane, or a kick roll on the Build-up lane) ----
  const boom = rules.dropImpact ? trackPick('impact', impacts) : null
  if (boom && bassy(boom)) {
    const kicks = (b: number) => !!lanes.bar('kick', b)?.steps.some((v) => v > 0)
      || (!!kick && lanes.bar('buildup', b)?.sample.id === kick.id)
    const body = Math.max(1, Math.ceil(bodyBars(boom)))
    for (const sec of sections) {
      if (sec.kind !== 'break' && sec.kind !== 'build') continue
      const under = Array.from({ length: body }, (_, k) => sec.start + k).filter((b) => b < total)
      if (!under.some(kicks)) placeFree(['hits', 'fx2', 'fx'], boom, sec.start * 4)
    }
  }

  // ---- crashes on the 1 of key moments ----
  if (crash) for (const b of crashAt) if (b < total) lanes.setBar('crash', b, { sample: crash, steps: steps([0]) })
  // … and crashes building every drop: coming faster bar by bar (half bars, quarters, 8ths), or
  // on each of the last four counts.
  if (crash && rules.buildupCrash !== 'none') {
    for (const sec of sections) {
      if (sec.kind !== 'drop' || sec.start < CRASH_FASTER.length) continue
      if (rules.buildupCrash === 'last4') lanes.setBar('crash', sec.start - 1, { sample: crash, steps: steps(FOUR) })
      else {
        CRASH_FASTER.forEach(([every, db], k) => lanes.setBar('crash', sec.start - CRASH_FASTER.length + k, {
          sample: crash, steps: steps(Array.from({ length: STEPS_PER_BAR / every }, (_, x) => x * every), k === CRASH_FASTER.length - 1 ? 3 : 2), ...(db ? { gainDb: db } : {}),
        }))
      }
    }
  }

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

  // ---- disco hits on the 1 of key moments, taking turns when there are two (after the 8-bar
  // variations, so the rest of the track is the same with or without them) ----
  const avoidHits = new Set(keep.avoid)
  const keptHit = (role: Role) => (keep.picks?.[role] ? hitPool.find((s) => s.rel_path === keep.picks![role]!.rel_path) ?? null : null)
  const pickHit = (not: SampleListItem | null) => {
    const cands = hitPool.filter((s) => s.rel_path !== not?.rel_path)
    const fresh = cands.filter((s) => !avoidHits.has(s.rel_path))
    return fresh.length ? drng.pick(fresh) : cands.length ? drng.pick(cands) : null
  }
  const disco1 = keptHit('disco') ?? (rules.discoIn ? pickHit(null) : null)
  const disco2 = disco1 && (keptHit('disco2') ?? (rules.discoCount >= 2 ? pickHit(disco1) : null))
  const discoHits = [disco1, disco2].filter((s): s is SampleListItem => !!s)
  if (discoHits.length) {
    const at: number[] = []
    for (const sec of sections) {
      const z = sec.start + sec.bars
      if (sec.kind === 'drop') {
        if (rules.discoAt === '16' || rules.discoAt === '8') for (let b = sec.start; b < z; b += Number(rules.discoAt)) at.push(b)
        else {
          at.push(sec.start)
          const half = sec.start + Math.floor(sec.bars / 2 / PHRASE) * PHRASE
          if (half > sec.start && half < z) at.push(half)
        }
      } else if (sec.kind === 'break' && rules.discoAt === 'all') at.push(sec.start)
    }
    at.forEach((b, i) => {
      const s = discoHits[i % discoHits.length]
      const pitch = hitPitch(hitOf.get(s.rel_path)!, key)
      lanes.setBar(i % discoHits.length ? 'disco2' : 'disco', b, { sample: s, steps: steps([0]), ...(pitch ? { pitch } : {}) })
    })
    picks.disco = disco1!
    if (disco2) picks.disco2 = disco2
  }

  // ---- a drone under the track (after the 8-bar variations, like the disco hits): one source,
  // washed into a loop, in the drops, all through, or between the intro and the outro ----
  const keptDrone = keep.picks?.drone ? droneHits.find((h) => droneItem(h).id === keep.picks!.drone!.id) ?? null : null
  let drone: HitItem | null = keptDrone
  if (!drone && rules.droneIn && droneHits.length) {
    const fresh = droneHits.filter((h) => !keep.avoid?.some((a) => a.startsWith(droneRenderPrefix(h.rel_path))))
    drone = orng.pick(fresh.length ? fresh : droneHits)
  }
  if (drone) {
    const look: DroneLook = {
      rhythm: rules.droneRhythm as DroneRhythm, warp: (rules.droneWarp ?? 'none') as DroneWarp,
      octave: Number(rules.droneOctave ?? 0), start: Number(rules.droneStart ?? 0),
    }
    const render = droneRender(drone, key, look)
    const item = droneItem(drone)
    const sample = droneSample(item, render, bpm)
    const first = sections[0]
    const last = sections[sections.length - 1]
    const spans: [number, number][] = rules.droneAt === 'drops' ? sections.filter((x) => x.kind === 'drop').map((x) => [x.start, x.start + x.bars])
      : rules.droneAt === 'all' ? [[0, total]]
        : [[first.kind === 'intro' ? first.start + first.bars : 0, last.kind === 'outro' ? last.start : total]]
    for (const [a, z] of spans) {
      if (z > a) lanes.add('drone', { sample, start: a * BEATS_PER_BAR, length: (z - a) * BEATS_PER_BAR, bass: render })
    }
    picks.drone = item
  }

  // ---- a vocal (after the 8-bar variations, like the drone): one take, its phrase loop where the
  // track's rule says, its chops on the key's chord tones in a rhythm ----
  const keptTake = keep.picks?.vocal ? takes.find((t) => vocalItem(t).id === keep.picks!.vocal!.id) ?? null : null
  let take: VocalTake | null = keptTake
  if (!take && rules.vocalIn && takes.length) {
    const avoid = new Set(keep.avoid ?? [])
    const fresh = takes.filter((t) => !t.usedIn.length && !t.analysis.phrases.some((p) => avoid.has(p.path)) && !t.analysis.chops.some((c) => avoid.has(c.path))
      && !(keep.avoid ?? []).some((a) => a.startsWith('.drumvault/vocals/') && a.includes(t.id)))
    const unused = takes.filter((t) => !t.usedIn.length)
    take = vrng.pick(fresh.length ? fresh : unused.length ? unused : takes)
  }
  let vocalNote = ''
  if (take) {
    const phrases = [...take.analysis.phrases].sort((a, b) => a.bars - b.bars)
    const chops = [...take.analysis.chops].sort((a, b) => (b.energy_db ?? -99) - (a.energy_db ?? -99))
    const use = !phrases.length ? 'chops' : !chops.length ? 'phrase' : rules.vocalUse as string
    const drops = sections.filter((x) => x.kind === 'drop')
    const breaks = sections.filter((x) => x.kind === 'break')
    const at = rules.vocalAt === 'breaks' && !breaks.length ? 'drops' : rules.vocalAt as string
    const halfOf = (x: Section) => x.start + (x.bars >= 2 * PHRASE ? Math.floor(x.bars / 2 / PHRASE) * PHRASE : 0)
    if (use !== 'chops') {
      const phrase = rules.vocalLoop === 'long' ? phrases[phrases.length - 1] : phrases[0]
      const render = phraseRender(take, phrase, key)
      const sample = phraseSample(take, render, bpm)
      const add = (a: number, z: number, verb?: ClipReverb) => {
        if (z > a) lanes.add('vocal', { sample, start: a * BEATS_PER_BAR, length: (z - a) * BEATS_PER_BAR, bass: render, ...(verb ? { verb } : {}) })
      }
      // With chops too, the phrase takes each drop's second half (the chops its first).
      for (const d of drops) {
        if (at === 'halves' || (use === 'both' && at !== 'breaks')) add(halfOf(d), d.start + d.bars)
        else if (at === 'drops' || at === 'drops_breaks') add(d.start, d.start + d.bars)
      }
      // In the last drop too when it's only in the breakdowns: the vocal comes back for the end.
      if (at === 'breaks' && drops.length) add(halfOf(drops[drops.length - 1]), drops[drops.length - 1].start + drops[drops.length - 1].bars)
      if (at === 'drops_breaks' || at === 'breaks') for (const b of breaks) add(b.start, b.start + b.bars, { from: 0.15, to: 0.6 })
    }
    if (use !== 'phrase') {
      const rhythm = rules.chopRhythm as Velocity[][]
      const two = chops.slice(0, 2)
      const bar = (b: number, i: number) => {
        const c = two[i % two.length]
        const pitch = chopPitch(c.note, key)
        lanes.setBar('vchop', b, { sample: chopSample(take!, c), steps: [...rhythm[i % rhythm.length]] as Steps, ...(pitch ? { pitch } : {}) })
      }
      // Where the phrase isn't: each drop's first half when the phrase takes the second, else all of it.
      for (const d of drops) {
        const z = use === 'both' && at !== 'breaks' ? halfOf(d) : d.start + d.bars
        for (let b = d.start; b < z; b++) bar(b, b - d.start)
      }
      if (rules.chopsAt === 'drops_builds') {
        for (const x of sections.filter((y) => y.kind === 'build')) for (let b = Math.max(x.start, x.start + x.bars - PHRASE); b < x.start + x.bars; b++) bar(b, b)
      }
    }
    picks.vocal = vocalItem(take)
    vocalNote = `vocal ${vocalItem(take).name} (${take.voice}, ${take.mood}): ${use === 'both' ? 'phrase and chops' : use === 'phrase' ? 'phrase' : 'chops'}`
  }

  // ---- the silence before every drop: where its FX and fill stop (the producer's), or when
  // they run right up to it, the track's beat or two (FX, fills and hits ring through) ----
  rules.dropGaps = dropGaps
  for (const s of sections) {
    if (s.kind !== 'drop' || s.start <= 0) continue
    const t = dropGaps[s.start] ?? 0
    const sixteenths = t > TO_THE_LINE ? Math.min(t, MAX_SILENCE) : rules.dropSilence * 4
    if (sixteenths) lanes.silence(s.start * 4 - sixteenths / 4, s.start * 4, THROUGH_SILENCE)
  }

  // ---- a breath before drops: the bar before each one without its tops (and drums and bass),
  // the kick by its own rule, fills and FX playing on ----
  let breaths = 0
  if (rules.dropBreath) {
    const roles: Role[] = [...TOP_ROLES, 'groove', ...(rules.dropBreath === 'all' ? BREATH_DRUMS : [])]
    for (const s of sections) {
      if (s.kind !== 'drop' || s.start < 2) continue
      for (const role of roles) {
        lanes.cut(role, (s.start - 1) * BEATS_PER_BAR, s.start * BEATS_PER_BAR, true)
        lanes.setBar(role, s.start - 1, null)
      }
      breaths++
    }
  }

  // ---- rides (SCOPE.md §6.6): the producer's filter and fader moves on bass and top loops,
  // bar by bar from the track this one is built on (else from a like section of one of them), and
  // the whole mix high-passed into drops. Their own RNG, from the structure: a lane made again
  // rides the same way ----
  const ridden = { parts: new Set<string>(), from: new Set<string>() }
  const sources = rideSources(sections, opts.templates ?? [], new Rng(structureSeed(sections)))
  sections.forEach((sec, i) => {
    const src = sources[i]
    if (!src) return
    for (const [part, roles, name] of RIDE_ROLES) {
      for (const p of ridePieces(sectionBars(src.arrangement, part, src.from, src.to, sec.bars))) {
        const hit = roles.map((r) => lanes.ride(r, (sec.start + p.from) * BEATS_PER_BAR, (sec.start + p.to) * BEATS_PER_BAR, p)).some(Boolean)
        if (hit) {
          ridden.parts.add(name)
          ridden.from.add(src.arrangement.source_code)
        }
      }
    }
  })
  const hpBars = Number(rules.mixHp ?? 0)
  let hpDrops = 0
  if (hpBars) {
    for (const sec of sections) {
      if (sec.kind !== 'drop' || sec.start < hpBars) continue
      const a = sec.start - hpBars
      const hz = (b: number) => Math.round(MIX_HP_FROM_HZ * (MIX_HP_TO_HZ / MIX_HP_FROM_HZ) ** ((b - a) / hpBars))
      for (const role of lanes.roles()) {
        if (!MIX_HP_ROLES(role)) continue
        lanes.ride(role, a * BEATS_PER_BAR, sec.start * BEATS_PER_BAR, { filter: { type: 'highpass', from: hz(a), to: hz(sec.start), q: 0.7 }, gainDb: 0 })
        for (let b = a; b < sec.start; b++) {
          const p = lanes.bar(role, b)
          if (p && !p.filter) lanes.setBar(role, b, { ...p, filter: { type: 'highpass', from: hz(b), to: hz(b + 1), q: 0.7 } })
        }
      }
      hpDrops++
    }
  }

  // ---- reverb builds: on the loops still playing into each drop and break (after the silence
  // before drops, so a build peaks where they stop and its tail rings through the gap) ----
  const vo = opts.verb
  const builds = { into: 0, phrase: 0 }
  if (vo?.tops) {
    const roles: Role[] = TOP_ROLES
    const ends = new Map<number, number>()  // bar → bars the build rises over
    sections.forEach((sec, i) => {
      const z = sec.start + sec.bars
      const next = sections[i + 1]?.kind
      if (next === 'drop' || next === 'break') ends.set(z, VERB_INTO_BARS)
      if (vo.every) for (let b = sec.start + vo.every; b <= z && b < total; b += vo.every) if (!ends.has(b)) ends.set(b, VERB_PHRASE_BARS)
    })
    for (const [bar, n] of ends) {
      const hit = roles.map((r) => lanes.swell(r, (bar - n) * BEATS_PER_BAR, bar * BEATS_PER_BAR, vo.amount)).some(Boolean)
      if (hit) builds[n === VERB_INTO_BARS ? 'into' : 'phrase']++
    }
  }

  // ---- the project ----
  const project = newProject('Generated', bpm)
  project.lengthBars = total
  project.lanes = LANES.map((l, i) => ({ ...makeLane(l.name, i), color: l.color }))
  applyMix(project, opts.mix ?? {})
  const bassLane = project.lanes.find((l) => l.name === 'Bass')
  if (bassLane && bo) bassLane.duck = bo.sidechain
  const droneLane = project.lanes.find((l) => l.name === 'Drone')
  if (droneLane) droneLane.duck = opts.drones?.sidechain ?? DRONE_SIDECHAIN
  const laneIds = new Map(LANES.map((l, i) => [l.role, project.lanes[i].id]))
  project.clips = lanes.clips(laneIds)
  const used = new Set(project.clips.map((c) => c.laneId))
  project.lanes = project.lanes.filter((l) => used.has(l.id))
  project.markers = sections.map((s) => makeMarker(s.label, s.start * 4, (s.start + s.bars) * 4))
  const balance = balanceLanes(project, all, opts, sections)

  // ---- what was chosen ----
  const n = (k: Section['kind']) => sections.filter((s) => s.kind === k).length
  choices.push(`${n('drop')} drops, ${n('break')} breakdown${n('break') === 1 ? '' : 's'}`)
  for (const s of sections) {
    if (s.kind === 'build') choices.push(BUILD_LABEL[s.build ?? 'layered'])
    if (s.kind === 'break') choices.push(`${s.label}: ${KICK_MODE_LABEL[s.kick ?? 'out']}${s.long ? ' (long)' : ''}`)
  }
  if (bpm !== opts.bpm) choices.push(`${bpm} BPM (library ${opts.bpm})`)
  if (bass) choices.push(`bass in drops, ${rules.bassBreaks === 'filtered' ? `high-passed (${rules.bassHp} Hz)` : 'out'} in breakdowns`)
  if (tops.length && n('break')) choices.push(`tops ${{ filtered: 'low-passed', open: 'open', none: 'out' }[rules.topsBreaks]} in breakdowns`)
  if (breaths) choices.push(`${rules.dropBreath === 'all' ? 'tops, drums and bass' : 'tops'} out in the bar before drops`)
  if (hats) {
    const io = { none: 'none', half: 'from halfway', all: 'all through' }
    choices.push(`hats in the intro: ${io[rules.introHats]}, in the outro: ${rules.outroHats === 'half' ? 'the first half' : io[rules.outroHats]}`)
  }
  if (rules.phraseCrash) choices.push(rules.crash8 ? 'crash every 8 bars' : 'crash every 16 bars')
  else if (rules.crash8) choices.push('crash every 8 bars in drops')
  if (rules.phraseKickOut) choices.push('four kicks out every 16 bars')
  if (rules.phraseFill) choices.push('fill every 16 bars')
  if (rules.kickEnd8) choices.push('kick variation every 8 bars')
  if (rules.clapRolls !== 'none') choices.push(`clap rolls every ${rules.clapRolls} bars`)
  if (rules.clapGhost != null) choices.push('ghost claps')
  if (balance.measured) {
    choices.push(balance.tracks ? `mix balanced as in ${balance.tracks} of your tracks` : 'mix balanced on house defaults')
  }
  if (built) choices.push(`${BUILDUP_NOTE[rules.buildup as typeof BUILDUPS[number]]} into drops (${built} bars)`)
  if (crash && rules.buildupCrash !== 'none') choices.push(rules.buildupCrash === 'faster' ? 'crashes coming faster into drops' : 'crashes on the last four counts into drops')
  if (rules.loopGap) choices.push('loops stop before breaks')
  if (tpl) choices.unshift(`structure after ${tpl.source} (${tpl.changes.join(', ')})`)
  if (lanes.feel && feelSrc) {
    const sw = feelSrc.groove?.swing ?? 0
    choices.push(`feel of ${feelSrc.source_code}'s ${feelSrc.category} loop${Math.abs(sw) >= 0.05 ? ` (${Math.round(50 + sw * 50)} % swing)` : ''}`)
  }
  if (rules.pitchTop || rules.pitchPerc2 || rules.pitchHats2) choices.push('a pitched loop layer')
  if (liftOf(sections[0]).length || liftOf(sections[sections.length - 1]).length) choices.push('the intro fills up into the drop, the outro thins out')
  if (rules.firstDrop === 'lean' && sections[1]?.kind === 'drop') choices.push('drop 1 starts leaner')
  if (rules.ioShort) choices.push(`intro loops on their first ${rules.ioShort === 1 ? 'bar' : '2 bars'} at first`)
  if (varied) choices.push(`${varied} small variations at 8-bar marks`)
  if (ridden.parts.size) {
    const own = tpl && ridden.from.size === 1 && ridden.from.has(tpl.source)
    choices.push(`filter and volume rides on ${[...ridden.parts].join(', ')}${own ? ` as in ${tpl!.source}` : ` after ${[...ridden.from].sort().join(', ')}`}`)
  }
  if (hpDrops) choices.push(`the mix high-passed in the ${hpBars === 1 ? 'bar' : `${hpBars} bars`} before drops`)
  if (vocalNote) choices.push(vocalNote)
  if (drone) {
    const at = { drops: 'in the drops', all: 'all through', inner: 'between the intro and the outro' }[rules.droneAt as string]
    const how = { pump: 'pumping with the kick', gate8: 'gated in 8ths', gate16: 'gated in 16ths', swell: 'swelling to the offbeats',
      dotted: 'gated in dotted 8ths', chop: 'chopped in 16ths' }[rules.droneRhythm as DroneRhythm]
    const warp = { none: '', slow2: ', slowed down 2×', slow4: ', slowed down 4×', reverse: ', reversed' }[(rules.droneWarp ?? 'none') as DroneWarp]
    const oct = rules.droneOctave ? `, an octave ${Number(rules.droneOctave) < 0 ? 'down' : 'up'}` : ''
    choices.push(`drone from ${drone.name} ${at}, ${how}${warp}${oct}`)
  }
  if (discoHits.length) {
    const where = { drops: 'where drops start and halfway', 16: 'every 16 bars of drops', 8: 'every 8 bars of drops', all: 'where drops and breaks start, halfway through drops' }[rules.discoAt]
    choices.push(`disco hit${discoHits.length > 1 ? 's' : ''} ${discoHits.map((s) => s.name).join(' and ')} ${where}`)
  }
  if (stabs.length) {
    const where = rules.stabsIn === 'drops' ? 'in drops only'
      : `in drops, ${rules.stabsBreaks === 'filtered' ? 'low-passed' : 'out'} in breakdowns`
    choices.push(`chord stab${stabs.length > 1 ? 's' : ''} ${stabs.map((x) => x.name).join(', ')}, ${where}`)
  }
  if (vo && builds.into + builds.phrase) {
    choices.push(`reverb builds on tops${builds.into ? ' into drops and breaks' : ''}${builds.phrase ? `${builds.into ? ',' : ''} every ${vo.every} bars` : ''}`)
  }
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
  return { seed, rngAt, project, sections, key, choices, zips, picks, bass, rules, template: tpl?.source ?? null }
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
  // (Not the stabs: their 2-bar rhythm changes every bar, and the drums are the same with or without them.)
  const changed = (b: number) => lanes.roles().filter((r) => !STAB_ROLES.includes(r)).some((r) => {
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
      // A fill into it (in the intro and outro only when nothing else plays with the kick).
      const lift = TOP_ROLES.filter((r) => lanes.loopOver(r, B - 4, B) && !lanes.loopOver(r, B - 4, B)!.filter)
      if (ctx.fill && (!io || (!cands.length && !lift.length)) && ![b - 2, b - 1, b].some((x) => lanes.state('fills', x))) {
        const endOn = ctx.fill
        cands.push(['fill', 0.8, () => { endOn('fill', 'fills', ctx.fills, B, 8, 1) }])
      }
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
  hats: ['hatsInBreaks', 'introHats', 'outroHats'],
  ride: ['ride'],
  perc: ['ioPerc', 'perc2From'],
  top: ['dropTops', 'ioTopFirst', 'ioTopSecond', 'topsBreaks', 'topsBreakHz', 'dropBreath'],
  groove: ['grooveFrom', 'grooveSwap', 'switchHalfway'],
  crash: ['phraseCrash', 'crash8', 'breakCrash', 'outroCrash', 'buildupCrash'],
  buildup: ['buildup', 'buildupBars'],
  fills: ['phraseFill', 'dropFill', 'breakFill', 'outroFill'],
  fx: ['fx', 'dropRiser', 'breakSweep', 'fxLayers', 'dropSet'],
  hits: ['dropImpact', 'breakDownlifter', 'dropDown'],
  bass: ['bassBreaks', 'bassBuild', 'bassIO', 'bassHp'],
  disco: ['discoIn', 'discoCount', 'discoAt'],
  // A drone lane made again: another sample, placement and take on it (it stays a drone).
  drone: [...DRONE_RULES],
  // The vocal lanes made again: another take, and how and where it's sung (it stays a vocal).
  vocal: ['vocalUse', 'vocalLoop', 'vocalAt', 'chopsAt', 'chopRhythm'],
  // A stab lane made again: another sample in the same rhythm (the others play their turns in it).
  stab: [],
}
const LAYER_OF: Partial<Record<Role, Role>> = {
  clap2: 'clap', clap3: 'clap', hats2: 'hats', perc2: 'perc', top2: 'top', top3: 'top', top4: 'top', fx2: 'fx', disco2: 'disco', vchop: 'vocal',
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
  if (role === 'buildup') return rerollBuildup(all, opts, g, seed)
  const rules = Object.fromEntries(Object.entries(rulesOf(g)).filter(([k]) => !own.has(k)))
  const picks = Object.fromEntries(Object.entries(g.picks).filter(([r]) => r !== role)) as Generation['picks']
  const sig = (cs: Clip[]) => JSON.stringify(cs.map(({ id: _i, laneId: _l, ...c }) => c))
  const before = g.project.clips.filter((c) => c.laneId === laneId)
  const bpm = g.project.bpm
  for (let i = 0; i < 12; i++) {
    const r = generate(all, { ...opts, tempo: { min: bpm, max: bpm }, bass: role === 'bass' ? opts.bass : null }, seed + i * 7919, {
      structure: g.sections, key: g.key, picks, rules, avoid: g.project.clips.map((c) => c.sample.relPath),
    })
    const rl = r.project.lanes.find((l) => l.name === lane.name)
    const clips = rl ? r.project.clips.filter((c) => c.laneId === rl.id) : []
    if (!clips.length || sig(clips) === sig(before)) continue
    if (role !== 'bass' && clips.every((c) => before.some((b) => b.sample.relPath === c.sample.relPath))) continue
    if (role === 'bass' && r.bass && g.bass && r.bass.midi.id === g.bass.midi.id && r.bass.preset.path === g.bass.preset.path) continue
    const project = structuredClone(g.project)
    project.clips = [...project.clips.filter((c) => c.laneId !== laneId), ...clips.map((c) => ({ ...c, laneId }))]
    const kept = project.lanes.find((l) => l.id === laneId)!
    kept.levelDb = rl!.levelDb
    kept.eq = rl!.eq && structuredClone(rl!.eq)
    const nextPicks = { ...g.picks }
    if (r.picks[role]) nextPicks[role] = r.picks[role]
    const nextRules = { ...g.rules, ...Object.fromEntries(Object.entries(r.rules).filter(([k]) => own.has(k))) }
    const byPath = new Map(all.map((s) => [s.rel_path, s]))
    const zips = [...new Set(project.clips.map((c) => byPath.get(c.sample.relPath)?.source_code).filter((x): x is string => !!x))].sort()
    return { ...g, project, picks: nextPicks, rules: nextRules, zips, bass: role === 'bass' ? r.bass : g.bass }
  }
  return null
}

/**
 * The same track in another key (the Generate view's key menu). The bass part is the same part
 * moved into it the nearest way (its patch octave and any semitones set stay), disco hits and
 * chord stabs are pitched for it, and tonal FX (risers, downlifters, atmos, …) whose key doesn't fit are
 * swapped for ones that do: the same kind, and for those leading into a line the same body length
 * and silence before it, so they still end where they did. The drums stay exactly as they are.
 */
export function changeKey(all: SampleListItem[], opts: GenerateOptions, g: Generation, key: string, seed: number): Generation {
  const rng = new Rng(seed)
  const project = structuredClone(g.project)
  const move = (b: GenerationBass | null): GenerationBass | null => b && {
    ...b, transpose: Math.max(-24, Math.min(24, b.transpose - transposeTo(b.midi.key_label, g.key) + transposeTo(b.midi.key_label, key))),
  }
  const bass = move(g.bass)
  const hitOf = new Map([...opts.disco?.hits ?? [], ...opts.stabs?.hits ?? []].map((h) => [h.rel_path, h]))
  const byPath = new Map(all.map((s) => [s.rel_path, s]))
  const fits = new Set(expandCompatible([key]))
  const inProject = new Set(project.clips.map((c) => c.sample.relPath))
  const swaps = new Map<string, SampleListItem | null>()
  const swapFor = (s: SampleListItem, looped: boolean): SampleListItem | null => {
    const id = `${s.rel_path}|${looped}`
    if (!swaps.has(id)) {
      const inKey = all.filter((x) => x.kind === s.kind && x.category === s.category && x.key_label && fits.has(x.key_label))
      // Looped (atmos under a breakdown): any length; leading into a line: ending the same way.
      const same = looped ? inKey : inKey.filter((x) => bodyBars(x) === bodyBars(s) && gapsAgree(gapOf(x), gapOf(s)))
      const fresh = same.filter((x) => !inProject.has(x.rel_path))
      const pick = fresh.length ? rng.pick(fresh) : same.length ? rng.pick(same) : null
      if (pick) inProject.add(pick.rel_path)
      swaps.set(id, pick)
    }
    return swaps.get(id)!
  }
  let swapped = 0
  let kept = 0
  project.clips = project.clips.map((c) => {
    if (c.type === 'audio' && c.bass?.role === 'vocal') {
      // A vocal phrase: from the key it's sung in into the new one.
      const render = { ...c.bass, keyLabel: key, transpose: Math.max(-12, Math.min(12, transposeTo(c.bass.vocal?.key ?? null, key))) }
      return { ...c, bass: render, sample: { ...c.sample, relPath: bassPath(render, project.bpm) } }
    }
    const chop = c.type === 'pattern' && c.sample.relPath.startsWith('Vocals/')
      ? opts.vocals?.takes.flatMap((t) => t.analysis.chops).find((x) => x.path === c.sample.relPath) : undefined
    if (chop) {
      const { pitch: _p, ...rest } = c
      const pitch = chopPitch(chop.note, key)
      return pitch ? { ...rest, pitch } : rest
    }
    if (c.type === 'audio' && c.bass?.role === 'drone') {
      const render = droneInKey(c.bass, key, opts.drones?.hits ?? [])
      return { ...c, bass: render, sample: { ...c.sample, relPath: bassPath(render, project.bpm) } }
    }
    // (Keys parts and stab patches of older tracks stay as they are.)
    if (c.type === 'audio' && c.bass) {
      if (!bass || (c.bass.role ?? 'bass') !== 'bass') return c
      const render = bassRenderOf(bass)
      return { ...c, bass: render, sample: { ...c.sample, relPath: bassPath(render, project.bpm) } }
    }
    const hit = c.sample.category === 'disco_hit' || c.sample.category === 'chord_stab' ? hitOf.get(c.sample.relPath) : undefined
    if (hit) {
      const { pitch: _p, ...rest } = c
      const pitch = hitPitch(hit, key)
      return pitch ? { ...rest, pitch } : rest
    }
    const s = byPath.get(c.sample.relPath)
    if (c.type !== 'audio' || !s || !TONAL.includes(s.category) || !s.key_label || fits.has(s.key_label)) return c
    const looped = c.length > (s.bars ?? 1) * BEATS_PER_BAR + 1e-6
    const x = swapFor(s, looped)
    if (!x) {
      kept++
      return c
    }
    swapped++
    const next = replaceSample(c, sampleRef(x))
    // An event plays once: no longer than the new one (a longer clip would repeat it).
    return looped ? next : { ...next, length: Math.min(c.length, (x.bars ?? 1) * BEATS_PER_BAR) }
  })
  const zips = [...new Set(project.clips.map((c) => byPath.get(c.sample.relPath)?.source_code).filter((z): z is string => !!z))].sort()
  const note = `in ${key} (made in ${g.key ?? 'no key'})${swapped ? `, ${swapped} FX swapped for ones in key` : ''}${kept ? `, ${kept} kept: nothing else in key` : ''}`
  const choices = [...g.choices.filter((c) => !KEY_NOTE.test(c)), note]
  return { ...g, project, key, bass, zips, choices }
}

/**
 * New disco hits for the same track (the Generate view's Disco Hits module): one or two hits and
 * where they land drawn again, over the same structure, key and everything else, which stays
 * exactly as it is. Always some hits (the button asks for them); others than the track has when
 * there are. Null when the Disco Hits page has none, or nothing new comes out.
 */
export function rerollDisco(all: SampleListItem[], opts: GenerateOptions, g: Generation, seed: number): Generation | null {
  if (!opts.disco?.hits.length) return null
  return rerollGroup(all, opts, g, seed, new Set<Role>(['disco', 'disco2']), new Set(LANE_RULES.disco), { discoIn: true }, 'disco hit')
}

/**
 * New chord stabs for a generation (the Chord Stabs module's button): other stab samples, another
 * rhythm and placement. The rest stays exactly as it is. Null when nothing new comes out.
 */
export function rerollStabs(all: SampleListItem[], opts: GenerateOptions, g: Generation, seed: number): Generation | null {
  if (!opts.stabs?.hits.length) return null
  return rerollGroup(all, opts, g, seed, new Set<Role>(STAB_ROLES), new Set(STAB_RULES), { stabs: true }, 'chord stab')
}

/** The rules the stab reroll draws again. */
const STAB_RULES = ['stabs', 'stabRhythm', 'stabsIn', 'stabsBreaks', 'stabsBuild', 'stabsCutoff']

/**
 * The lanes of `roles` made again (with their rules `own`, `force` set), the rest of the track
 * as it is: a lane the result doesn't have goes, one the track didn't have comes in its place.
 */
/**
 * A new drone for the same track (the Generate view's Drones module): another sample, placement
 * and take on it, or a drone in a track that had none; everything else exactly as it is. Null when
 * the Drones page has no samples, or nothing new comes out.
 */
export function rerollDrone(all: SampleListItem[], opts: GenerateOptions, g: Generation, seed: number): Generation | null {
  if (!opts.drones?.hits.length) return null
  return rerollGroup(all, opts, g, seed, new Set<Role>(['drone']), new Set(LANE_RULES.drone), { droneIn: true }, 'drone')
}

/**
 * A new vocal for the same track (the Generate view's Vocals module): another take, sung another
 * way (phrase, chops or both, and where), the rest exactly as it is. Null without takes, or when
 * nothing new comes out.
 */
export function rerollVocal(all: SampleListItem[], opts: GenerateOptions, g: Generation, seed: number): Generation | null {
  if (!opts.vocals?.takes.length) return null
  return rerollGroup(all, opts, g, seed, new Set<Role>(['vocal', 'vchop']), new Set(LANE_RULES.vocal), { vocalIn: true }, 'vocal')
}

/** Another drone sample for the same track (the Drone lane's "New sound"): where it plays and its take on it (rhythm, warp, octave, start) stay. */
export function newDroneSound(all: SampleListItem[], opts: GenerateOptions, g: Generation, seed: number): Generation | null {
  if (!g.picks.drone || !opts.drones?.hits.length) return null
  return rerollGroup(all, opts, g, seed, new Set<Role>(['drone']), new Set(), { droneIn: true }, 'drone')
}

function rerollGroup(all: SampleListItem[], opts: GenerateOptions, g: Generation, seed: number, roles: Set<Role>,
                     own: Set<string>, force: Rules, choice: string): Generation | null {
  const rules = { ...Object.fromEntries(Object.entries(rulesOf(g)).filter(([k]) => !own.has(k))), ...force }
  const picks = Object.fromEntries(Object.entries(g.picks).filter(([r]) => !roles.has(r as Role))) as Generation['picks']
  const sig = (p: Project) => JSON.stringify(groupClips(p, roles).map(({ id: _i, laneId, ...c }) => [p.lanes.find((l) => l.id === laneId)!.name, c]))
  const bpm = g.project.bpm
  for (let i = 0; i < 12; i++) {
    const r = generate(all, { ...opts, tempo: { min: bpm, max: bpm }, bass: null }, seed + i * 7919, {
      structure: g.sections, key: g.key, picks, rules, avoid: groupClips(g.project, roles).map((c) => c.sample.relPath),
    })
    if (!groupClips(r.project, roles).length || sig(r.project) === sig(g.project)) continue
    return swapGroup(g, r, roles, own, picks, choice)
  }
  return null
}

const groupClips = (p: Project, roles: Set<Role>) => p.clips.filter((c) => roles.has(laneRole(p.lanes.find((l) => l.id === c.laneId)?.name ?? '')!))

/**
 * `g` with the lanes of `roles` (their clips, picks, rules `own` and choices) as `r` has them.
 * `choice`: the choices starting with it are `r`'s; null: all of them are (but a key change).
 */
function swapGroup(g: Generation, r: Generation, roles: Set<Role>, own: Set<string>, picks: Generation['picks'], choice: string | null): Generation {
  const inGroup = (laneName: string) => roles.has(laneRole(laneName)!)
  // The track's own lanes keep their mix (volume, mute, …); a lane it didn't have comes from `r`.
  const project = structuredClone(g.project)
  // (Their level in the mix follows their new samples.)
  const lanes = r.project.lanes.filter((l) => inGroup(l.name)).map((l) => {
    const own = project.lanes.find((x) => x.name === l.name)
    return own ? { ...own, levelDb: l.levelDb, eq: l.eq && structuredClone(l.eq) } : structuredClone(l)
  })
  const clips = groupClips(r.project, roles).map((c) => ({ ...c, laneId: lanes.find((l) => l.name === r.project.lanes.find((x) => x.id === c.laneId)!.name)!.id }))
  project.lanes = project.lanes.filter((l) => !inGroup(l.name))
  for (const l of lanes) {
    // In the track's lane order: before the first lane that comes after it.
    const at = LANES.findIndex((x) => x.name === l.name)
    const before = project.lanes.findIndex((x) => LANES.findIndex((y) => y.name === x.name) > at)
    project.lanes.splice(before < 0 ? project.lanes.length : before, 0, l)
  }
  project.clips = [...project.clips.filter((c) => !inGroup(g.project.lanes.find((l) => l.id === c.laneId)?.name ?? '')), ...clips]
  const nextPicks: Generation['picks'] = { ...picks }
  for (const role of roles) if (r.picks[role]) nextPicks[role] = r.picks[role]
  const nextRules = { ...g.rules, ...Object.fromEntries(Object.entries(r.rules).filter(([k]) => own.has(k))) }
  const choices = choice == null ? [...r.choices, ...g.choices.filter((c) => KEY_NOTE.test(c))]
    : [...g.choices.filter((c) => !c.startsWith(choice)), ...r.choices.filter((c) => c.startsWith(choice))]
  return { ...g, project, picks: nextPicks, rules: nextRules, choices }
}

/** The note a key change leaves in a track's choices. */
const KEY_NOTE = /^in \S+ \(made in /

/**
 * The current generation's stabs playing another rhythm (edited in the Chord Stabs module's step
 * sequencer): the same stab, where it played, the rest of the track exactly as it is. Null when
 * the track has no stabs.
 */
export function setStabRhythm(all: SampleListItem[], opts: GenerateOptions, g: Generation, rhythm: Velocity[][]): Generation | null {
  const roles = new Set(STAB_ROLES)
  if (!g.rules.stabs) return null
  const bpm = g.project.bpm
  const r = generate(all, { ...opts, tempo: { min: bpm, max: bpm }, bass: null }, g.seed, {
    structure: g.sections, key: g.key, picks: g.picks, rules: { ...rulesOf(g), stabRhythm: rhythm },
  })
  return swapGroup(g, r, roles, new Set(['stabRhythm']), g.picks, 'chord stab')
}

// ---------------------------------------------------------------------------
// Changing a made track: one of its rules, a lane's sound
// ---------------------------------------------------------------------------

/**
 * The bass clips of `project` playing exactly what `g`'s bass does (a bassline or patch changed
 * since, an octave): a remake writes where it plays, not what.
 */
function sameRenders(g: Generation, project: Project): void {
  const bpm = project.bpm
  const b = g.bass
  if (!b) return
  for (const c of project.clips) {
    if (c.type !== 'audio' || !c.bass || (c.bass.role ?? 'bass') !== 'bass') continue
    c.bass = bassRenderOf(b)
    const bars = bassBars(b)
    c.sample = { ...c.sample, relPath: bassPath(c.bass, bpm), name: `${b.preset.name} · ${b.midi.name}`, bars, durationS: (bars * BEATS_PER_BAR * 60) / bpm }
    c.trimBeats %= bars * BEATS_PER_BAR
  }
}

/**
 * The same track with one of its rules set to `value` (a choice changed in Generate): the lanes
 * it shapes (`roles`) made again with it, over the same structure, key and samples, every other
 * rule as it was; the other lanes stay exactly as they are. Made from where the track's own RNG
 * was, so what doesn't follow from the rule comes out as it did.
 */
export function setTrackRule(all: SampleListItem[], opts: GenerateOptions, g: Generation, rule: string, value: unknown, roles: Role[]): Generation {
  return setTrackRules(all, opts, g, { [rule]: value }, roles)
}

/** Rules that follow when one of them is set: a build-up and a roll sample into drops don't go together. */
const COUPLED: Record<string, string[]> = { dropFill: ['buildup'], buildup: ['dropFill'] }

/** setTrackRule for several rules at once (`picks`: the samples kept, `avoid`: ones not to take again). */
function setTrackRules(all: SampleListItem[], opts: GenerateOptions, g: Generation, values: Rules, roles: Role[],
                       picks: Generation['picks'] = g.picks, avoid?: string[]): Generation {
  const bpm = g.project.bpm
  const rules = { ...rulesOf(g), ...values }
  const r = generate(all, { ...opts, tempo: { min: bpm, max: bpm }, locks: { ...opts.locks, ...values } }, g.seed, {
    structure: g.sections, key: g.key, picks, rules, replay: g.rngAt, avoid,
  })
  // A part the remake can't play again (its module off since, its samples gone) stays as it is.
  const gone = (role: Role) => (role === 'bass' && g.bass && !r.bass)
    || (STAB_ROLES.includes(role) && g.rules.stabs && !r.rules.stabs) || (role === 'drone' && !!g.picks.drone && !r.picks.drone)
  const own = new Set(Object.keys(values).flatMap((k) => [k, ...COUPLED[k] ?? []]))
  const next = swapGroup(g, r, new Set(roles.filter((x) => !gone(x))), own, picks, null)
  sameRenders(g, next.project)
  return { ...next, rules: { ...next.rules, ...values } }
}

/** The lanes a build-up plays on or takes the place of. */
export const BUILDUP_ROLES: Role[] = ['buildup', 'kick', 'clap', 'fills']

/**
 * The Build-up lane made again: another kind of build-up (and how many bars it runs) and another
 * snare, made from where the track's random stream was, so the kick and clap lanes it takes the
 * place of follow and the rest stays exactly as it is.
 */
function rerollBuildup(all: SampleListItem[], opts: GenerateOptions, g: Generation, seed: number): Generation | null {
  const rng = new Rng(seed)
  const was = rulesOf(g).buildup
  const values = { buildup: rng.pick(BUILDUPS.filter((b) => b !== was)), buildupBars: rng.pick([2, 4, 8]) }
  const picks = Object.fromEntries(Object.entries(g.picks).filter(([r]) => r !== 'buildup')) as Generation['picks']
  const lane = g.project.lanes.find((l) => l.name === 'Build-up')
  const r = setTrackRules(all, opts, g, values, BUILDUP_ROLES, picks, g.project.clips.filter((c) => c.laneId === lane?.id).map((c) => c.sample.relPath))
  return r.rules.buildup === 'none' ? null : r
}

/**
 * A lane with other sounds where it plays (Generate's and Arrange's "New sound"): each sample
 * on it swapped for another of the same kind (a clap for a clap, a 4-bar top loop for a top
 * loop), FX for ones that end the same way and fit the key; the clips stay where they are, the
 * rest of the track exactly as it is. Not for rendered parts (the bass: another patch). Null when the library has nothing else.
 */
export function newLaneSound(all: SampleListItem[], opts: GenerateOptions, g: Generation, laneId: string, seed: number): Generation | null {
  const lane = g.project.lanes.find((l) => l.id === laneId)
  const role = lane && laneRole(lane.name)
  if (!lane || !role) return null
  const rng = new Rng(seed)
  const samples = opts.zipIds ? all.filter((s) => opts.zipIds!.includes(s.zip_id)) : all
  const hits = [...opts.disco?.hits ?? [], ...opts.stabs?.hits ?? []]
  const hitOf = new Map(hits.map((h) => [h.rel_path, h]))
  const byPath = new Map([...all, ...hits.map(hitSample)].map((s) => [s.rel_path, s]))
  const fits = g.key ? new Set(expandCompatible([g.key])) : null
  const inProject = new Set(g.project.clips.map((c) => c.sample.relPath))
  const swaps = new Map<string, SampleListItem | null>()
  const swapFor = (s: SampleListItem, looped: boolean): SampleListItem | null => {
    if (!swaps.has(s.rel_path)) {
      const pool = hitOf.has(s.rel_path) ? hits.filter((h) => h.kind === hitOf.get(s.rel_path)!.kind).map(hitSample) : samples
      const same = pool.filter((x) => x.rel_path !== s.rel_path && x.kind === s.kind && x.category === s.category
        && (s.kind !== 'event' || looped || (bodyBars(x) === bodyBars(s) && gapsAgree(gapOf(x), gapOf(s))))
        && (!TONAL.includes(s.category) || !fits || !x.key_label || fits.has(x.key_label)))
      const fresh = same.filter((x) => !inProject.has(x.rel_path))
      const pick = fresh.length ? rng.pick(fresh) : same.length ? rng.pick(same) : null
      if (pick) inProject.add(pick.rel_path)
      swaps.set(s.rel_path, pick)
    }
    return swaps.get(s.rel_path)!
  }
  let swapped = 0
  const project = structuredClone(g.project)
  project.clips = project.clips.map((c) => {
    const s = c.laneId === laneId && !(c.type === 'audio' && c.bass) ? byPath.get(c.sample.relPath) : undefined
    if (!s) return c
    const looped = c.type === 'audio' && c.length > (s.bars ?? 1) * BEATS_PER_BAR + 1e-6
    const x = swapFor(s, looped)
    if (!x) return c
    swapped++
    const next = replaceSample(c, sampleRef(x))
    const hit = hitOf.get(x.rel_path)
    if (hit) {
      const pitch = hitPitch(hit, g.key)
      if (pitch) next.pitch = pitch
      else delete next.pitch
    }
    // An event plays once: no longer than the new one (a longer clip would repeat it).
    return c.type === 'audio' && s.kind === 'event' && !looped ? { ...next, length: Math.min(c.length, (x.bars ?? 1) * BEATS_PER_BAR) } : next
  })
  if (!swapped) return null
  balanceLanes(project, all, opts, g.sections, new Set([laneId]))
  const picks = { ...g.picks }
  const was = picks[role] && swaps.get(picks[role]!.rel_path)
  if (was) picks[role] = was
  const zips = [...new Set(project.clips.map((c) => byPath.get(c.sample.relPath)?.source_code).filter((z): z is string => !!z && z !== 'Serum'))].sort()
  return { ...g, project, picks, zips }
}
