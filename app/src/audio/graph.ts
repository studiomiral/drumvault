// Plays scheduled events into a Web Audio graph. Used by live playback and (Phase 4)
// offline export with an OfflineAudioContext, so both render identically.
//
// source → [clip filter] → [loop crossfade] → clip gain → lane gain → [lane EQ] → [lane comp] → lane duck (sidechain) → lane pan → [mono low end] → tail → [bus gain] → master
//                                    ↘ [reverb send → lane reverb] ↗ (into lane gain)
// A drum bus lane's tail also feeds the bus's detector (live), whose gain drives every bus lane's bus gain.

/// <reference types="vite/client" />
import { dbToGain } from '../lib/project'
import type { EqBand, Lane, Project } from '../types/project'
import { BUS_NODE, COMP_NODE, DETECT_MS, type CompParams } from './compressor'
import compWorkletUrl from './compressor.worklet.ts?worker&url'
import { createEcho, createReverb, type Echo, type Reverb } from './reverb'
import { fadeAt, fadeBreakpoints, type ScheduledEvent } from './schedule'

export interface LaneNodes {
  gain: GainNode
  /** Sidechain ducking under the kick (unity unless the lane has `duck`). */
  duck: GainNode
  pan: StereoPannerNode
  /** The lane's EQ bands, between its gain and its duck (none: straight through). */
  eq: BiquadFilterNode[]
  /** The bands' shape the EQ nodes were made for (types in order), to rebuild only when it changes. */
  eqShape: string
  /** The lane's reverb, made when a clip first sends to it: the hall, or a short room when `room` is set. */
  verb?: Reverb
  room?: boolean
  /** The lane's delay, made when a clip first throws to it. */
  echo?: Echo
  /** The lane's compressor, after its EQ (made when the lane gets one; left in place, set to do nothing, when it goes). */
  comp?: AudioWorkletNode
  /** The end of the lane's own chain (its pan and mono low end play into it). */
  out: GainNode
  /** Where the lane plays into (the master). */
  dest: AudioNode
  /** On the drum bus: the gain the bus drives (its value 0, the bus's gain signal added to it), what drives it, and the bus's detector it feeds. */
  bus?: { gain: GainNode; drive: AudioNode; tap?: AudioNode }
  /** The lane's mono low end: the crossover's filters (lows, then highs) and the Hz they were made for. */
  mono?: { hz: number; low: BiquadFilterNode[]; high: BiquadFilterNode[]; sum: GainNode }
}

/** The lane's reverb (made on first use). */
export function laneVerb(ctx: BaseAudioContext, nodes: LaneNodes): Reverb {
  nodes.verb ??= createReverb(ctx, nodes.gain, nodes.room ? 'room' : 'hall')
  return nodes.verb
}

/** The lane's delay (made on first use), set to repeat every `time` seconds, `feedback` of each repeat coming round again. */
export function laneEcho(ctx: BaseAudioContext, nodes: LaneNodes, time: number, feedback: number): Echo {
  nodes.echo ??= createEcho(ctx, nodes.gain)
  if (nodes.echo.delay.delayTime.value !== time) nodes.echo.delay.delayTime.value = time
  nodes.echo.feedback.gain.value = Math.max(0, Math.min(0.9, feedback))
  return nodes.echo
}

/** Drop the lane's reverb and whatever tail it still rings (stop): the next send makes a new one. */
export function dropVerb(nodes: LaneNodes): void {
  nodes.verb?.output.disconnect()
  nodes.verb = undefined
  // (The delay's echoes stop with it.)
  nodes.echo?.output.disconnect()
  nodes.echo?.feedback.disconnect()
  nodes.echo = undefined
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
  const out = ctx.createGain()
  gain.connect(duck).connect(pan).connect(out).connect(dest)
  return { gain, duck, pan, eq: [], eqShape: '', out, dest }
}

/** Which reverb the lane sends to: a reverb made as the other kind is dropped (the next send makes the right one). */
export function setLaneRoom(nodes: LaneNodes, room: boolean): void {
  if (!!nodes.room === room) return
  nodes.room = room
  nodes.verb?.output.disconnect()
  nodes.verb = undefined
}

/** A Butterworth biquad's Q as Web Audio takes it for low- and high-passes (dB). */
const BUTTERWORTH_Q_DB = -3.01

/**
 * The lane's low end below `hz` summed to mono (none: stereo all the way down), after its pan: a
 * 4th-order Linkwitz-Riley crossover (two Butterworth filters each way: together they add up flat),
 * the lows mixed to mono and fed to both sides, the highs as they are. New nodes only when it is
 * switched on or off.
 */
export function setLaneMono(ctx: BaseAudioContext, nodes: LaneNodes, hz: number | undefined): void {
  if (!hz) {
    if (!nodes.mono) return
    nodes.pan.disconnect()
    for (const n of [...nodes.mono.low, ...nodes.mono.high, nodes.mono.sum]) n.disconnect()
    nodes.mono = undefined
    nodes.pan.connect(nodes.out)
    return
  }
  if (!nodes.mono) {
    const pass = (type: 'lowpass' | 'highpass') => [0, 1].map(() => {
      const f = ctx.createBiquadFilter()
      f.type = type
      f.Q.value = BUTTERWORTH_Q_DB
      return f
    })
    const low = pass('lowpass')
    const high = pass('highpass')
    // Stereo in, one channel out (the two sides averaged); the master upmixes it to both sides.
    const sum = ctx.createGain()
    sum.channelCount = 1
    sum.channelCountMode = 'explicit'
    sum.channelInterpretation = 'speakers'
    nodes.pan.disconnect()
    nodes.pan.connect(low[0]).connect(low[1]).connect(sum).connect(nodes.out)
    nodes.pan.connect(high[0]).connect(high[1]).connect(nodes.out)
    nodes.mono = { hz: 0, low, high, sum }
  }
  if (nodes.mono.hz !== hz) {
    for (const f of [...nodes.mono.low, ...nodes.mono.high]) f.frequency.value = hz
    nodes.mono.hz = hz
  }
}

/** The lane's gain → its EQ bands → its compressor (if it has one) → its duck, wired again. */
function wireChain(nodes: LaneNodes): void {
  nodes.gain.disconnect()
  for (const f of nodes.eq) f.disconnect()
  nodes.comp?.disconnect()
  let at: AudioNode = nodes.gain
  for (const f of nodes.eq) at = at.connect(f)
  if (nodes.comp) at = at.connect(nodes.comp)
  at.connect(nodes.duck)
}

/** The lane's EQ as `bands` (none: bypassed): new nodes only when the bands' shape changes. */
export function setLaneEq(ctx: BaseAudioContext, nodes: LaneNodes, bands: EqBand[]): void {
  const shape = bands.map((b) => b.type).join(',')
  if (shape !== nodes.eqShape) {
    nodes.eq = bands.map((b) => {
      const f = ctx.createBiquadFilter()
      f.type = b.type
      return f
    })
    nodes.eqShape = shape
    wireChain(nodes)
  }
  bands.forEach((b, i) => {
    const f = nodes.eq[i]
    f.frequency.value = b.freq
    f.gain.value = b.gainDb
    f.Q.value = b.q
  })
}

const compLoads = new WeakMap<BaseAudioContext, Promise<boolean>>()
const compLoaded = new WeakSet<BaseAudioContext>()

/**
 * Load the lane compressor's worklet into `ctx` (once per context): before the lanes are made, so
 * a compressed lane has its compressor from its first sound. False when it couldn't be loaded
 * (the lanes then play without one).
 */
export function loadComp(ctx: BaseAudioContext): Promise<boolean> {
  let p = compLoads.get(ctx)
  if (!p) {
    p = Promise.resolve()
      .then(() => ctx.audioWorklet.addModule(compWorkletUrl))
      .then(() => { compLoaded.add(ctx); return true })
      .catch((e) => { console.error('the lane compressor could not be loaded', e); return false })
    compLoads.set(ctx, p)
  }
  return p
}

/**
 * The lane's compressor as `p` (null: none). Its node is made the first time the lane gets one
 * (once `loadComp` has loaded it into the context) and stays; without one it is set to do nothing.
 */
export function setLaneComp(ctx: BaseAudioContext, nodes: LaneNodes, p: CompParams | null): void {
  if (!nodes.comp) {
    if (!p || !compLoaded.has(ctx)) return
    nodes.comp = new AudioWorkletNode(ctx, COMP_NODE, {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
    })
    wireChain(nodes)
  }
  setCompParams(nodes.comp, p)
}

/** A compressor worklet's (or the bus detector's) settings; null: doing nothing. */
function setCompParams(node: AudioWorkletNode, p: CompParams | null): void {
  const set = (name: string, v: number) => {
    // (AudioParamMap is a read-only Map; TypeScript's DOM library leaves its methods out.)
    const a = (node.parameters as unknown as ReadonlyMap<string, AudioParam>).get(name)
    if (a && a.value !== v) a.value = v
  }
  const q = p ?? { thresholdDb: 0, ratio: 1, kneeDb: 0, attackMs: 10, releaseMs: 100, makeupDb: 0, detectMs: DETECT_MS }
  set('threshold', q.thresholdDb)
  set('ratio', q.ratio)
  set('knee', q.kneeDb)
  set('attack', q.attackMs)
  set('release', q.releaseMs)
  set('makeup', q.makeupDb)
  set('detect', q.detectMs ?? DETECT_MS)
}

/**
 * The drum bus's detector (null until `loadComp` has loaded the worklet): the bus lanes' sum in,
 * the gain out (one channel), which drives every bus lane's bus gain.
 */
export function createBusDetector(ctx: BaseAudioContext): AudioWorkletNode | null {
  if (!compLoaded.has(ctx)) return null
  return new AudioWorkletNode(ctx, BUS_NODE, {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
  })
}

/** The bus detector set as the project's drum bus (off or none: a gain of 1). */
export function setBusDetector(node: AudioWorkletNode, project: Project): void {
  setCompParams(node, busParams(project))
}

/** What the drum bus works with at the project's tempo (null: none, or off). */
export function busParams(project: Project): CompParams | null {
  const b = project.drumBus
  if (!b || b.off || !(b.ratio > 1)) return null
  return {
    thresholdDb: b.thresholdDb, ratio: b.ratio, kneeDb: b.kneeDb, attackMs: b.attackMs,
    releaseMs: (b.releaseBeats * 60_000) / project.bpm, makeupDb: b.makeupDb, detectMs: b.detectMs,
  }
}

/** Whether the project's drum bus works on this lane (a bus lane, the bus on). */
export const onBus = (lane: Lane, project: Project): boolean => !!lane.bus && !!busParams(project)

/**
 * The lane on the drum bus or off it: on it, its tail plays through a gain that `drive` (the bus's
 * gain signal) sets, and feeds `tap` (the detector, live; none in an export, whose gain comes
 * rendered). New connections only when that changes.
 */
export function setLaneBus(nodes: LaneNodes, bus: { drive: AudioNode; tap?: AudioNode } | null): void {
  const was = nodes.bus
  if (was && bus && was.drive === bus.drive && was.tap === bus.tap) return
  if (!was && !bus) return
  nodes.out.disconnect()
  if (was) {
    was.drive.disconnect(was.gain.gain)
    was.gain.disconnect()
  }
  nodes.bus = undefined
  if (!bus) {
    nodes.out.connect(nodes.dest)
    return
  }
  const gain = nodes.out.context.createGain()
  gain.gain.value = 0
  bus.drive.connect(gain.gain)
  nodes.out.connect(gain).connect(nodes.dest)
  if (bus.tap) nodes.out.connect(bus.tap)
  nodes.bus = { gain, drive: bus.drive, tap: bus.tap }
}

/**
 * What a lane's compressor works with (null: none, or off) at `bpm`: its threshold where the
 * lane's sound is at that point (after its volume and its level in the mix), its release in ms.
 */
export function laneCompParams(lane: Lane, bpm: number): CompParams | null {
  const c = lane.comp
  if (!c || c.off || !(c.ratio > 1)) return null
  return {
    thresholdDb: c.thresholdDb + lane.volumeDb + (lane.levelDb ?? 0),
    ratio: c.ratio, kneeDb: c.kneeDb, attackMs: c.attackMs,
    releaseMs: (c.releaseBeats * 60_000) / bpm, makeupDb: c.makeupDb, detectMs: c.detectMs,
  }
}

/** The bands a lane plays through (its EQ unless it's off). */
export const laneEqBands = (lane: Lane): EqBand[] => (lane.eq && !lane.eq.off ? lane.eq.bands : [])

/** A lane's gain (dB) before its duck: its volume, its level in the mix and its EQ's makeup. */
export const laneGainDb = (lane: Lane): number => lane.volumeDb + (lane.levelDb ?? 0) + (lane.eq && !lane.eq.off ? lane.eq.gainDb : 0)

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

/** Lane volume/pan/mute, EQ and compressor (solo is applied by the caller via `audible`). */
export function applyLane(nodes: LaneNodes, lane: Lane, audible: boolean, bpm: number, at = 0): void {
  nodes.gain.gain.setTargetAtTime(audible ? dbToGain(laneGainDb(lane)) : 0, at, 0.01)
  setLaneEq(nodes.gain.context, nodes, laneEqBands(lane))
  setLaneComp(nodes.gain.context, nodes, laneCompParams(lane, bpm))
  setLaneMono(nodes.gain.context, nodes, lane.monoBelow)
  setLaneRoom(nodes, !!lane.room)
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
  const xf = ev.crossfade ?? 0
  // A seamless loop's repetition plays on round the loop: its offset may come round too.
  let offset = Math.round(Math.max(0, ev.offset) * buffer.sampleRate) / buffer.sampleRate
  if (xf) offset %= buffer.duration
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
  // A filtered loop starts that much earlier, silent: its new filter has settled when it's heard
  // (one started on the beat would pass the wave's jump from silence as a click). Not in the past.
  const pre = xf && ev.filter ? Math.max(0, Math.min(FILTER_PREROLL_S, Math.floor((when - ctx.currentTime - 0.005) * sr) / sr)) : 0
  if (xf) {
    // Crossfade: in over `xf` from the start, out over `xf` past the end (the loop goes on round).
    src.loop = true
    const d = ctx.createGain()
    // Silent until the first ramp, also on a first frame the source plays before `when` by rounding.
    d.gain.value = 0
    d.gain.setValueAtTime(0, when - pre)
    d.gain.setValueAtTime(0, when)
    d.gain.linearRampToValueAtTime(1, when + xf)
    d.gain.setValueAtTime(1, when + duration)
    d.gain.linearRampToValueAtTime(0, when + duration + xf)
    d.connect(g)
    head = d
  } else if (ev.declick && duration > 0.006) {
    // Tempo slices: 1 ms in, 3 ms out, so cutting a loop into 16ths doesn't click.
    const d = ctx.createGain()
    d.gain.setValueAtTime(0, when)
    d.gain.linearRampToValueAtTime(1, when + 0.001)
    d.gain.setValueAtTime(1, when + duration - 0.003)
    d.gain.linearRampToValueAtTime(0, when + duration)
    d.connect(g)
    head = d
  } else if (ev.release && duration > ev.release) {
    // A gated hit: full until its release, then out by its end.
    const d = ctx.createGain()
    d.gain.setValueAtTime(1, when)
    d.gain.setValueAtTime(1, when + duration - ev.release)
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
    f.frequency.setValueAtTime(ev.filter.f0, when - pre)
    f.frequency.setValueAtTime(ev.filter.f0, when)
    if (ev.filter.f1 !== ev.filter.f0) f.frequency.exponentialRampToValueAtTime(ev.filter.f1, when + duration)
    src.connect(f).connect(head)
  } else {
    src.connect(head)
  }
  let out: AudioNode = g
  if (ev.gainEnd != null && ev.gainEnd !== 1) {
    // Volume ride: from the event's gain to `gainEnd` of it, evenly in dB (an exponential ramp).
    const r = ctx.createGain()
    r.gain.setValueAtTime(1, when)
    r.gain.exponentialRampToValueAtTime(Math.max(1e-4, ev.gainEnd), when + Math.max(1e-3, ev.duration ?? duration))
    g.connect(r)
    out = r
  }
  out.connect(lane.gain)
  if (ev.verb?.some((v) => v > 0)) {
    // Reverb build: the send follows the clip's curve over the event (after its fades).
    const s = ctx.createGain()
    if (ev.verb.length === 1) s.gain.value = ev.verb[0]
    else {
      s.gain.value = ev.verb[0]
      s.gain.setValueCurveAtTime(Float32Array.from(ev.verb), when, Math.max(1e-3, ev.duration ?? duration))
    }
    out.connect(s).connect(laneVerb(ctx, lane).input)
  }
  if (ev.echo && ev.echo.send > 0) {
    // Delay throw: the sound sent to the lane's delay, which repeats it.
    const s = ctx.createGain()
    s.gain.value = ev.echo.send
    out.connect(s).connect(laneEcho(ctx, lane, ev.echo.time, ev.echo.feedback).input)
  }
  if (pre) {
    // Round the loop back from the offset, by whole frames.
    const back = ((offset - pre) % buffer.duration + buffer.duration) % buffer.duration
    src.start(when - pre, Math.round(back * buffer.sampleRate) / buffer.sampleRate, (pre + duration + xf) * rate)
  } else {
    src.start(when, offset, (duration + xf) * rate)  // Web Audio's duration is buffer time
  }
  return src
}

/** How long a filtered seamless loop plays silent before it's heard, for its filter to settle (seconds). */
const FILTER_PREROLL_S = 0.05
