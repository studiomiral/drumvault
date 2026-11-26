// Vocal Enhance (SCOPE.md §6.11c): a dry vocal given body, glue and a space, as a producer would
// on a vocal bus. Plain Web Audio (no plugin), in the Vocal lane's chain, so playback and the
// exported Vocal.wav are the same.
//
// lane gain → [lane EQ] → body / box / presence / air → [lane comp, pushed] → saturation (parallel) → trim → lane duck
//                                                                                    ├→ plate send → plate ──────→ lane duck
//                                                                                    └→ delay send → delay → ducker → lane duck
//
// The ducker turns the echoes down while the dry vocal sings (its level from the bus detector's
// worklet), so the repeats come out in the gaps. graph.ts wires the chain and sets its nodes.

import { COMP_ROLES, RENDER_PUNCH_DB } from '../generate/comp'
import type { EqBand, LaneComp, LaneEnhance } from '../types/project'
import { gainComputer, type CompParams } from './compressor'
import { createEcho, createReverb, type Echo, type Reverb } from './reverb'

/** What a new Vocal lane gets, and what the popup's double-click goes back to. */
export const ENHANCE_DEFAULTS: LaneEnhance = { amount: 1, beef: 0.5, comp: 0.5, saturation: 0.4, reverb: 0.4, delay: 0.35, delayTime: '1/8d' }
/** The Amount slider's top: every part half as much again as set. */
export const ENHANCE_MAX_AMOUNT = 1.5

export interface EnhanceLevels {
  beef: number
  comp: number
  saturation: number
  reverb: number
  delay: number
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo))

/** Each part as it works (its setting times the amount, 0…1.5); null when Enhance is off or not on the lane. */
export function enhanceLevels(e: LaneEnhance | undefined): EnhanceLevels | null {
  if (!e || e.off) return null
  const a = clamp(e.amount, 0, ENHANCE_MAX_AMOUNT)
  const k = (v: number) => clamp(v, 0, 1) * a
  return { beef: k(e.beef), comp: k(e.comp), saturation: k(e.saturation), reverb: k(e.reverb), delay: k(e.delay) }
}

// ---------------------------------------------------------------------------
// Beef: chest, less box, presence and air, per unit of `beef`
// ---------------------------------------------------------------------------

const BODY = { freq: 200, q: 0.9, db: 3.5 }
const BOX = { freq: 500, q: 1.4, db: -1.5 }
const PRESENCE = { freq: 3200, q: 0.9, db: 1.5 }
const AIR = { freq: 10_000, db: 2.5 }
/** The boosts make it louder: this much is taken back (dB per unit), so the balance stands. */
const BEEF_TRIM_DB = -1.2

/** The beef's four bands (always four, so the nodes stay: only their gains move). */
export function beefBands(beef: number): EqBand[] {
  return [
    { type: 'peaking', freq: BODY.freq, gainDb: BODY.db * beef, q: BODY.q },
    { type: 'peaking', freq: BOX.freq, gainDb: BOX.db * beef, q: BOX.q },
    { type: 'peaking', freq: PRESENCE.freq, gainDb: PRESENCE.db * beef, q: PRESENCE.q },
    { type: 'highshelf', freq: AIR.freq, gainDb: AIR.db * beef, q: 0 },
  ]
}

export const beefTrimDb = (beef: number): number => BEEF_TRIM_DB * beef

// ---------------------------------------------------------------------------
// Compression: the lane's own compressor pushed harder
// ---------------------------------------------------------------------------

const VOCAL = COMP_ROLES.vocal!
/** A Vocal lane without a compressor of its own: the vocal's, from what vocals measure (comp.ts). */
const FALLBACK_THRESHOLD_DB = (RENDER_PUNCH_DB.vocal ?? -13.5) + VOCAL.overDb
/** Per unit of compression: the threshold this much lower, the ratio this much higher. */
const PUSH_THRESHOLD_DB = 6
const PUSH_RATIO = 2.5
/** Of what the push takes off at the phrase's loudest, this share is given back (most of it is quieter). */
const PUSH_MAKEUP_SHARE = 0.7

/**
 * The lane's compressor with Enhance's compression on top: its threshold lower and its ratio
 * higher, the extra it takes off at the phrase's loudest given back. One switched off (or none)
 * starts from the vocal's threshold at a ratio of 1. No compression: the compressor as it is.
 */
export function enhancedComp(base: LaneComp | undefined, comp: number): LaneComp | undefined {
  if (!(comp > 0)) return base
  const on = !!base && !base.off && base.ratio > 1
  const t0 = base?.thresholdDb ?? FALLBACK_THRESHOLD_DB
  const r0 = on ? base!.ratio : 1
  const m0 = on ? base!.makeupDb : 0
  const knee = base?.kneeDb ?? VOCAL.kneeDb
  // Where the phrase is loudest (its punch: the threshold was set this far under it).
  const punch = t0 - VOCAL.overDb
  const thresholdDb = t0 - PUSH_THRESHOLD_DB * comp
  const ratio = r0 + PUSH_RATIO * comp
  const extra = gainComputer(punch, t0, r0, knee) - gainComputer(punch, thresholdDb, ratio, knee)
  return {
    thresholdDb: Math.round(thresholdDb * 10) / 10, ratio: Math.round(ratio * 100) / 100, kneeDb: knee,
    attackMs: base?.attackMs ?? VOCAL.attackMs, releaseBeats: base?.releaseBeats ?? VOCAL.releaseBeats,
    ...(base?.detectMs ? { detectMs: base.detectMs } : {}),
    makeupDb: Math.round((m0 + PUSH_MAKEUP_SHARE * extra) * 10) / 10,
  }
}

// ---------------------------------------------------------------------------
// Saturation: a soft, slightly lopsided tanh (the even harmonics of tape), mixed in parallel
// ---------------------------------------------------------------------------

/** Drive at saturation 0 and per unit. */
const SAT_DRIVE = { from: 1, per: 5 }
/** The saturated share of the sound per unit (and at most). */
const SAT_MIX = { per: 0.6, max: 0.75 }
/** The curve leans this far (in input) to one side: even harmonics, warmer than a symmetric clip. */
const SAT_BIAS = 0.05
/** A sound at this level (about −12 dBFS, a sung phrase) comes out as loud as it went in. */
const SAT_REF = 0.25
/** Points of the curve (odd: silence lands on its middle point). */
const SAT_POINTS = 2049
/** The lean adds a little DC: taken out under this (Hz). */
const SAT_DC_HZ = 20

export const satDrive = (saturation: number): number => SAT_DRIVE.from + SAT_DRIVE.per * saturation
export const satMix = (saturation: number): number => Math.min(SAT_MIX.max, SAT_MIX.per * saturation)

/** The shaper's curve at `drive`: silence stays silence, a sound at SAT_REF stays as loud, peaks round off. */
export function satCurve(drive: number, n = SAT_POINTS): Float32Array<ArrayBuffer> {
  const f = (x: number) => Math.tanh(drive * (x + SAT_BIAS)) - Math.tanh(drive * SAT_BIAS)
  const g = SAT_REF / f(SAT_REF)
  const curve = new Float32Array(n)
  for (let i = 0; i < n; i++) curve[i] = f((i / (n - 1)) * 2 - 1) * g
  return curve
}

// ---------------------------------------------------------------------------
// The plate and the delay
// ---------------------------------------------------------------------------

/** Send to the plate per unit (its return is about as loud as the dry sound at a send of 1). */
const PLATE_SEND = 0.3
/** Send to the delay per unit, and its feedback at 0 and per unit (at most). */
const ECHO_SEND = 0.3
const ECHO_FEEDBACK = { from: 0.22, per: 0.18, max: 0.5 }
/** The ducker: the echoes go down while the vocal sings over this far under its punch. */
const DUCK_UNDER_PUNCH_DB = 12
const DUCK = { ratio: 2.5, kneeDb: 6, attackMs: 5, releaseMs: 250, detectMs: 20 }

export const plateSend = (reverb: number): number => PLATE_SEND * reverb
export const echoSend = (delay: number): number => ECHO_SEND * delay
export const echoFeedback = (delay: number): number => Math.min(ECHO_FEEDBACK.max, ECHO_FEEDBACK.from + ECHO_FEEDBACK.per * delay)

/** The delay's time in seconds at `bpm`: a dotted 8th or a quarter. */
export const echoSeconds = (time: LaneEnhance['delayTime'], bpm: number): number => ((time === '1/4' ? 1 : 0.75) * 60) / bpm

/**
 * The ducker's settings: its threshold DUCK_UNDER_PUNCH_DB under where the phrase is loudest at
 * the ducker (the compressor's threshold, as set from the vocal's punch, plus the lane's volume
 * and level), so it ducks while the vocal sings and lets go in the gaps.
 */
export function echoDuckParams(base: LaneComp | undefined, laneGainDb: number): CompParams {
  const punch = (base?.thresholdDb ?? FALLBACK_THRESHOLD_DB) - VOCAL.overDb + laneGainDb
  return { thresholdDb: punch - DUCK_UNDER_PUNCH_DB, ratio: DUCK.ratio, kneeDb: DUCK.kneeDb, attackMs: DUCK.attackMs, releaseMs: DUCK.releaseMs, makeupDb: 0, detectMs: DUCK.detectMs }
}

// ---------------------------------------------------------------------------
// The nodes
// ---------------------------------------------------------------------------

export interface EnhanceNodes {
  /** Between the lane EQ and its compressor (graph.ts wires them in). */
  beef: BiquadFilterNode[]
  /** After the compressor: the saturation's input (graph.ts wires the compressor into it). */
  input: GainNode
  dry: GainNode
  shaper: WaveShaperNode
  wet: GainNode
  /** The trim, into the lane's duck and the sends. */
  output: GainNode
  plateSend: GainNode
  plate: Reverb
  echoSend: GainNode
  echo: Echo
  /** The echoes' gain: 0 plus the ducker's gain signal (1 when there is no ducker). */
  echoGain: GainNode
  ducker: AudioWorkletNode | null
  /** The drive the shaper's curve was made for. */
  drive: number
}

/** A plate: bright, a second and a half, a little pre-delay so the words stay in front. */
export const PLATE_KIND = 'plate' as const

/** Enhance's nodes returning into `dest` (the lane's duck); the beef and `input` are left for graph.ts to wire. */
export function createEnhance(ctx: BaseAudioContext, dest: AudioNode): EnhanceNodes {
  const beef = beefBands(0).map((b) => {
    const f = ctx.createBiquadFilter()
    f.type = b.type
    f.frequency.value = b.freq
    f.Q.value = b.q
    f.gain.value = 0
    return f
  })
  for (let i = 0; i + 1 < beef.length; i++) beef[i].connect(beef[i + 1])
  const input = ctx.createGain()
  const dry = ctx.createGain()
  const shaper = ctx.createWaveShaper()
  shaper.oversample = '4x'
  const dc = ctx.createBiquadFilter()
  dc.type = 'highpass'
  dc.frequency.value = SAT_DC_HZ
  dc.Q.value = 0.7
  const wet = ctx.createGain()
  wet.gain.value = 0
  const output = ctx.createGain()
  input.connect(dry).connect(output)
  input.connect(shaper).connect(dc).connect(wet).connect(output)
  output.connect(dest)
  const plateSend = ctx.createGain()
  plateSend.gain.value = 0
  const echoSend = ctx.createGain()
  echoSend.gain.value = 0
  const echoGain = ctx.createGain()
  echoGain.gain.value = 1
  echoGain.connect(dest)
  output.connect(plateSend)
  output.connect(echoSend)
  const nodes: EnhanceNodes = {
    beef, input, dry, shaper, wet, output, plateSend, echoSend, echoGain, ducker: null, drive: 0,
    plate: createReverb(ctx, dest, PLATE_KIND), echo: createEcho(ctx, echoGain),
  }
  plateSend.connect(nodes.plate.input)
  echoSend.connect(nodes.echo.input)
  return nodes
}

/** The ducker on the echoes (once the worklet is loaded): the dry vocal in, its gain onto the echoes. */
export function attachDucker(nodes: EnhanceNodes, ducker: AudioWorkletNode): void {
  nodes.ducker = ducker
  nodes.echoGain.gain.value = 0
  nodes.output.connect(ducker)
  ducker.connect(nodes.echoGain.gain)
}

/** The plate and the delay made again (stop: their tails end), wired as they were. */
export function renewTails(ctx: BaseAudioContext, nodes: EnhanceNodes, dest: AudioNode): void {
  const time = nodes.echo.delay.delayTime.value
  const feedback = nodes.echo.feedback.gain.value
  nodes.plate.output.disconnect()
  nodes.plateSend.disconnect()
  nodes.echo.output.disconnect()
  nodes.echo.feedback.disconnect()
  nodes.echoSend.disconnect()
  nodes.plate = createReverb(ctx, dest, PLATE_KIND)
  nodes.echo = createEcho(ctx, nodes.echoGain)
  nodes.echo.delay.delayTime.value = time
  nodes.echo.feedback.gain.value = feedback
  nodes.plateSend.connect(nodes.plate.input)
  nodes.echoSend.connect(nodes.echo.input)
}

/** Every node of Enhance let go (it was switched off): graph.ts wires the lane's chain without it. */
export function dropEnhance(nodes: EnhanceNodes): void {
  for (const n of [...nodes.beef, nodes.input, nodes.dry, nodes.shaper, nodes.wet, nodes.output, nodes.plateSend, nodes.echoSend,
    nodes.plate.output, nodes.echo.output, nodes.echo.feedback, nodes.echoGain, ...(nodes.ducker ? [nodes.ducker] : [])]) n.disconnect()
}
