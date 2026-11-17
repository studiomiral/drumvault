// Structure templates (SCOPE.md §6.6): a real track's arrangement, measured by the engine
// (arrangement.py: per part and bar silent / quiet / full), read as sections and track rules a
// producer chose, then changed a little so the result is new: one section longer or shorter,
// another kick treatment in a breakdown, a few rules drawn again. A reference track (§5.17: a
// finished mix, no stems) gives one too, read from its loudness, kick and drops bar by bar: its
// sections, its breakdown kicks and the bar before its drops, and the arc its drops make.

import type { TrackArrangement } from '../types/api'
import type { MixProfile, ReferenceTrack } from '../types/engine'
import type { Rng } from './rng'
import {
  fit, layout, LIMITS, PHRASE, pickBuildStyle, pickKickMode, type KickMode, type Section, type SectionKind,
} from './structure'
import { bassHighpassHz, lowpassHz, mixHighpassOf, partBright, TOPS_BREAK_MAX_HZ, TOPS_BREAK_MIN_HZ } from './rides'

/** Parts that make a phrase's energy (fills, FX and crashes are moments, not energy). */
const ENERGY_PARTS = ['kick', 'clap', 'hats', 'perc', 'top', 'ride', 'bass', 'music']
/** A kick phrase is a drop at this share of the track's highest energy (or with the bass full). */
const DROP_ENERGY = 0.75
/** Share of a phrase's bars a part must play in to count as playing there. */
const PLAYS = 0.5
/** Chance that a rule read from the track is drawn again instead (the "10 %" that is new). */
const REDRAW = 0.12
/** A reference's bar is silent under this loudness (LUFS). */
const SILENT_LUFS = -60
/** A reference's build rises when its second half is this much louder than its first (LU). */
const RISING_LU = 2

export interface Template {
  /** Source code of the track (S0012), or a reference track's name. */
  source: string
  /** As the choices name it: "S0012", "the reference “Name”". */
  label: string
  /** A reference track's arc (its median drop lift and break depth, LU): what its candidates are scored against. */
  arc?: Arc
  sections: Section[]
  /** Track rules read from the track (the generator's names; the rest it draws itself). */
  rules: Record<string, unknown>
  /** What was changed from the original, for the choices list. */
  changes: string[]
}

/** How hard a track's drops lift (LU over the 8 bars before) and how deep it goes between them (LU under its drops). */
export interface Arc { liftLu: number | null; breakDepthLu: number | null }

type Raw = Omit<Section, 'start' | 'label'>
type Read = { kind: SectionKind; from: number; to: number }
/** A phrase as read: a kick through it, as full as a drop, or nothing there. */
type Phrase = { kick: boolean; drop: boolean; silent: boolean }

/** Share of the bars in [from, to) where `part` plays at `level` or louder; 0 without that part. */
export function share(a: TrackArrangement, part: string, from: number, to: number, level = 1): number {
  const s = a.parts[part]
  if (!s || to <= from) return 0
  let n = 0
  for (let b = from; b < to; b++) if (Number(s[b] ?? 0) >= level) n++
  return n / (to - from)
}

/** The track's sections as it was produced (phrase by phrase), before fitting them to our rules. */
export function readSections(a: TrackArrangement): Read[] | null {
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
  const kicks = ph.filter((p) => p.kick && !p.silent)
  if (!kicks.length) return null
  const top = Math.max(...kicks.map((p) => p.energy))
  return sectionsOf(ph.map((x) => ({ kick: x.kick, drop: x.kick && (x.bass || x.energy >= DROP_ENERGY * top), silent: x.silent })), 0)
}

/** The build into the drop after the longest breakdown, as a reference track plays it. */
export interface MainBuild {
  /** Bars it builds over (4, 8 or 16): its fills (a roll, a fill) running up to the drop, else its FX at full. */
  bars: number
  /** The kick back in the build (a quarter of its bars or more), and the claps. */
  kick: boolean
  claps: boolean
}

/**
 * How a reference track builds into the drop after its longest breakdown, read from its parts bar
 * by bar: back from the drop while its fills play (a bar without them allowed: the gap before the
 * drop), else while its FX play at full. Null without a breakdown and a drop after it, or a build
 * shorter than 3 bars.
 */
export function mainBuildOf(a: TrackArrangement): MainBuild | null {
  const secs = readSections(a)
  const breaks = secs?.filter((x) => x.kind === 'break') ?? []
  if (!secs || !breaks.length) return null
  const long = breaks.reduce((x, y) => (y.to - y.from > x.to - x.from ? y : x))
  const drop = secs.find((x) => x.kind === 'drop' && x.from >= long.to)
  if (!drop) return null
  const D = drop.from
  const on = (part: string, b: number, level = 1) => Number(a.parts[part]?.[b] ?? 0) >= level
  const run = (plays: (b: number) => boolean) => {
    let n = 0
    let miss = 0
    for (let b = D - 1; b >= long.from; b--) {
      if (plays(b)) { n = D - b; miss = 0 } else if (++miss > 1) break
    }
    return n
  }
  const fills = run((b) => on('fills', b))
  const raw = fills >= 4 ? fills : run((b) => on('fx', b, 2))
  if (raw < 3) return null
  const bars = raw >= 12 ? 16 : raw >= 6 ? 8 : 4
  return { bars, kick: share(a, 'kick', D - bars, D) >= 0.25, claps: share(a, 'clap', D - bars, D) >= 0.25 }
}

/** How the user's tracks build into the drop after their longest breakdown: those that show it. */
export function mainBuilds(arrangements: TrackArrangement[]): MainBuild[] {
  return arrangements.map(mainBuildOf).filter((x): x is MainBuild => !!x)
}

/**
 * A reference track's sections, read from its mix bar by bar: phrases on the grid of its first
 * drop (a track's phrases needn't start on its first bar); no kick = breakdown, full = drop. Null
 * for a profile from before it kept the bars' kicks, or one without a drop.
 */
export function readReference(p: MixProfile): Read[] | null {
  if (!p.bar_kick || !p.bar_full || !p.drops.length) return null
  const off = p.drops[0].bar % PHRASE
  const n = Math.floor((p.bars - off) / PHRASE)
  const ph = Array.from({ length: n }, (_, i) => {
    const bars = Array.from({ length: PHRASE }, (_, k) => off + i * PHRASE + k)
    const f = (xs: boolean[]) => bars.filter((b) => xs[b]).length / PHRASE
    const kick = f(p.bar_kick!) >= PLAYS
    return {
      kick, drop: kick && f(p.bar_full!) >= PLAYS,
      silent: bars.filter((b) => (p.bar_lufs[b] ?? -200) < SILENT_LUFS).length / PHRASE >= 0.9,
    }
  })
  return sectionsOf(ph, off)
}

/** Phrases (from bar `off`) as sections, before fitting them to our rules. */
function sectionsOf(ph: Phrase[], off: number): Read[] | null {
  const n = ph.length
  let first = 0
  let last = n - 1
  while (first < n && ph[first].silent) first++
  while (last > first && ph[last].silent) last--
  if (last - first + 1 < 8) return null
  const kinds: SectionKind[] = []
  for (let p = first; p <= last; p++) {
    const x = ph[p]
    kinds.push(!x.kick ? 'break' : x.drop ? 'drop' : 'build')
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
  const out: Read[] = []
  kinds.forEach((k, i) => {
    const bar = off + (first + i) * PHRASE
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
type Part = Raw & { from: number; to: number }

/** Sections as read, in the generator's grammar: an intro, a build or a drop next, builds into drops, a DJ outro. */
function shape(read: Read[] | null): Part[] | null {
  if (!read || read.length < 3) return null
  const parts: Part[] = read.map((r) => ({ kind: r.kind, bars: r.to - r.from, from: r.from, to: r.to }))
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
  return merged
}

/** Where a vocal sings in a track (the generator's `vocalAt`). */
export interface VocalRule { vocalAt: 'drops' | 'halves' | 'drops_breaks' | 'breaks' }

/**
 * Where the track's vocal sings, read from its vocal stems over its sections: in the breakdowns
 * (and the drops), in the drops' second halves only, or in the drops. Null when it doesn't sing (in a quarter of its drops and
 * breakdowns at least), or wasn't measured.
 */
function vocalRuleIn(a: TrackArrangement, s: Part[]): VocalRule | null {
  const v = a.levels?.vocal?.bars
  if (!v) return null
  const on = (from: number, to: number) => {
    let n = 0
    for (let b = from; b < to; b++) if (Number(v[b] ?? 0) >= 1) n++
    return to > from ? n / (to - from) : 0
  }
  const across = (xs: { from: number; to: number }[]) => {
    const bars = xs.reduce((n, x) => n + x.to - x.from, 0)
    return bars ? xs.reduce((n, x) => n + on(x.from, x.to) * (x.to - x.from), 0) / bars : 0
  }
  const drops = s.filter((x) => x.kind === 'drop')
  const brks = s.filter((x) => x.kind === 'break')
  const inDrops = across(drops)
  const inBreaks = across(brks)
  if (inDrops < 0.25 && inBreaks < 0.25) return null
  const mid = (d: Part) => d.from + Math.floor((d.to - d.from) / 2 / PHRASE) * PHRASE
  const first = across(drops.map((d) => ({ from: d.from, to: mid(d) })))
  const second = across(drops.map((d) => ({ from: mid(d), to: d.to })))
  const vocalAt = inBreaks >= PLAYS ? (inDrops >= PLAYS ? 'drops_breaks' : 'breaks') : second >= PLAYS && first < 0.3 ? 'halves' : 'drops'
  return { vocalAt }
}

/** Where a track sings (vocalRuleIn), from its arrangement as measured; null: no vocal there. */
export function vocalRuleOf(a: TrackArrangement): VocalRule | null {
  const s = shape(readSections(a))
  return s ? vocalRuleIn(a, s) : null
}

/** How often the user's tracks sing where: weights for the generator's `vocalAt` (null: none sing). */
export function vocalAtWeights(arrangements: TrackArrangement[]): [VocalRule['vocalAt'], number][] | null {
  const n: Record<VocalRule['vocalAt'], number> = { drops: 0, halves: 0, drops_breaks: 0, breaks: 0 }
  let any = 0
  for (const a of arrangements) {
    const r = vocalRuleOf(a)
    if (r) { n[r.vocalAt]++; any++ }
  }
  return any ? (Object.entries(n) as [VocalRule['vocalAt'], number][]).filter(([, w]) => w > 0) : null
}

/** The longest breakdown is the long one (when there are several, or it is 16 bars or more). */
function markLong(s: Part[]): void {
  const breaks = s.filter((x) => x.kind === 'break')
  const longest = Math.max(0, ...breaks.map((x) => x.bars))
  const long = breaks.filter((x) => x.bars === longest)
  if (long.length === 1 && (breaks.length > 1 || longest >= 16)) long[0].long = true
}

export function templateFrom(a: TrackArrangement, rng: Rng, minBars: number, maxBars: number): Template | null {
  const merged = shape(readSections(a))
  if (!merged) return null

  const s: Part[] = merged.map((p) => {
    const x: Part = { ...p, bars: clampBars(p.kind, p.bars) }
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
  markLong(s)

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
  // Hats in the intro and the outro: none, the half next to the drops, or all through.
  const ioHats = (xs: { from: number; to: number }[]) => {
    const v = across('hats', xs)
    return v < 0.2 ? 'none' : v < 0.75 ? 'half' : 'all'
  }
  const outro = where('outro')
  if (has('hats') && intro.length) rules.introHats = ioHats(intro)
  if (has('hats') && outro.length) rules.outroHats = ioHats(outro)
  // Top loops through breakdowns: low-passed (as dark as measured), open, or out.
  if (has('top') && brks.length) {
    const dark = partBright(a, 'top', brks)
    rules.topsBreaks = across('top', brks) < PLAYS ? 'none' : dark != null && dark > -0.35 ? 'open' : 'filtered'
    if (dark != null && dark <= -0.35) rules.topsBreakHz = Math.max(TOPS_BREAK_MIN_HZ, Math.min(TOPS_BREAK_MAX_HZ, lowpassHz(dark)))
  }
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
    // Outside drops the bass is high-passed: how far, from how much brighter it measures there.
    const thin = partBright(a, 'bass', s.filter((x) => x.kind !== 'drop'))
    if (thin != null && thin > 0) rules.bassHp = bassHighpassHz(thin)
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
    // A breath in the bar before drops: the parts playing two bars before that stop for it.
    const stops = (parts: string[]) => {
      const xs = into.flatMap((d) => parts.filter((p) => d.from >= 2 && share(a, p, d.from - 2, d.from - 1) > 0)
        .map((p) => share(a, p, d.from - 1, d.from) === 0))
      return xs.length ? xs.filter(Boolean).length / xs.length : null
    }
    const tops = stops(['top'])
    const drums = stops(['clap', 'perc', 'hats'])
    if (tops != null) rules.dropBreath = tops < PLAYS ? null : drums != null && drums >= PLAYS ? 'all' : 'tops'
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
  // The whole mix high-passed in the bars before drops (measured rides).
  const hp = mixHighpassOf(a, into)
  if (hp) rules.mixHp = hp
  if (has('fx')) {
    const busy = share(a, 'fx', 0, a.bars)
    rules.fx = busy < 0.12 ? 'sparse' : busy < 0.3 ? 'normal' : 'busy'
  }

  const { sections, changes } = makeNew(s, rules, rng, minBars, maxBars, a.source_code)
  // Where it sings (its vocal stems): there, when the track gets a vocal. (After the redraws: the
  // rest of the template is drawn as before.)
  const sings = vocalRuleIn(a, s)
  if (sings) Object.assign(rules, sings)
  return { source: a.source_code, label: a.source_code, sections, rules, changes }
}

/**
 * Made new: a few rules drawn again, a section a phrase longer or shorter, sometimes another
 * breakdown kick or build; then fitted to [minBars, maxBars] when outside it. `src`: the
 * arrangement the sections stand for (their rides), none for a reference.
 */
function makeNew(s: Part[], rules: Record<string, unknown>, rng: Rng, minBars: number, maxBars: number, src: string | null): { sections: Section[]; changes: string[] } {
  const where = (kind: SectionKind) => s.filter((x) => x.kind === kind)
  const brks = where('break')
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
  const raw: Raw[] = s.map(({ from, to, ...x }) => (src ? { ...x, src: { code: src, from, to } } : x))
  if (total < minBars || total > maxBars) fit(rng, raw, total < minBars ? minBars : maxBars)
  return { sections: layout(raw), changes }
}

/**
 * A template from a reference track (a finished mix): its sections as read from its mix, the kick
 * in its breakdowns, builds that rise or not, the kick out in the bar before its drops, and its
 * arc. Everything a mix doesn't tell (hats, tops, bass in breakdowns, …) the generator draws.
 * Null when the profile doesn't read as a dance track or is from before it kept the bars' kicks.
 */
export function templateFromReference(ref: ReferenceTrack, rng: Rng, minBars: number, maxBars: number): Template | null {
  const p = ref.profile
  if (!p) return null
  const merged = shape(readReference(p))
  if (!merged) return null
  const kickShare = (from: number, to: number) => {
    let n = 0
    for (let b = from; b < to; b++) if (p.bar_kick![b]) n++
    return to > from ? n / (to - from) : 0
  }
  const loud = (from: number, to: number) => {
    const xs = p.bar_lufs.slice(from, to).filter((v): v is number => v != null)
    return xs.length ? 10 * Math.log10(xs.reduce((n, v) => n + 10 ** (v / 10), 0) / xs.length) : null
  }
  const s: Part[] = merged.map((x0) => {
    const x: Part = { ...x0, bars: clampBars(x0.kind, x0.bars) }
    if (x0.kind === 'break') {
      const k = kickShare(x0.from, x0.to)
      x.kick = k < 0.15 ? 'out' : k >= PLAYS ? rng.weighted([['thin', 2], ['filtered', 1], ['sweep', 0.5]] as const) : pickKickMode(rng)
    }
    if (x0.kind === 'build') {
      const mid = Math.round((x0.from + x0.to) / 2)
      const a = loud(x0.from, mid)
      const z = loud(mid, x0.to)
      x.build = a != null && z != null && z - a >= RISING_LU ? rng.weighted([['layered', 3], ['doubletime', 1]] as const)
        : rng.chance(0.4) ? 'all' : pickBuildStyle(rng)
    }
    if (x0.kind === 'drop') x.switchHalfway = rng.chance(0.3)
    return x
  })
  markLong(s)
  const rules: Record<string, unknown> = {}
  const into = s.filter((x) => x.kind === 'drop' && x.from >= 4)
  if (into.length) {
    const outs = into.filter((d) => !p.bar_kick![d.from - 1] && kickShare(d.from - 4, d.from - 1) > 0)
    rules.dropKickOut = outs.length / into.length >= PLAYS
  }
  const { sections, changes } = makeNew(s, rules, rng, minBars, maxBars, null)
  return {
    source: ref.name, label: `the reference “${ref.name}”`, sections, rules, changes,
    arc: { liftLu: p.lift_lu, breakDepthLu: p.break_depth_lu },
  }
}
