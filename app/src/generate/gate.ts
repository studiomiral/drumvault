// The intro's top loops gated, the gate opening up (SCOPE.md §6.6): each top loop cut into 16ths,
// only some of them playing at first, more every 8 bars, the plain loop by the intro's last phrase,
// so the intro builds by itself. The gate is on the bar grid (`AudioClip.chop`), the loop played as
// 16th slices.

import { STEPS_PER_BAR } from '../lib/project'

/** A gate's character: which 16ths it lets through first. */
export type GateFamily = 'offbeats' | 'push' | 'pulse'
export const GATE_FAMILIES: GateFamily[] = ['offbeats', 'push', 'pulse']

/** The order each family opens in: the first `n` of these 16ths of the bar play. */
const GATE_ORDER: Record<GateFamily, number[]> = {
  // The offbeat 8ths, then the beats' other 16ths: a hat-like lift.
  offbeats: [2, 10, 6, 14, 0, 8, 4, 12, 3, 11, 7, 15, 1, 9, 5, 13],
  // 3-3-2 across the bar, then filling in.
  push: [0, 3, 6, 8, 11, 14, 10, 2, 4, 12, 7, 15, 1, 9, 5, 13],
  // The beats, then the 8ths, then the rest: the loop's own pulse.
  pulse: [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15],
}

export const GATE_LABEL: Record<GateFamily, string> = { offbeats: 'the offbeats first', push: 'a 3-3-2 first', pulse: 'the beats first' }

/** The 16ths the first and the last gated phrase let through (one gated phrase: `ONE`). */
const FIRST = 4
const LAST = 12
const ONE = 6

/** The gate letting the first `n` of `family`'s 16ths through (1: plays, 0: doesn't). */
export function gateSteps(family: GateFamily, n: number): number[] {
  const out = new Array<number>(STEPS_PER_BAR).fill(0)
  for (const i of GATE_ORDER[family].slice(0, Math.max(0, Math.min(STEPS_PER_BAR, n)))) out[i] = 1
  return out
}

/**
 * The gate of phrase `k` (0-based) of an intro's `gated` gated phrases on top lane `lane`: each
 * lane opens in another family (two tops interlock), letting more through phrase by phrase.
 */
export function introGate(family: GateFamily, lane: number, k: number, gated: number): number[] {
  const f = GATE_FAMILIES[(GATE_FAMILIES.indexOf(family) + lane) % GATE_FAMILIES.length]
  const n = gated <= 1 ? ONE : Math.round(FIRST + ((LAST - FIRST) * k) / (gated - 1))
  return gateSteps(f, n)
}

/** Phrases of an intro of `bars` that are gated (its last phrase plays plain; none in an intro of one phrase). */
export const gatedPhrases = (bars: number, phrase: number): number => Math.max(0, Math.floor(bars / phrase) - 1)
