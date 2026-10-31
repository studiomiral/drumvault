// Rides (SCOPE.md §6.6): the producer's filter and fader moves, read bar by bar from a real track
// (the engine's arrangement detail: each part's dB against its full level, and its brightness in
// octaves against its full bars), and turned into clip filters and volume rides on keys, bass
// and top loops. A track built on a real track rides like that track did; the others ride like
// a section of the same kind of one of them.

import type { TrackArrangement } from '../types/api'
import type { ClipFilter } from '../types/project'
import type { Rng } from './rng'
import { readSections } from './template'
import type { Section, SectionKind } from './structure'

/** The arrangement parts the rides come from: keys and other music, the bass, the top loops. */
export type RidePart = 'music' | 'bass' | 'top'

/** What a bar of a part does: low- or high-passed at `hz` (null: not filtered), `db` quieter. */
export interface RideBar {
  type: 'lowpass' | 'highpass' | null
  hz: number
  db: number
}

/** A stretch of bars (from the section start) with one filter sweep and/or one volume ride. */
export interface RidePiece {
  from: number
  to: number
  filter?: ClipFilter
  gainDb: number
  gainTo?: number
}

/** Darker than this (octaves): low-passed. Brighter, and at least HP_MIN_DB quieter: high-passed. */
const LP_OCT = 0.35
const HP_OCT = 0.35
const HP_MIN_DB = -3
/** A low-pass this many octaves darker sits at OPEN_HZ · 2^(LP_GAMMA · octaves). */
const OPEN_HZ = 16000
const LP_GAMMA = 2.2
const LP_MIN_HZ = 150
/** A high-pass this many octaves brighter sits at HP_BASE_HZ · 2^(HP_GAMMA · octaves). */
const HP_BASE_HZ = 60
const HP_GAMMA = 6
const HP_MAX_HZ = 2500
/** Smaller level changes aren't a fader move; none goes further down than MAX_CUT_DB. */
const MIN_DB = 1.5
const MAX_CUT_DB = -18
/** Of a filtered bar's level drop, this share is the producer's fader (the rest the filter). */
const FADER_SHARE = 0.5
/** A treatment shorter than this (bars) is the music, not a ride (a riff resting, a break). */
const MIN_RUN = 2
/** One piece rides evenly from its first bar to its last while the bars between stay this close. */
const TOL_OCT = 0.5
const TOL_DB = 2
const Q = 0.7
/** The mix high-pass into drops: from MIX_HP_FROM_HZ to MIX_HP_TO_HZ over its bars. */
export const MIX_HP_FROM_HZ = 40
export const MIX_HP_TO_HZ = 700
/** Parts that count for the mix high-pass in a reference track, and how much thinner they get. */
const MIX_HP_PARTS = ['kick', 'bass', 'music', 'top', 'hats', 'clap']
const MIX_HP_OCT = 0.3

/** Outside drops a bass is high-passed (its sub out), this many octaves brighter at BASS_HP_BASE_HZ · 2^octaves. */
const BASS_HP_BASE_HZ = 120
export const BASS_HP_MIN_HZ = 150
export const BASS_HP_MAX_HZ = 450
/** Top loops low-passed in breakdowns: never darker or lighter than this. */
export const TOPS_BREAK_MIN_HZ = 600
export const TOPS_BREAK_MAX_HZ = 8000

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const half = (v: number) => Math.round(v * 2) / 2

/** A low-pass for a part `octaves` darker than in its full bars. */
export function lowpassHz(octaves: number): number {
  return Math.round(clamp(OPEN_HZ * 2 ** (LP_GAMMA * octaves), LP_MIN_HZ, OPEN_HZ))
}

/** A high-pass taking a bass's sub out, for a bass `octaves` brighter than in its full bars. */
export function bassHighpassHz(octaves: number): number {
  return Math.round(clamp(BASS_HP_BASE_HZ * 2 ** octaves, BASS_HP_MIN_HZ, BASS_HP_MAX_HZ))
}

/** How much brighter (octaves, median) `part` plays in the bars of `xs` it plays in; null unmeasured. */
export function partBright(a: TrackArrangement, part: RidePart, xs: { from: number; to: number }[]): number | null {
  const d = a.detail?.[part]
  const s = a.parts[part]
  if (!d || !s) return null
  const v = xs.flatMap((x) => Array.from({ length: x.to - x.from }, (_, i) => x.from + i))
    .filter((b) => s[b] && s[b] !== '0' && d.bright[b] != null).map((b) => d.bright[b]!).sort((p, q) => p - q)
  return v.length ? v[Math.floor(v.length / 2)] : null
}

/** A bar's treatment from its measurement; null when it plays as in full bars (or is silent). */
export function rideBar(db: number | null | undefined, bright: number | null | undefined): RideBar | null {
  if (db == null || bright == null) return null
  if (bright <= -LP_OCT) {
    return { type: 'lowpass', hz: lowpassHz(bright), db: half(clamp(db * FADER_SHARE, MAX_CUT_DB, 0)) }
  }
  if (bright >= HP_OCT && db <= HP_MIN_DB) {
    return { type: 'highpass', hz: Math.round(clamp(HP_BASE_HZ * 2 ** (HP_GAMMA * bright), 30, HP_MAX_HZ)), db: half(clamp(db * FADER_SHARE, MAX_CUT_DB, 0)) }
  }
  const g = half(clamp(db, MAX_CUT_DB, 0))
  return Math.abs(g) < MIN_DB ? null : { type: null, hz: 0, db: g }
}

const sameKind = (a: RideBar | null, b: RideBar | null) => (a?.type ?? 'none') === (b?.type ?? 'none') && !!a === !!b

/** Bars into pieces: runs of one kind of treatment, each ridden evenly where the bars allow. */
export function ridePieces(bars: (RideBar | null)[]): RidePiece[] {
  // Runs shorter than MIN_RUN are the music playing, not a ride.
  const xs = [...bars]
  for (let i = 0; i < xs.length;) {
    let j = i
    while (j < xs.length && sameKind(xs[j], xs[i])) j++
    if (xs[i] && j - i < MIN_RUN) for (let k = i; k < j; k++) xs[k] = null
    i = j
  }
  const out: RidePiece[] = []
  const oct = (b: RideBar) => (b.type ? Math.log2(b.hz) : 0)
  for (let i = 0; i < xs.length;) {
    const a = xs[i]
    if (!a) {
      i++
      continue
    }
    let j = i
    // Grow while the next bar is the same kind and every bar between stays near an even ride.
    while (j + 1 < xs.length && sameKind(xs[j + 1], a)) {
      const z = xs[j + 1]!
      const n = j + 1 - i
      const ok = xs.slice(i + 1, j + 1).every((m, k) => {
        const t = (k + 1) / n
        return Math.abs(oct(m!) - (oct(a) + (oct(z) - oct(a)) * t)) <= TOL_OCT && Math.abs(m!.db - (a.db + (z.db - a.db) * t)) <= TOL_DB
      })
      if (!ok) break
      j++
    }
    const z = xs[j]!
    const piece: RidePiece = { from: i, to: j + 1, gainDb: a.db }
    if (z.db !== a.db) piece.gainTo = z.db
    if (a.type) piece.filter = { type: a.type, from: a.hz, to: z.hz !== a.hz ? z.hz : null, q: Q }
    out.push(piece)
    i = j + 1
  }
  return out
}

/** A section's bars as the reference bars [from, to) map onto them (stretched or squeezed evenly). */
export function sectionBars(a: TrackArrangement, part: RidePart, from: number, to: number, bars: number): (RideBar | null)[] {
  const d = a.detail?.[part]
  if (!d) return new Array(bars).fill(null)
  return Array.from({ length: bars }, (_, i) => {
    const b = from + Math.floor((i * (to - from)) / bars)
    return rideBar(d.db[b], d.bright[b])
  })
}

/** Where each section's rides come from: its own reference bars, else a like section of another track. */
export interface RideSource {
  arrangement: TrackArrangement
  from: number
  to: number
}

export function rideSources(sections: Section[], templates: TrackArrangement[], rng: Rng): (RideSource | null)[] {
  const measured = templates.filter((a) => a.detail)
  const byCode = new Map(measured.map((a) => [a.source_code, a]))
  let pool: { kind: SectionKind; a: TrackArrangement; from: number; to: number }[] | null = null
  const like = (kind: SectionKind) => {
    pool ??= measured.flatMap((a) => (readSections(a) ?? []).map((s) => ({ ...s, a })))
    const xs = pool.filter((s) => s.kind === kind)
    return xs.length ? rng.pick(xs) : null
  }
  return sections.map((s) => {
    const own = s.src && byCode.get(s.src.code)
    if (own) return { arrangement: own, from: s.src!.from, to: s.src!.to }
    const x = like(s.kind)
    return x ? { arrangement: x.a, from: x.from, to: x.to } : null
  })
}

/**
 * The bars before drops a reference track high-passes as a whole (1, 2 or 4): most of its parts
 * still playing get thinner there, in most of its drops. Null when it doesn't.
 */
export function mixHighpassOf(a: TrackArrangement, drops: { from: number }[]): number | null {
  if (!a.detail || !drops.length) return null
  const thin = (bar: number) => {
    const parts = MIX_HP_PARTS.filter((p) => a.detail![p]?.db[bar] != null)
    const thinner = parts.filter((p) => (a.detail![p]!.bright[bar] ?? 0) >= MIX_HP_OCT)
    return parts.length >= 2 && thinner.length * 2 > parts.length
  }
  for (const n of [4, 2, 1]) {
    const yes = drops.filter((d) => d.from >= n && Array.from({ length: n }, (_, k) => thin(d.from - 1 - k)).every(Boolean))
    if (yes.length * 2 > drops.length) return n
  }
  return null
}
