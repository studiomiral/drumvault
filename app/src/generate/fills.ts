// Fills made anew (SCOPE.md §6.6): a short drum fill never plays as it was recorded, so a fill
// in one of the user's tracks isn't heard as it is in another. Each fill a track plays is turned
// into its own: pitched a little, often spliced beat by beat with a fill that sounds like it, and
// sometimes with a beat played twice or its last beat stuttered into the line. One variant per
// fill per track (the track has its own fill, the same each time it comes), played as 16th slices
// on the grid (`AudioClip.pitch`, `AudioClip.remix`).

import { sampleRef, STEPS_PER_BAR } from '../lib/project'
import type { SampleListItem } from '../types/api'
import type { Clip } from '../types/project'
import type { Rng } from './rng'

/** Fills this long or shorter (bars) are made anew; rolls and long fills play as they are. */
export const FILL_MAX_BARS = 2
/** Semitones a fill is moved (never 0: it is never the fill as recorded), and how often each. */
const PITCHES: [number, number][] = [[-1, 3], [1, 3], [-2, 1], [2, 1]]
/** How often a fill is spliced with another, and has its beats reworked. */
const SPLICE_CHANCE = 0.6
const EDIT_CHANCE = 0.5
/** The partner is drawn from the fills nearest in tone: this many, within this far (mean dB per band). */
const NEAREST = 3
const MAX_TONE_DB = 6

/** How two fills share the bar: beats 1–2 and 3–4, beat by beat, or the other one's last beat. */
export type Splice = 'halves' | 'alternate' | 'last'
const SPLICES: [Splice, number][] = [['halves', 2], ['alternate', 2], ['last', 1]]
/** A rework of the (last) bar's beats: the first beat twice, the middle two swapped, the last beat in 8ths or 16ths. */
export type BeatEdit = 'repeatFirst' | 'swap' | 'stutter8' | 'stutter16'
const EDITS: [BeatEdit, number][] = [['repeatFirst', 1], ['swap', 1], ['stutter8', 2], ['stutter16', 1]]

/** How the track's choices start the line on its fills. */
export const FILL_WORDS = 'fills made anew'

export interface FillVariant {
  pitch: number
  partner: SampleListItem | null
  splice: Splice | null
  edit: BeatEdit | null
}

const SPLICE_LABEL: Record<Splice, string> = { halves: 'half and half', alternate: 'beat by beat', last: 'for its last beat' }
const EDIT_LABEL: Record<BeatEdit, string> = {
  repeatFirst: 'its first beat twice', swap: 'its middle beats swapped', stutter8: 'its last beat in 8ths', stutter16: 'its last beat in 16ths',
}

/** How far apart two sounds' tones are: the mean difference per band (dB); Infinity when not measured. */
export function toneDistance(a: number[] | null | undefined, b: number[] | null | undefined): number {
  if (!a || !b || a.length !== b.length || !a.length) return Infinity
  return a.reduce((n, v, i) => n + Math.abs(v - b[i]), 0) / a.length
}

/**
 * The slice map of a variant of a fill of `bars` bars: for each of its 16ths, [which fill (0: its
 * own, 1: the partner), which of that fill's 16ths]. A splice goes through every bar; a rework of
 * the beats only through the last (where the fill lands). The last `keep` 16ths stay the fill's
 * own (its silence before the line). The plain fill (no splice, no rework) maps to itself.
 */
export function fillSlices(bars: number, splice: Splice | null, edit: BeatEdit | null, keep = 0): [number, number][] {
  const n = bars * STEPS_PER_BAR
  const out: [number, number][] = []
  for (let i = 0; i < n; i++) {
    const bar = Math.floor(i / STEPS_PER_BAR)
    const beat = Math.floor((i % STEPS_PER_BAR) / 4)
    let sub = i % 4
    const src = splice === 'halves' ? (beat >= 2 ? 1 : 0) : splice === 'alternate' ? beat % 2 : splice === 'last' ? (beat === 3 ? 1 : 0) : 0
    let b = beat
    if (bar === bars - 1) {
      if (edit === 'repeatFirst' && beat === 1) b = 0
      if (edit === 'swap' && (beat === 1 || beat === 2)) b = 3 - beat
      if (edit === 'stutter8' && beat === 3) sub = sub % 2
      if (edit === 'stutter16' && beat === 3) sub = 0
    }
    out.push(i >= n - keep ? [0, i] : [src, bar * STEPS_PER_BAR + b * 4 + sub])
  }
  return out
}

/** A fill's silence before the line, in 16ths (`shape.gap`), within its body. */
const gapOf = (s: SampleListItem) => Math.max(0, Math.round(s.shape?.gap ?? 0))

/**
 * A variant of fill `a`: a pitch (always), and maybe a partner from `pool` (a fill as long, near in
 * tone, not one in `avoid`) with a splice, and maybe a rework of the beats.
 */
export function drawVariant(a: SampleListItem, pool: SampleListItem[], avoid: Set<string>, rng: Rng): FillVariant {
  const pitch = rng.weighted(PITCHES)
  let partner: SampleListItem | null = null
  let splice: Splice | null = null
  if (rng.chance(SPLICE_CHANCE)) {
    const near = pool
      .filter((s) => s.kind === 'event' && s.category === 'fill' && s.bars === a.bars && s.rel_path !== a.rel_path && !avoid.has(s.rel_path))
      .map((s) => ({ s, d: toneDistance(a.tone, s.tone) }))
      .filter((x) => x.d <= MAX_TONE_DB)
      .sort((x, y) => x.d - y.d)
      .slice(0, NEAREST)
    if (near.length) {
      partner = rng.pick(near).s
      splice = rng.weighted(SPLICES)
    }
  }
  // (A fill whose last beat is its silence before the line: nothing there to stutter.)
  const edits = gapOf(a) >= 4 ? EDITS.filter(([e]) => !e.startsWith('stutter')) : EDITS
  const edit = rng.chance(EDIT_CHANCE) ? rng.weighted(edits) : null
  return { pitch, partner, splice, edit }
}

/**
 * Every short fill on the lane `laneId` made anew (in place): one variant per fill sample. `pool`:
 * the library's fills (partners are drawn from them, never a fill the track plays itself). A few
 * words on what was done, or null when the lane has no short fill.
 */
export function varyFills(clips: Clip[], laneId: string | undefined, samples: Map<string, SampleListItem>,
                          pool: SampleListItem[], rng: Rng): string | null {
  if (!laneId) return null
  const own = clips.filter((c) => c.laneId === laneId && c.type === 'audio' && !c.bass && c.sample.category === 'fill'
    && (c.sample.bars ?? 1) <= FILL_MAX_BARS)
  if (!own.length) return null
  const used = new Set(clips.map((c) => c.sample.relPath))
  const words: string[] = []
  const variants = new Map<string, FillVariant>()
  for (const c of own) {
    const a = samples.get(c.sample.relPath)
    if (!a || c.type !== 'audio') continue
    let v = variants.get(a.rel_path)
    if (!v) {
      v = drawVariant(a, pool, used, rng)
      variants.set(a.rel_path, v)
      words.push([`pitched ${v.pitch > 0 ? '+' : ''}${v.pitch}`, v.splice ? `spliced ${SPLICE_LABEL[v.splice]} with another` : '',
        v.edit ? EDIT_LABEL[v.edit] : ''].filter(Boolean).join(', '))
    }
    c.pitch = (c.pitch ?? 0) + v.pitch
    if (v.splice || v.edit) {
      const bars = Math.max(1, a.bars ?? 1)
      const body = Math.max(1, Math.min(bars, a.body_bars ?? bars))
      // The silence before the line, from the body's end to the sample's: the fill's own.
      const keep = Math.min(bars * STEPS_PER_BAR, gapOf(a) + (bars - body) * STEPS_PER_BAR)
      c.remix = { from: v.partner ? [sampleRef(v.partner)] : [], slices: fillSlices(bars, v.splice, v.edit, keep) }
    }
  }
  return words.length ? `${FILL_WORDS}: ${words.join('; ')}` : null
}
