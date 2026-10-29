// Turns a project into sample events for a time window. Shared by live playback (25 ms
// lookahead windows) and offline stem export (one window covering the whole range), so
// both hear exactly the same thing (CLAUDE.md: never duplicate scheduling logic).
//
// Every event time is computed from integer grid positions (beats, 16th steps), never by
// accumulating durations, so there is no drift: bar 192 is as exact as bar 1.

import { BEATS_PER_BAR, beatToSec, clipEnd, dbToGain, loopBeats, pitchRate, STEPS_PER_BAR, STEPS_PER_BEAT, VELOCITY_GAIN } from '../lib/project'
import type { AudioClip, BassRender, Clip, PatternClip, Project, SampleRef } from '../types/project'

export interface ScheduledEvent {
  laneId: string
  clipId: string
  relPath: string
  /** Project time (seconds) at which the sound starts. */
  start: number
  /** Seconds into the sample. */
  offset: number
  /** Seconds to play (project time); null = to the end of the sample. */
  duration: number | null
  /** Playback rate of a pitched clip (sampler style); 1 when left out. */
  rate?: number
  /** Linear gain (clip gain × step velocity). */
  gain: number
  /** Clip filter, with its cutoff at the event's start and end (Hz). */
  filter?: { type: BiquadFilterType; q: number; f0: number; f1: number }
  /** The clip's fades (project seconds); the gain follows `fadeAt` over the event. */
  fade?: EventFade
  /** A 16th slice of a loop played at another tempo: tiny fades at both ends against clicks. */
  declick?: boolean
}

// ---------------------------------------------------------------------------
// Tempo (SCOPE.md §6.4a): samples are cut at the library BPM; a project may run at another.
// Drum loops, fills and rolls are then played as 16th slices on the project's grid (like
// Ableton's Beats mode: pitch and transients untouched); FX play a copy the engine stretched to
// the project tempo with Rubber Band.
// ---------------------------------------------------------------------------

/** Sustained sounds that slicing would break up: they get a stretched file instead. */
export const STRETCHED_CATEGORIES = new Set<string>(['fx_riser', 'fx_downlifter', 'fx_impact', 'fx_sweep', 'fx_atmos', 'fx'])

/** Tempo a sample file is cut at (older projects don't store it: derived from its length). */
export function sampleBpm(s: SampleRef): number | null {
  if (s.bpm) return s.bpm
  if (s.kind === 'oneshot' || !s.bars || !s.durationS) return null
  return Math.round(((s.bars * BEATS_PER_BAR * 60) / s.durationS) * 100) / 100
}

export type TempoMode = 'native' | 'sliced' | 'stretched' | 'rendered'

export function tempoMode(clip: Clip, bpm: number): TempoMode {
  if (clip.type !== 'audio') return 'native'
  if (clip.bass) return 'rendered'
  const sb = sampleBpm(clip.sample)
  const same = sb == null || Math.abs(sb - bpm) < 1e-6
  if (STRETCHED_CATEGORIES.has(clip.sample.category)) return same ? 'native' : 'stretched'
  // A pitched loop plays faster or slower: as slices on the grid, so it stays in time.
  return same && !clip.pitch ? 'native' : 'sliced'
}

/** Library-relative path of a sample stretched to `bpm` (the engine's naming.tempo_rel_path). */
export function tempoPath(relPath: string, bpm: number): string {
  return `.drumvault/tempo/${Math.round(bpm * 100) / 100}/${relPath}`
}

/** FNV-1a, hex: a short stable id for a preset path in render file names. */
function shortHash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** Library-relative path of a bass part rendered through Serum at `bpm` (the engine writes it). */
export function bassPath(b: BassRender, bpm: number): string {
  const edit = b.notes ? `e${shortHash(JSON.stringify([b.bars ?? null, b.notes]))}` : `${b.midiId}`
  const feel = b.groove?.some((o) => o) ? `-g${shortHash(JSON.stringify(b.groove))}` : ''
  return `.drumvault/${b.role === 'keys' ? 'keys' : 'bass'}/${shortHash(b.preset)}-${edit}${feel}-${b.transpose}-${Math.round(bpm * 100) / 100}.wav`
}

/** The file a clip plays at the project tempo. */
export function soundPath(clip: Clip, bpm: number): string {
  if (clip.type === 'audio' && clip.bass) return bassPath(clip.bass, bpm)
  return tempoMode(clip, bpm) === 'stretched' ? tempoPath(clip.sample.relPath, bpm) : clip.sample.relPath
}

/** A clip's fade-in [inStart, inEnd] and fade-out [outStart, outEnd] in project seconds. */
export interface EventFade {
  inStart: number
  inEnd: number
  outStart: number
  outEnd: number
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

/** Fade gain (0…1) at project time `t`: linear ramps; silent before the clip and after it. */
export function fadeAt(f: EventFade, t: number): number {
  const a = f.inEnd > f.inStart ? clamp01((t - f.inStart) / (f.inEnd - f.inStart)) : t >= f.inStart - EPS ? 1 : 0
  const b = f.outEnd > f.outStart ? clamp01((f.outEnd - t) / (f.outEnd - f.outStart)) : t <= f.outEnd + EPS ? 1 : 0
  return a * b
}

/** Times in [t0, t1] where the fade gain changes slope: ramping linearly between them is exact. */
export function fadeBreakpoints(f: EventFade, t0: number, t1: number): number[] {
  const ts = [t0, f.inStart, f.inEnd, f.outStart, f.outEnd, t1].filter((t) => t >= t0 - EPS && t <= t1 + EPS)
  return [...new Set(ts.map((t) => Math.min(t1, Math.max(t0, t))))].sort((a, b) => a - b)
}

function clipFade(clip: Clip, bpm: number): EventFade | undefined {
  const fi = Math.max(0, clip.fadeIn ?? 0)
  const fo = Math.max(0, clip.fadeOut ?? 0)
  if (!fi && !fo) return undefined
  const s = beatToSec(clip.start, bpm)
  const e = beatToSec(clipEnd(clip), bpm)
  return { inStart: s, inEnd: s + beatToSec(fi, bpm), outStart: e - beatToSec(fo, bpm), outEnd: e }
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
/** Slice length (beats) when a loop plays at another tempo. */
const SLICE = 1 / 4

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

function withFade(ev: ScheduledEvent, clip: Clip, bpm: number): ScheduledEvent {
  const fade = clipFade(clip, bpm)
  return fade ? { ...ev, fade } : ev
}

function push(out: ScheduledEvent[], clip: Clip, bpm: number, start: number, offset: number, duration: number | null,
              gain: number, from: number, to: number, includeOngoing: boolean, soundLength: number,
              relPath = clip.sample.relPath, opts: { declick?: boolean; rate?: number } = {}): void {
  const rate = opts.rate ?? 1
  const extra = { ...(opts.declick ? { declick: true } : {}), ...(rate !== 1 ? { rate } : {}) }
  if (start >= from - EPS && start < to - EPS) {
    out.push(withFade(withFilter({ laneId: clip.laneId, clipId: clip.id, relPath, start, offset, duration, gain, ...extra }, clip, bpm), clip, bpm))
  } else if (includeOngoing && start < from - EPS && start + soundLength > from + EPS) {
    const late = from - start
    out.push(withFade(withFilter({
      laneId: clip.laneId, clipId: clip.id, relPath, start: from, offset: offset + late * rate,
      duration: duration == null ? null : duration - late, gain, ...extra,
    }, clip, bpm), clip, bpm))
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
  const mode = tempoMode(clip, bpm)
  const sb = sampleBpm(clip.sample)
  const rel = soundPath(clip, bpm)
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
    const off = k === 0 ? trim : 0  // beats into the loop at s
    if (mode === 'sliced') {
      // One 16th slice at a time, each starting on the project's grid with its own piece of the
      // loop; a pitched slice plays faster (it ends early) or slower (it's cut at the next one).
      const srcBpm = sb ?? bpm
      const rate = pitchRate(clip.pitch)
      const sliceOut = (SLICE * 60) / srcBpm / rate
      const first = Math.max(0, Math.floor((fromBeat - s) / SLICE) - 1)
      for (let j = first; s + j * SLICE < e - EPS; j++) {
        const at = s + j * SLICE
        if (at >= toBeat + EPS) break
        const slot = beatToSec(Math.min(SLICE, e - at), bpm)
        const dur = Math.min(sliceOut, slot)
        push(out, clip, bpm, beatToSec(at, bpm), ((off + j * SLICE) * 60) / srcBpm, dur, gain, from, to, ongoing, dur, rel,
          { declick: true, rate })
      }
      continue
    }
    // Native or stretched: the file runs at the project tempo, one event per repetition.
    const startSec = beatToSec(s, bpm)
    const durSec = beatToSec(e - s, bpm)
    push(out, clip, bpm, startSec, beatToSec(off, bpm), durSec, gain, from, to, ongoing, durSec, rel)
  }
}

/**
 * A pattern clip fires its one-shot on every active 16th step; the pattern repeats across the
 * clip. With a groove, each step lands that step's offset late (or early) at its accent.
 */
function patternEvents(clip: PatternClip, bpm: number, from: number, to: number, out: ScheduledEvent[]): void {
  const n = clip.steps.length
  if (!n) return
  const stepsInClip = Math.round(clip.length * STEPS_PER_BEAT)
  const gain = dbToGain(clip.gainDb)
  const stepSec = beatToSec(1 / STEPS_PER_BEAT, bpm)
  const clipStartSec = beatToSec(clip.start, bpm)
  const first = Math.max(0, Math.floor((from - clipStartSec) / stepSec) - 1)
  const last = Math.min(stepsInClip - 1, Math.ceil((to - clipStartSec) / stepSec) + 1)
  const g = clip.groove
  const startStep = Math.round(clip.start * STEPS_PER_BEAT)
  const rate = pitchRate(clip.pitch)
  for (let i = first; i <= last; i++) {
    const v = clip.steps[i % n]
    if (!v) continue
    // Step i of the clip: computed from integers (beats, 16ths), not accumulated.
    const inBar = (((startStep + i) % STEPS_PER_BAR) + STEPS_PER_BAR) % STEPS_PER_BAR
    const start = beatToSec(clip.start + (i + (g?.offsets[inBar] ?? 0)) / STEPS_PER_BEAT, bpm)
    const accent = g ? dbToGain(g.gains[inBar] ?? 0) : 1
    push(out, clip, bpm, start, 0, null, gain * VELOCITY_GAIN[v] * accent, from, to, false, 0, clip.sample.relPath, { rate })
  }
}

/** Kick hits in [from, to) seconds (pattern clips with a kick one-shot): the sidechain's trigger. */
export function kickHits(project: Project, from: number, to: number): number[] {
  const out: ScheduledEvent[] = []
  for (const clip of project.clips) {
    if (clip.type === 'pattern' && clip.sample.category === 'kick') patternEvents(clip, project.bpm, from, to, out)
  }
  return [...new Set(out.map((e) => e.start))].sort((a, b) => a - b)
}

/** Release of the sidechain duck: most of a beat. */
export const duckRelease = (bpm: number) => (0.6 * 60) / bpm

/** Metronome clicks in [from, to): one per beat, `downbeat` on bar starts. */
export function metronomeTicks(bpm: number, from: number, to: number): { start: number; downbeat: boolean }[] {
  const out = []
  const beatSec = 60 / bpm
  for (let b = Math.max(0, Math.ceil(from / beatSec - EPS)); b * beatSec < to - EPS; b++) {
    out.push({ start: beatToSec(b, bpm), downbeat: b % BEATS_PER_BAR === 0 })
  }
  return out
}
