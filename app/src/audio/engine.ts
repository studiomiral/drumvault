// Arrange transport (SCOPE.md §6.4): a lookahead scheduler on the shared AudioContext.
// Every 25 ms it schedules everything that starts in the next 120 ms with
// AudioBufferSourceNode.start(when, offset, duration). Event times come from the shared
// scheduler (schedule.ts), so playback is sample-accurate with no drift.

import { beatToSec, BEATS_PER_BAR, secToBeat } from '../lib/project'
import type { Lane, Project } from '../types/project'
import type { SampleKind } from '../types/engine'
import { audioContext, buffers } from './context'
import { applyLane, createLaneNodes, duckAt, laneAudible, playEvent, resetDuck, type LaneNodes } from './graph'
import { duckRelease, eventsInRange, kickHits, metronomeTicks, soundPath } from './schedule'
import { ensureStretched, ensureTempo, projectSounds } from './tempo'

const TICK_MS = 25
const LOOKAHEAD = 0.12      // seconds scheduled ahead
const START_DELAY = 0.03    // seconds from "play" to the first sound

type Listener = () => void

class PlaybackEngine {
  private master: GainNode | null = null
  private lanes = new Map<string, LaneNodes>()
  private sources = new Set<AudioScheduledSourceNode>()
  /** The clip each playing sound belongs to (to swap a clip's sound while playing). */
  private sourceClip = new WeakMap<AudioScheduledSourceNode, string>()
  private timer: ReturnType<typeof setInterval> | null = null
  private listeners = new Set<Listener>()
  private getProject: () => Project = () => { throw new Error('no project') }

  playing = false
  loading = false
  /** Bumped by every play and stop: a play still loading gives up when a later one (or a stop) came. */
  private playToken = 0
  /** Where playback started / stopped (beats) when not playing. */
  private stoppedAt = 0
  // Mapping between context time and project time for the current segment
  // (a new segment starts at every loop wrap).
  private segCtx = 0
  private segProj = 0
  private scheduledTo = 0
  private firstWindow = true
  private auditionSrc: AudioBufferSourceNode | null = null

  connect(getProject: () => Project): void {
    this.getProject = getProject
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(): void {
    for (const fn of this.listeners) fn()
  }

  private out(): GainNode {
    if (!this.master) {
      const ctx = audioContext()
      this.master = ctx.createGain()
      this.master.connect(ctx.destination)
    }
    return this.master
  }

  /** Create/update lane nodes (volume, pan, mute, solo); call after lane edits. */
  syncLanes(lanes: Lane[]): void {
    const ctx = audioContext()
    for (const lane of lanes) {
      let n = this.lanes.get(lane.id)
      if (!n) {
        n = createLaneNodes(ctx, this.out())
        this.lanes.set(lane.id, n)
      }
      applyLane(n, lane, laneAudible(lane, lanes), ctx.currentTime)
    }
    for (const [id, n] of this.lanes) {
      if (!lanes.some((l) => l.id === id)) {
        n.pan.disconnect()
        this.lanes.delete(id)
      }
    }
  }

  /** Current position in beats (playhead). */
  position(): number {
    if (!this.playing) return this.stoppedAt
    const ctx = audioContext()
    const proj = this.segProj + Math.max(0, ctx.currentTime - this.segCtx)
    return secToBeat(proj, this.getProject().bpm)
  }

  setPosition(beat: number): void {
    if (this.playing) void this.play(beat)
    else {
      this.stoppedAt = Math.max(0, beat)
      this.emit()
    }
  }

  /** Decode everything the project uses up front (stretched FX first), so pressing play starts at once. */
  async preload(project: Project): Promise<string[]> {
    // The files as they are now: a bass change made while this waits loads its own part.
    const sounds = projectSounds(project)
    try {
      await ensureTempo(project)
    } catch (e) {
      console.error('stretching for the project tempo failed', e)  // those FX stay silent
    }
    return buffers.loadAll(sounds)
  }

  async play(fromBeat = this.stoppedAt): Promise<void> {
    this.halt()
    const token = ++this.playToken
    const ctx = audioContext()
    if (ctx.state === 'suspended') await ctx.resume()
    const project = this.getProject()
    this.syncLanes(project.lanes)
    // Bass renders through Serum can take a while (the first one loads the plugin), so play
    // doesn't wait for them: the bass comes in, from the playhead, once it's rendered.
    const isBass = (c: Project['clips'][number]) => c.type === 'audio' && !!c.bass
    const sounds = [...new Set(project.clips.filter((c) => !isBass(c)).map((c) => soundPath(c, project.bpm)))]
    if (sounds.some((p) => !buffers.get(p))) {
      this.loading = true
      this.emit()
      try {
        await ensureStretched(project)
      } catch (e) {
        console.error('stretching for the project tempo failed', e)  // those FX stay silent
      }
      await buffers.loadAll(sounds)
    }
    if (token !== this.playToken) return  // stopped, or played again, while loading
    this.loading = false
    const bass = project.clips.filter((c) => isBass(c) && !buffers.get(soundPath(c, project.bpm)))
    this.stoppedAt = fromBeat
    this.segCtx = ctx.currentTime + START_DELAY
    this.segProj = beatToSec(fromBeat, project.bpm)
    this.scheduledTo = this.segProj
    this.firstWindow = true
    this.playing = true
    this.tick()
    this.timer = setInterval(() => this.tick(), TICK_MS)
    this.emit()
    if (bass.length) void this.reloadClips(project, bass.map((c) => c.id))
  }

  stop(): void {
    const at = this.position()
    this.halt()
    this.playToken++
    this.loading = false
    this.stoppedAt = at
    this.emit()
  }

  toggle(fromBeat?: number): void {
    if (this.playing || this.loading) this.stop()
    else void this.play(fromBeat)
  }

  private halt(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const s of this.sources) {
      try {
        s.stop()
      } catch {
        // not started yet / already stopped
      }
    }
    this.sources.clear()
    this.stopAudition()
    const now = audioContext().currentTime
    for (const n of this.lanes.values()) resetDuck(n, now)
    this.playing = false
  }

  private ctxAt(projSec: number): number {
    return this.segCtx + (projSec - this.segProj)
  }

  private tick(): void {
    const ctx = audioContext()
    const p = this.getProject()
    const nowProj = this.segProj + (ctx.currentTime - this.segCtx)
    let horizon = Math.max(nowProj, this.segProj) + LOOKAHEAD
    const endSec = beatToSec(p.lengthBars * BEATS_PER_BAR, p.bpm)
    const loopStart = beatToSec(p.loop.start, p.bpm)
    const loopEnd = beatToSec(p.loop.end, p.bpm)

    for (let guard = 0; this.scheduledTo < horizon && guard < 8; guard++) {
      // Wrap at the loop end only if this segment started inside the loop region.
      const looping = p.loop.enabled && p.loop.end > p.loop.start && this.segProj < loopEnd - 1e-9
      const limit = looping ? loopEnd : endSec
      const to = Math.min(horizon, limit)
      this.scheduleWindow(p, this.scheduledTo, to, looping ? this.ctxAt(limit) : undefined)
      this.scheduledTo = to
      if (to < limit) break
      if (looping) {
        // New segment: project time jumps back to the loop start.
        const carry = horizon - limit
        this.segCtx = this.ctxAt(limit)
        this.segProj = loopStart
        this.scheduledTo = loopStart
        this.firstWindow = true
        horizon = loopStart + carry
      } else {
        // Project end: stop when it's reached.
        const delay = Math.max(0, (this.ctxAt(endSec) - ctx.currentTime) * 1000)
        if (this.timer) clearInterval(this.timer)
        this.timer = null
        setTimeout(() => {
          if (this.playing && !this.timer) {
            this.halt()
            this.stoppedAt = 0
            this.emit()
          }
        }, delay)
        break
      }
    }
  }

  private scheduleWindow(p: Project, from: number, to: number, cutAt?: number): void {
    const ctx = audioContext()
    const events = eventsInRange(p, from, to, { includeOngoing: this.firstWindow })
    this.firstWindow = false
    for (const ev of events) {
      const buf = buffers.get(ev.relPath)
      const lane = this.lanes.get(ev.laneId)
      if (!buf || !lane) continue
      const src = playEvent(ctx, ev, buf, lane.gain, this.ctxAt(ev.start), cutAt)
      if (src) this.track(src, ev.clipId)
    }
    if (p.metronome) {
      for (const t of metronomeTicks(p.bpm, from, to)) this.click(this.ctxAt(t.start), t.downbeat)
    }
    // Sidechain: lanes with `duck` dip on every kick hit in this window.
    const ducking = p.lanes.filter((l) => l.duck)
    if (ducking.length) {
      const hits = kickHits(p, from, to)
      for (const l of ducking) {
        const n = this.lanes.get(l.id)
        if (n) for (const t of hits) duckAt(n, this.ctxAt(t), l.duck!, duckRelease(p.bpm))
      }
    }
  }

  private track(src: AudioScheduledSourceNode, clipId?: string): void {
    this.sources.add(src)
    if (clipId) this.sourceClip.set(src, clipId)
    src.onended = () => this.sources.delete(src)
  }

  /**
   * These clips' sound changed (a new bass render): load it, then — if playing — stop the old
   * sound and start the new one right away from the playhead, instead of at the next repetition
   * (a long bass loop would otherwise stay silent for up to its whole length).
   */
  async reloadClips(project: Project, clipIds: Iterable<string>): Promise<void> {
    await this.preload(project)
    const ids = new Set(clipIds)
    if (!this.playing || !ids.size) return
    const ctx = audioContext()
    // The project as it is now: it may have been edited (a volume, say) while rendering.
    const p = this.getProject()
    for (const src of [...this.sources]) {
      if (!ids.has(this.sourceClip.get(src) ?? '')) continue
      try {
        src.stop()
      } catch {
        // not started yet
      }
      this.sources.delete(src)
    }
    const from = this.segProj + (ctx.currentTime + START_DELAY - this.segCtx)
    if (from >= this.scheduledTo) return  // the next tick schedules them anyway
    const loopEnd = beatToSec(p.loop.end, p.bpm)
    const looping = p.loop.enabled && p.loop.end > p.loop.start && this.segProj < loopEnd - 1e-9
    const cutAt = looping ? this.ctxAt(loopEnd) : undefined
    for (const ev of eventsInRange(p, from, this.scheduledTo, { includeOngoing: true })) {
      if (!ids.has(ev.clipId)) continue
      const buf = buffers.get(ev.relPath)
      const lane = this.lanes.get(ev.laneId)
      if (!buf || !lane) continue
      const src = playEvent(ctx, ev, buf, lane.gain, this.ctxAt(ev.start), cutAt)
      if (src) this.track(src, ev.clipId)
    }
  }

  private click(when: number, downbeat: boolean): void {
    const ctx = audioContext()
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.frequency.value = downbeat ? 1760 : 1320
    g.gain.setValueAtTime(0.0001, when)
    g.gain.exponentialRampToValueAtTime(downbeat ? 0.35 : 0.2, when + 0.002)
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05)
    osc.connect(g).connect(this.out())
    osc.start(when)
    osc.stop(when + 0.06)
    this.track(osc)
  }

  /**
   * Library audition while the transport runs: loops start on the next bar, in sync, and
   * repeat; events (fills, FX) start on the next bar and play once; one-shots play at once.
   * Returns false when not playing (caller plays normally).
   */
  auditionSynced(buffer: AudioBuffer, kind: SampleKind, bars: number | null, onEnd: () => void): boolean {
    if (!this.playing) return false
    const ctx = audioContext()
    const p = this.getProject()
    this.stopAudition()
    const src = ctx.createBufferSource()
    src.buffer = buffer
    let when = ctx.currentTime + 0.01
    if (kind !== 'oneshot') {
      const barSec = beatToSec(BEATS_PER_BAR, p.bpm)
      const proj = this.segProj + (ctx.currentTime - this.segCtx)
      const nextBar = Math.ceil((proj + 0.005) / barSec) * barSec
      when = this.ctxAt(nextBar)
    }
    if (kind === 'loop') {
      src.loop = true
      src.loopStart = 0
      // Project at another tempo than the library: the preview runs at the project's speed
      // (a slight pitch change, audition only; clips in the project are sliced instead).
      const loopBpm = ((bars ?? 1) * BEATS_PER_BAR * 60) / buffer.duration
      if (Math.abs(loopBpm - p.bpm) > 0.01) src.playbackRate.value = p.bpm / loopBpm
      src.loopEnd = buffer.duration
    }
    src.connect(this.out())
    src.onended = () => {
      if (this.auditionSrc === src) {
        this.auditionSrc = null
        onEnd()
      }
    }
    src.start(when)
    this.auditionSrc = src
    return true
  }

  stopAudition(): void {
    if (this.auditionSrc) {
      const s = this.auditionSrc
      this.auditionSrc = null
      try {
        s.stop()
      } catch {
        // already stopped
      }
    }
  }
}

export const playback = new PlaybackEngine()
