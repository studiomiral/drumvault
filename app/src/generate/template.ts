// Structure templates (SCOPE.md §6.6): a real track's arrangement, measured by the engine
// (arrangement.py: per part and bar silent / quiet / full), read as sections and track rules a
// producer chose, then changed a little so the result is new: one section longer or shorter,
// another kick treatment in a breakdown, a few rules drawn again.

import type { TrackArrangement } from '../types/api'
import type { Rng } from './rng'
import {
  fit, layout, LIMITS, PHRASE, pickBuildStyle, pickKickMode, type KickMode, type Section, type SectionKind,
} from './structure'

/** Parts that make a phrase's energy (fills, FX and crashes are moments, not energy). */
const ENERGY_PARTS = ['kick', 'clap', 'hats', 'perc', 'top', 'ride', 'bass', 'music']
/** A kick phrase is a drop at this share of the track's highest energy (or with the bass full). */
const DROP_ENERGY = 0.75
/** Share of a phrase's bars a part must play in to count as playing there. */
const PLAYS = 0.5
/** Chance that a rule read from the track is drawn again instead (the "10 %" that is new). */
const REDRAW = 0.12

export interface Template {
  /** Source code of the track (S0012). */
  source: string
  sections: Section[]
  /** Track rules read from the track (the generator's names; the rest it draws itself). */
  rules: Record<string, unknown>
  /** What was changed from the original, for the choices list. */
  changes: string[]
}

type Raw = Omit<Section, 'start' | 'label'>

/** Share of the bars in [from, to) where `part` plays at `level` or louder; 0 without that part. */
export function share(a: TrackArrangement, part: string, from: number, to: number, level = 1): number {
  const s = a.parts[part]
  if (!s || to <= from) return 0
  let n = 0
  for (let b = from; b < to; b++) if (Number(s[b] ?? 0) >= level) n++
  return n / (to - from)
}

/** The track's sections as it was produced (phrase by phrase), before fitting them to our rules. */
export function readSections(a: TrackArrangement): { kind: SectionKind; from: number; to: number }[] | null {
  const n = Math.floor(a.bars / PHRASE)
  const ph = Array.from({ length: n }, (_, p) => {
    const f = (part: string, level = 1) => share(a, part, p * PHRASE, (p + 1) * PHRASE, level)
    return {
      kick: f('kick', 2) >= PLAYS,
      bass: f('bass', 2) >= PLAYS,
      energy: ENERGY_PARTS.reduce((e, part) => e + f(part, 2), 0),
      silent: Object.keys(a.parts).every((part) => f(part) < 0.1),
    }
  })
  let first = 0
  let last = n - 1
  while (first < n && ph[first].silent) first++
  while (last > first && ph[last].silent) last--
  if (last - first + 1 < 8) return null
  const kicks = ph.slice(first, last + 1).filter((p) => p.kick)
  if (!kicks.length) return null
  const top = Math.max(...kicks.map((p) => p.energy))
  const kinds: SectionKind[] = []
  for (let p = first; p <= last; p++) {
    const x = ph[p]
    kinds.push(!x.kick ? 'break' : x.bass || x.energy >= DROP_ENERGY * top ? 'drop' : 'build')
  }
  const d0 = kinds.indexOf('drop')
  const d1 = kinds.lastIndexOf('drop')
  if (d0 < 0) return null
  // Before the first drop: the intro (up to four phrases, elements coming in as it goes), and
  // what runs on after that a build.
  for (let i = 0; i < d0; i++) kinds[i] = i < 4 || d0 < 5 ? 'intro' : 'build'
  for (let i = d1 + 1; i < kinds.length; i++) kinds[i] = 'outro'
  // In the middle, a quieter kick part after a breakdown builds into the drop; otherwise it is
  // part of the drop.
  for (let i = d0; i <= d1; i++) {
    if (kinds[i] !== 'build') continue
    let j = i
    while (j > d0 && kinds[j - 1] === 'build') j--
    if (kinds[j - 1] !== 'break') kinds[i] = 'drop'
  }
  const out: { kind: SectionKind; from: number; to: number }[] = []
  kinds.forEach((k, i) => {
    const bar = (first + i) * PHRASE
    const prev = out[out.length - 1]
    if (prev && prev.kind === k) prev.to = bar + PHRASE
    else out.push({ kind: k, from: bar, to: bar + PHRASE })
  })
  return out
}

const clampBars = (kind: SectionKind, bars: number) => {
  const [lo, hi] = LIMITS[kind]
  return Math.max(lo, Math.min(hi, Math.round(bars / PHRASE) * PHRASE))
}

function kickModeOf(a: TrackArrangement, from: number, to: number, rng: Rng): KickMode {
  const quiet = share(a, 'kick', from, to)
  if (quiet < 0.15) return 'out'
  if (quiet >= PLAYS) return rng.weighted([['thin', 2], ['filtered', 1], ['sweep', 0.5]] as const)
  return pickKickMode(rng)
}

/**
 * A template from a track's arrangement: its sections (kept within the generator's limits and
 * grammar, fitted to [minBars, maxBars] only when outside it), its rules, and a few changes.
 * Null when the arrangement doesn't read as a dance track (too short, no drop).
 */
export function templateFrom(a: TrackArrangement, rng: Rng, minBars: number, maxBars: number): Template | null {
  const read = readSections(a)
  if (!read || read.length < 3) return null
  const parts: (Raw & { from: number; to: number })[] = read.map((r) => ({ kind: r.kind, bars: r.to - r.from, from: r.from, to: r.to }))
  // The generator's grammar: an intro, then a build or a drop; builds run into a drop.
  if (parts[1].kind === 'break') parts[1].kind = 'build'
  for (let i = 1; i < parts.length - 1; i++) {
    if (parts[i].kind === 'build' && parts[i + 1].kind !== 'drop') parts[i].kind = parts[i - 1].kind === 'drop' ? 'drop' : 'break'
  }
  const merged: typeof parts = []
  for (const p of parts) {
    const prev = merged[merged.length - 1]
    if (prev && prev.kind === p.kind) { prev.bars += p.bars; prev.to = p.to } else merged.push({ ...p })
  }
  // A track that ends on its drop (an edit without a DJ outro): its last 16 bars become the outro.
  const end = merged.at(-1)!
  if (end.kind === 'drop' && end.bars >= 32 && merged.filter((p) => p.kind === 'drop').length > 1) {
    end.bars -= 16
    end.to -= 16
    merged.push({ kind: 'outro', bars: 16, from: end.to, to: end.to + 16 })
  }
  if (merged[0].kind !== 'intro' || merged.at(-1)!.kind !== 'outro' || !merged.some((p) => p.kind === 'drop')) return null

  const s: (Raw & { from: number; to: number })[] = merged.map((p) => {
    const x: Raw & { from: number; to: number } = { ...p, bars: clampBars(p.kind, p.bars) }
    if (p.kind === 'break') x.kick = kickModeOf(a, p.from, p.to, rng)
    if (p.kind === 'build') {
      const mid = Math.round((p.from + p.to) / 2)
      const opening = share(a, 'top', p.from, mid, 1) > share(a, 'top', p.from, mid, 2) + 0.3 && share(a, 'top', mid, p.to, 2) >= PLAYS
      const rising = ENERGY_PARTS.filter((q) => share(a, q, mid, p.to, 2) >= PLAYS).length
        > ENERGY_PARTS.filter((q) => share(a, q, p.from, mid, 2) >= PLAYS).length + 1
      x.build = opening ? 'filter' : rising ? rng.weighted([['layered', 3], ['doubletime', 1]] as const) : rng.chance(0.4) ? 'all' : pickBuildStyle(rng)
    }
    if (p.kind === 'drop') x.switchHalfway = rng.chance(0.3)
    return x
  })
  const breaks = s.filter((x) => x.kind === 'break')
  const longest = Math.max(0, ...breaks.map((x) => x.bars))
  const long = breaks.filter((x) => x.bars === longest)
  if (long.length === 1 && (breaks.length > 1 || longest >= 16)) long[0].long = true

  // ---- the rules the producer chose ----
  const rules: Record<string, unknown> = {}
  const where = (kind: SectionKind) => s.filter((x) => x.kind === kind)
  const across = (part: string, xs: { from: number; to: number }[], level = 1) => {
    const bars = xs.reduce((n, x) => n + x.to - x.from, 0)
    return bars ? xs.reduce((n, x) => n + share(a, part, x.from, x.to, level) * (x.to - x.from), 0) / bars : 0
  }
  const has = (part: string) => !!a.parts[part]
  const intro = where('intro')
  const drops = where('drop')
  const brks = where('break')
  if (has('hats') && brks.length) rules.hatsInBreaks = across('hats', brks) >= PLAYS
  if (has('clap')) rules.ioClaps = across('clap', intro) >= 0.25
  if (has('perc')) rules.ioPerc = across('perc', intro) >= 0.25
  if (has('top') && intro.length) {
    const i0 = intro[0]
    rules.ioTopFirst = share(a, 'top', i0.from, Math.round((i0.from + i0.to) / 2)) >= PLAYS ? 0 : 0.5
  }
  if (has('bass')) {
    if (brks.length) rules.bassBreaks = across('bass', brks) >= PLAYS ? 'filtered' : 'none'
    rules.bassIO = across('bass', intro) >= 0.25 ? 'filtered' : 'none'
    const builds = where('build')
    if (builds.length) {
      const b = builds[0]
      const full = share(a, 'bass', b.from, b.to, 2)
      const any = share(a, 'bass', b.from, b.to)
      rules.bassBuild = any < 0.25 ? 'none' : full < any - 0.3 ? 'sweep' : 'filtered'
    }
  }
  if (has('ride') && drops.length) {
    const d0 = drops[0]
    const half = Math.round((d0.from + d0.to) / 2)
    const early = share(a, 'ride', d0.from, half) >= PLAYS
    const late = share(a, 'ride', half, d0.to) >= PLAYS
    const later = drops.length > 1 && across('ride', drops.slice(1)) >= PLAYS
    if (late || later) rules.ride = (late || early) && later ? 'both' : later ? 'second' : 'late'
  }
  // Into every drop: the kick out in the bar before it.
  const into = drops.filter((d) => d.from > 0)
  if (into.length) {
    const outs = into.filter((d) => share(a, 'kick', d.from - 1, d.from, 2) === 0 && share(a, 'kick', d.from - 4, d.from - 1, 2) > 0)
    rules.dropKickOut = outs.length / into.length >= PLAYS
  }
  // Crashes and fills at the 8- and 16-bar marks of drops.
  const marks = (step: number, odd: boolean) => drops.flatMap((d) => {
    const out = []
    for (let b = d.from + step; b < d.to; b += step) if (!odd || (b - d.from) % (2 * step)) out.push(b)
    return out
  })
  if (has('crash')) {
    const m16 = marks(16, false)
    const m8 = marks(8, true)
    if (m16.length) rules.phraseCrash = m16.filter((b) => share(a, 'crash', b, b + 1) > 0).length / m16.length >= PLAYS
    if (m8.length) rules.crash8 = m8.filter((b) => share(a, 'crash', b, b + 1) > 0).length / m8.length >= PLAYS
  }
  if (has('fills')) {
    const m16 = marks(16, false)
    if (m16.length) rules.phraseFill = m16.filter((b) => share(a, 'fills', b - 1, b) > 0).length / m16.length >= PLAYS
    if (into.length && !(into.some((d) => share(a, 'fills', d.from - 1, d.from) > 0))) rules.dropFill = null
  }
  if (has('fx')) {
    const busy = share(a, 'fx', 0, a.bars)
    rules.fx = busy < 0.12 ? 'sparse' : busy < 0.3 ? 'normal' : 'busy'
  }

  // ---- make it new: a few rules drawn again, a section a phrase longer or shorter, … ----
  const changes: string[] = []
  for (const k of Object.keys(rules)) if (rng.chance(REDRAW)) delete rules[k]
  const middle = s.filter((x) => x.kind !== 'intro' && x.kind !== 'outro')
  const resize = () => {
    const x = rng.pick(middle)
    const [lo, hi] = LIMITS[x.kind]
    const d = x.bars + PHRASE <= hi && (x.bars - PHRASE < lo || rng.chance(0.5)) ? PHRASE : -PHRASE
    if (x.bars + d < lo || x.bars + d > hi) return false
    x.bars += d
    changes.push(`${x.kind} ${d > 0 ? 'longer' : 'shorter'}`)
    return true
  }
  if (rng.chance(0.6)) resize()
  if (brks.length && rng.chance(0.35)) {
    const b = rng.pick(brks)
    const k = pickKickMode(rng)
    if (k !== b.kick) { b.kick = k; changes.push('another breakdown kick') }
  }
  const builds = where('build')
  if (builds.length && rng.chance(0.25)) {
    const b = rng.pick(builds)
    const st = pickBuildStyle(rng)
    if (st !== b.build) { b.build = st; changes.push('another build') }
  }
  if (!changes.length) resize() || changes.push('some rules new')

  // Long breakdown still the longest after the changes (the generator's own rule).
  const lb = s.find((x) => x.long)
  if (lb && s.some((x) => x !== lb && x.kind === 'break' && x.bars >= lb.bars)) delete lb.long
  s.filter((x) => x.kind === 'drop').at(-1)!.peak = true
  const total = s.reduce((n, x) => n + x.bars, 0)
  const raw: Raw[] = s.map(({ from: _f, to: _t, ...x }) => x)
  if (total < minBars || total > maxBars) fit(rng, raw, total < minBars ? minBars : maxBars)
  return { source: a.source_code, sections: layout(raw), rules, changes }
}
