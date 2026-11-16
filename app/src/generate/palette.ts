// A track's sound palette and its loops as one set (SCOPE.md §6.6, "Picked as a record"): instead
// of every lane drawing its sample on its own, the kick is the anchor, the track's character sets
// where the palette leans (darker, brighter, punchier, softer), and every other drum sample is
// picked by how well it sits with that. The loops are picked as a set that interlocks: each next
// one by how little its hits land on the 16ths the loops already chosen play, in the same tone.
//
// Everything is measured against what is usual for its kind in the library (a hat is bright, a
// kick is dark: a "dark" hat is dark for a hat), as z-scores: 0 the library's median, ±1 about one
// spread away. Samples not measured are neutral (0.5): nothing is held against them.

import type { SampleListItem } from '../types/api'
import { compactness } from './balance'
import type { Character } from './character'
import { maskOf, stackOf } from './critic'
import { BAND_HZ } from './eq'

/** Where a track's palette sits: brightness and compactness, in spreads from the library's median. */
export interface Palette {
  bright: number
  compact: number
}

/** Where each character leans (z): dub dark and soft, disco bright and snappy, drums dry and punchy, deep warm. */
export const CHARACTER_PALETTE: Record<Character, Palette> = {
  dub: { bright: -0.8, compact: -0.3 },
  disco: { bright: 0.6, compact: 0.3 },
  drums: { bright: 0.2, compact: 0.8 },
  deep: { bright: -0.5, compact: -0.2 },
}
/** How far the palette is pulled from the character's towards the kick's own place (0…1). */
export const ANCHOR_PULL = 0.5
/** A sample this many spreads from the palette fits half as well (Gaussian width). */
const WIDTH = 1.0
/** Compactness counts this much against brightness in the distance. */
const COMPACT_WEIGHT = 0.5
/** A kind is measured from this many samples; the spread is at least this (octaves, dB). */
const MIN_SAMPLES = 4
const MIN_BRIGHT_SPREAD = 0.15
const MIN_COMPACT_SPREAD = 1.0
/** Unmeasured: neither fits nor doesn't. */
export const NEUTRAL = 0.5

const LOG_HZ = BAND_HZ.map((f) => Math.log2(f))

/** A sound's brightness: the power-weighted mean log2 frequency of its tone; null unmeasured. */
export function brightness(tone: number[] | null | undefined): number | null {
  if (!tone || tone.length !== BAND_HZ.length) return null
  const p = tone.map((v) => 10 ** (v / 10))
  const total = p.reduce((a, b) => a + b, 0)
  return total > 0 ? p.reduce((n, v, i) => n + v * LOG_HZ[i], 0) / total : null
}

interface Stat { median: number; spread: number }
/** What is usual per kind of sample (`kind:category`): its brightness and (one-shots) compactness. */
export type PaletteRefs = Map<string, { bright?: Stat; compact?: Stat }>

const kindOf = (s: Pick<SampleListItem, 'kind' | 'category'>) => `${s.kind}:${s.category}`

function stat(xs: number[], floor: number): Stat | undefined {
  if (xs.length < MIN_SAMPLES) return undefined
  const s = [...xs].sort((a, b) => a - b)
  const median = s[s.length >> 1]
  const dev = s.map((x) => Math.abs(x - median)).sort((a, b) => a - b)
  return { median, spread: Math.max(floor, 1.4826 * dev[dev.length >> 1]) }
}

export function paletteRefs(samples: Iterable<SampleListItem>): PaletteRefs {
  const by = new Map<string, { bright: number[]; compact: number[] }>()
  for (const s of samples) {
    const k = kindOf(s)
    if (!by.has(k)) by.set(k, { bright: [], compact: [] })
    const b = brightness(s.tone)
    if (b != null) by.get(k)!.bright.push(b)
    const c = s.kind === 'oneshot' ? compactness(s) : null
    if (c != null) by.get(k)!.compact.push(c)
  }
  const out: PaletteRefs = new Map()
  for (const [k, v] of by) out.set(k, { bright: stat(v.bright, MIN_BRIGHT_SPREAD), compact: stat(v.compact, MIN_COMPACT_SPREAD) })
  return out
}

/** Where a sample sits for its kind (z), each null when it or its kind isn't measured. */
export function placeOf(s: SampleListItem, refs: PaletteRefs): { bright: number | null; compact: number | null } {
  const r = refs.get(kindOf(s))
  const b = brightness(s.tone)
  const c = s.kind === 'oneshot' ? compactness(s) : null
  return {
    bright: r?.bright && b != null ? (b - r.bright.median) / r.bright.spread : null,
    compact: r?.compact && c != null ? (c - r.compact.median) / r.compact.spread : null,
  }
}

/** The track's palette: its character's lean, pulled towards where its kick (the anchor) sits. */
export function paletteFor(character: Character | null | undefined, anchor: SampleListItem | null, refs: PaletteRefs): Palette {
  const base = character ? CHARACTER_PALETTE[character] : { bright: 0, compact: 0 }
  const at = anchor ? placeOf(anchor, refs) : { bright: null, compact: null }
  const pull = (b: number, z: number | null) => Math.round((z == null ? b : b + ANCHOR_PULL * (z - b)) * 100) / 100
  return { bright: pull(base.bright, at.bright), compact: pull(base.compact, at.compact) }
}

/** How well a sample sits in the palette (0…1, 1 right on it); NEUTRAL when it isn't measured. */
export function paletteFit(s: SampleListItem, p: Palette, refs: PaletteRefs): number {
  const z = placeOf(s, refs)
  if (z.bright == null && z.compact == null) return NEUTRAL
  const d2 = (z.bright == null ? 0 : (z.bright - p.bright) ** 2) + (z.compact == null ? 0 : COMPACT_WEIGHT * (z.compact - p.compact) ** 2)
  return Math.exp(-d2 / (2 * WIDTH ** 2))
}

/**
 * How well a loop interlocks with the loops already chosen (0…1): 1 where its hits fall on other
 * 16ths, less the more they land on the same ones, and less again in the same tone (that is the
 * critic's clash). The mean over the chosen loops measured with it; NEUTRAL with none.
 */
export function interlockFit(s: SampleListItem, chosen: readonly SampleListItem[]): number {
  const vals: number[] = []
  for (const o of chosen) {
    if (o.id === s.id) continue
    const stack = stackOf(s, o)
    if (stack == null) continue
    const mask = maskOf(s, o) ?? 0.5
    vals.push(1 - stack * (0.35 + 0.65 * mask))
  }
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NEUTRAL
}
