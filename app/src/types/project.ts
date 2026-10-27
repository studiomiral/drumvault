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
}

/** A loop on the bar grid; extending it repeats the loop. */
export interface AudioClip extends ClipBase {
  type: 'audio'
  /** Beats skipped at the start of the loop (left trim), a multiple of a 16th. */
  trimBeats: number
}

/** 0 = off, 1 = soft, 2 = medium, 3 = full. */
export type Velocity = 0 | 1 | 2 | 3

/** A one-shot played by a 16-steps-per-bar pattern that repeats across the clip. */
export interface PatternClip extends ClipBase {
  type: 'pattern'
  patternBars: 1 | 2 | 4
  steps: Velocity[]    // patternBars * 16
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
