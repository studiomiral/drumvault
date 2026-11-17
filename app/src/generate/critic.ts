// The critic (SCOPE.md §6.6): a made track listened back to, from what the engine measured of its
// loops, and what clashes fixed, the way a producer would: two loops that sound together in the
// drops with the same tone on the same 16ths (one only covers the other), and a loop with a kick
// of its own in it (it flams against the track's). The loop at fault gets another one in its
// place that goes with everything it plays with; the clips stay where they are. Pure and seeded:
// the same track gets the same fixes.

import type { SampleListItem } from '../types/api'
import { dropRanges } from './balance'
import { BAND_HZ } from './eq'
import { feelFit, hasFeel } from './feel'
import { hitPitch } from './disco'
import { laneRole, newLaneSound, STAB_ROLES, type GenerateOptions, type Generation, type Role } from './generator'
import { focusWeight, stabWeight, toneShare } from './stabs'
import { Rng } from './rng'

/** The lanes whose loops are listened to: the layers that fill the drops up. */
const LOOP_ROLES = new Set<Role>(['hats', 'hats2', 'ride', 'perc', 'perc2', 'top', 'top2', 'top3', 'top4', 'groove'])
/**
 * Two loops clash from here: tone overlap × overlap of their hits (each 0…1, 1 the same). In the
 * user's library 5 % of the loop pairs are over 0.8 (half of them under 0.39): near enough the
 * same loop twice.
 */
export const CLASH = 0.8
/** Loops count as sounding together from this many beats in the drops (8 bars). */
const MIN_TOGETHER = 32
/** The low end that is the kick's (Hz), and the share of a loop's power there that is a kick in it (the library: one top loop at 0.72, every other loop ≤ 0.02; kicks 0.77–0.95). */
const KICK_HZ = 100
export const BLEED_SHARE = 0.05
/** Fixes per track at most, and how much better a swap must be when nothing clears every clash. */
const MAX_FIXES = 6
const BETTER = 0.05
/** A loop fits the track's feel from here (as the generator picks them). */
const GOOD_FIT = 0.5

/** A loop where it plays: one sample on one lane, and the beats of the drops it sounds in. */
export interface Part {
  laneId: string
  lane: string
  role: Role
  sample: SampleListItem
  spans: [number, number][]
}

/** Two loops that sound together for `beats`, how alike their tone (`mask`) and their hits (`stack`) are, and the two multiplied. */
export interface Clash {
  a: Part
  b: Part
  mask: number
  stack: number
  clash: number
  beats: number
}

export interface Critique {
  parts: Part[]
  /** Every pair that sounds together and is measured, the worst first. */
  pairs: Clash[]
  /** The pairs over CLASH. */
  clashes: Clash[]
  /** Loops with a kick of their own, and the share of their power in the kick's low end. */
  bleeds: { part: Part; share: number }[]
}

/** What two sets of amounts share, against the smaller one: 1 when one lies wholly inside the other. */
function overlap(a: number[], b: number[]): number {
  const sum = (x: number[]) => x.reduce((n, v) => n + v, 0)
  const least = Math.min(sum(a), sum(b))
  return least > 0 ? a.reduce((n, v, i) => n + Math.min(v, b[i]), 0) / least : 0
}

/** A sample's tone as shares of its power per band; null unmeasured. */
function shares(s: SampleListItem): number[] | null {
  if (!s.tone || s.tone.length !== BAND_HZ.length) return null
  const p = s.tone.map((v) => 10 ** (v / 10))
  const total = p.reduce((n, v) => n + v, 0)
  return total > 0 ? p.map((v) => v / total) : null
}

/** A loop's hits per 16th of the bar, as loud as each plays (linear, 1 the loudest step); null unmeasured. */
function accents(s: SampleListItem): number[] | null {
  const g = s.groove
  if (!g || !g.hits.some((h) => h > 0)) return null
  return g.hits.map((h, k) => (h > 0 && g.levels[k] != null ? 10 ** (g.levels[k]! / 20) : 0))
}

/** How alike two loops are in tone (0…1). Null when either isn't measured. */
export function maskOf(a: SampleListItem, b: SampleListItem): number | null {
  const pa = shares(a), pb = shares(b)
  return pa && pb ? overlap(pa, pb) : null
}

/** How much two loops' hits land on the same 16ths (0…1). Null when either isn't measured. */
export function stackOf(a: SampleListItem, b: SampleListItem): number | null {
  const ha = accents(a), hb = accents(b)
  return ha && hb ? overlap(ha, hb) : null
}

/** The clash of two loops sounding together: the same tone on the same 16ths. Null unmeasured. */
export function clashOf(a: SampleListItem, b: SampleListItem): number | null {
  const m = maskOf(a, b), s = stackOf(a, b)
  return m == null || s == null ? null : m * s
}

/** The share of a loop's power in the kick's low end (0 unmeasured). */
export function bleedOf(s: SampleListItem): number {
  const p = shares(s)
  return p ? p.reduce((n, v, i) => n + (BAND_HZ[i] < KICK_HZ ? v : 0), 0) : 0
}

const together = (a: Part, b: Part) => a.spans.reduce((n, [a0, a1]) => n + b.spans.reduce((m, [b0, b1]) => m + Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)), 0), 0)

/** The track's loops where they play in its drops, and what clashes among them. */
export function critique(all: SampleListItem[], g: Generation): Critique {
  const byPath = new Map(all.map((s) => [s.rel_path, s]))
  const drops = dropRanges(g.sections)
  const lanes = new Map(g.project.lanes.map((l) => [l.id, l]))
  const parts = new Map<string, Part>()
  for (const c of g.project.clips) {
    const lane = lanes.get(c.laneId)
    const role = lane && laneRole(lane.name)
    const s = byPath.get(c.sample.relPath)
    if (!lane || !role || !LOOP_ROLES.has(role) || c.type !== 'audio' || c.bass || s?.kind !== 'loop') continue
    const id = `${c.laneId}|${s.rel_path}`
    const part = parts.get(id) ?? { laneId: c.laneId, lane: lane.name, role, sample: s, spans: [] }
    for (const [from, to] of drops) {
      const a = Math.max(from, c.start), z = Math.min(to, c.start + c.length)
      if (z > a) part.spans.push([a, z])
    }
    parts.set(id, part)
  }
  const list = [...parts.values()].filter((p) => p.spans.length)
  const pairs: Clash[] = []
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j]
      if (a.laneId === b.laneId || a.sample.id === b.sample.id) continue
      const beats = together(a, b)
      const mask = maskOf(a.sample, b.sample), stack = stackOf(a.sample, b.sample)
      if (beats < MIN_TOGETHER || mask == null || stack == null) continue
      pairs.push({ a, b, mask, stack, clash: mask * stack, beats })
    }
  }
  pairs.sort((x, y) => y.clash - x.clash)
  const bleeds = list.map((part) => ({ part, share: bleedOf(part.sample) })).filter((b) => b.share >= BLEED_SHARE).sort((x, y) => y.share - x.share)
  return { parts: list, pairs, clashes: pairs.filter((p) => p.clash >= CLASH), bleeds }
}

/** A kick in a loop weighs as much as this many clashing pairs: two kicks flamming is heard at once, a covered layer is only lost. */
const BLEED_WEIGHT = 10

/** How much is wrong with a track: its clashes and bleeds added up (0: nothing). */
export function penalty(c: Critique): number {
  return c.clashes.reduce((n, p) => n + p.clash, 0) + c.bleeds.reduce((n, b) => n + BLEED_WEIGHT + b.share, 0)
}

/** A stab is off from here: moved this many semitones into the key, or this much of its tone the tops' (0…1). */
export const STAB_SHIFT = 4
export const STAB_PILE = 0.85
const BANDS_PER_OCTAVE = BAND_HZ.length / Math.log2(16000 / 40)

/** The tone of several loops together (each as its share of power per band); null when none is measured. */
function together_(tones: (number[] | null | undefined)[]): number[] | null {
  const xs = tones.map((t) => (t && t.length === BAND_HZ.length ? t.map((v) => 10 ** (v / 10)) : null)).filter((t): t is number[] => !!t)
  if (!xs.length) return null
  const acc = new Array(BAND_HZ.length).fill(0)
  for (const p of xs) {
    const total = p.reduce((a, b) => a + b, 0)
    if (total > 0) p.forEach((v, i) => { acc[i] += v / total / xs.length })
  }
  return acc.map((v) => 10 * Math.log10(Math.max(v, 1e-9)))
}

/**
 * The stabs listened back to (tracks whose stabs are written for them): one moved `STAB_SHIFT`
 * semitones or more into the key (a sampler changes a sound with its pitch), or whose tone is the
 * top loops' over again (it piles onto them), is swapped for one of the Chord Stabs page's that is
 * neither, drawn among those by how well they fit the track and the other stabs. Its rhythm and
 * where it plays stay. What was done, as notes.
 */
function refineStabs(all: SampleListItem[], opts: GenerateOptions, g: Generation, rng: Rng, o: RefineOptions): { g: Generation; notes: string[] } {
  const hits = (opts.stabs?.hits ?? []).filter((h) => h.kind === 'stab')
  const notes: string[] = []
  if (!g.rules.stabFit || !hits.length || (o.locked ?? []).some((r) => STAB_ROLES.includes(r))) return { g, notes }
  const byPath = new Map(hits.map((h) => [h.rel_path, h]))
  let now = g
  for (const role of STAB_ROLES) {
    if (o.only && !o.only.includes(role)) continue
    const lane = now.project.lanes.find((l) => laneRole(l.name) === role)
    const clip = lane && now.project.clips.find((c) => c.laneId === lane.id)
    const h = clip && byPath.get(clip.sample.relPath)
    if (!lane || !h) continue
    const tops = together_(critique(all, now).parts.filter((p) => p.role.startsWith('top')).map((p) => p.sample.tone))
    const shift = (x: typeof h) => Math.abs(hitPitch(x, now.key))
    const pile = (x: typeof h) => toneShare(x.tone, tops) ?? 0
    const why = shift(h) >= STAB_SHIFT ? `moved ${shift(h)} semitones into the key` : pile(h) >= STAB_PILE ? 'the tops\' tone over again' : null
    if (!why) continue
    const others = STAB_ROLES.filter((r) => r !== role).map((r) => now.picks[r] && byPath.get(now.picks[r]!.rel_path)).filter((x): x is typeof h => !!x)
    const next = newLaneSound(all, opts, now, lane.id, g.seed, (_s, cands) => {
      const ok = cands.map((c) => ({ c, h: byPath.get(c.rel_path) })).filter((x): x is { c: SampleListItem; h: typeof h } => !!x.h)
        .filter((x) => shift(x.h) < STAB_SHIFT && pile(x.h) < STAB_PILE)
      return ok.length ? rng.pickBy(ok, (x) => stabWeight(x.h, hitPitch(x.h, now.key), tops, others, BANDS_PER_OCTAVE) * (now.rules.stabLoop ? focusWeight(x.h) : 1)).c : null
    })
    if (!next) continue
    now = next
    notes.push(`another stab on ${lane.name} (${why})`)
  }
  return { g: now, notes }
}

export interface RefineOptions {
  /** Lanes kept by the user (🔒): their main sample stays. */
  locked?: Role[]
  /** Only loops on these lanes are swapped (the lanes just made again); the rest is only listened to. */
  only?: Role[]
}

/**
 * The track with what clashes fixed: the worst first, the loop at fault (a layer before a lane's
 * main loop, never the loop the track's feel comes from, never a kept one) swapped for another of
 * its kind that clears every loop it plays with, has no kick in it and fits the feel, drawn among
 * those by favourites and ratings; when none clears them all, the one that clashes least, if that
 * is better. What was done is added to the track's choices. The same track when nothing clashes.
 */
export function refine(all: SampleListItem[], opts: GenerateOptions, g: Generation, o: RefineOptions = {}): Generation {
  const rng = new Rng((g.seed ^ 0x43524954) >>> 0)
  const feel = [g.picks.groove, g.picks.top, g.picks.perc, g.picks.hats].find(hasFeel) ?? null
  const kept = new Set((o.locked ?? []).map((r) => g.picks[r]?.rel_path).filter((x): x is string => !!x))
  const tried = new Set<string>()
  const idOf = (p: Part) => `${p.laneId}|${p.sample.rel_path}`
  const weight = (s: SampleListItem) => (opts.useRatings ? 1 + (s.favorite ? 2 : 0) + (s.rating ?? 0) * 0.4 : 1)
  const stabbed = refineStabs(all, opts, g, rng, o)
  const notes: string[] = [...stabbed.notes]
  let now = stabbed.g
  for (let n = 0; n < MAX_FIXES; n++) {
    const c = critique(all, now)
    const mains = new Set(Object.values(now.picks).map((s) => s?.rel_path))
    const open = (p: Part) => !tried.has(idOf(p)) && p.sample.rel_path !== feel?.rel_path && !kept.has(p.sample.rel_path)
      && (!o.only || o.only.includes(p.role))
    const blame = (p: Part) => c.pairs.reduce((t, x) => t + (x.a === p || x.b === p ? x.clash : 0), 0)
    // The worst thing first: a kick in a loop, then the pairs. Of a pair, a layer goes before a main loop.
    let fix: { part: Part; why: string } | null = null
    for (const b of c.bleeds) {
      if (open(b.part)) { fix = { part: b.part, why: 'a kick in it' }; break }
    }
    for (const p of fix ? [] : c.clashes) {
      const pick = [p.a, p.b].filter(open)
        .sort((x, y) => Number(mains.has(x.sample.rel_path)) - Number(mains.has(y.sample.rel_path)) || blame(y) - blame(x))[0]
      if (pick) { fix = { part: pick, why: `the same hits and tone as ${pick === p.a ? p.b.lane : p.a.lane}` }; break }
    }
    if (!fix) break
    const part = fix.part
    tried.add(idOf(part))
    const others = c.parts.filter((p) => p !== part && together(p, part) >= MIN_TOGETHER)
    const worst = (s: SampleListItem) => others.reduce((m, p) => Math.max(m, clashOf(s, p.sample) ?? 0), 0)
    const choose = (s: SampleListItem, cands: SampleListItem[]): SampleListItem | null => {
      if (s.rel_path !== part.sample.rel_path) return null
      // Only loops that can be heard for what they are: measured, and no kick in them.
      let pool = cands.filter((x) => maskOf(x, x) != null && stackOf(x, x) != null && bleedOf(x) < BLEED_SHARE)
      const fits = pool.filter((x) => feelFit(x.groove, feel?.groove) >= GOOD_FIT)
      if (feel && fits.length) pool = fits
      const clear = pool.filter((x) => worst(x) < CLASH)
      if (clear.length) return rng.pickBy(clear, weight)
      const best = [...pool].sort((x, y) => worst(x) - worst(y))[0]
      return best && (bleedOf(s) >= BLEED_SHARE || worst(best) < worst(s) - BETTER) ? best : null
    }
    const next = newLaneSound(all, opts, now, part.laneId, g.seed, choose)
    if (!next || penalty(critique(all, next)) >= penalty(c)) continue
    now = next
    notes.push(`another loop on ${part.lane} (${fix.why})`)
  }
  return notes.length ? { ...now, choices: [...now.choices, `listened back: ${notes.join(', ')}`] } : g
}
