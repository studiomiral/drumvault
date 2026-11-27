// Arrange project (.dvproj, JSON). All positions are in beats (4/4, project BPM = library BPM).

import type { Category, Genre, SampleKind } from './engine'
import type { Generation } from '../generate/generator'
import type { TrackOrigin } from '../generate/taste'

export interface SampleRef {
  /** Library-relative path: the stable identity of a sample across reprocessing. */
  relPath: string
  /** Database id at the time it was last resolved (used for peaks; refreshed on load). */
  id: number | null
  name: string
  kind: SampleKind
  category: Category
  bars: number | null
  durationS: number
  /** Tempo the file is cut at (the library BPM for loops and events; null for one-shots). */
  bpm?: number | null
}

export interface Lane {
  id: string
  name: string
  color: string
  volumeDb: number
  pan: number          // -1 … 1
  mute: boolean
  solo: boolean
  height: number       // px
  /** Sidechain: the lane ducks under every kick hit by this much (0…1); none when undefined. */
  duck?: number
  /** How long each duck takes to recover, in beats (the kick's length, SCOPE.md §6.6); most of a beat when undefined. */
  duckBeats?: number
  /**
   * The lane's low end below this (Hz) is summed to mono (SCOPE.md §6.6): the kick's and the
   * bass's, so the low end holds up on a mono club system. Stereo all the way down when undefined.
   */
  monoBelow?: number
  /** The lane's reverb is a short room (what stabs sit in) instead of the hall of the reverb builds. */
  room?: boolean
  /**
   * The lane's level in the generated mix (SCOPE.md §6.6): dB that bring its samples to their
   * place in the balance, on top of `volumeDb` (the slider stays the producer's).
   */
  levelDb?: number
  /** The lane's EQ in the generated mix (SCOPE.md §6.6), in playback and baked into its stem. */
  eq?: LaneEq
  /** The lane's compressor in the generated mix (SCOPE.md §6.6), after its EQ, in playback and baked into its stem. */
  comp?: LaneComp
  /** The lane plays through the drum bus (`Project.drumBus`): the bus's gain, from all its lanes together, on this one's stem too. */
  bus?: boolean
  /** Vocal Enhance (SCOPE.md §6.11c): body, compression, saturation, a plate and a delay on the Vocal lane, in playback and baked into its stem. */
  enhance?: LaneEnhance
  /**
   * A lane added to a generated track (SCOPE.md §6.6, "Adding a lane"): the generator role it is
   * another one of ('buildup', 'top', …), filled and mixed as that kind. Its own lane: remakes of
   * the track's lanes leave it as it is.
   */
  extra?: string
}

/**
 * A lane compressor (feed-forward, both sides linked, a soft knee, no look-ahead). Its threshold is
 * against the lane's sound before its volume and its level in the mix (the samples at their own
 * level, with their clip gain), so moving the lane's slider doesn't change how hard it works; its
 * release is in beats, so it breathes with the tempo.
 */
export interface LaneComp {
  thresholdDb: number
  ratio: number
  kneeDb: number
  attackMs: number
  releaseBeats: number
  /** The level detector's time (ms): short to catch a hit itself, longer to go by its body. 5 ms when unset. */
  detectMs?: number
  /** Gain after it (dB): what it takes off, given back, so the balance stands. */
  makeupDb: number
  off?: boolean
}

/**
 * Vocal Enhance's settings (SCOPE.md §6.11c): each part 0…1, all of them scaled by `amount`
 * (0…1.5: 1 is the parts as set). The delay repeats a dotted 8th or a quarter apart.
 */
export interface LaneEnhance {
  amount: number
  beef: number
  comp: number
  saturation: number
  reverb: number
  delay: number
  delayTime: '1/8d' | '1/4'
  off?: boolean
}

/** One band of a lane EQ (Web Audio biquads: a high-pass's Q in dB, a bell's as is; shelves have none). */
export interface EqBand {
  type: 'highpass' | 'lowshelf' | 'peaking' | 'highshelf'
  freq: number
  gainDb: number
  q: number
}

/** A lane EQ: its bands, the makeup gain that keeps the lane as loud as without them, and off (bypassed). */
export interface LaneEq {
  bands: EqBand[]
  gainDb: number
  off?: boolean
}

/**
 * One of the two effects in the DAW (SCOPE.md §6.6): a low- or high-pass filter on a clip, fixed
 * at `from` Hz or swept (exponentially) from `from` to `to` Hz across the clip.
 */
export interface ClipFilter {
  type: 'lowpass' | 'highpass'
  from: number
  to: number | null
  q: number
}

/**
 * The other one (SCOPE.md §6.6): a clip sent to the lane's reverb, by `from` (0…1) at the clip's
 * start rising to `to` at its end, most of it late (a reverb build). The tail rings on past the
 * clip, and is part of the lane's stem.
 */
export interface ClipReverb {
  from: number
  to: number
}

interface ClipBase {
  id: string
  laneId: string
  start: number        // beats
  length: number       // beats
  gainDb: number
  /** A volume ride: the gain moves (in dB, evenly) from `gainDb` at the clip's start to this at its end. */
  gainTo?: number
  sample: SampleRef
  filter?: ClipFilter
  verb?: ClipReverb
  /**
   * A delay throw (SCOPE.md §6.9): the clip sent, by this much (0…1), to its lane's delay, which
   * repeats it a dotted 8th later and again, each time quieter and thinner. In the lane's stem.
   */
  echo?: number
  /** Fade-in / fade-out lengths in beats: linear gain ramps from the clip's edges. */
  fadeIn?: number
  fadeOut?: number
  /**
   * Semitones up or down, played faster or slower like a sampler (a loop as 16th slices that
   * each start on the grid, so it stays in time). Not on bass clips: they are rendered.
   */
  pitch?: number
}

/** What a bass clip renders: an imported MIDI part through a Serum 2 preset (SCOPE.md §6.7). */
export interface BassRender {
  /**
   * Absent on older bass projects. Strings (§6.10), vocal phrases (§6.11) and piano parts (§6.9a)
   * share the render pipeline; keys parts, Serum chord stabs and drones only in tracks made before they were removed.
   */
  role?: 'bass' | 'piano' | 'keys' | 'stab' | 'drone' | 'strings' | 'vocal' | 'pad' | 'ambience' | 'music'
  keyLabel?: string | null
  /** Absolute path of the .SerumPreset; strings' is a Strings page sample, a sampled bass's or piano's its one-shot (library-relative). */
  preset: string
  presetName: string
  midiId: number
  midiName: string
  /** Semitones applied to the MIDI (the track key, plus any manual transpose). */
  transpose: number
  /**
   * Edited in the piano roll for this track: [start beats, length beats, pitch, velocity], at
   * the MIDI's own pitch (before `transpose`), and the loop length; the imported file otherwise.
   */
  notes?: [number, number, number, number][]
  bars?: number
  /** The track's groove: per 16th step, how late (in 16ths) notes starting there play. */
  groove?: number[]
  /**
   * The bassline's turn at the end of a phrase (SCOPE.md §6.7): the loop with its last beat
   * changed (`turnOf` on `notes`), so an edit of the line changes its turns too. Without notes it plays as it is.
   */
  turn?: 'gap' | 'octave' | 'pickup'
  /** An older track's Serum chord stab part: the patch's own chord (semitones from the root), or its root alone. */
  stab?: { voicing?: number[]; oneKey?: boolean }
  /** An older track's drone: how it was made (its file is named after it; it isn't made again). */
  drone?: { rhythm: string; warp?: string; start?: number }
  /** A vocal phrase: the key it's sung in (`transpose` moves it from there) and its take's id. */
  vocal?: { key: string | null; take: string }
  /** A music loop (§6.11b): the key it was recorded in (`transpose` moves it from there) and its id. */
  music?: { key: string | null; loop: string }
  /**
   * A music loop's colour in this track, so it never sounds as recorded: [low cut Hz, bell Hz,
   * bell dB, bell Q, high shelf dB, saturation drive dB] (generate/musicloops.ts: drawColor).
   */
  color?: number[]
}

/** A loop on the bar grid; extending it repeats the loop. */
export interface AudioClip extends ClipBase {
  type: 'audio'
  /** Beats skipped at the start of the loop (left trim), a multiple of a 16th. */
  trimBeats: number
  /** A rendered bass part: the file is rendered for the project tempo (`bassPath`). */
  bass?: BassRender
  /** Repeat only the loop's first bars (1 or 2 of a 4-bar loop, …); the whole loop when unset. */
  loopBars?: number
  /**
   * A step gate (SCOPE.md §6.6): which 16ths of every bar play (1) and which don't (0), 16 of
   * them, on the project's bar lines. A gated loop plays as 16th slices on the grid, each declicked.
   */
  chop?: number[]
  /**
   * A fill made anew (SCOPE.md §6.6): for each 16th of the sound (from its start, repeating with
   * it), which fill plays (0: the clip's own sample, 1…: `from`) and which of its 16ths. Played as
   * 16th slices on the grid, so beats of two fills, a beat twice or a stutter make a new fill.
   */
  remix?: { from: SampleRef[]; slices: [number, number][] }
}

/** 0 = off, 1 = soft, 2 = medium, 3 = full. */
export type Velocity = 0 | 1 | 2 | 3

/** A one-shot played by a 16-steps-per-bar pattern that repeats across the clip. */
export interface PatternClip extends ClipBase {
  type: 'pattern'
  patternBars: 1 | 2 | 4
  steps: Velocity[]    // patternBars * 16
  /** Played with a loop's feel: per 16th step of the bar, how late (16ths) and how loud (dB). */
  groove?: StepGroove
  /** Each hit plays at most this long (beats), fading out at its end (a gated stab); to its end when unset. */
  gate?: number
  /**
   * Semitones per step (as `steps`) on top of `pitch`, played like a sampler: a stab loop's hit
   * moved up a tone (SCOPE.md §6.9). Unset or 0: the clip's pitch.
   */
  bend?: number[]
}

/** A groove applied to one-shot steps (taken from a loop, see LoopGroove in api.ts). */
export interface StepGroove {
  /** 16 values: fractions of a 16th, + late, − early. */
  offsets: number[]
  /** 16 values: dB added to the step's velocity. */
  gains: number[]
}

export type Clip = AudioClip | PatternClip

export interface Marker {
  id: string
  name: string
  start: number        // beats
  end: number          // beats
  color: string
}

export interface LoopRegion {
  start: number        // beats
  end: number          // beats
  enabled: boolean
}

export interface Project {
  format: 'drumvault-project'
  version: 1
  name: string
  /** The genre it was made in (projects from before genres: house). */
  genre: Genre
  bpm: number
  lengthBars: number
  lanes: Lane[]
  clips: Clip[]
  markers: Marker[]
  loop: LoopRegion
  metronome: boolean
  createdAt: string
  updatedAt: string
  /**
   * A project sent from Generate: the track it was made as (structure, key, rules, picks, bass),
   * so its lanes keep their modules in Arrange: a new sound, the lane made again.
   */
  generation?: GenerationMeta
  /**
   * How a generated track was first made (generate/taste.ts): what its export is compared with,
   * so Generate learns what the user changed. Absent on tracks built by hand or made before.
   */
  origin?: TrackOrigin
  /**
   * The drum bus (SCOPE.md §6.6): one compressor heard from the lanes with `bus` together, its
   * gain applied to each of them, so each stem carries its share and the stems still add up to the
   * bus. Its threshold is at the bus (dBFS), after the lanes' volumes.
   */
  drumBus?: DrumBus
}

/** The drum bus's compressor: as a lane's, but its threshold at the bus (dBFS). */
export type DrumBus = LaneComp

/** What a generated project remembers of its generation (everything but the project itself). */
export type GenerationMeta = Omit<Generation, 'project'>

export interface ProjectFileInfo {
  file: string         // file name inside the projects folder
  name: string
  genre: Genre         // projects from before genres: house
  updatedAt: string
  modified: number     // mtime (ms)
}
