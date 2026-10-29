// The track's feel (SCOPE.md §6.6): the groove of its main loop, measured by the engine
// (groove.py), applied to the one-shot patterns and the bass, so they sit in the same pocket as
// the loops instead of dead on the grid. Loops for the other lanes are picked to match it.

import type { LoopGroove, SampleListItem } from '../types/api'
import type { StepGroove } from '../types/project'

/** Steps of the bar that play alike: quarters, offbeat 8ths, the 16ths in between. */
const KINDS = [[0, 4, 8, 12], [2, 6, 10, 14], [1, 3, 5, 7, 9, 11, 13, 15]]
const kindOf = (k: number) => KINDS.find((ks) => ks.includes(k))!
/** Offsets further than this (16ths) are clamped: a groove, not a flam. */
const MAX_OFFSET = 0.4
/** A loop's accents are applied at this fraction, and cut at most this far (dB). */
const ACCENT_SCALE = 0.5
const MAX_CUT_DB = 6
/** A loop gives the track its feel with at least this many hits measured. */
const MIN_HITS = 8
/** Swing (16ths) between two loops at which they fit half as well. */
const SWING_TOLERANCE = 0.06

const round = (v: number, d = 1000) => Math.round(v * d) / d + 0

/** Every step's value, the missing ones filled with the mean of their kind (or 0). */
function filled(vals: (number | null)[]): number[] {
  return vals.map((v, k) => {
    if (v != null) return v
    const same = kindOf(k).map((j) => vals[j]).filter((x): x is number => x != null)
    return same.length ? same.reduce((a, b) => a + b, 0) / same.length : 0
  })
}

export function hasFeel(s: SampleListItem | null | undefined): s is SampleListItem {
  return !!s && s.kind === 'loop' && (s.groove?.hits.reduce((a, b) => a + b, 0) ?? 0) >= MIN_HITS
}

/** A loop's groove as 16 step offsets and accents, `amount` (0…1) of the way. */
export function stepGroove(g: LoopGroove, amount: number): StepGroove {
  return {
    offsets: filled(g.offsets).map((o) => round(Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, o * amount)))),
    gains: filled(g.levels).map((l) => round(Math.max(-MAX_CUT_DB, l * ACCENT_SCALE * amount), 10)),
  }
}

/** The groove for one pattern: accents relative to its loudest step, so it doesn't get quieter overall. */
export function grooveFor(g: StepGroove, steps: number[]): StepGroove {
  const played = [...new Set(steps.flatMap((v, i) => (v ? [i % 16] : [])))]
  const top = played.length ? Math.max(...played.map((k) => g.gains[k])) : 0
  return { offsets: [...g.offsets], gains: g.gains.map((x) => round(x - top, 10)) }
}

/** Whether a groove moves anything noticeably (else it is left out, and the bass isn't re-rendered). */
export function audible(g: StepGroove): boolean {
  return g.offsets.some((o) => Math.abs(o) >= 0.02)
}

/** How well a loop's swing fits the track's feel: 1 the same, towards 0 far apart; 0.5 unknown. */
export function feelFit(a: LoopGroove | null | undefined, b: LoopGroove | null | undefined): number {
  if (!a || !b) return 0.5
  const d = Math.abs((a.swing ?? 0) - (b.swing ?? 0)) + Math.abs((a.push ?? 0) - (b.push ?? 0))
  return 1 / (1 + (d / SWING_TOLERANCE) ** 2)
}
