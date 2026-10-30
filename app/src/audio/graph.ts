// Plays scheduled events into a Web Audio graph. Used by live playback and (Phase 4)
// offline export with an OfflineAudioContext, so both render identically.
//
// source → [clip filter] → clip gain → lane gain → lane duck (sidechain) → lane pan → master
//                                    ↘ [reverb send → lane reverb] ↗ (into lane gain)

import { dbToGain } from '../lib/project'
import type { Lane } from '../types/project'
import { createReverb, type Reverb } from './reverb'
import { fadeAt, fadeBreakpoints, type ScheduledEvent } from './schedule'

export interface LaneNodes {
  gain: GainNode
  /** Sidechain ducking under the kick (unity unless the lane has `duck`). */
  duck: GainNode
  pan: StereoPannerNode
  /** The lane's reverb, made when a clip first sends to it. */
  verb?: Reverb
}

/** The lane's reverb (made on first use). */
export function laneVerb(ctx: BaseAudioContext, nodes: LaneNodes): Reverb {
  nodes.verb ??= createReverb(ctx, nodes.gain)
  return nodes.verb
}

/** Drop the lane's reverb and whatever tail it still rings (stop): the next send makes a new one. */
export function dropVerb(nodes: LaneNodes): void {
  nodes.verb?.output.disconnect()
  nodes.verb = undefined
}

export function createLaneNodes(ctx: BaseAudioContext, dest: AudioNode): LaneNodes {
  const gain = ctx.createGain()
  // Upmix to stereo before the panner: StereoPannerNode applies an equal-power law to mono
  // input (-3 dB in each channel at centre) but passes stereo through at unity. Mono
  // one-shots and stereo loops must come out at the level they have in the library.
  gain.channelCount = 2
  gain.channelCountMode = 'explicit'
  gain.channelInterpretation = 'speakers'
  const duck = ctx.createGain()
  const pan = ctx.createStereoPanner()
  gain.connect(duck).connect(pan).connect(dest)
  return { gain, duck, pan }
}

/**
 * Sidechain: duck a lane by `depth` (0…1) on a kick at `when`, reaching full depth 4 ms later
 * and recovering linearly over `release` seconds.
 */
export function duckAt(nodes: LaneNodes, when: number, depth: number, release: number): void {
  const g = nodes.duck.gain
  g.setValueAtTime(1, Math.max(0, when - 0.004))
  g.linearRampToValueAtTime(1 - Math.max(0, Math.min(1, depth)), when)
  g.linearRampToValueAtTime(1, when + release)
}

/** Drop any ducking still scheduled (stop / restart). */
export function resetDuck(nodes: LaneNodes, at: number): void {
  nodes.duck.gain.cancelScheduledValues(at)
  nodes.duck.gain.setValueAtTime(1, at)
}

/** Lane volume/pan/mute (solo is applied by the caller via `audible`). */
export function applyLane(nodes: LaneNodes, lane: Lane, audible: boolean, at = 0): void {
  nodes.gain.gain.setTargetAtTime(audible ? dbToGain(lane.volumeDb) : 0, at, 0.01)
  nodes.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, lane.pan)), at, 0.01)
}

/** A lane is audible unless muted, or some lane is soloed and this one isn't. */
export function laneAudible(lane: Lane, lanes: Lane[]): boolean {
  if (lane.mute) return false
  return !lanes.some((l) => l.solo) || lane.solo
}

/**
 * Start one event on its lane. `when` is the context time of `ev.start`; `cutAt` (context time)
 * optionally ends the sound early (loop-region wrap).
 *
 * Start times and offsets are snapped to whole sample frames: Chromium interpolates
 * (and slightly dulls) sounds that start between two samples, so snapping keeps every
 * hit a bit-exact copy of the library sample, at most half a sample from the grid.
 */
export function playEvent(ctx: BaseAudioContext, ev: ScheduledEvent, buffer: AudioBuffer, lane: LaneNodes,
                          when: number, cutAt?: number): AudioBufferSourceNode | null {
  const sr = ctx.sampleRate
  when = Math.round(when * sr) / sr
  const offset = Math.round(Math.max(0, ev.offset) * buffer.sampleRate) / buffer.sampleRate
  if (offset >= buffer.duration) return null
  // `duration` is project time; a pitched event plays `rate` seconds of the buffer per second.
  const rate = ev.rate ?? 1
  let duration = ev.duration ?? (buffer.duration - offset) / rate
  if (cutAt != null) duration = Math.min(duration, cutAt - when)
  if (duration <= 0) return null
  const src = ctx.createBufferSource()
  src.buffer = buffer
  if (rate !== 1) src.playbackRate.value = rate
  const g = ctx.createGain()
  g.gain.value = ev.gain
  let head: AudioNode = g
  if (ev.declick && duration > 0.006) {
    // Tempo slices: 1 ms in, 3 ms out, so cutting a loop into 16ths doesn't click.
    const d = ctx.createGain()
    d.gain.setValueAtTime(0, when)
    d.gain.linearRampToValueAtTime(1, when + 0.001)
    d.gain.setValueAtTime(1, when + duration - 0.003)
    d.gain.linearRampToValueAtTime(0, when + duration)
    d.connect(g)
    head = d
  }
  if (ev.fade) {
    // Clip fades: gain ramps between the fade's corner points (in project time from ev.start).
    const pts = fadeBreakpoints(ev.fade, ev.start, ev.start + duration)
    pts.forEach((t, i) => {
      const v = ev.gain * fadeAt(ev.fade!, t)
      if (i === 0) g.gain.setValueAtTime(v, when)
      else g.gain.linearRampToValueAtTime(v, when + (t - ev.start))
    })
  }
  if (ev.filter) {
    const f = ctx.createBiquadFilter()
    f.type = ev.filter.type
    f.Q.value = ev.filter.q
    f.frequency.setValueAtTime(ev.filter.f0, when)
    if (ev.filter.f1 !== ev.filter.f0) f.frequency.exponentialRampToValueAtTime(ev.filter.f1, when + duration)
    src.connect(f).connect(head)
  } else {
    src.connect(head)
  }
  g.connect(lane.gain)
  if (ev.verb?.some((v) => v > 0)) {
    // Reverb build: the send follows the clip's curve over the event (after its fades).
    const s = ctx.createGain()
    if (ev.verb.length === 1) s.gain.value = ev.verb[0]
    else {
      s.gain.value = ev.verb[0]
      s.gain.setValueCurveAtTime(Float32Array.from(ev.verb), when, Math.max(1e-3, ev.duration ?? duration))
    }
    g.connect(s).connect(laneVerb(ctx, lane).input)
  }
  src.start(when, offset, duration * rate)  // Web Audio's duration is buffer time
  return src
}
