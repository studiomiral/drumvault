// Chord stabs (SCOPE.md §6.9): one of the Chord Stabs page's one-shots or Serum 2 stab patches per
// track, played instead of the keys in most tracks, in the track key, in a funky 1- or 2-bar
// rhythm: off the kick, mostly two stabs a bar (sometimes one or three), learned from the rhythms
// saved in the Chord Stabs module's step sequencer once there are some.

import type { SampleListItem, SavedStabRhythm, SerumPreset } from '../types/api'
import type { Velocity } from '../types/project'
import { parseKey, type BassNote } from './bassline'
import type { Rng } from './rng'

/** Share of tracks with stabs instead of keys, when both are on. */
export const STAB_CHANCE = 2 / 3

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

function drawBar(rng: Rng, counts: [number, number][], weight: number[], gap: number): number[] {
  const n = rng.weighted(counts)
  const hits: number[] = []
  for (let tries = 0; hits.length < n && tries < 40; tries++) {
    const free = weight.map((w, i) => (hits.some((h) => Math.abs(h - i) < gap) ? 0 : w))
    if (!free.some((w) => w > 0)) break
    hits.push(rng.weighted(free.map((w, i) => [i, w] as [number, number])))
  }
  return hits.sort((a, b) => a - b)
}

/**
 * A stab rhythm (1 or 2 arrays of 16 velocities). Without saved rhythms: a classic house one, or
 * 2 bars drawn from the funky 16ths, the second the same or answering the first. With saved ones
 * (they replace the built-ins): one of them as it is, or one learned from them: as long as they
 * tend to be, as many stabs a bar, on the 16ths they hit (per bar), bar 2 repeating bar 1 as
 * often, no closer together than they get.
 */
export function stabRhythm(rng: Rng, saved: SavedStabRhythm[] = []): Velocity[][] {
  const mine = saved.filter((r) => r.steps.length && r.steps.some((b) => b.some(Boolean)))
  if (!mine.length) {
    if (rng.chance(0.5)) {
      const [a, b] = rng.pick(CLASSICS)
      return [bar(a), bar(b)]
    }
    const a = drawBar(rng, PER_BAR, STEP_WEIGHT, MIN_GAP)
    return [bar(a), bar(rng.chance(REPEAT) ? a : drawBar(rng, PER_BAR, STEP_WEIGHT, MIN_GAP))]
  }
  if (rng.chance(SAVED_EXACT)) return rng.pick(mine).steps.map((b) => bar(hitsOf(b)))
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
  const a = drawBar(rng, per, weightFor(0), gap)
  if (bars === 1) return [bar(a)]
  const repeat = bars2.length ? bars2.filter((r) => hitsOf(r.steps[0]).join() === hitsOf(r.steps[1]).join()).length / bars2.length : REPEAT
  return [bar(a), bar(rng.chance(repeat) ? a : drawBar(rng, per, weightFor(1), gap))]
}

/**
 * A patch's stab without a chord of its own: the track key's seventh chord (minor 7 in a minor
 * key, major 7 in a major one), or its root alone on a patch that plays a chord from one key.
 */
const MINOR_CHORD = [0, 3, 7, 10]
const MAJOR_CHORD = [0, 4, 7, 11]
/** The chord's root sits between A3 and G#4 (MIDI 57–68), before the patch's own octave … */
const ROOT_FROM = 57
/** … a chord patch's key between C3 and B3, where its chord was measured. */
const CHORD_KEY_FROM = 48
/** Each stab is held a 16th; the patch's release rings on. */
const STAB_BEATS = 0.25
const VELOCITY: Record<number, number> = { 1: 70, 2: 92, 3: 112 }

/** A patch's own chord (from its clip player) is written from C4: it plays from the key's root nearest to it. */
const VOICING_REF = 60

/**
 * The notes a patch plays for its part of the rhythm (bars of 16 velocities) in `key`: its own
 * chord when it has one (`voicing`, semitones from the root: from the key's root, or the relative
 * key's when its third says the other mode), the root alone on a patch that plays a chord from
 * one key, else the key's seventh chord.
 */
export function stabChordNotes(part: Velocity[][], key: string | null, oneKey = false, voicing?: number[] | null): BassNote[] {
  const k = parseKey(key) ?? { root: 0, minor: true }
  const pc = (n: number) => ((n % 12) + 12) % 12
  let chord: number[]
  if (voicing?.length && !oneKey) {
    const pcs = new Set(voicing.map(pc))
    const minor = pcs.has(3)
    const major = pcs.has(4) && !minor
    const r = pc(k.root + (k.minor && major ? 3 : !k.minor && minor ? -3 : 0))
    const root = VOICING_REF + (r > 5 ? r - 12 : r)
    chord = voicing.map((v) => Math.max(0, Math.min(127, root + v)))
  } else {
    const from = oneKey ? CHORD_KEY_FROM : ROOT_FROM
    const root = from + pc(k.root - from)
    chord = oneKey ? [root] : (k.minor ? MINOR_CHORD : MAJOR_CHORD).map((iv) => root + iv)
  }
  return stabNotes(part, chord)
}

/** `chord` (pitches) on every step of the rhythm (bars of 16 velocities), each held a 16th. */
export function stabNotes(part: Velocity[][], chord: number[]): BassNote[] {
  return part.flatMap((bar, b) => bar.flatMap((v, i) => (v
    ? chord.map((p): BassNote => [b * 4 + i / 4, STAB_BEATS, p, VELOCITY[v]]) : [])))
}

/** Sample ids of stab patches: negative, apart from the library's, the rendered parts' and the hits'. */
const PRESET_ID_BASE = -2_500_000_000

export function stabPresetId(path: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < path.length; i++) h = Math.imul(h ^ path.charCodeAt(i), 0x01000193) >>> 0
  return PRESET_ID_BASE - (h % 100_000_000)
}

/** A stab patch as a stand-in sample for the generator, until its part is rendered. */
export function stabPresetSample(p: SerumPreset): SampleListItem {
  return {
    id: stabPresetId(p.path), rel_path: `serum:${p.path}`, name: p.name, kind: 'loop', category: 'chord_stab',
    bpm: null, bars: 2, body_bars: null, key_label: null, key_camelot: null, duration_s: 0, channels: 2,
    favorite: 0, rating: null, tags: null, zip_id: -1, source_code: 'Serum',
  }
}

/** Whether a rendered stab part plays one key at a time (a patch that plays a chord from one key). */
export function stabOneKey(notes: BassNote[]): boolean {
  return new Set(notes.map(([s]) => s)).size === notes.length
}

/** A rendered stab part's rhythm back from its notes (`bars` bars of 16 velocities). */
export function stabPartOf(notes: BassNote[], bars = 2): Velocity[][] {
  const part = Array.from({ length: bars }, () => new Array<Velocity>(16).fill(0))
  const vel = Object.fromEntries(Object.entries(VELOCITY).map(([v, n]) => [n, Number(v) as Velocity]))
  for (const [start, , , v] of notes) {
    const b = Math.floor(start / 4)
    if (b < bars) part[b][Math.round((start - b * 4) * 4)] = vel[v] ?? 3
  }
  return part
}
