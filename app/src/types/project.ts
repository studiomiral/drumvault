// Arrange project (.dvproj, JSON). All positions are in beats (4/4, project BPM = library BPM).

import type { Category, SampleKind } from './engine'

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
}

/**
 * The one effect in the DAW (SCOPE.md §6.6): a low- or high-pass filter on a clip, fixed at
 * `from` Hz or swept (exponentially) from `from` to `to` Hz across the clip.
 */
export interface ClipFilter {
  type: 'lowpass' | 'highpass'
  from: number
  to: number | null
  q: number
}

interface ClipBase {
  id: string
  laneId: string
  start: number        // beats
  length: number       // beats
  gainDb: number
  sample: SampleRef
  filter?: ClipFilter
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
  /** Absent on older bass projects. Keys share the Serum render pipeline. */
  role?: 'bass' | 'keys'
  keyLabel?: string | null
  /** Absolute path of the .SerumPreset. */
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
  bpm: number
  lengthBars: number
  lanes: Lane[]
  clips: Clip[]
  markers: Marker[]
  loop: LoopRegion
  metronome: boolean
  createdAt: string
  updatedAt: string
}

export interface ProjectFileInfo {
  file: string         // file name inside the projects folder
  name: string
  updatedAt: string
  modified: number     // mtime (ms)
}
