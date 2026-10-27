// Turns a project into sample events for a time window. Shared by live playback (25 ms
// lookahead windows) and offline stem export (one window covering the whole range), so
// both hear exactly the same thing (CLAUDE.md: never duplicate scheduling logic).
//
// Every event time is computed from integer grid positions (beats, 16th steps), never by
// accumulating durations, so there is no drift: bar 192 is as exact as bar 1.

import { BEATS_PER_BAR, beatToSec, clipEnd, dbToGain, loopBeats, STEPS_PER_BEAT, VELOCITY_GAIN } from '../lib/project'
import type { AudioClip, Clip, PatternClip, Project } from '../types/project'

export interface ScheduledEvent {
  laneId: string
  clipId: string
  relPath: string
  /** Project time (seconds) at which the sound starts. */
  start: number
  /** Seconds into the sample. */
  offset: number
  /** Seconds to play; null = to the end of the sample. */
  duration: number | null
  /** Linear gain (clip gain × step velocity). */
  gain: number
  /** Clip filter, with its cutoff at the event's start and end (Hz). */
  filter?: { type: BiquadFilterType; q: number; f0: number; f1: number }
}

export interface ScheduleOptions {
  /**
   * Also return loop audio that started before `from` and is still playing at `from`,
   * trimmed to start at `from` (starting playback mid-clip, or at a loop start).
   * One-shot tails are not picked up: a hit cut off mid-sound is a click, not music.
   */
  includeOngoing?: boolean
  /** Only these lanes (stem export renders one lane at a time). */
  laneIds?: Set<string>
}

const EPS = 1e-9

/** Events whose start lies in [from, to) (seconds), ordered by start time. */
export function eventsInRange(project: Project, from: number, to: number, opts: ScheduleOptions = {}): ScheduledEvent[] {
  const out: ScheduledEvent[] = []
  for (const clip of project.clips) {
    if (opts.laneIds && !opts.laneIds.has(clip.laneId)) continue
    if (clip.type === 'audio') audioEvents(clip, project.bpm, from, to, !!opts.includeOngoing, out)
    else patternEvents(clip, project.bpm, from, to, out)
  }
  return out.sort((a, b) => a.start - b.start)
}

/** Cutoff of a clip's filter at project time `sec`: exponential from `from` to `to` over the clip. */
export function filterCutoff(clip: Clip, bpm: number, sec: number): number {
  const f = clip.filter!
  if (f.to == null || f.to === f.from) return f.from
  const t = Math.max(0, Math.min(1, (sec - beatToSec(clip.start, bpm)) / beatToSec(clip.length, bpm)))
  return f.from * (f.to / f.from) ** t
}

function withFilter(ev: ScheduledEvent, clip: Clip, bpm: number): ScheduledEvent {
  if (!clip.filter) return ev
  const end = ev.duration == null ? ev.start : ev.start + ev.duration  // one-shot hits keep one cutoff
  return {
    ...ev,
    filter: { type: clip.filter.type, q: clip.filter.q, f0: filterCutoff(clip, bpm, ev.start), f1: filterCutoff(clip, bpm, end) },
  }
}

function push(out: ScheduledEvent[], clip: Clip, bpm: number, start: number, offset: number, duration: number | null,
              gain: number, from: number, to: number, includeOngoing: boolean, soundLength: number): void {
  if (start >= from - EPS && start < to - EPS) {
    out.push(withFilter({ laneId: clip.laneId, clipId: clip.id, relPath: clip.sample.relPath, start, offset, duration, gain }, clip, bpm))
  } else if (includeOngoing && start < from - EPS && start + soundLength > from + EPS) {
    const late = from - start
    out.push(withFilter({
      laneId: clip.laneId, clipId: clip.id, relPath: clip.sample.relPath, start: from, offset: offset + late,
      duration: duration == null ? null : duration - late, gain,
    }, clip, bpm))
  }
}

/**
 * An audio clip plays its loop from `trimBeats`, wrapping back to the loop start every
 * loop length, until the clip ends (possibly mid-loop). Each repetition is its own event
 * anchored to the grid.
 */
function audioEvents(clip: AudioClip, bpm: number, from: number, to: number, ongoing: boolean, out: ScheduledEvent[]): void {
  const L = loopBeats(clip)
  const trim = ((clip.trimBeats % L) + L) % L
  const end = clipEnd(clip)
  const gain = dbToGain(clip.gainDb)
  const fromBeat = (from * bpm) / 60
  const toBeat = (to * bpm) / 60
  if (end <= fromBeat - L || clip.start >= toBeat + 1) return

  // Repetition k starts at firstEnd + (k-1)·L (k ≥ 1); k = 0 is the trimmed first one.
  const firstEnd = clip.start + (L - trim)
  const segStart = (k: number) => (k === 0 ? clip.start : firstEnd + (k - 1) * L)
  let k = fromBeat <= firstEnd ? 0 : Math.max(0, Math.floor((fromBeat - firstEnd) / L))  // may start ongoing
  for (; ; k++) {
    const s = segStart(k)
    if (s >= end || s >= toBeat + EPS) break
    const e = Math.min(end, k === 0 ? firstEnd : s + L)
    const startSec = beatToSec(s, bpm)
    const durSec = beatToSec(e - s, bpm)
    push(out, clip, bpm, startSec, beatToSec(k === 0 ? trim : 0, bpm), durSec, gain, from, to, ongoing, durSec)
  }
}

/** A pattern clip fires its one-shot on every active 16th step; the pattern repeats across the clip. */
function patternEvents(clip: PatternClip, bpm: number, from: number, to: number, out: ScheduledEvent[]): void {
  const n = clip.steps.length
  if (!n) return
  const stepsInClip = Math.round(clip.length * STEPS_PER_BEAT)
  const gain = dbToGain(clip.gainDb)
  const stepSec = beatToSec(1 / STEPS_PER_BEAT, bpm)
  const clipStartSec = beatToSec(clip.start, bpm)
  const first = Math.max(0, Math.floor((from - clipStartSec) / stepSec) - 1)
  const last = Math.min(stepsInClip - 1, Math.ceil((to - clipStartSec) / stepSec) + 1)
  for (let i = first; i <= last; i++) {
    const v = clip.steps[i % n]
    if (!v) continue
    // Step i of the clip: computed from integers (beats, 16ths), not accumulated.
    const start = beatToSec(clip.start + i / STEPS_PER_BEAT, bpm)
    push(out, clip, bpm, start, 0, null, gain * VELOCITY_GAIN[v], from, to, false, 0)
  }
}

/** Metronome clicks in [from, to): one per beat, `downbeat` on bar starts. */
export function metronomeTicks(bpm: number, from: number, to: number): { start: number; downbeat: boolean }[] {
  const out = []
  const beatSec = 60 / bpm
  for (let b = Math.max(0, Math.ceil(from / beatSec - EPS)); b * beatSec < to - EPS; b++) {
    out.push({ start: beatToSec(b, bpm), downbeat: b % BEATS_PER_BAR === 0 })
  }
  return out
}
