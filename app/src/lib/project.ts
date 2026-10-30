// Pure project helpers: defaults, clip geometry, presets, serialisation.

import type { SampleListItem } from '../types/api'
import type { Category } from '../types/engine'
import type { AudioClip, Clip, Lane, Marker, PatternClip, Project, SampleRef, Velocity } from '../types/project'

export const BEATS_PER_BAR = 4
export const STEPS_PER_BEAT = 4
export const STEPS_PER_BAR = BEATS_PER_BAR * STEPS_PER_BEAT
export const DEFAULT_LENGTH_BARS = 192
export const DEFAULT_LANE_HEIGHT = 64
export const MIN_LANE_HEIGHT = 36
export const MAX_LANE_HEIGHT = 200

/** Linear gain for each velocity level (soft ≈ -9 dB, medium ≈ -4 dB). */
export const VELOCITY_GAIN: Record<Velocity, number> = { 0: 0, 1: 0.35, 2: 0.65, 3: 1 }

export const LANE_COLORS = ['#e2c35f', '#4ee3a6', '#22d3ee', '#60a5fa', '#a78bfa', '#f472b6', '#fb923c', '#a3e635']
/** Colour picker choices: the default lane colours, then lighter and darker variants. */
export const LANE_PALETTE = [
  ...LANE_COLORS,
  '#a6f4d4', '#a5f3fc', '#bfdbfe', '#ddd6fe', '#fbcfe8', '#fed7aa', '#fef08a', '#d9f99d',
  '#14b87f', '#0891b2', '#2563eb', '#7c3aed', '#db2777', '#ea580c', '#ca8a04', '#65a30d',
  '#f87171', '#2dd4bf', '#e879f9', '#fb7185', '#94a3b8', '#cbd5e1', '#78716c', '#f5f5f4',
]

export const MARKER_NAMES = ['Intro', 'Build', 'Drop', 'Break', 'Breakdown', 'Outro']
const MARKER_COLORS: Record<string, string> = {
  intro: '#22d3ee', build: '#facc15', drop: '#f472b6', break: '#4ee3a6', breakdown: '#4ee3a6', outro: '#60a5fa',
}

export function markerColor(name: string): string {
  return MARKER_COLORS[name.trim().split(/\s+/)[0]?.toLowerCase() ?? ''] ?? '#a78bfa'
}

export function uid(prefix = ''): string {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
}

export function dbToGain(db: number): number {
  return db <= -60 ? 0 : 10 ** (db / 20)
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

const DEFAULT_LANES = ['Kick', 'Clap', 'Snare', 'Hats', 'Perc', 'Tops', 'Groove']

export function makeLane(name: string, index: number): Lane {
  return {
    id: uid('l'), name, color: LANE_COLORS[index % LANE_COLORS.length], volumeDb: 0, pan: 0,
    mute: false, solo: false, height: DEFAULT_LANE_HEIGHT,
  }
}

export function newProject(name: string, bpm: number): Project {
  const now = new Date().toISOString()
  return {
    format: 'drumvault-project', version: 1, name, bpm, lengthBars: DEFAULT_LENGTH_BARS,
    lanes: DEFAULT_LANES.map(makeLane), clips: [], markers: [],
    loop: { start: 0, end: 16, enabled: false }, metronome: false, createdAt: now, updatedAt: now,
  }
}

export function sampleRef(s: SampleListItem): SampleRef {
  return {
    relPath: s.rel_path, id: s.id, name: s.name, kind: s.kind, category: s.category, bars: s.bars,
    durationS: s.duration_s, bpm: s.bpm,
  }
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

export type PresetName = 'four' | 'offbeat' | 'twofour'

export const PRESETS: { id: PresetName; label: string; steps: number[] }[] = [
  { id: 'four', label: '4 on the floor', steps: [0, 4, 8, 12] },
  { id: 'offbeat', label: 'Offbeat', steps: [2, 6, 10, 14] },
  { id: 'twofour', label: 'Every 2 & 4', steps: [4, 12] },
]

export function presetSteps(preset: PresetName, patternBars: number): Velocity[] {
  const hits = PRESETS.find((p) => p.id === preset)!.steps
  const steps: Velocity[] = new Array(patternBars * STEPS_PER_BAR).fill(0)
  for (let b = 0; b < patternBars; b++) for (const s of hits) steps[b * STEPS_PER_BAR + s] = 3
  return steps
}

export function defaultPreset(category: Category): PresetName {
  if (category === 'kick') return 'four'
  if (category === 'clap' || category === 'snare') return 'twofour'
  return 'offbeat'
}

/** Resize a pattern to `bars`, repeating the existing bars to fill a longer one. */
export function resizePattern(steps: Velocity[], bars: number): Velocity[] {
  const n = bars * STEPS_PER_BAR
  return Array.from({ length: n }, (_, i) => steps[i % steps.length] ?? 0)
}

// ---------------------------------------------------------------------------
// Clips
// ---------------------------------------------------------------------------

export function clipEnd(c: Clip): number {
  return c.start + c.length
}

/** Loop length of an audio clip's sample in beats. */
/** Length of what an audio clip repeats: its loop, or only the loop's first `loopBars`. */
export function loopBeats(c: AudioClip): number {
  const bars = c.sample.bars ?? 1
  return Math.max(1, (c.loopBars ? Math.min(c.loopBars, bars) : bars) * BEATS_PER_BAR)
}

/** Playback rate for a pitch in semitones (sampler style: higher is faster). */
export function pitchRate(semitones: number | undefined): number {
  return semitones ? 2 ** (semitones / 12) : 1
}

/**
 * Move a clip's sound `beats` later (negative: earlier) inside its own loop, wrapping around;
 * the clip stays where it is. Audio clips rotate their loop (via `trimBeats`), pattern clips
 * rotate their steps.
 */
export function shiftContent(c: Clip, beats: number): Clip {
  if (c.type === 'audio') {
    const L = loopBeats(c)
    return { ...c, trimBeats: (((c.trimBeats - beats) % L) + L) % L }
  }
  const n = c.steps.length
  const k = (((beats * STEPS_PER_BEAT) % n) + n) % n
  return { ...c, steps: c.steps.map((_, i) => c.steps[(i - k + n) % n]) }
}

/** How far an audio clip's sound is moved inside its loop, in beats within (-L/2, L/2]. */
export function contentShift(c: AudioClip): number {
  const L = loopBeats(c)
  const s = (((-c.trimBeats) % L) + L) % L
  return s > L / 2 ? s - L : s
}

export function makeClip(sample: SampleListItem, laneId: string, start: number): Clip {
  const base = { id: uid('c'), laneId, start, gainDb: 0, sample: sampleRef(sample) }
  // Loops and events (fills, rolls, FX) are whole bars of audio on the grid.
  if (sample.kind !== 'oneshot') {
    const beats = (sample.bars ?? 1) * BEATS_PER_BAR
    return { ...base, type: 'audio', length: beats, trimBeats: 0 }
  }
  return {
    ...base, type: 'pattern', length: 4 * BEATS_PER_BAR, patternBars: 1,
    steps: presetSteps(defaultPreset(sample.category), 1),
  } satisfies PatternClip
}

/**
 * Copies of `clips` placed right after the span they cover (⌘D), or `span` beats later
 * (duplicating a section: the copy starts where the section ends).
 */
export function duplicateClips(clips: Clip[], span?: number): Clip[] {
  if (!clips.length) return []
  const start = Math.min(...clips.map((c) => c.start))
  const end = Math.max(...clips.map(clipEnd))
  const offset = span ?? end - start
  return clips.map((c) => ({ ...structuredClone(c), id: uid('c'), start: c.start + offset }))
}

/**
 * Copies of `clips` placed so the earliest starts at `at`, on the same lanes (lanes that no
 * longer exist fall back to `fallbackLane`).
 */
export function pasteClips(clips: Clip[], at: number, laneIds: string[], fallbackLane: string): Clip[] {
  if (!clips.length) return []
  const first = Math.min(...clips.map((c) => c.start))
  return clips.map((c) => ({
    ...structuredClone(c), id: uid('c'), start: Math.max(0, at + c.start - first),
    laneId: laneIds.includes(c.laneId) ? c.laneId : fallbackLane,
  }))
}

/**
 * Split a clip at `beat` (strictly inside it) into two that play exactly as before: the right
 * part continues the loop (trim) or pattern (rotated steps); fades stay at their edges.
 */
export function splitClip(c: Clip, beat: number): [Clip, Clip] | null {
  const d = beat - c.start
  if (d <= 0 || d >= c.length) return null
  const left = { ...structuredClone(c), length: d, fadeOut: undefined }
  const right = { ...structuredClone(c), id: uid('c'), start: beat, length: c.length - d, fadeIn: undefined }
  if (left.fadeIn) left.fadeIn = Math.min(left.fadeIn, d) || undefined
  if (right.fadeOut) right.fadeOut = Math.min(right.fadeOut, right.length) || undefined
  if (c.verb) {
    // The reverb build carries on where it was: the left half up to the split, the right from it.
    const t = (d / c.length) ** 2
    const mid = c.verb.from + (c.verb.to - c.verb.from) * t
    left.verb = { from: c.verb.from, to: mid }
    right.verb = { from: mid, to: c.verb.to }
  }
  if (right.type === 'audio' && c.type === 'audio') {
    const L = loopBeats(c)
    right.trimBeats = (((c.trimBeats + d) % L) + L) % L
  } else if (right.type === 'pattern' && c.type === 'pattern') {
    const n = c.steps.length
    const k = Math.round(d * STEPS_PER_BEAT) % n
    right.steps = c.steps.map((_, i) => c.steps[(i + k) % n])
  }
  return [left, right]
}

/** Can `sample` stand in for the clip's sample? One-shots in patterns, loops/events in audio clips. */
export function canReplace(c: Clip, sample: SampleRef): boolean {
  return c.type === 'pattern' ? sample.kind === 'oneshot' : sample.kind !== 'oneshot'
}

/** The clip with another sample, same place and length (a loop's trim wraps to the new length). */
export function replaceSample(c: Clip, sample: SampleRef): Clip {
  const next = { ...c, sample: { ...sample } }
  if (next.type === 'audio') {
    const L = loopBeats(next)
    next.trimBeats = ((next.trimBeats % L) + L) % L
  }
  return next
}

/** Clips overlapping [start, end) on any lane (marker selection). */
export function clipsInRange(clips: Clip[], start: number, end: number): Clip[] {
  return clips.filter((c) => c.start < end && clipEnd(c) > start)
}

export function makeMarker(name: string, start: number, end: number): Marker {
  return { id: uid('m'), name, start, end, color: markerColor(name) }
}

export function nextMarkerName(markers: Marker[]): string {
  const used = new Set(markers.map((m) => m.name))
  return MARKER_NAMES.find((n) => !used.has(n)) ?? `Section ${markers.length + 1}`
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

export function beatToSec(beat: number, bpm: number): number {
  return (beat * 60) / bpm
}

export function secToBeat(sec: number, bpm: number): number {
  return (sec * bpm) / 60
}

/** "12.3.4" = bar 12, beat 3, 16th 4 (1-based). */
export function formatPosition(beat: number): string {
  const sixteenth = Math.floor(beat * STEPS_PER_BEAT + 1e-6)
  const bar = Math.floor(sixteenth / STEPS_PER_BAR) + 1
  const b = Math.floor((sixteenth % STEPS_PER_BAR) / STEPS_PER_BEAT) + 1
  const s = (sixteenth % STEPS_PER_BEAT) + 1
  return `${bar}.${b}.${s}`
}

/** "1:23.4" (with tenths) or "5:12": minutes and seconds of a time in seconds. */
export function formatTime(sec: number, tenths = false): string {
  const t = Math.max(0, tenths ? Math.floor(sec * 10 + 1e-6) / 10 : Math.round(sec))
  const m = Math.floor(t / 60)
  const s = t - m * 60
  return `${m}:${(tenths ? s.toFixed(1) : String(Math.floor(s))).padStart(tenths ? 4 : 2, '0')}`
}

export function snap(beat: number, toBeats: number): number {
  return Math.round(beat / toBeats) * toBeats
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

export function serializeProject(p: Project): string {
  return JSON.stringify({ ...p, updatedAt: new Date().toISOString() }, null, 1)
}

/** Parse and validate a .dvproj file; fills in fields added in later versions. */
export function parseProject(text: string): Project {
  const p = JSON.parse(text) as Partial<Project>
  if (p.format !== 'drumvault-project') throw new Error('Not a Warehouse project')
  if (p.version !== 1) throw new Error(`Unsupported project version ${p.version}`)
  const now = new Date().toISOString()
  return {
    format: 'drumvault-project', version: 1,
    name: p.name ?? 'Untitled', bpm: p.bpm ?? 124, lengthBars: p.lengthBars ?? DEFAULT_LENGTH_BARS,
    lanes: (p.lanes ?? []).map((l, i) => ({ ...makeLane(l.name ?? `Lane ${i + 1}`, i), ...l })),
    clips: p.clips ?? [], markers: p.markers ?? [],
    loop: p.loop ?? { start: 0, end: 16, enabled: false }, metronome: p.metronome ?? false,
    createdAt: p.createdAt ?? now, updatedAt: p.updatedAt ?? now,
  }
}
