// Plays scheduled events into a Web Audio graph. Used by live playback and (Phase 4)
// offline export with an OfflineAudioContext, so both render identically.
//
// source → [clip filter] → clip gain → lane gain → lane pan → master → destination

import { dbToGain } from '../lib/project'
import type { Lane } from '../types/project'
import type { ScheduledEvent } from './schedule'

export interface LaneNodes {
  gain: GainNode
  pan: StereoPannerNode
}

export function createLaneNodes(ctx: BaseAudioContext, dest: AudioNode): LaneNodes {
  const gain = ctx.createGain()
  // Upmix to stereo before the panner: StereoPannerNode applies an equal-power law to mono
  // input (-3 dB in each channel at centre) but passes stereo through at unity. Mono
  // one-shots and stereo loops must come out at the level they have in the library.
  gain.channelCount = 2
  gain.channelCountMode = 'explicit'
  gain.channelInterpretation = 'speakers'
  const pan = ctx.createStereoPanner()
  gain.connect(pan).connect(dest)
  return { gain, pan }
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
 * Start one event. `when` is the context time of `ev.start`; `cutAt` (context time)
 * optionally ends the sound early (loop-region wrap).
 *
 * Start times and offsets are snapped to whole sample frames: Chromium interpolates
 * (and slightly dulls) sounds that start between two samples, so snapping keeps every
 * hit a bit-exact copy of the library sample, at most half a sample from the grid.
 */
export function playEvent(ctx: BaseAudioContext, ev: ScheduledEvent, buffer: AudioBuffer, dest: AudioNode,
                          when: number, cutAt?: number): AudioBufferSourceNode | null {
  const sr = ctx.sampleRate
  when = Math.round(when * sr) / sr
  const offset = Math.round(Math.max(0, ev.offset) * buffer.sampleRate) / buffer.sampleRate
  if (offset >= buffer.duration) return null
  let duration = ev.duration ?? buffer.duration - offset
  if (cutAt != null) duration = Math.min(duration, cutAt - when)
  if (duration <= 0) return null
  const src = ctx.createBufferSource()
  src.buffer = buffer
  const g = ctx.createGain()
  g.gain.value = ev.gain
  if (ev.filter) {
    const f = ctx.createBiquadFilter()
    f.type = ev.filter.type
    f.Q.value = ev.filter.q
    f.frequency.setValueAtTime(ev.filter.f0, when)
    if (ev.filter.f1 !== ev.filter.f0) f.frequency.exponentialRampToValueAtTime(ev.filter.f1, when + duration)
    src.connect(f).connect(g)
  } else {
    src.connect(g)
  }
  g.connect(dest)
  src.start(when, offset, duration)
  return src
}
