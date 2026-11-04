// Chord stabs (SCOPE.md §6.9): one of the Chord Stabs page's one-shots per track, in the track
// key, in a funky 1- or 2-bar rhythm: off the kick, mostly two stabs a bar (sometimes one or
// three), learned from the rhythms saved in the Chord Stabs module's step sequencer once there
// are some.

import type { SavedStabRhythm } from '../types/api'
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
