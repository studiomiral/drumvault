// Chord stabs (SCOPE.md §6.9): one of the Chord Stabs page's one-shots per track, in the track
// key, in a funky 1- or 2-bar rhythm: off the kick, mostly two stabs a bar (sometimes one or
// three), learned from the rhythms saved in the Chord Stabs module's step sequencer once there
// are some.

import type { HitItem, SavedStabRhythm } from '../types/api'
import type { Velocity } from '../types/project'
import type { Rng } from './rng'

/** How funky each 16th of a bar is for a stab: the offbeat 8ths most, then the 16ths just after them. */
const STEP_WEIGHT = [0.3, 0.2, 3, 1.5, 0.3, 0.6, 2.5, 1.2, 0.3, 0.6, 3, 1.5, 0.3, 0.8, 2.5, 1]
/** Stabs in a bar: mostly two, sometimes one or three. */
const PER_BAR: [number, number][] = [[1, 2], [2, 5], [3, 2]]
/** Never closer together than this (16ths), unless saved rhythms are. */
const MIN_GAP = 2
/** Bar 2 repeats bar 1 this often (built-in rhythms). */
const REPEAT = 0.4
/** With saved rhythms: one of them as it is this often, else one learned from them. */
export const SAVED_EXACT = 0.35
/** A step no saved rhythm hits keeps this much of its built-in weight (so learned ones can surprise a little). */
const UNSEEN = 0.04

/** House stab rhythms that always work (16ths of bar 1, of bar 2). */
const CLASSICS: [number[], number[]][] = [
  [[2, 10], [2, 10]],
  [[3, 10], [6, 14]],
  [[6, 14], [6]],
  [[2, 7], [2, 10]],
  [[10, 13], [10]],
  [[3, 11], [3, 6]],
  [[6, 11], [14]],
  [[2, 14], [7, 10]],
  [[3, 6], [3, 6, 14]],
]

const bar = (hits: number[]): Velocity[] => {
  const out: Velocity[] = new Array(16).fill(0)
  for (const h of hits) out[h] = 3
  return out
}
const hitsOf = (steps: number[]) => steps.flatMap((v, i) => (v ? [i] : []))

function drawBar(rng: Rng, counts: [number, number][], weight: number[], gap: number, from: number[] = []): number[] {
  const n = Math.max(from.length, rng.weighted(counts))
  const hits: number[] = [...from]
  for (let tries = 0; hits.length < n && tries < 40; tries++) {
    const free = weight.map((w, i) => (hits.some((h) => Math.abs(h - i) < gap) ? 0 : w))
    if (!free.some((w) => w > 0)) break
    hits.push(rng.weighted(free.map((w, i) => [i, w] as [number, number])))
  }
  return hits.sort((a, b) => a - b)
}

/** Where the track's bassline plays, over two bars of 16ths: where its notes start, and where one sounds. */
export interface BassSteps {
  onset: boolean[]
  sounding: boolean[]
}

/** A bassline's notes ([start beats, length beats, …], a loop of `bars`) as two bars of 16ths (a longer loop folded onto them). */
export function bassSteps(notes: [number, number, number, number][], bars: number): BassSteps {
  const total = Math.max(1, Math.round(bars)) * 16
  const on = new Array<boolean>(total).fill(false)
  const snd = new Array<boolean>(total).fill(false)
  for (const [start, length] of notes) {
    const from = Math.round(start * 4)
    const to = Math.max(from + 1, Math.round((start + length) * 4))
    on[((from % total) + total) % total] = true
    for (let k = from; k < to; k++) snd[((k % total) + total) % total] = true
  }
  // A 1-bar loop plays in both bars; a 4-bar one is folded onto two.
  const onset = new Array<boolean>(32).fill(false)
  const sounding = new Array<boolean>(32).fill(false)
  for (let k = 0; k < Math.max(total, 32); k++) {
    if (on[k % total]) onset[k % 32] = true
    if (snd[k % total]) sounding[k % 32] = true
  }
  return { onset, sounding }
}

/** How the stabs sit against the bassline: in its rests (call and response), or on its syncopations (locked to it). */
export type StabBass = 'answer' | 'lock'

/** What a rhythm is drawn for (the track it has to fit): how many stabs a bar, and the bassline it plays against. */
export interface RhythmFit {
  perBar?: [number, number][]
  bass?: BassSteps | null
  mode?: StabBass
  /** Written as one stab loop (rule `stabLoop`): more of the classics and the saved rhythms, one anchor hit in every bar, the bassline a soft preference. */
  loop?: boolean
}

/** A stab answering the bass: this much of a step's weight where a bass note starts, where one sounds, in its rests. */
const ANSWER_ONSET = 0.08
const ANSWER_SOUNDING = 0.6
const ANSWER_REST = 1.7
/** A stab locked to the bass: this much on its off-the-beat note starts, and elsewhere. */
const LOCK_ONSET = 3
const LOCK_ELSE = 0.5

/** The same for a stab loop: the bassline leans the rhythm, it doesn't decide it (a groove first). */
const LOOP_ANSWER: [number, number, number] = [0.5, 0.85, 1.25]
const LOOP_LOCK: [number, number] = [1.8, 0.8]

/** A step's weight against the bassline (bar `b` of the two, step `i` of 16). */
function bassWeight(fit: RhythmFit | undefined, b: number, i: number): number {
  const bass = fit?.bass
  if (!bass) return 1
  const k = (b % 2) * 16 + i
  const [onset, else_] = fit!.loop ? LOOP_LOCK : [LOCK_ONSET, LOCK_ELSE]
  if (fit!.mode === 'lock') return bass.onset[k] && i % 4 !== 0 ? onset : else_
  const [on, sounding, rest] = fit!.loop ? LOOP_ANSWER : [ANSWER_ONSET, ANSWER_SOUNDING, ANSWER_REST]
  return bass.onset[k] ? on : bass.sounding[k] ? sounding : rest
}

/** A stab loop's anchor: the off-beat 8th it comes back to in every bar (weights). */
const ANCHORS: [number, number][] = [[2, 3], [10, 3], [6, 2], [14, 2]]
/** A stab loop: a classic this often (without saved rhythms), a saved rhythm as it is this often (with), bar 2 repeating bar 1 this often. */
export const LOOP_CLASSIC = 0.55
export const LOOP_SAVED_EXACT = 0.6
const LOOP_REPEAT = 0.5

/**
 * A stab rhythm (1 or 2 arrays of 16 velocities). Without saved rhythms: a classic house one, or
 * 2 bars drawn from the funky 16ths, the second the same or answering the first. With saved ones
 * (they replace the built-ins): one of them as it is, or one learned from them: as long as they
 * tend to be, as many stabs a bar, on the 16ths they hit (per bar), bar 2 repeating bar 1 as
 * often, no closer together than they get. With `fit`, a drawn or learned rhythm is written for
 * the track: as many stabs a bar as its stabs want (`perBar`), and against its bassline (in its
 * rests, or on its syncopations); a saved rhythm taken as it is stays as it is.
 */
export function stabRhythm(rng: Rng, saved: SavedStabRhythm[] = [], fit?: RhythmFit): Velocity[][] {
  const mine = saved.filter((r) => r.steps.length && r.steps.some((b) => b.some(Boolean)))
  const against = (weight: number[], b: number) => weight.map((w, i) => w * bassWeight(fit, b, i))
  if (fit?.loop && !mine.length) return loopRhythm(rng, fit, against)
  if (!mine.length) {
    // (A classic doesn't know the bassline or what the track's stabs want: only without either.)
    if (rng.chance(0.5) && !fit?.bass && (!fit?.perBar || fit.perBar === PER_BAR)) {
      const [a, b] = rng.pick(CLASSICS)
      return [bar(a), bar(b)]
    }
    const per = fit?.perBar ?? PER_BAR
    const a = drawBar(rng, per, against(STEP_WEIGHT, 0), MIN_GAP)
    // Bar 2 repeats bar 1 only where the bass does the same in both.
    const same = !fit?.bass || fit.bass.onset.slice(0, 16).join() === fit.bass.onset.slice(16).join()
    return [bar(a), bar(rng.chance(REPEAT) && same ? a : drawBar(rng, per, against(STEP_WEIGHT, 1), MIN_GAP))]
  }
  if (rng.chance(fit?.loop ? LOOP_SAVED_EXACT : SAVED_EXACT)) return rng.pick(mine).steps.map((b) => bar(hitsOf(b)))
  const bars = rng.pick(mine).steps.length > 1 ? 2 : 1
  const bars2 = mine.filter((r) => r.steps.length > 1)
  const counts = new Map<number, number>()
  for (const r of mine) for (const b of r.steps) { const n = hitsOf(b).length; if (n) counts.set(n, (counts.get(n) ?? 0) + 1) }
  const weightFor = (k: number) => {
    const w = new Array(16).fill(0)
    for (const r of mine) for (const i of hitsOf(r.steps[Math.min(k, r.steps.length - 1)])) w[i]++
    return w.map((x, i) => x || UNSEEN * STEP_WEIGHT[i])
  }
  const gaps = mine.flatMap((r) => r.steps.flatMap((b) => hitsOf(b).slice(1).map((h, j) => h - hitsOf(b)[j])))
  const gap = Math.max(1, Math.min(MIN_GAP, ...gaps))
  const per = [...counts.entries()]
  const a = drawBar(rng, per, against(weightFor(0), 0), gap)
  if (bars === 1 && !fit?.bass) return [bar(a)]
  const repeat = bars2.length ? bars2.filter((r) => hitsOf(r.steps[0]).join() === hitsOf(r.steps[1]).join()).length / bars2.length : REPEAT
  return [bar(a), bar(rng.chance(repeat) ? a : drawBar(rng, per, against(weightFor(1), 1), gap))]
}

/**
 * A built-in stab loop: a classic house rhythm (the one that sits best against the bassline), or
 * one drawn around an anchor, an off-beat 8th both bars hit, with the funky 16ths around it.
 */
function loopRhythm(rng: Rng, fit: RhythmFit, against: (w: number[], b: number) => number[]): Velocity[][] {
  if (rng.chance(LOOP_CLASSIC)) {
    const [a, b] = rng.pickBy(CLASSICS, ([x, y]) => [...x.map((i) => bassWeight(fit, 0, i)), ...y.map((i) => bassWeight(fit, 1, i))]
      .reduce((n, w) => n * Math.min(1, w), 1))
    return [bar(a), bar(b)]
  }
  const per = fit.perBar ?? PER_BAR
  const anchor = rng.weighted(ANCHORS.map(([i, w]) => [i, w * Math.min(bassWeight(fit, 0, i), bassWeight(fit, 1, i))] as [number, number]))
  const a = drawBar(rng, per, against(STEP_WEIGHT, 0), MIN_GAP, [anchor])
  const same = !fit.bass || fit.bass.onset.slice(0, 16).join() === fit.bass.onset.slice(16).join()
  return [bar(a), bar(rng.chance(LOOP_REPEAT) && same ? a : drawBar(rng, per, against(STEP_WEIGHT, 1), MIN_GAP, [anchor]))]
}

// ---------------------------------------------------------------------------
// Phrasing: accents, a leaner version, the turn at the end of a phrase
// ---------------------------------------------------------------------------

/** The rhythm with its accents: the first stab of each bar full, the ones answering it softer. */
export function accented(rhythm: Velocity[][]): Velocity[][] {
  return rhythm.map((b) => {
    let first = true
    return b.map((v) => {
      if (!v) return 0
      const out: Velocity = first ? 3 : 2
      first = false
      return out
    })
  })
}

/** The rhythm's lean version (a track's first drop, a tease): the first stab of each bar alone (`anchor`: its first on an 8th). */
export function sparse(rhythm: Velocity[][], anchor = false): Velocity[][] {
  return rhythm.map((b) => {
    const eighth = anchor ? b.findIndex((v, i) => v && i % 2 === 0) : -1
    const at = eighth >= 0 ? eighth : b.findIndex(Boolean)
    return b.map((v, i) => (i === at ? v : 0)) as Velocity[]
  })
}

/** How a phrase's last bar turns: its last stab left out, played a 16th early, or said twice. */
export type StabTurn = 'none' | 'drop' | 'push' | 'double'

/** A bar as the last of an 8-bar phrase. A bar with one stab only drops it when it has company in the phrase (never an empty turn for 'push'). */
export function turned(b: Velocity[], how: StabTurn): Velocity[] {
  const hits = hitsOf(b)
  const last = hits[hits.length - 1]
  if (how === 'none' || last == null) return [...b]
  const out = [...b]
  if (how === 'drop') {
    if (hits.length > 1) out[last] = 0
  } else if (how === 'push') {
    if (last > 0 && !out[last - 1] && !(hits.length > 1 && last - 1 - hits[hits.length - 2] < 2)) {
      out[last - 1] = out[last]
      out[last] = 0
    }
  } else if (last + 2 < 16) out[last + 2] = 2
  return out
}

/** 16ths between the closest two stabs of a rhythm (over its two bars, round the loop). */
export function closestGap(rhythm: Velocity[][]): number {
  const two = [rhythm[0], rhythm[1 % rhythm.length]]
  const at = two.flatMap((b, k) => hitsOf(b).map((i) => k * 16 + i))
  if (at.length < 2) return 32
  return Math.min(...at.map((x, i) => (at[(i + 1) % at.length] - x + 32) % 32 || 32))
}

// ---------------------------------------------------------------------------
// Which stabs: ones that fit the track, and each other
// ---------------------------------------------------------------------------

/** A stab moved this many semitones into the track key counts this much (a sampler changes a sound's character with its pitch). */
const SHIFT_WEIGHT: [number, number][] = [[2, 1], [3, 0.6], [5, 0.25], [12, 0.08]]
/** A stab is a chord from this many notes (the engine's `voices`). */
export const CHORD_VOICES = 3
/** How much a stab's tone being the tops' counts against it (it would pile onto them). */
const PILE_UP = 0.6
/** A second stab of the first one's kind (both chords, both single notes) counts this much more; a tone this much the first's, this much less. */
const SAME_KIND = 1.6
const TWIN_TONE = 0.9
const TWIN_WEIGHT = 0.2
/** Stabs in a set sit well this far apart (octaves between their tones' centres). */
const APART_OCTAVES = 0.8

/** Whether a stab is a chord (three notes or more) or a single note; null when not measured. */
export function isChord(h: Pick<HitItem, 'voices'>): boolean | null {
  return h.voices == null || h.voices <= 0 ? null : h.voices >= CHORD_VOICES
}

const linear = (tone: number[]) => tone.map((v) => 10 ** (v / 10))

/** What two tones share (0…1); null when either isn't measured. */
export function toneShare(a: number[] | null | undefined, b: number[] | null | undefined): number | null {
  if (!a?.length || !b?.length || a.length !== b.length) return null
  const pa = linear(a), pb = linear(b)
  const ta = pa.reduce((x, y) => x + y, 0), tb = pb.reduce((x, y) => x + y, 0)
  return ta > 0 && tb > 0 ? pa.reduce((n, v, i) => n + Math.min(v / ta, pb[i] / tb), 0) : null
}

/** Where a tone's weight is: the band index its power centres on (bands are evenly spaced in pitch); null unmeasured. */
function centre(tone: number[] | null | undefined): number | null {
  if (!tone?.length) return null
  const p = linear(tone)
  const total = p.reduce((x, y) => x + y, 0)
  return total > 0 ? p.reduce((n, v, i) => n + v * i, 0) / total : null
}

/** How much a stab moved `semitones` into the key counts. */
export function shiftWeight(semitones: number): number {
  const d = Math.abs(semitones)
  return (SHIFT_WEIGHT.find(([max]) => d <= max) ?? SHIFT_WEIGHT[SHIFT_WEIGHT.length - 1])[1]
}

/**
 * How well a stab fits a track, as a weight to draw it by: near the key (little pitch shift), and
 * not the tops' tone over again (`tops`: the tone of the track's top loops; it should fill what
 * they leave). With the stabs already chosen (`set`): one of their kind (chords with chords, single
 * notes with single notes), in another register, never the same sound twice.
 */
export function stabWeight(h: HitItem, shift: number, tops: number[] | null, set: HitItem[], bandsPerOctave: number): number {
  let w = shiftWeight(shift)
  const pile = toneShare(h.tone, tops)
  if (pile != null) w *= 1 - PILE_UP * pile
  for (const o of set) {
    const a = isChord(h), b = isChord(o)
    if (a != null && b != null && a === b) w *= SAME_KIND
    const twin = toneShare(h.tone, o.tone)
    if (twin != null && twin >= TWIN_TONE) w *= TWIN_WEIGHT
    const ca = centre(h.tone), cb = centre(o.tone)
    if (ca != null && cb != null) w *= 0.5 + Math.min(1, Math.abs(ca - cb) / bandsPerOctave / APART_OCTAVES)
  }
  return w
}

/**
 * How many stabs a bar the track's stabs want: single notes are a riff (two to four), long or
 * chordal ones accents (one or two, sometimes three), the rest the usual.
 */
export function perBarFor(stabs: HitItem[]): [number, number][] {
  if (!stabs.length) return PER_BAR
  const notes = stabs.filter((h) => isChord(h) === false).length
  const long = stabs.filter((h) => h.duration_s >= LONG_S).length
  if (notes > stabs.length / 2 && !long) return [[2, 3], [3, 4], [4, 2]]
  if (long > stabs.length / 2) return [[1, 4], [2, 5], [3, 1]]
  return PER_BAR
}

/** A stab rings long from this (seconds). */
const LONG_S = 0.8

/** How several stabs share the rhythm: call and response a bar each (two stabs), or hit by hit. */
export type StabTurns = 'bars' | 'hits'

/**
 * Each stab's part of the track's rhythm (bars of 16 velocities), so no two ever hit together:
 * one stab plays it all; two taking turns by bar play a bar each (the rhythm over 2 bars); else
 * the hits go round from the first, over 2 bars. `n` is capped by the hits there are (every stab
 * plays some), and turns by bar need both bars to have hits.
 */
export function stabParts(rhythm: Velocity[][], n: number, turns: StabTurns): Velocity[][][] {
  const two = [rhythm[0], rhythm[1 % rhythm.length]]
  const k = Math.max(1, Math.min(n, two.flat().filter(Boolean).length))
  if (k === 1) return [rhythm]
  const byBar = k === 2 && turns === 'bars' && two.every((b) => b.some(Boolean))
  const parts = Array.from({ length: k }, () => two.map(() => new Array<Velocity>(16).fill(0)))
  let i = 0
  two.forEach((bar, b) => bar.forEach((v, s) => {
    if (v) parts[byBar ? b : i++ % k][b][s] = v
  }))
  return parts
}

// ---------------------------------------------------------------------------
// One stab loop (rule `stabLoop`): the track's stabs as one riff
// ---------------------------------------------------------------------------

/** The window a hit's punch is measured over (the engine's `punch_window_ms`). */
const PUNCH_WINDOW_S = 0.2
/** A stab with this share of its energy in its loudest 200 ms or more counts fully; the least any counts. */
const FOCUS_FULL = 0.5
const FOCUS_MIN = 0.15

/**
 * How much of a stab's energy lands in its loudest 200 ms (0…1): near 1 a tight hit, low a
 * sustained or swelling sound (a pad-like stab sounds soft at any level). Null when not measured.
 */
export function hitFocus(h: Pick<HitItem, 'punch_db' | 'energy_db'>): number | null {
  if (h.punch_db == null || h.energy_db == null || h.punch_db <= -200 || h.energy_db <= -200) return null
  return Math.min(1, 10 ** ((h.punch_db + 10 * Math.log10(PUNCH_WINDOW_S) - h.energy_db) / 10))
}

/** A stab's weight for a loop by how tight a hit it is (1 when not measured). */
export function focusWeight(h: Pick<HitItem, 'punch_db' | 'energy_db'>): number {
  const f = hitFocus(h)
  return f == null ? 1 : Math.max(FOCUS_MIN, Math.min(1, f / FOCUS_FULL))
}

/** How a second stab joins the loop: layered on its hits, or playing its 16th pickups (the main one the 8ths). */
export type StabLayout = 'stack' | 'split'

/** What a stab does in the loop: the main sound, a layer on it, or the pickups. */
export type StabJob = 'main' | 'layer' | 'pickups'

/** A pickup: a hit on a 16th between the 8ths, in a bar that has a hit on an 8th (else the bar is the main stab's). */
const isPickup = (b: Velocity[], i: number) => i % 2 === 1 && b.some((v, k) => v && k % 2 === 0)

/**
 * The jobs of a loop's `n` stabs: one is the main sound; a second is a layer on it (`stack`) or
 * plays the pickups (`split`); a third plays the pickups under a stacked pair. Without pickups in
 * the rhythm a second stab stacks and there is no third.
 */
export function loopJobs(rhythm: Velocity[][], n: number, layout: StabLayout): StabJob[] {
  const pickups = rhythm.some((b) => b.some((v, i) => v && isPickup(b, i)))
  if (n <= 1) return ['main']
  if (n === 2) return layout === 'split' && pickups ? ['main', 'pickups'] : ['main', 'layer']
  return pickups ? ['main', 'layer', 'pickups'] : ['main', 'layer']
}

/**
 * Each stab's part of the loop (bars of 16 velocities): the main sound and its layer hit together
 * (one bigger stab), on every hit but the pickups when a stab plays those.
 */
export function loopParts(rhythm: Velocity[][], jobs: StabJob[]): Velocity[][][] {
  const split = jobs.includes('pickups')
  return jobs.map((job) => rhythm.map((b) => b.map((v, i) => (!v ? 0 : !split || (job === 'pickups') === isPickup(b, i) ? v : 0)) as Velocity[]))
}

/** A roll into a drop on the stabs' last bar before it (16ths; the last beat stays dry): 8ths, or 8ths then 16ths. */
export type StabRoll = 'none' | 'eighths' | 'sixteenths'

/** The roll's bar: where it hits (16ths) and how hard, building up. */
export function rollBar(how: StabRoll): Velocity[] | null {
  if (how === 'none') return null
  const at = how === 'eighths' ? [0, 2, 4, 6, 8, 10] : [0, 2, 4, 6, 8, 9, 10, 11]
  const out: Velocity[] = new Array(16).fill(0)
  at.forEach((i, k) => (out[i] = k < at.length / 3 ? 2 : 3))
  return out
}
